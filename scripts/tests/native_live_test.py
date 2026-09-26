"""Offline tests: fake Docker/sqlcmd boundary, never a server or a credential."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts.certification.native_live import (
    Docker, RunFailure, artifact_path, check_host, cleanup_container, digest,
    error_facts, execute_plan, expected_rows, verify_rows, PREAMBLE,
)

RUN = "1234abcd"
SYNTHETIC_SECRET = "synthetic-private-password"


def result(stdout="", code=0, stderr=""):
    return subprocess.CompletedProcess([], code, stdout, stderr)


def rows_text():
    return "\n".join(f'{r["id"]}|{r["label"]}|{r["amount"]}' for r in expected_rows()) + "\n"


class FakeDocker:
    def __init__(self, failure=None, owner=RUN):
        self.calls = []
        self.exists = False
        self.failure = failure
        self.owner = owner

    def run(self, args, *, sql=None, timeout=45):
        self.calls.append((args, sql, timeout))
        if args[0] == "pull":
            return result("pulled")
        if args[:2] == ["image", "inspect"]:
            return result(json.dumps(["mcr.microsoft.com/mssql/server@sha256:" + "b" * 64])
                          if "RepoDigests" in args[3] else "sha256:" + "a" * 64)
        if args[0] == "run":
            self.exists = True
            if self.failure == "start_timeout":
                raise RunFailure("process_timeout")
            return result("owned-container-id")
        if args[:2] == ["container", "ls"]:
            return result("owned-container-id" if self.exists else "")
        if args[0] == "inspect":
            return result(self.owner)
        if args[0] == "rm":
            self.exists = False
            return result("removed")
        if args[0] == "exec":
            if "SELECT 1;" in sql:
                return result("1\n")
            if "SERVERPROPERTY" in sql:
                return result("16.0.9999.1|Developer Edition (64-bit)\n")
            if "BULK INSERT" in sql:
                if self.failure == "cancel":
                    raise RunFailure("canceled")
                if self.failure == "native":
                    return result(code=1, stderr=(
                        "Msg 16202, Level 16, State 1\nCODEPAGE unavailable "
                        f"Password={SYNTHETIC_SECRET} https://private.invalid/fixture?sig=secret"
                    ))
                return result("100\n")
            if "COUNT_BIG" in sql:
                return result("101\n" if self.failure == "overflow" else "100\n")
            if "SELECT TOP" in sql:
                return result(rows_text())
            return result("")
        raise AssertionError(f"Unexpected fake command: {args[0]}")


def make_plan(directory):
    sql_dir = directory / "sql"
    fixtures = directory / "fixtures"
    sql_dir.mkdir()
    fixtures.mkdir()
    csv = "id,label,amount\n" + "".join(
        f'{r["id"]},{r["label"]},{r["amount"]}\n' for r in expected_rows())
    (fixtures / "sample.csv").write_text(csv, encoding="utf-8")
    statements = {
        "ddl": "CREATE TABLE [sqlfdt_cert_1234abcd].[sqlfdt_cert_1234abcd_data] ([id] INT, [label] NVARCHAR(255), [amount] INT);",
        "read": ("BULK INSERT [sqlfdt_cert_1234abcd].[sqlfdt_cert_1234abcd_data] "
                 "FROM '/var/opt/mssql/sqlfdt/1234abcd/sample.csv' WITH (CODEPAGE='65001');"),
        "external": "-- no endpoint provisioned",
    }
    cells = []
    for name, sql in statements.items():
        (sql_dir / f"{name}.sql").write_text(sql, encoding="utf-8")
        cells.append({
            "id": name, "fixtureId": "sample", "kind": "create_table" if name == "ddl" else "bulk_insert",
            "phase": "DDL" if name == "ddl" else "READ",
            "sqlFile": f"sql/{name}.sql", "sqlSha256": digest(sql.encode()),
            "prerequisites": ["ddl"] if name == "read" else [],
            "availability": "unavailable" if name == "external" else "ready",
            "reason": "No network endpoint", "substitutions": [],
        })
    cells[1].update(
        verificationSql="SELECT TOP (100) [id], [label], [amount] FROM [sqlfdt_cert_1234abcd].[sqlfdt_cert_1234abcd_data] ORDER BY [id];",
        rowCountSql="SELECT COUNT_BIG(*) FROM [sqlfdt_cert_1234abcd].[sqlfdt_cert_1234abcd_data];",
        knownIssue="Emitted CODEPAGE is not rewritten",
    )
    return {
        "runId": RUN, "sourceSha": "f" * 40, "extensionVersion": "1.0.0", "engine": "2022",
        "image": "mcr.microsoft.com/mssql/server:2022-latest", "compiledTree": {"sha256": "a" * 64},
        "prerequisites": ["native-x86-linux"], "unavailableEngines": ["Azure SQL"],
        "cells": cells, "fixtures": [{"id": "sample", "file": "fixtures/sample.csv",
                                      "sha256": digest((fixtures / "sample.csv").read_bytes()),
                                      "expected": expected_rows()}],
    }


class NativeLiveTests(unittest.TestCase):
    def test_session_options_do_not_precede_create_schema_in_the_same_batch(self):
        self.assertEqual(PREAMBLE, "SET NOCOUNT ON;\nGO\n")

    def test_exact_100_nonempty_values(self):
        fixture = {"expected": expected_rows()}
        self.assertEqual(verify_rows(rows_text(), fixture)["verifiedRows"], 100)
        for text in ("", rows_text().replace("fixture_001", "bad"),
                     rows_text().replace("1|fixture_001|7", "NULL|fixture_001|7"),
                     rows_text() + "101|fixture_101|707"):
            with self.assertRaises(RunFailure):
                verify_rows(text, fixture)

    def test_whole_file_alternative_must_also_match(self):
        fixture = {"expected": expected_rows()}
        csv = b"id,label,amount\n1,fixture_001,7\n"
        self.assertEqual(verify_rows(rows_text() + csv.decode(), fixture, True, csv)["badValues"], 0)
        with self.assertRaisesRegex(RunFailure, "whole_file"):
            verify_rows(rows_text() + "bad contents", fixture, True, csv)

    def test_native_errors_remain_fail_separate_from_ddl_and_unavailable(self):
        with tempfile.TemporaryDirectory(prefix="sqlfdt-adapter-test-") as temporary:
            root = Path(temporary)
            plan = make_plan(root)
            docker = FakeDocker("native")
            evidence = execute_plan(plan, "b" * 64, root, root / "report", docker,
                                    host_check=lambda _docker: None, wait=lambda _seconds: None)
            self.assertEqual(evidence["status"], "FAIL")
            self.assertEqual([cell["status"] for cell in evidence["cells"]], ["PASS", "FAIL", "UNAVAILABLE"])
            self.assertEqual(evidence["cells"][1]["error"]["sqlErrorNumbers"], [16202])
            self.assertTrue(evidence["cleanupVerified"])
            self.assertFalse(docker.exists)
            serialized = (root / "report/evidence.json").read_text(encoding="utf-8")
            for private in (SYNTHETIC_SECRET, "private.invalid", "sig=secret"):
                self.assertNotIn(private, serialized)
            self.assertEqual(evidence["cells"][1]["generatedSqlSha256"], plan["cells"][1]["sqlSha256"])
            sent = [sql for _, sql, _ in docker.calls if sql and "BULK INSERT" in sql][0]
            self.assertIn("CODEPAGE='65001'", sent)
            self.assertNotIn("LASTROW", sent)
            for args, _, _ in docker.calls:
                self.assertNotIn(SYNTHETIC_SECRET, json.dumps(args))
            run_args = next(args for args, _, _ in docker.calls if args[0] == "run")
            self.assertIn("--network", run_args)
            self.assertIn("none", run_args)
            self.assertNotIn("-p", run_args)
            self.assertNotIn("--publish", run_args)

    def test_success_requires_exact_ingestion_count_and_values(self):
        with tempfile.TemporaryDirectory(prefix="sqlfdt-adapter-test-") as temporary:
            root = Path(temporary)
            plan = make_plan(root)
            evidence = execute_plan(plan, "b" * 64, root, root / "report", FakeDocker(),
                                    host_check=lambda _docker: None)
            self.assertEqual(evidence["status"], "PASS")
            self.assertEqual(evidence["cells"][1]["ingestedRows"], 100)
            self.assertEqual(evidence["cells"][1]["verifiedRows"], 100)
            self.assertEqual(evidence["cleanup"]["residueCount"], 0)
            overflow = execute_plan(plan, "b" * 64, root, root / "overflow", FakeDocker("overflow"),
                                    host_check=lambda _docker: None)
            self.assertEqual(overflow["status"], "FAIL")

    def test_timeout_and_cancellation_remove_only_the_owned_container(self):
        for failure in ("start_timeout", "cancel"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(prefix="sqlfdt-adapter-test-") as temporary:
                root = Path(temporary)
                docker = FakeDocker(failure)
                evidence = execute_plan(make_plan(root), "b" * 64, root, root / "report", docker,
                                        host_check=lambda _docker: None)
                self.assertEqual(evidence["status"], "FAIL")
                self.assertTrue(evidence["cleanupVerified"])
                self.assertFalse(docker.exists)
                removals = [args for args, _, _ in docker.calls if args[0] == "rm"]
                self.assertEqual(removals, [["rm", "--force", "--volumes", f"sqlfdt-native-{RUN}"]])

    def test_cleanup_refuses_foreign_ownership_and_surfaces_error(self):
        docker = FakeDocker(owner="foreign")
        docker.exists = True
        with self.assertRaisesRegex(RunFailure, "unowned"):
            cleanup_container(docker, f"sqlfdt-native-{RUN}", RUN)
        self.assertTrue(docker.exists)
        self.assertFalse(any(args[0] == "rm" for args, _, _ in docker.calls))

    def test_host_rejects_mac_arm_and_remote_context_before_provisioning(self):
        docker = FakeDocker()
        with patch("platform.system", return_value="Darwin"):
            with self.assertRaisesRegex(RunFailure, "native_x86"):
                check_host(docker)
        with patch("platform.system", return_value="Linux"), patch("platform.machine", return_value="arm64"):
            with self.assertRaisesRegex(RunFailure, "native_x86"):
                check_host(docker)
        with patch("platform.system", return_value="Linux"), patch("platform.machine", return_value="x86_64"), \
                patch.dict("os.environ", {"DOCKER_HOST": "tcp://remote:2375"}):
            with self.assertRaisesRegex(RunFailure, "docker_host"):
                check_host(docker)
        self.assertEqual(docker.calls, [])

    def test_password_is_environment_only_and_process_errors_are_redacted(self):
        docker = Docker(SYNTHETIC_SECRET)
        with patch("subprocess.run", return_value=result()) as run:
            docker.run(["exec", "--env", "SQLCMDPASSWORD", "owned", "sqlcmd"], sql="SELECT 1;")
        args, kwargs = run.call_args
        self.assertNotIn(SYNTHETIC_SECRET, json.dumps(args))
        self.assertEqual(kwargs["env"]["SQLCMDPASSWORD"], SYNTHETIC_SECRET)
        self.assertEqual(kwargs["input"], "SELECT 1;")
        facts = error_facts(result(code=1, stderr=f"Msg 16202\nPassword={SYNTHETIC_SECRET}"))
        self.assertNotIn(SYNTHETIC_SECRET, json.dumps(facts))
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("docker", 1, output=SYNTHETIC_SECRET)):
            with self.assertRaisesRegex(RunFailure, "^process_timeout$"):
                docker.run(["exec"])

    def test_artifact_paths_cannot_escape_or_use_windows_drive_names(self):
        with tempfile.TemporaryDirectory(prefix="sqlfdt-path-test-") as temporary:
            root = Path(temporary)
            for relative in ("../secret", "/secret", "C:/secret", "a\\secret", "a//b"):
                with self.subTest(relative=relative), self.assertRaises(RunFailure):
                    artifact_path(root, relative)


if __name__ == "__main__":
    unittest.main()
