"""A dry run must be provably offline.

The harness is handed to someone who has credentials in their environment. If
``--dry-run`` can read an endpoint, take a password or open a socket, then a
"safe preview" is not safe at all. These tests sabotage every path that could
reach the network and prove the dry run still completes.
"""

import json
import os
import subprocess
import sys

import pytest

from certification.evidence import (
    DRY_RUN_ACCEPTED,
    NOT_EXECUTABLE,
    RunEvidence,
)
from certification.execute import ExecutionOptions, execute_cell
from certification.matrix import HARNESS_ONLY_VERDICTS
from certification.redaction import Redactor
from certification.safety import SafetyPolicy

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPTS = os.path.join(REPO_ROOT, 'scripts')

#: Every environment variable the credentialed path would read.
CREDENTIAL_ENV = (
    'SQLFDT_CERT_HOST',
    'SQLFDT_CERT_DATABASE',
    'SQLFDT_CERT_USER',
    'SQLFDT_CERT_PASSWORD',
    'SQLFDT_CERT_PORT',
)


def _planned(cell_id, identity, *, verdict='READY', sql=None):
    sql = sql or (
        f'CREATE TABLE [{identity.schema}].[{identity.name("c01", "csv")}] (id INT);'
    )
    return {
        'cell_id': cell_id,
        'target': 'azure',
        'platform': 'azure_sql_db',
        'fixture': 'csv_scalar',
        'statement_kind': 'create_table',
        'access': 'none',
        'hypothesis': 'H1',
        'intent': 'test',
        'accepts': ['PASS'],
        'notes': '',
        'sql_sha256': 'a' * 64,
        'sql_redacted': sql,
        'substitutions': [],
        'plan_verdict': verdict,
        'reason': '' if verdict == 'READY' else 'staged nothing',
        'batches': [
            {
                'batch_index': 0,
                'start_line': 1,
                'repeat': 1,
                'sql': sql,
                'sql_redacted': sql,
                'sql_sha256': 'b' * 64,
                'safety': {
                    'allowed': True,
                    'requires_substitution': False,
                    'violations': [],
                    'placeholders': [],
                    'targets': [],
                },
            }
        ],
    }


def test_ready_cell_reports_dry_run_accepted_not_not_executable(identity, policy):
    # NOT_EXECUTABLE means "the generator cannot produce runnable SQL here".
    # Saying that about SQL we simply chose not to send would hide real defects
    # behind an offline run.
    result = execute_cell(
        None,
        _planned('C01', identity),
        policy=policy,
        redactor=Redactor(),
        options=ExecutionOptions(dry_run=True),
    )
    assert result.verdict == DRY_RUN_ACCEPTED
    assert [b.verdict for b in result.batches] == [DRY_RUN_ACCEPTED]
    assert 'not sent' in result.notes


def test_genuinely_unrunnable_cell_stays_not_executable(identity, policy):
    result = execute_cell(
        None,
        _planned('C02', identity, verdict=NOT_EXECUTABLE),
        policy=policy,
        redactor=Redactor(),
        options=ExecutionOptions(dry_run=True),
    )
    assert result.verdict == NOT_EXECUTABLE


def test_dry_run_verdict_is_never_accepted_and_never_a_defect(identity, policy):
    result = execute_cell(
        None,
        _planned('C01', identity),
        policy=policy,
        redactor=Redactor(),
        options=ExecutionOptions(dry_run=True),
    )
    assert result.verdict in HARNESS_ONLY_VERDICTS
    assert result.accepted is False
    assert result.is_defect is False

    evidence = RunEvidence(run_id=identity.run_id, target='azure', platform='azure_sql_db')
    evidence.cells.append(result)
    summary = evidence.summary()
    assert summary['DEFECTS'] == 0
    assert summary[DRY_RUN_ACCEPTED] == 1


def test_execute_cell_never_touches_the_adapter_module(identity, policy, monkeypatch):
    import certification.adapters as adapters

    def explode(*args, **kwargs):  # pragma: no cover - must never run
        raise AssertionError('the dry run tried to reach the network')

    monkeypatch.setattr(adapters, 'connect', explode)
    monkeypatch.setattr(adapters, 'take_password', explode)
    monkeypatch.setattr(adapters.ConnectionSettings, 'from_env', staticmethod(explode))
    for name in CREDENTIAL_ENV:
        monkeypatch.delenv(name, raising=False)

    result = execute_cell(
        None,
        _planned('C01', identity),
        policy=policy,
        redactor=Redactor(),
        options=ExecutionOptions(dry_run=True),
    )
    assert result.verdict == DRY_RUN_ACCEPTED


@pytest.mark.parametrize('missing', CREDENTIAL_ENV)
def test_cli_dry_run_completes_with_no_credential_environment(missing, tmp_path):
    """End to end: plan then dry-run in a subprocess with a scrubbed env.

    Doing this out of process is the only way to prove the *import* of an
    adapter never happens, since an in-process test has already imported it.
    """
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in CREDENTIAL_ENV
    }
    env['PYTHONPATH'] = SCRIPTS
    env['SQLFDT_CERT_SABOTAGE'] = '1'
    manifest = tmp_path / 'plan.json'

    plan = subprocess.run(
        [sys.executable, '-m', 'certification', 'plan', '--target', 'azure',
         '--emit-sql', '--out', str(manifest)],
        cwd=REPO_ROOT, env=env, capture_output=True, text=True,
    )
    assert plan.returncode == 0, plan.stderr

    run = subprocess.run(
        [sys.executable, '-m', 'certification', 'execute', '--manifest', str(manifest),
         '--dry-run', '--out-prefix', str(tmp_path / 'evidence')],
        cwd=REPO_ROOT, env=env, capture_output=True, text=True,
    )
    assert run.returncode == 0, run.stderr

    summary = json.loads(run.stdout[run.stdout.index('{'):])
    assert summary[DRY_RUN_ACCEPTED] >= 1
    assert summary['PASS'] == 0
    assert summary['FAIL'] == 0

    for suffix in ('.json', '.junit.xml', '.md'):
        assert (tmp_path / f'evidence{suffix}').exists()


def test_dry_run_does_not_require_confirm(tmp_path):
    # --confirm guards connecting. Demanding it for an offline run would only
    # teach people to type it reflexively before the run that does connect.
    env = dict(os.environ)
    env['PYTHONPATH'] = SCRIPTS
    manifest = tmp_path / 'plan.json'
    subprocess.run(
        [sys.executable, '-m', 'certification', 'plan', '--target', 'vm',
         '--emit-sql', '--out', str(manifest)],
        cwd=REPO_ROOT, env=env, capture_output=True, text=True, check=True,
    )
    run = subprocess.run(
        [sys.executable, '-m', 'certification', 'execute', '--manifest', str(manifest),
         '--dry-run', '--out-prefix', str(tmp_path / 'e')],
        cwd=REPO_ROOT, env=env, capture_output=True, text=True,
    )
    assert run.returncode == 0, run.stderr


def test_live_execute_still_refuses_without_confirm(tmp_path):
    env = dict(os.environ)
    env['PYTHONPATH'] = SCRIPTS
    manifest = tmp_path / 'plan.json'
    subprocess.run(
        [sys.executable, '-m', 'certification', 'plan', '--target', 'azure',
         '--out', str(manifest)],
        cwd=REPO_ROOT, env=env, capture_output=True, text=True, check=True,
    )
    run = subprocess.run(
        [sys.executable, '-m', 'certification', 'execute', '--manifest', str(manifest)],
        cwd=REPO_ROOT, env=env, capture_output=True, text=True,
    )
    assert run.returncode == 2
    assert '--confirm' in run.stderr


def test_verify_re_gates_prerequisite_and_verification_batches(tmp_path):
    """`verify` is the human review gate, so it must look at every batch sent.

    Prerequisite SQL is the part that creates credentials and data sources. A
    manifest whose setup batch had been edited used to pass `verify: OK`
    because only the cell's own batches were re-evaluated.
    """
    env = dict(os.environ)
    env['PYTHONPATH'] = SCRIPTS
    manifest = tmp_path / 'plan.json'
    subprocess.run(
        [sys.executable, '-m', 'certification', 'plan', '--target', 'azure',
         '--emit-sql', '--out', str(manifest)],
        cwd=REPO_ROOT, env=env, capture_output=True, text=True, check=True,
    )
    clean = subprocess.run(
        [sys.executable, '-m', 'certification', 'verify', '--manifest', str(manifest)],
        cwd=REPO_ROOT, env=env, capture_output=True, text=True,
    )
    assert clean.returncode == 0, clean.stdout + clean.stderr

    document = json.loads(manifest.read_text(encoding='utf-8'))
    tampered = None
    for cell in document['cells']:
        for step in cell.get('setup') or []:
            for batch in step.get('batches') or []:
                if batch.get('sql'):
                    batch['sql'] = 'DROP TABLE [dbo].[orders];'
                    tampered = cell['cell_id']
                    break
            if tampered:
                break
        if tampered:
            break
    assert tampered, 'the plan has no prerequisite batch to tamper with'
    manifest.write_text(json.dumps(document), encoding='utf-8')

    caught = subprocess.run(
        [sys.executable, '-m', 'certification', 'verify', '--manifest', str(manifest)],
        cwd=REPO_ROOT, env=env, capture_output=True, text=True,
    )
    assert caught.returncode == 1
    assert 'setup[' in caught.stdout
    assert tampered in caught.stdout


def test_evidence_documents_are_free_of_secrets(identity, policy, tmp_path):
    from certification.evidence import write_json, write_junit, write_markdown
    from certification.redaction import assert_no_secrets

    redactor = Redactor()
    evidence = RunEvidence(run_id=identity.run_id, target='azure', platform='azure_sql_db')
    evidence.cells.append(
        execute_cell(
            None,
            _planned('C01', identity),
            policy=policy,
            redactor=redactor,
            options=ExecutionOptions(dry_run=True),
        )
    )
    paths = {
        'json': str(tmp_path / 'e.json'),
        'junit': str(tmp_path / 'e.xml'),
        'md': str(tmp_path / 'e.md'),
    }
    write_json(evidence, paths['json'], redactor)
    write_junit(evidence, paths['junit'], redactor)
    write_markdown(evidence, paths['md'], redactor)
    for kind, path in paths.items():
        with open(path, 'r', encoding='utf-8') as fh:
            assert_no_secrets(fh.read(), context=kind)
