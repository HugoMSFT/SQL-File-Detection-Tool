"""Disposable Linux-only execution of the shipped TypeScript generator's SQL.

No Python generator is imported. Docker/sqlcmd output is consumed in memory;
only allowlisted error codes and synthetic verification facts enter evidence.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import signal
import subprocess
import tempfile
import time

from .batches import split_batches, strip_sql_comments
from .runid import RunIdentity
from .safety import SafetyPolicy, evaluate_batch

REPO = Path(__file__).resolve().parents[2]
IMAGES = {
    "2022": "mcr.microsoft.com/mssql/server:2022-latest",
    "2025": "mcr.microsoft.com/mssql/server:2025-latest",
}
LABEL = "io.sqlfdt.native-run"
PREAMBLE = "SET NOCOUNT ON;\nGO\n"


class RunFailure(RuntimeError):
    """Carries a safe, fixed diagnostic code, never a raw server exception."""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def artifact_path(root, relative):
    if (not isinstance(relative, str) or not relative or "\\" in relative
            or re.match(r"^[A-Za-z]:", relative)
            or any(part in ("", ".", "..") for part in relative.split("/"))):
        raise RunFailure("invalid_artifact_path")
    target = root.joinpath(*relative.split("/"))
    if root.resolve() not in target.resolve().parents or target.is_symlink():
        raise RunFailure("artifact_path_escape")
    return target


def expected_rows():
    return [{"id": i, "label": f"fixture_{i:03d}", "amount": i * 7} for i in range(1, 101)]


def validate_plan(directory):
    root = Path(directory).resolve()
    raw = (root / "plan.json").read_bytes()
    plan = json.loads(raw)
    if not re.fullmatch(r"[0-9a-f]{8}", plan.get("runId", "")):
        raise RunFailure("invalid_run_id")
    identity = RunIdentity(plan["runId"])
    if (plan.get("schemaVersion") != 1 or plan.get("generator") != "native-typescript"
            or plan.get("entryPoint") != "out/native/service.js"
            or plan.get("engine") not in IMAGES or plan.get("image") != IMAGES[plan["engine"]]
            or plan.get("schema") != identity.schema or plan.get("database") != identity.database
            or plan.get("fixtureRows") != 100 or plan.get("verificationLimit") != 100
            or not re.fullmatch(r"[0-9a-f]{40}", plan.get("sourceSha", ""))):
        raise RunFailure("invalid_native_plan_contract")
    fixtures = {}
    for fixture in plan["fixtures"]:
        file = artifact_path(root, fixture["file"])
        data = file.read_bytes()
        metadata = fixture["metadata"]
        if (len(data) > 128 * 1024 or digest(data) != fixture["sha256"]
                or len(data) != fixture["bytes"] or fixture["rows"] != 100
                or fixture["expected"] != expected_rows()
                or metadata.get("native_support") != "supported"
                or metadata.get("row_count") != 100 or metadata.get("column_count") != 3
                or metadata["file_path"] != f"/var/opt/mssql/sqlfdt/{identity.run_id}/{file.name}"):
            raise RunFailure("fixture_hash_or_metadata_contract_failed")
        if file.suffix == ".csv":
            actual = data.decode("utf-8-sig").splitlines()
            expected = ["id,label,amount"] + [f'{r["id"]},{r["label"]},{r["amount"]}' for r in expected_rows()]
            if actual != expected:
                raise RunFailure("fixture_values_do_not_match_metadata")
        elif file.suffix == ".json":
            actual = json.loads(data.decode("utf-16" if data.startswith(b"\xff\xfe") else "utf-8"))
            if actual != expected_rows():
                raise RunFailure("fixture_values_do_not_match_metadata")
        else:
            raise RunFailure("unsupported_fixture")
        if fixture["id"] in fixtures:
            raise RunFailure("duplicate_fixture")
        fixtures[fixture["id"]] = fixture
    if len(fixtures) != 3:
        raise RunFailure("expected_three_exact_fixtures")
    policy = SafetyPolicy(identity)
    seen = set()
    for cell in plan["cells"]:
        if not re.fullmatch(r"[a-z0-9_-]+", cell["id"]) or cell["id"] in seen:
            raise RunFailure("invalid_cell_identity")
        if cell["sqlFile"] != f'sql/{cell["id"]}.sql' or cell.get("substitutions") != []:
            raise RunFailure("modified_native_sql")
        sql = artifact_path(root, cell["sqlFile"]).read_bytes()
        if len(sql) > 256 * 1024 or digest(sql) != cell["sqlSha256"]:
            raise RunFailure("native_sql_hash_mismatch")
        batches = split_batches(sql.decode("utf-8"))
        if cell["availability"] == "ready":
            if not batches or cell["kind"] not in ("create_table", "bulk_insert", "openrowset"):
                raise RunFailure("empty_or_unsupported_ready_cell")
            if any(dependency not in seen for dependency in cell["prerequisites"]):
                raise RunFailure("invalid_prerequisite_order")
            allowed_path = fixtures[cell["fixtureId"]]["metadata"]["file_path"]
            for batch in batches:
                gate = evaluate_batch(batch.text, policy)
                if batch.repeat != 1 or not gate.allowed:
                    raise RunFailure("native_safety_gate:" + ",".join(gate.codes or ["placeholder_or_repeat"]))
                for literal in re.findall(r"'((?:''|[^'])*)'", strip_sql_comments(batch.text)):
                    if ("/" in literal or "\\" in literal) and literal != allowed_path:
                        raise RunFailure("unowned_native_source_path")
            for key in ("verificationSql", "rowCountSql"):
                if cell.get(key) and not evaluate_batch(cell[key], policy).allowed:
                    raise RunFailure("verification_safety_gate")
        elif cell["availability"] == "native-unavailable":
            if batches:
                raise RunFailure("native_unavailable_cell_contains_executable_sql")
        elif cell["availability"] != "unavailable" or not cell.get("reason"):
            raise RunFailure("invalid_availability")
        seen.add(cell["id"])
    if len(plan["cells"]) != 14:
        raise RunFailure("native_matrix_incomplete")
    return plan, digest(raw)


def error_facts(result):
    text = result.stdout + result.stderr
    codes = sorted({int(code) for code in re.findall(r"\b(?:Msg|Error:)\s*(\d{2,6})\b", text)})
    return {"exitCode": result.returncode, "sqlErrorNumbers": codes,
            "diagnostic": "authentication_failed" if "Login failed" in text else "sql_or_process_failure"}


class Docker:
    def __init__(self, password):
        self.env = {key: os.environ[key] for key in ("PATH", "HOME", "SystemRoot") if key in os.environ}
        self.env.update(MSSQL_SA_PASSWORD=password, SQLCMDPASSWORD=password)

    def run(self, args, *, sql=None, timeout=45):
        try:
            result = subprocess.run(["docker", *args], input=sql, text=True, encoding="utf-8",
                                    errors="replace", capture_output=True, timeout=timeout,
                                    env=self.env, check=False)
        except subprocess.TimeoutExpired:
            raise RunFailure("process_timeout") from None
        except OSError:
            raise RunFailure("docker_process_unavailable") from None
        if len(result.stdout) + len(result.stderr) > 2 * 1024 * 1024:
            raise RunFailure("process_output_limit")
        return result


def require_success(result, code):
    if result.returncode != 0:
        raise RunFailure(code)
    return result.stdout.strip()


def check_host(docker):
    if platform.system() != "Linux" or platform.machine().lower() not in ("x86_64", "amd64"):
        raise RunFailure("requires_native_x86_64_linux_no_emulation")
    if os.environ.get("DOCKER_HOST") or os.environ.get("DOCKER_CONTEXT"):
        raise RunFailure("explicit_docker_host_or_context_not_allowed")
    endpoint = require_success(docker.run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]),
                               "docker_context_unavailable")
    if not endpoint.startswith("unix://"):
        raise RunFailure("requires_local_docker_socket")
    host = require_success(docker.run(["info", "--format", "{{.OSType}}/{{.Architecture}}"]),
                           "docker_daemon_unavailable")
    if host not in ("linux/x86_64", "linux/amd64"):
        raise RunFailure("requires_x86_64_linux_docker_daemon")


def cleanup_container(docker, name, run_id):
    def inventory():
        return require_success(docker.run([
            "container", "ls", "--all", "--filter", f"name=^/{name}$", "--format", "{{.ID}}",
        ]), "cleanup_inventory_failed")
    if inventory():
        owner = require_success(docker.run([
            "inspect", "--format", '{{index .Config.Labels "' + LABEL + '"}}', name,
        ]), "cleanup_owner_unavailable")
        if owner != run_id:
            raise RunFailure("cleanup_refused_unowned_container")
        require_success(docker.run(["rm", "--force", "--volumes", name]), "cleanup_remove_failed")
    if inventory():
        raise RunFailure("cleanup_residue")
    return {"containerRemoved": True, "residueCount": 0, "databaseDestroyedWithContainer": True}


def verify_rows(output, fixture, whole_csv=False, fixture_data=None):
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if whole_csv:
        expected_csv = fixture_data.decode("utf-8-sig").splitlines()
        if lines[-len(expected_csv):] != expected_csv:
            raise RunFailure("whole_file_value_mismatch")
        lines = lines[:-len(expected_csv)]
    rows = []
    for line in lines:
        parts = [part.strip() for part in line.split("|")]
        if len(parts) != 3 or not parts[0].isdigit() or not parts[2].isdigit():
            raise RunFailure("bad_or_null_result_value")
        rows.append({"id": int(parts[0]), "label": parts[1], "amount": int(parts[2])})
    if len(rows) != 100 or sorted(rows, key=lambda row: row["id"]) != fixture["expected"]:
        raise RunFailure("nonempty_exact_100_row_contract_failed")
    return {"verifiedRows": 100, "badValues": 0, "emptyResult": False}


def execute_plan(plan, plan_hash, directory, output, docker, *, host_check=check_host, wait=time.sleep):
    identity = RunIdentity(plan["runId"])
    name = f"sqlfdt-native-{identity.run_id}"
    root = Path(directory)
    evidence = {
        "schemaVersion": 1, "generator": "native-typescript", "sourceSha": plan["sourceSha"],
        "extensionVersion": plan["extensionVersion"], "compiledTreeSha256": plan["compiledTree"]["sha256"],
        "planSha256": plan_hash, "engine": plan["engine"], "imageTag": plan["image"],
        "rowLimit": 100, "fixtureCount": 3, "liveExecuted": False,
        "status": "FAIL", "cells": [], "cleanupVerified": False,
        "prerequisites": plan["prerequisites"], "unavailableEngines": plan["unavailableEngines"],
    }
    container_attempted = False
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    sqlcmd = "/opt/mssql-tools18/bin/sqlcmd"

    def query(sql, database=None, timeout=40):
        return docker.run([
            "exec", "--interactive", "--env", "SQLCMDPASSWORD", name, sqlcmd,
            "-S", "localhost", "-U", "sa", "-C", "-b", "-V", "11",
            "-l", "5", "-t", "30", "-h", "-1", "-W", "-w", "65535", "-s", "|",
            "-d", database or identity.database,
        ], sql=PREAMBLE + sql, timeout=timeout)

    try:
        host_check(docker)
        require_success(docker.run(["pull", plan["image"]], timeout=240), "official_image_pull_failed")
        image_id = require_success(docker.run(["image", "inspect", "--format", "{{.Id}}", plan["image"]]),
                                   "image_digest_unavailable")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
            raise RunFailure("invalid_image_digest")
        evidence["imageId"] = image_id
        repo_digests = json.loads(require_success(docker.run([
            "image", "inspect", "--format", "{{json .RepoDigests}}", image_id,
        ]), "image_repo_digest_unavailable"))
        if (not isinstance(repo_digests, list) or not repo_digests
                or any(not isinstance(value, str) or not re.fullmatch(
                    r"mcr\.microsoft\.com/mssql/server@sha256:[0-9a-f]{64}", value) for value in repo_digests)):
            raise RunFailure("invalid_official_image_repository_digest")
        evidence["repoDigests"] = repo_digests
        for fixture in plan["fixtures"]:
            if digest(artifact_path(root, fixture["file"]).read_bytes()) != fixture["sha256"]:
                raise RunFailure("fixture_changed_after_validation")
        container_attempted = True
        require_success(docker.run([
            "run", "--detach", "--name", name, "--network", "none", "--memory", "3g",
            "--cpus", "2", "--pids-limit", "512", "--label", f"{LABEL}={identity.run_id}",
            "--env", "ACCEPT_EULA=Y", "--env", "MSSQL_PID=Developer",
            "--env", "MSSQL_SA_PASSWORD",
            "--mount", f"type=bind,source={(root / 'fixtures').resolve()},target=/var/opt/mssql/sqlfdt/{identity.run_id},readonly",
            image_id,
        ], timeout=90), "container_start_failed")
        for _ in range(30):
            if query("SELECT 1;", "master", timeout=12).returncode == 0:
                break
            wait(2)
        else:
            raise RunFailure("sql_readiness_timeout")
        version = require_success(query(
            "SELECT CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(100)), "
            "CAST(SERVERPROPERTY('Edition') AS NVARCHAR(100));", "master"), "server_version_query_failed").split("|")
        if (len(version) != 2 or not re.fullmatch(r"(16|17)\.[0-9.]+", version[0].strip())
                or "Developer" not in version[1]
                or not version[0].startswith("16." if plan["engine"] == "2022" else "17.")):
            raise RunFailure("wrong_server_version_or_edition")
        evidence["serverVersion"], evidence["edition"] = [item.strip() for item in version]
        evidence["sqlcmd"] = sqlcmd
        create_database = f"CREATE DATABASE [{identity.database}];"
        if not evaluate_batch(create_database, SafetyPolicy(identity, allow_create_database=True)).allowed:
            raise RunFailure("bootstrap_safety_gate")
        require_success(query(create_database, "master"), "owned_database_create_failed")
        require_success(query(f"CREATE SCHEMA [{identity.schema}];"), "owned_schema_create_failed")
        evidence["liveExecuted"] = True
        outcomes = {}
        for cell in plan["cells"]:
            result = {"id": cell["id"], "phase": cell["phase"], "generatedSqlSha256": cell["sqlSha256"],
                      "substitutions": [], "status": "FAIL", "batches": []}
            evidence["cells"].append(result)
            if cell["availability"] != "ready":
                result.update(status="UNAVAILABLE", category=cell["availability"], reason=cell["reason"])
                continue
            if any(outcomes.get(dependency) != "PASS" for dependency in cell["prerequisites"]):
                result.update(status="BLOCKED", reason="DDL prerequisite failed; read was not attempted")
                outcomes[cell["id"]] = result["status"]
                continue
            sql = artifact_path(root, cell["sqlFile"]).read_text(encoding="utf-8")
            if digest(sql.encode("utf-8")) != cell["sqlSha256"]:
                raise RunFailure("native_sql_changed_after_validation")
            outputs = []
            for batch in split_batches(sql):
                gate = evaluate_batch(batch.text, SafetyPolicy(identity))
                if not gate.allowed:
                    raise RunFailure("execution_safety_gate")
                executed = query(batch.text)
                result["batches"].append({
                    "batchIndex": batch.index, "batchSha256": digest(batch.text.encode()),
                    "wireSqlSha256": digest((PREAMBLE + batch.text).encode()),
                    "preamble": PREAMBLE, "status": "PASS" if executed.returncode == 0 else "FAIL",
                })
                if executed.returncode != 0:
                    result.update(error=error_facts(executed), knownIssue=cell.get("knownIssue"))
                    break
                outputs.append(executed.stdout)
            else:
                try:
                    if cell["phase"] == "READ":
                        fixture = next(item for item in plan["fixtures"] if item["id"] == cell["fixtureId"])
                        if cell.get("verificationSql"):
                            count = require_success(query(cell["rowCountSql"]), "row_count_query_failed")
                            if count != "100":
                                raise RunFailure("ingestion_must_equal_100_rows")
                            result["ingestedRows"] = 100
                            result["rowCountSqlSha256"] = digest(cell["rowCountSql"].encode())
                            verification = query(cell["verificationSql"])
                            require_success(verification, "verification_query_failed")
                            result["verificationSqlSha256"] = digest(cell["verificationSql"].encode())
                            text = verification.stdout
                        else:
                            text = "\n".join(outputs)
                        result.update(verify_rows(
                            text, fixture, cell.get("outputContract") == "typed-rows-and-exact-whole-csv",
                            artifact_path(root, fixture["file"]).read_bytes(),
                        ))
                    result["status"] = "PASS"
                except RunFailure as error:
                    result["error"] = {"diagnostic": str(error)}
            outcomes[cell["id"]] = result["status"]
        evidence["status"] = "FAIL" if any(
            cell["status"] in ("FAIL", "BLOCKED") for cell in evidence["cells"]
        ) else "PASS"
    except RunFailure as error:
        evidence["error"] = str(error)
    except (OSError, ValueError, KeyError, StopIteration):
        evidence["error"] = "invalid_runner_or_process_output"
    finally:
        if container_attempted:
            try:
                evidence["cleanup"] = cleanup_container(docker, name, identity.run_id)
                evidence["cleanupVerified"] = True
            except RunFailure as error:
                evidence["cleanupError"] = str(error)
                evidence["status"] = "FAIL"
        else:
            evidence["cleanup"] = {"containerAttempted": False, "residueCount": 0}
            evidence["cleanupVerified"] = True
        evidence["counts"] = {status: sum(cell["status"] == status for cell in evidence["cells"])
                              for status in ("PASS", "FAIL", "BLOCKED", "UNAVAILABLE")}
        (output / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=IMAGES, default="2022")
    parser.add_argument("--output", default=".artifacts/native-live")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--validate-plan")
    args = parser.parse_args()
    if args.validate_plan:
        plan, plan_hash = validate_plan(args.validate_plan)
        print(json.dumps({"status": "OFFLINE_VALIDATED", "planSha256": plan_hash,
                          "cells": len(plan["cells"]), "liveExecuted": False}))
        return 0
    if not args.live:
        parser.error("Execution requires explicit --live; use --validate-plan for offline checks.")
    # Refuse ARM/emulated/remote hosts before creating even a Docker resource.
    password = "Aa1!" + secrets.token_urlsafe(32)
    docker = Docker(password)
    check_host(docker)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise RunFailure("evidence_output_must_be_empty")
    run_id = secrets.token_hex(4)
    with tempfile.TemporaryDirectory(prefix="sqlfdt-native-", dir=Path(tempfile.gettempdir()).resolve()) as scratch:
        root = Path(scratch) / "plan"
        generated = subprocess.run(
            ["node", str(REPO / "scripts/native-sql.js"), "--engine", args.engine,
             "--run-id", run_id, "--output", str(root)],
            capture_output=True, timeout=90, check=False, cwd=REPO,
        )
        if generated.returncode != 0:
            raise RunFailure("native_plan_generation_failed_run_npm_compile")
        plan, plan_hash = validate_plan(root)
        # These bytes are synthetic: persist the exact input, never server output.
        shutil.copytree(root, output / "input")
        def cancel(_signum, _frame):
            raise RunFailure("canceled")
        previous = {sig: signal.signal(sig, cancel) for sig in (signal.SIGINT, signal.SIGTERM)}
        try:
            evidence = execute_plan(plan, plan_hash, root, output, docker)
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    evidence["temporaryDirectoryRemoved"] = not Path(scratch).exists()
    if not evidence["temporaryDirectoryRemoved"]:
        evidence["status"] = "FAIL"
    (output / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": evidence["status"], "counts": evidence["counts"],
                      "cleanupVerified": evidence["cleanupVerified"]}))
    return 0 if evidence["status"] == "PASS" and evidence["cleanupVerified"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RunFailure as failure:
        print(json.dumps({"status": "FAIL", "diagnostic": str(failure)}))
        raise SystemExit(1)
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
        print(json.dumps({"status": "FAIL", "diagnostic": "runner_or_plan_failed"}))
        raise SystemExit(1)
