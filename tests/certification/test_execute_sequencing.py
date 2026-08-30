"""Sequencing tests: the harness must run statements in an order that means something.

A live run once reported nineteen defects. None of them were defects. The cells
had executed as isolated fragments against ``master``: no run database, no run
schema, no data source for the ``OPENROWSET`` that referenced one, and staged
row counts asserted against ``CREATE EXTERNAL FILE FORMAT``, which returns no
rows at all. These tests pin the corrected behaviour with a fake connection, so
the next live run costs a credentialed execution only once.
"""

import pytest

from certification.evidence import (
    FAIL,
    NOT_EXECUTABLE,
    PASS,
    RunEvidence,
)
from certification.execute import (
    ExecutionOptions,
    _error_facts,
    execute_cell,
    run_session,
)
from certification.redaction import Redactor
from certification.safety import SafetyPolicy


class FakeQuery:
    def __init__(self, columns=(), rows=()):
        self.columns = list(columns)
        self.rows = [tuple(row) for row in rows]

    @property
    def row_count(self):
        return len(self.rows)

    @property
    def column_count(self):
        return len(self.columns)


class FakeConnection:
    """Records every statement and answers from a scripted response table.

    ``responses`` maps a case-insensitive substring to either a
    :class:`FakeQuery` or an exception instance to raise.
    """

    driver = 'fake'

    def __init__(self, responses=None, database='master'):
        self.responses = responses or {}
        self.database = database
        self.statements = []
        self.closed = False

    def execute(self, sql, params=None, *, textual=False):
        self.statements.append(sql)
        for needle, response in self.responses.items():
            if needle.lower() in sql.lower():
                if isinstance(response, Exception):
                    raise response
                return response
        return FakeQuery()

    def commit(self):
        pass

    def close(self):
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()


class FakeFactory:
    """Hands out fake connections and records which database each asked for."""

    def __init__(self, connections):
        self._connections = list(connections)
        self.databases = []
        self.attempts_log = []
        self.disposed = False

    def connect(self, database=None):
        self.databases.append(database)
        return self._connections.pop(0)

    def dispose(self):
        self.disposed = True


def _batch(sql, index=0):
    return {
        'batch_index': index,
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


def _planned(identity, cell_id, **overrides):
    table = identity.name('c14', 'csv_scalar')
    planned = {
        'cell_id': cell_id,
        'target': 'vm',
        'platform': 'sql_server_2025',
        'fixture': 'csv_scalar',
        'statement_kind': 'bulk_insert',
        'access': 'blob_storage',
        'hypothesis': 'H6',
        'intent': 'test',
        'accepts': ['PASS'],
        'notes': '',
        'sql_sha256': 'a' * 64,
        # The cell's static assertions run against this text whatever else
        # happens, so it has to look like what C14 is supposed to generate.
        'sql_redacted': "BULK INSERT ... WITH (FORMAT = 'CSV');",
        'substitutions': [],
        'plan_verdict': 'READY',
        'expectations': {},
        'requires': [],
        'verification_kind': 'none',
        'asserts_result_counts': False,
        'catalog_object': None,
        'auth_method': 'public',
        'names': {
            'schema': identity.schema,
            'table': table,
            'external_table': identity.name('c14', 'ext'),
            'external_file_format': identity.name('c14', 'fmt'),
            'external_data_source': identity.name('c14', 'src'),
            'database_scoped_credential': identity.name('c14', 'cred'),
        },
        'setup': [],
        'verification': None,
        'batches': [_batch(f'BULK INSERT [{identity.schema}].[{table}] FROM \'x\';')],
    }
    planned.update(overrides)
    return planned


# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

def test_prerequisites_run_before_the_cell(identity, policy):
    """The data source has to exist before the statement that names it."""
    setup_sql = f"CREATE EXTERNAL DATA SOURCE [{identity.name('c14', 'src')}] WITH (X);"
    planned = _planned(
        identity,
        'C14',
        setup=[{
            'requirement': 'setup',
            'statement_kind': 'credential_setup',
            'sql_sha256': 'c' * 64,
            'sql_redacted': setup_sql,
            'batches': [_batch(setup_sql)],
        }],
    )
    connection = FakeConnection()
    result = execute_cell(
        connection, planned,
        policy=policy, redactor=Redactor(), options=ExecutionOptions(),
    )
    assert result.verdict == PASS
    assert connection.statements[0] == setup_sql
    assert connection.statements[1].startswith('BULK INSERT')
    assert result.setup_steps[0]['ok'] is True


def test_failed_prerequisite_is_not_a_defect(identity, policy):
    """Error 12703 means the harness ran things out of order, not that the tool is broken."""
    setup_sql = f"CREATE EXTERNAL DATA SOURCE [{identity.name('c14', 'src')}] WITH (X);"
    planned = _planned(
        identity,
        'C14',
        setup=[{
            'requirement': 'setup',
            'statement_kind': 'credential_setup',
            'sql_sha256': 'c' * 64,
            'sql_redacted': setup_sql,
            'batches': [_batch(setup_sql)],
        }],
    )
    boom = Exception(12703, b'Resource or file group is invalid.')
    connection = FakeConnection({'CREATE EXTERNAL DATA SOURCE': boom})
    result = execute_cell(
        connection, planned,
        policy=policy, redactor=Redactor(), options=ExecutionOptions(),
    )
    assert result.verdict == NOT_EXECUTABLE
    assert result.prerequisite_failed is True
    assert result.is_defect is False
    assert result.not_certified is True
    # The cell's own statement must never have been sent.
    assert not any(s.startswith('BULK INSERT') for s in connection.statements)


# ---------------------------------------------------------------------------
# Assertion scoping
# ---------------------------------------------------------------------------

def test_ddl_is_not_failed_by_a_staged_row_count(identity, policy):
    """CREATE EXTERNAL FILE FORMAT returns no rows; that is not a failure."""
    fmt = identity.name('c16', 'fmt')
    planned = _planned(
        identity,
        'C16',
        statement_kind='external_file_format',
        sql_redacted="CREATE EXTERNAL FILE FORMAT WITH (FORMAT_OPTIONS (FIRST_ROW = 2));",
        expectations={'row_count': 150, 'column_count': 5},
        asserts_result_counts=False,
        catalog_object='external file format',
        batches=[_batch(f'CREATE EXTERNAL FILE FORMAT [{fmt}] WITH (FORMAT_TYPE = DELIMITEDTEXT);')],
    )
    connection = FakeConnection({
        'sys.external_file_formats': FakeQuery(['n'], [(1,)]),
    })
    result = execute_cell(
        connection, planned,
        policy=policy, redactor=Redactor(), options=ExecutionOptions(),
    )
    kinds = [a.kind for a in result.assertions]
    assert 'row_count' not in kinds
    assert 'catalog_present' in kinds
    assert result.verdict == PASS


def test_ddl_that_leaves_no_catalog_object_fails(identity, policy):
    fmt = identity.name('c16', 'fmt')
    planned = _planned(
        identity,
        'C16',
        statement_kind='external_file_format',
        sql_redacted="CREATE EXTERNAL FILE FORMAT WITH (FORMAT_OPTIONS (FIRST_ROW = 2));",
        catalog_object='external file format',
        batches=[_batch(f'CREATE EXTERNAL FILE FORMAT [{fmt}] WITH (FORMAT_TYPE = DELIMITEDTEXT);')],
    )
    connection = FakeConnection({
        'sys.external_file_formats': FakeQuery(['n'], [(0,)]),
    })
    result = execute_cell(
        connection, planned,
        policy=policy, redactor=Redactor(), options=ExecutionOptions(),
    )
    assert result.verdict == FAIL


def test_load_cell_asserts_counts_against_the_verification_query(identity, policy):
    """The row count belongs to the SELECT that reads what was loaded."""
    table = identity.name('c14', 'csv_scalar')
    verify_sql = f'SELECT * FROM [{identity.schema}].[{table}];'
    planned = _planned(
        identity,
        'C14',
        expectations={'row_count': 3, 'column_count': 2},
        asserts_result_counts=True,
        verification_kind='target_table',
        verification={
            'kind': 'target_table',
            'sql_sha256': 'd' * 64,
            'sql_redacted': verify_sql,
            'batches': [_batch(verify_sql)],
        },
    )
    connection = FakeConnection({
        'SELECT * FROM': FakeQuery(['a', 'b'], [(1, 2), (3, 4), (5, 6)]),
    })
    result = execute_cell(
        connection, planned,
        policy=policy, redactor=Redactor(), options=ExecutionOptions(),
    )
    assert result.verdict == PASS
    assert all(a.ok for a in result.assertions)


# ---------------------------------------------------------------------------
# Error text
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('args', [
    (4860, b"Cannot bulk load. The file \"C:\\x\" does not exist."),
    (b'42000', b'Incorrect syntax near JSON.'),
    (b'a single bytes argument',),
])
def test_error_text_never_carries_a_python_bytes_repr(args):
    facts = _error_facts(Exception(*args))
    rendered = repr(facts)
    assert "b'" not in rendered
    assert 'b"' not in rendered
    assert isinstance(facts['error_message'], str)


def test_error_number_and_decoded_message_survive():
    facts = _error_facts(Exception(4860, 'Cannot bulk load.'.encode('utf-8')))
    assert facts['error_number'] == 4860
    assert facts['error_message'] == 'Cannot bulk load.'


def test_undecodable_error_bytes_do_not_raise():
    facts = _error_facts(Exception(1105, b'\xff\xfe bad bytes'))
    assert isinstance(facts['error_message'], str)
    assert "b'" not in facts['error_message']


# ---------------------------------------------------------------------------
# Database and schema lifecycle
# ---------------------------------------------------------------------------

def test_vm_run_creates_database_switches_into_it_and_drops_it(identity, policy):
    admin = FakeConnection(database='master')
    work = FakeConnection(database=identity.database)
    factory = FakeFactory([admin, work, admin])
    manifest = {
        'target': 'vm',
        'platform': 'sql_server_2025',
        'allow_create_database': True,
        'cells': [],
    }
    evidence = RunEvidence(run_id=identity.run_id, target='vm', platform='sql_server_2025')
    run_session(
        factory, manifest, identity,
        policy=policy, redactor=Redactor(),
        options=ExecutionOptions(), evidence=evidence,
    )
    # master first, then the run database, then master again for the drop.
    assert factory.databases[0] == 'master'
    assert factory.databases[1] == identity.database
    assert any('CREATE DATABASE' in s for s in admin.statements)
    assert any('DROP DATABASE' in s for s in admin.statements)
    # The schema is created inside the run database, never in master.
    assert any('CREATE SCHEMA' in s for s in work.statements)
    assert not any('CREATE SCHEMA' in s for s in admin.statements)
    assert evidence.lifecycle['created_database'] is True
    assert evidence.lifecycle['dropped_database'] is True


def test_azure_run_uses_the_database_it_was_given(identity, policy):
    """Azure SQL Database cannot create a database on the fly; the schema confines the run."""
    work = FakeConnection(database='given')
    factory = FakeFactory([work])
    manifest = {
        'target': 'azure',
        'platform': 'azure_sql_db',
        'allow_create_database': False,
        'cells': [],
    }
    evidence = RunEvidence(run_id=identity.run_id, target='azure', platform='azure_sql_db')
    run_session(
        factory, manifest, identity,
        policy=policy, redactor=Redactor(),
        options=ExecutionOptions(), evidence=evidence,
    )
    assert factory.databases == [None]
    assert not any('CREATE DATABASE' in s for s in work.statements)
    assert any('CREATE SCHEMA' in s for s in work.statements)


def test_a_database_that_will_not_drop_is_reported_as_residue(identity, policy):
    admin = FakeConnection(database='master')
    # DB_ID still answers with an id, so the database is still there.
    admin.responses = {"SELECT DB_ID(": FakeQuery(['id'], [(7,)])}
    work = FakeConnection(database=identity.database)
    factory = FakeFactory([admin, work, admin])
    manifest = {
        'target': 'vm', 'platform': 'sql_server_2025',
        'allow_create_database': True, 'cells': [],
    }
    evidence = RunEvidence(run_id=identity.run_id, target='vm', platform='sql_server_2025')
    run_session(
        factory, manifest, identity,
        policy=policy, redactor=Redactor(),
        options=ExecutionOptions(), evidence=evidence,
    )
    assert evidence.cleanup_verified is False
    assert f'database:{identity.database}' in evidence.residue


def test_schema_failure_stops_the_run_before_any_cell(identity, policy):
    work = FakeConnection()
    work.responses = {'CREATE SCHEMA': Exception(2760, b'The specified schema name is invalid.')}
    factory = FakeFactory([work])
    manifest = {
        'target': 'azure', 'platform': 'azure_sql_db',
        'allow_create_database': False,
        'cells': [_planned(identity, 'C14')],
    }
    evidence = RunEvidence(run_id=identity.run_id, target='azure', platform='azure_sql_db')
    run_session(
        factory, manifest, identity,
        policy=policy, redactor=Redactor(),
        options=ExecutionOptions(), evidence=evidence,
    )
    assert evidence.cells == []
    assert evidence.lifecycle['schema_created'] is False
    assert "b'" not in evidence.lifecycle['schema_error']
