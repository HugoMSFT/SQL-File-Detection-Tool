"""Driver values must never be able to destroy a completed run's evidence.

A live VM execution finished its statements, reached report writing, and lost
everything to ``TypeError: Object of type bytes is not JSON serializable``.
That is the worst possible time to fail: the credentialed connection is the
scarce resource, and by then it is gone. ``Decimal`` and ``datetime`` would
have done exactly the same thing one fixture later.

So the rule is that normalisation happens where values enter the harness, is
total, and is deterministic - and that the three renderers are proved against
values no serialiser accepts.
"""

import datetime
import decimal
import json
import uuid
import xml.etree.ElementTree as ET

import pytest

from certification.adapters import Connection
from certification.evidence import (
    AssertionResult,
    BatchResult,
    CellResult,
    RunEvidence,
    write_json,
    write_junit,
    write_markdown,
)
from certification.redaction import (
    MAX_BINARY_PREFIX,
    Redactor,
    normalize_value,
)


# -- normalisation ----------------------------------------------------------

def test_bytes_become_a_sql_style_hex_literal():
    assert normalize_value(b'\xde\xad\xbe\xef') == '0xDEADBEEF'


def test_bytes_are_never_guessed_to_be_text():
    # 0x41424344 decodes cleanly as 'ABCD'. Sniffing would turn a VARBINARY
    # fixture into a string and quietly pass an assertion that should fail.
    assert normalize_value(b'ABCD') == '0x41424344'


def test_long_binary_is_bounded_and_carries_its_true_length():
    raw = bytes(range(256)) * 4
    rendered = normalize_value(raw)

    assert rendered.startswith('0x')
    assert f'{len(raw)} bytes' in rendered
    assert 'sha256' in rendered
    assert len(rendered) < 200
    assert raw.hex().upper() not in rendered


def test_binary_rendering_is_deterministic():
    raw = bytes(range(200))
    assert normalize_value(raw) == normalize_value(bytes(raw))


def test_exactly_the_prefix_length_is_still_rendered_whole():
    raw = bytes(range(MAX_BINARY_PREFIX))
    assert normalize_value(raw) == '0x' + raw.hex().upper()


def test_known_text_columns_decode_with_replacement():
    assert normalize_value('æ—¥æœ¬èªž'.encode('utf-8'), textual=True) == 'æ—¥æœ¬èªž'
    assert normalize_value(b'ok\xff', textual=True) == 'ok\ufffd'


def test_bytearray_and_memoryview_are_handled_like_bytes():
    assert normalize_value(bytearray(b'\x01\x02')) == '0x0102'
    assert normalize_value(memoryview(b'\x01\x02')) == '0x0102'


def test_decimal_keeps_full_precision_as_text():
    # The matrix asserts the uint64 boundary, which no float can hold.
    boundary = decimal.Decimal('18446744073709551615')
    assert normalize_value(boundary) == '18446744073709551615'
    assert normalize_value(decimal.Decimal('1.0500')) == '1.0500'


def test_dates_times_and_uuids_become_canonical_text():
    moment = datetime.datetime(2026, 8, 30, 12, 34, 56, tzinfo=datetime.timezone.utc)
    assert normalize_value(moment) == '2026-08-30T12:34:56+00:00'
    assert normalize_value(datetime.date(2026, 8, 30)) == '2026-08-30'
    assert normalize_value(datetime.time(1, 2, 3)) == '01:02:03'
    assert normalize_value(datetime.timedelta(hours=9)) == '9:00:00'
    value = uuid.UUID('12345678-1234-5678-1234-567812345678')
    assert normalize_value(value) == '12345678-1234-5678-1234-567812345678'


def test_json_scalars_pass_through_untouched():
    for value in (None, True, False, 0, -17, 'text', 1.5):
        assert normalize_value(value) == value


def test_non_finite_floats_become_text_because_they_are_not_json():
    assert normalize_value(float('nan')) == 'nan'
    assert normalize_value(float('inf')) == 'inf'


def test_an_unknown_object_is_bounded_rather_than_dumped_whole():
    class _Big:
        def __str__(self):
            return 'x' * 5000

    rendered = normalize_value(_Big())

    assert len(rendered) < 600
    assert '5000 characters' in rendered


def test_containers_are_normalised_through():
    result = normalize_value({'k': [b'\x01', decimal.Decimal('2')]})
    assert result == {'k': ['0x01', '2']}


# -- the adapter boundary ----------------------------------------------------

class _FakeCursor:
    description = (('binary', None), ('amount', None), ('when', None))

    def __init__(self, rows):
        self._rows = rows
        self.closed = False

    def execute(self, sql, params=None):
        return None

    def fetchall(self):
        return self._rows

    def close(self):
        self.closed = True


class _FakeRaw:
    def __init__(self, rows):
        self._rows = rows

    def cursor(self):
        return _FakeCursor(self._rows)


def test_the_adapter_normalises_every_cell_before_anything_sees_it():
    raw = _FakeRaw([(b'\xde\xad', decimal.Decimal('1.25'),
                     datetime.date(2026, 1, 2))])

    result = Connection(raw, 'fake').execute('SELECT 1;')

    assert result.rows == [('0xDEAD', '1.25', '2026-01-02')]
    json.dumps(result.rows)


def test_the_adapter_can_be_told_a_query_returns_engine_text():
    raw = _FakeRaw([('Microsoft SQL Server 2025'.encode('utf-8'),)])

    result = Connection(raw, 'fake').execute('SELECT @@VERSION;', textual=True)

    assert result.rows == [('Microsoft SQL Server 2025',)]


# -- redaction ---------------------------------------------------------------

def test_redaction_normalises_leaves_it_cannot_otherwise_reach():
    redactor = Redactor(extra_literals=('demo-secretname',))

    payload = redactor.redact_obj({
        'binary': b'\x01\x02',
        'amount': decimal.Decimal('3.5'),
        'host': 'demo-secretname',
        'nested': [b'\xff'],
    })

    assert payload['binary'] == '0x0102'
    assert payload['amount'] == '3.5'
    assert payload['nested'] == ['0xFF']
    assert 'demo-secretname' not in json.dumps(payload)


def test_a_secret_reaching_the_redactor_as_a_driver_object_is_still_scrubbed():
    # This is why normalisation runs *before* redaction rather than after:
    # redaction only rewrites strings, so a value that is not yet a string
    # would sail straight past it.
    class _DriverValue:
        def __str__(self):
            return 'login failed for demo-secretname'

    redactor = Redactor(extra_literals=('demo-secretname',))

    payload = redactor.redact_obj({'v': _DriverValue()})

    assert 'demo-secretname' not in json.dumps(payload)
    assert 'login failed for' in payload['v']


def test_bytes_cannot_carry_readable_text_into_an_artifact():
    redactor = Redactor()

    payload = redactor.redact_obj({'v': 'demo-secretname'.encode('utf-8')})

    assert 'demo-secretname' not in json.dumps(payload)
    assert payload['v'].startswith('0x')


# -- the renderers -----------------------------------------------------------

def _evidence_with_hostile_values():
    cell = CellResult(
        cell_id='C01',
        target='vm',
        platform='sql_server_2025',
        fixture='parquet_all_types',
        statement_kind='create_table',
        access='vm_local',
        hypothesis='H1',
        intent='binary round trip',
        verdict='FAIL',
        accepts=('PASS',),
        sql_sha256='a' * 64,
        sql_redacted='SELECT 1;',
    )
    cell.assertions = [
        AssertionResult('value_equals', b'\xde\xad', b'\xbe\xef', False, 'binary'),
        AssertionResult('value_equals', decimal.Decimal('1'),
                        datetime.date(2026, 1, 2), False, 'mixed'),
    ]
    cell.batches = [
        BatchResult(index=0, start_line=1, verdict='FAIL', error_number=4806,
                    error_message='SINGLE_CLOB requires a DBCS file')
    ]
    evidence = RunEvidence(run_id='0123abcd', target='vm', platform='sql_server_2025')
    evidence.engine = {
        # `version` arrives as text because `probe_engine` marks the engine
        # probes textual; `collation` stands in for a value that does not.
        'version': 'Microsoft SQL Server 2025',
        'master_key_count': decimal.Decimal('0'),
        'collation': b'\xff\xfe',
    }
    evidence.inventory_before = {'schema': [b'sqlfdt_cert_0123abcd']}
    evidence.cells = [cell]
    return evidence


@pytest.mark.parametrize('writer,name', [
    (write_json, 'evidence.json'),
    (write_junit, 'evidence.xml'),
    (write_markdown, 'evidence.md'),
])
def test_no_renderer_crashes_on_values_a_driver_really_returns(writer, name, tmp_path):
    path = tmp_path / name
    writer(_evidence_with_hostile_values(), str(path), Redactor())
    assert path.read_text(encoding='utf-8').strip()


def test_the_json_document_is_valid_json_and_carries_the_binary_as_hex(tmp_path):
    path = tmp_path / 'evidence.json'
    write_json(_evidence_with_hostile_values(), str(path), Redactor())

    payload = json.loads(path.read_text(encoding='utf-8'))

    assert payload['engine']['version'] == 'Microsoft SQL Server 2025'
    assert payload['engine']['master_key_count'] == '0'
    assert payload['engine']['collation'] == '0xFFFE'
    assert payload['cells'][0]['assertions'][0]['expected'] == '0xDEAD'


def test_the_junit_document_parses_and_leaks_no_python_byte_repr(tmp_path):
    path = tmp_path / 'evidence.xml'
    write_junit(_evidence_with_hostile_values(), str(path), Redactor())

    ET.parse(str(path))
    text = path.read_text(encoding='utf-8')
    assert "b'" not in text
    assert '0xDEAD' in text


def test_the_markdown_document_leaks_no_python_byte_repr(tmp_path):
    path = tmp_path / 'evidence.md'
    write_markdown(_evidence_with_hostile_values(), str(path), Redactor())

    text = path.read_text(encoding='utf-8')
    assert "b'" not in text
    assert 'Microsoft SQL Server 2025' in text
    assert '0xDEAD' in text


def test_a_binary_secret_never_reaches_an_artifact_whole(tmp_path):
    secret = bytes(range(256))
    evidence = _evidence_with_hostile_values()
    evidence.engine['probe'] = secret

    path = tmp_path / 'evidence.json'
    write_json(evidence, str(path), Redactor())

    text = path.read_text(encoding='utf-8')
    assert secret.hex().upper() not in text
    assert '256 bytes' in text


# -- driver errors, which arrive as (int, bytes) -----------------------------

class _PymssqlShapedError(Exception):
    """What pymssql actually raises: the number first, the message as bytes."""


def _pymssql_error(number, message):
    return _PymssqlShapedError(number, message.encode('utf-8'))


def test_a_bytes_error_message_is_decoded_not_repr_ed():
    from certification.execute import _error_facts

    facts = _error_facts(_pymssql_error(
        4806, 'SINGLE_CLOB requires a DBCS char data file. Try SINGLE_NCLOB.',
    ))

    assert facts['error_number'] == 4806
    assert facts['error_message'].startswith('SINGLE_CLOB requires')
    assert "b'" not in facts['error_message']


def test_a_bytes_message_survives_non_ascii():
    from certification.execute import _error_facts

    facts = _error_facts(_pymssql_error(547, "è¿‘æŽ¥ 'æ—¥æœ¬èªž' ã®æ§‹æ–‡ãŒæ­£ã—ãã‚ã‚Šã¾ã›ã‚“ã€‚"))

    assert 'æ—¥æœ¬èªž' in facts['error_message']
    assert "b'" not in facts['error_message']


def test_undecodable_bytes_do_not_raise_or_leak_a_repr():
    from certification.execute import _error_facts

    facts = _error_facts(_PymssqlShapedError(50000, b'\xff\xfe not utf-8 \xc3\x28'))

    assert "b'" not in facts['error_message']
    assert 'not utf-8' in facts['error_message']


def test_a_single_bytes_argument_is_decoded_too():
    from certification.execute import _error_facts

    facts = _error_facts(_PymssqlShapedError(b'Adaptive Server connection failed'))

    assert facts['error_message'] == 'Adaptive Server connection failed'
    assert "b'" not in facts['error_message']


def test_a_pyodbc_shaped_error_still_yields_its_number():
    from certification.execute import _error_facts

    facts = _error_facts(_PymssqlShapedError(
        '42000', '[42000] [Microsoft][ODBC Driver 18](4806) SINGLE_CLOB requires DBCS.',
    ))

    assert facts['error_number'] == 4806
    assert facts['sqlstate'] == '42000'


def test_no_renderer_prints_a_python_bytes_repr(tmp_path):
    """The end of the path, not just the start.

    A live run's markdown carried `b'...'` on line 66. Decoding in one place is
    only worth something if every artifact is checked, so this drives a bytes
    message through JSON, JUnit and Markdown together.
    """
    from certification.execute import _error_facts

    facts = _error_facts(_pymssql_error(
        4861, "Cannot bulk load because the file 'ERRORLOG' could not be opened.",
    ))
    cell = CellResult(
        cell_id='C01',
        target='vm',
        platform='sql_server_2025',
        fixture='csv_scalar',
        statement_kind='bulk_insert',
        access='engine_local',
        hypothesis='H6',
        intent='locked file',
        verdict='FAIL',
        accepts=('PASS',),
        sql_sha256='a' * 64,
        sql_redacted='BULK INSERT [s].[t] FROM \'x\';',
    )
    cell.batches = [BatchResult(
        index=0, start_line=1, verdict='FAIL',
        error_number=facts['error_number'],
        error_message=facts['error_message'],
    )]
    evidence = RunEvidence(run_id='0123abcd', target='vm', platform='sql_server_2025')
    evidence.cells = [cell]
    redactor = Redactor()

    written = [str(tmp_path / name) for name in ('e.json', 'e.xml', 'e.md')]
    write_json(evidence, written[0], redactor=redactor)
    write_junit(evidence, written[1], redactor=redactor)
    write_markdown(evidence, written[2], redactor=redactor)
    for path in written:
        text = open(path, encoding='utf-8').read()
        assert "b'" not in text, f'{path} carries a Python bytes repr'
        assert 'could not be opened' in text, f'{path} lost the message'


# -- the nested pymssql shape ------------------------------------------------

_FAILOVER = (
    b"Database 'contoso_warehouse' on server 'sqldemo-server' is not currently available. "
    b'Please retry the connection later. DB-Lib error message 20002'
)


def test_a_nested_number_and_bytes_pair_is_read_not_repr_ed():
    """``args == ((40613, b'...'),)`` - one argument holding the pair.

    Reading only the top level found neither the number nor the text, so the
    number went unrecorded and the message reached the artifacts as a repr.
    """
    from certification.execute import _error_facts

    facts = _error_facts(_PymssqlShapedError((40613, _FAILOVER)))

    assert facts['error_number'] == 40613
    assert facts['error_message'].startswith('Database')
    assert "b'" not in facts['error_message']
    assert '(40613' not in facts['error_message']


def test_the_nested_and_flat_shapes_produce_the_same_facts():
    from certification.execute import _error_facts

    nested = _error_facts(_PymssqlShapedError((40613, _FAILOVER)))
    flat = _error_facts(_PymssqlShapedError(40613, _FAILOVER))

    assert nested['error_number'] == flat['error_number']
    assert nested['error_message'] == flat['error_message']


def test_a_nested_error_is_redacted_in_every_artifact(tmp_path):
    from certification.execute import _error_facts

    facts = _error_facts(_PymssqlShapedError((40613, _FAILOVER)))
    cell = CellResult(
        cell_id='C01',
        target='azure',
        platform='azure_sql_db',
        fixture='csv_scalar',
        statement_kind='create_table',
        access='abs',
        hypothesis='H9',
        intent='gateway failover',
        verdict='BLOCKED',
        accepts=('PASS',),
        sql_sha256='a' * 64,
        sql_redacted='SELECT 1;',
    )
    cell.batches = [BatchResult(
        index=0, start_line=1, verdict='BLOCKED',
        error_number=facts['error_number'],
        error_message=facts['error_message'],
    )]
    evidence = RunEvidence(run_id='0123abcd', target='azure', platform='azure_sql_db')
    evidence.cells = [cell]
    redactor = Redactor(extra_literals=('sqldemo-server', 'contoso_warehouse'))

    paths = [str(tmp_path / name) for name in ('n.json', 'n.xml', 'n.md')]
    write_json(evidence, paths[0], redactor=redactor)
    write_junit(evidence, paths[1], redactor=redactor)
    write_markdown(evidence, paths[2], redactor=redactor)

    for path in paths:
        text = open(path, encoding='utf-8').read()
        assert "b'" not in text, path
        assert 'sqldemo-server' not in text, path
        assert 'contoso_warehouse' not in text, path
        assert 'not currently available' in text, path


# ---------------------------------------------------------------------------
# An assertion that was never judged is not a pass
# ---------------------------------------------------------------------------
#
# Every `sql_excludes` check is trivially true against an empty string, so a
# cell whose generator produced nothing came back with a full set of green
# assertions and counted as accepted. That is the most misleading result the
# harness can produce: it looks like proof and is the absence of one. Three
# cells were accepted this way.

from certification.evidence import (  # noqa: E402
    NOT_EXECUTABLE,
    Assertion,
    check_static_assertions,
)


def assertion(kind, value):
    return Assertion(kind=kind, value=value, detail=f'{kind} {value}')


def cell(assertions, verdict=NOT_EXECUTABLE, accepts=(NOT_EXECUTABLE,)):
    return CellResult(
        cell_id='C99', target='vm', platform='sqlserver', fixture='csv_scalar',
        statement_kind='create_table', access='none', hypothesis='H0',
        intent='pin the semantics', accepts=list(accepts), verdict=verdict,
        assertions=list(assertions),
    )


def test_nothing_generated_is_not_evaluated():
    results = check_static_assertions('', [assertion('sql_excludes', 'DELIMITEDTEXT')])

    assert results[0].evaluated is False
    assert results[0].ok is False
    assert 'not evaluated' in results[0].detail


def test_a_cell_with_an_unevaluated_assertion_is_not_accepted():
    results = check_static_assertions('', [assertion('sql_excludes', 'DELIMITEDTEXT')])
    subject = cell(results)

    assert subject.accepted is False
    assert subject.unevaluated_assertions == results


def test_a_failed_assertion_disqualifies_an_otherwise_acceptable_verdict():
    # The verdict says "the engine could not run this", which is on the accepts
    # list. That is no reason to stop checking that the generator wrote the
    # right thing, and a cell that wrote the wrong thing is not certified.
    results = check_static_assertions('SELECT 1;', [assertion('sql_contains', 'OPENJSON')])
    subject = cell(results)

    assert results[0].ok is False
    assert subject.accepted is False


def test_a_keyword_in_a_comment_does_not_certify_sql():
    results = check_static_assertions(
        '-- use OPENJSON for this\nSELECT 1;', [assertion('sql_contains', 'OPENJSON')]
    )
    assert results[0].ok is False


def test_guidance_only_output_is_certified_as_guidance():
    # Some formats have no external file format on either engine. The generator
    # is supposed to say so and point elsewhere, so the comment block *is* the
    # deliverable - but the evidence has to admit that is what was checked.
    guidance = (
        '-- CREATE EXTERNAL FILE FORMAT (JSON) - NOT AVAILABLE on this engine.\n'
        '-- Use OPENROWSET with OPENJSON instead.\n'
    )
    results = check_static_assertions(guidance, [assertion('sql_contains', 'OPENJSON')])

    assert results[0].ok is True
    assert results[0].evaluated is True
    assert 'guidance comments' in results[0].detail
    assert cell(results).accepted is True


def test_an_unevaluated_assertion_survives_serialisation():
    results = check_static_assertions('', [assertion('sql_contains', 'CODEPAGE')])
    assert results[0].as_dict()['evaluated'] is False


# ---------------------------------------------------------------------------
# Cleanup outcomes belong in the evidence
# ---------------------------------------------------------------------------
#
# "cleanup_verified: true" with a residue count is a summary of an inventory
# query. It does not say which DROP ran, so a statement the safety gate refused
# looked identical to one that succeeded - which is how two credentials
# survived a run that reported itself clean.

def evidence_with_cleanup(statements):
    return RunEvidence(
        run_id='0123abcd', target='vm', platform='sqlserver',
        started_at='2024-01-01T00:00:00Z', finished_at='2024-01-01T00:01:00Z',
        cleanup_statements=list(statements),
    )


def test_a_refused_cleanup_statement_is_named_in_the_markdown(tmp_path):
    evidence = evidence_with_cleanup([
        {'statement': 'DROP EXTERNAL DATA SOURCE [cert_src];', 'ok': True},
        {'statement': 'DROP DATABASE SCOPED CREDENTIAL [cert_cred];', 'ok': False,
         'violations': ['DROP_DATABASE'], 'error': ''},
    ])
    path = tmp_path / 'evidence.md'
    write_markdown(evidence, path, Redactor())
    text = path.read_text(encoding='utf-8')

    assert '## Cleanup' in text
    assert 'DROP DATABASE SCOPED CREDENTIAL [cert_cred];' in text
    assert 'DROP_DATABASE' in text


def test_cleanup_statements_reach_the_json(tmp_path):
    evidence = evidence_with_cleanup([
        {'statement': 'DROP SCHEMA [cert_schema];', 'ok': True},
    ])
    path = tmp_path / 'evidence.json'
    write_json(evidence, path, Redactor())
    payload = json.loads(path.read_text(encoding='utf-8'))

    assert payload['cleanup_statements'][0]['ok'] is True
    assert payload['cleanup_statements'][0]['statement'] == 'DROP SCHEMA [cert_schema];'

