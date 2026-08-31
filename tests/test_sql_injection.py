"""Regression tests for SQL-injection / escaping safety in generated DDL.

These assert that attacker-controlled values (file column names, table/schema
names, storage URLs, file paths, delimiters and schema-editor type overrides)
cannot break out of the bracket identifiers or string literals they are placed
into.
"""

import re

from external_file_detection.sql_generator import (
    SQLGenerator,
    _CONTROL_CHARACTERS,
    _escape_identifier,
    _quote_literal,
    _quote_json_path,
    _safe_sql_type,
    _split_go_batches,
)

# Payloads that try to end the current batch and start an attacker-authored one.
# ``GO`` is not a T-SQL keyword: it is a client-side batch separator, so the
# server-side parser happily accepts a newline inside ``[an identifier]`` while
# sqlcmd, SSMS and Azure Data Studio cut the statement in half at that point.
GO_INJECTION_PAYLOADS = (
    'id\nGO\nDROP TABLE users;\nGO\n--',
    'id\r\nGO\r\nDROP TABLE users;\r\nGO\r\n--',
    'id\n  go  \nDROP TABLE users;\n--',
    'id\u2028GO\u2028DROP TABLE users;--',
    'id\u2029GO\u2029DROP TABLE users;--',
    'id\x00GO\x00DROP TABLE users;--',
    'id\x0bGO\x0bDROP TABLE users;--',
    'id\x0cGO\x0cDROP TABLE users;--',
    'id\x1cGO\x1cDROP TABLE users;--',
    'id\x85GO\x85DROP TABLE users;--',
    'id\x7fGO\x7fDROP TABLE users;--',
)

# Every character the escaping helpers must never let through.
LINE_TERMINATORS = '\r\n\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029'


# --- Unit tests for the quoting helpers -------------------------------------

def test_quote_literal_doubles_single_quotes():
    assert _quote_literal("a'b") == "a''b"
    assert _quote_literal("plain") == "plain"


def test_escape_identifier_doubles_closing_bracket():
    assert _escape_identifier("a]b") == "a]]b"
    # Original characters (spaces, dots) are preserved, only ] is escaped.
    assert _escape_identifier("First Name") == "First Name"


def test_quote_json_path_simple_vs_special():
    # Simple identifiers keep the bare $.key form (back-compat with examples).
    assert _quote_json_path("name") == "$.name"
    # Names with spaces/dots get quoted per SQL Server JSON path rules.
    assert _quote_json_path("first name") == '$."first name"'
    assert _quote_json_path("a.b") == '$."a.b"'
    # A single quote is escaped so it is safe inside a '...' literal.
    assert "'" not in _quote_json_path("a'b").replace("''", "")
    # A double quote in the key is backslash-escaped inside the quoted path.
    assert _quote_json_path('a"b') == '$."a\\"b"'


def test_safe_sql_type_allowlist():
    assert _safe_sql_type("NVARCHAR(255)") == "NVARCHAR(255)"
    assert _safe_sql_type("DECIMAL(18,4)") == "DECIMAL(18,4)"
    assert _safe_sql_type("VARBINARY(MAX)") == "VARBINARY(MAX)"
    # Injection attempt falls back to the safe default.
    assert _safe_sql_type("INT, [x] AS (1) --") == "NVARCHAR(MAX)"
    assert _safe_sql_type("'; DROP TABLE t;--") == "NVARCHAR(MAX)"


# --- End-to-end generation tests --------------------------------------------

def test_malicious_table_name_cannot_break_brackets():
    gen = SQLGenerator()
    metadata = {
        'file_type': 'csv',
        'file_path': 'data.csv',
        'schema': [('id', 'int64')],
    }
    evil = "t] ; DROP TABLE users;--"
    ddl = gen.generate_create_table(metadata, table_name=evil)
    # The closing bracket must be doubled so the identifier cannot terminate early.
    assert "[t]] ; DROP TABLE users;--]" in ddl
    # The raw (unescaped) injection string must not appear.
    assert "[t] ; DROP TABLE users;--]" not in ddl


def test_malicious_schema_name_is_escaped():
    gen = SQLGenerator()
    metadata = {'file_type': 'csv', 'file_path': 'data.csv', 'schema': [('id', 'int64')]}
    ddl = gen.generate_create_table(metadata, table_name='t', schema_name="s]o")
    assert "[s]]o].[t]" in ddl


def test_malicious_json_key_cannot_escape_json_path():
    gen = SQLGenerator()
    metadata = {
        'file_type': 'json',
        'file_path': 'data.json',
        'json_format': 'array',
        'schema': [("a'); DROP TABLE users;--", 'str')],
    }
    sql = gen.generate_openrowset(metadata, storage_url='https://x/y.json',
                                  target_platform='fabric_sql_db')
    # The single quote from the key must be doubled; it cannot terminate the
    # surrounding '...' JSON-path literal.
    assert "DROP TABLE users" in sql  # the text survives as data...
    assert "'); DROP TABLE users;--'" not in sql  # ...but never as a closed literal


def test_malicious_storage_url_is_escaped_in_literal():
    gen = SQLGenerator()
    metadata = {'file_type': 'parquet', 'file_path': 'data.parquet',
                'schema': [('id', 'int64')]}
    evil_url = (
        "abfss://ws@tenant.dfs.fabric.microsoft.com/lh/Files/"
        "y'; DROP TABLE t;--/data.parquet"
    )
    sql = gen.generate_openrowset(metadata, storage_url=evil_url,
                                  target_platform='fabric_sql_db')
    assert "y''; DROP TABLE t;--" in sql
    assert "y'; DROP TABLE t;--'" not in sql


def test_unknown_storage_url_never_leaks_absolute_path():
    """An unrecognised URL falls back to a placeholder, not a raw URL."""
    gen = SQLGenerator()
    metadata = {'file_type': 'parquet', 'file_path': 'data.parquet',
                'schema': [('id', 'int64')]}
    sql = gen.generate_openrowset(metadata,
                                  storage_url="https://x/y'; DROP TABLE t;--",
                                  target_platform='fabric_sql_db')
    assert "BULK 'https://" not in sql
    assert "DROP TABLE t" not in sql


def test_malicious_sql_type_override_is_rejected():
    gen = SQLGenerator()
    metadata = {
        'file_type': 'csv',
        'file_path': 'data.csv',
        'schema': [('id', 'int64')],
        'sql_type_overrides': {'id': 'INT, [x] AS (1)'},
    }
    ddl = gen.generate_create_table(metadata)
    assert 'AS (1)' not in ddl
    assert '[id] NVARCHAR(MAX)' in ddl


def test_for_json_root_literal_is_escaped():
    gen = SQLGenerator()
    metadata = {'file_type': 'json', 'file_path': 'data.json',
                'schema': [('id', 'int64')]}
    ddl = gen.generate_for_json_path(metadata, table_name="t'x")
    # ROOT('t'x') would be broken; the quote must be doubled.
    assert "ROOT('t''x')" in ddl


def test_for_json_root_does_not_double_escape_brackets():
    """A ']' in the table name must be doubled in [brackets] but NOT in the ROOT literal."""
    gen = SQLGenerator()
    metadata = {'file_type': 'json', 'file_path': 'data.json',
                'schema': [('id', 'int64')]}
    ddl = gen.generate_for_json_path(metadata, table_name="ta]ble")
    assert "[ta]]ble]" in ddl          # bracket context: ] doubled
    assert "ROOT('ta]ble')" in ddl     # literal context: ] left intact


def test_benign_names_unchanged():
    """Escaping must not alter ordinary names/paths (no false positives)."""
    gen = SQLGenerator()
    metadata = {
        'file_type': 'json',
        'file_path': 'users.json',
        'json_format': 'array',
        'schema': [('id', 'int'), ('name', 'str')],
    }
    sql = gen.generate_openrowset(metadata, storage_url='https://x/users.json',
                                  target_platform='fabric_sql_db')
    assert "'$.id'" in sql
    assert "'$.name'" in sql


def test_multiline_sample_value_stays_inside_sql_comment():
    gen = SQLGenerator()
    metadata = {
        'file_type': 'csv',
        'file_path': 'data.csv',
        'schema': [('value', 'str')],
        'sample_rows': [['safe\nDROP TABLE important;--']],
    }

    sql = gen.generate_create_table(metadata)

    assert '\nDROP TABLE important' not in sql
    assert '-- safe DROP TABLE impo' in sql


def test_distinct_source_column_names_do_not_collapse():
    gen = SQLGenerator()
    metadata = {
        'file_type': 'csv',
        'file_path': 'data.csv',
        'schema': [('a-b', 'str'), ('a b', 'str')],
    }

    sql = gen.generate_create_table(metadata)

    assert '[a-b] NVARCHAR(255)' in sql
    assert '[a b] NVARCHAR(255)' in sql
    assert sql.count('[a_b]') == 0


def test_duplicate_column_names_are_rejected():
    gen = SQLGenerator()
    metadata = {
        'file_type': 'csv',
        'file_path': 'data.csv',
        'schema': [('id', 'int'), ('ID', 'int')],
    }

    try:
        gen.generate_create_table(metadata)
        assert False, 'Expected duplicate column validation to fail'
    except ValueError as exc:
        assert 'Duplicate column name' in str(exc)


# --- GO batch injection ------------------------------------------------------
# ``GO`` is a client-side batch separator, not a T-SQL keyword. A newline
# smuggled into a bracketed identifier or a quoted literal is accepted by the
# server-side parser but cuts the statement in half in sqlcmd, SSMS and Azure
# Data Studio, letting whatever follows run as its own batch. The escaping
# helpers therefore fail closed on every control character, and the splitter is
# region-aware as defence in depth.


def test_escape_identifier_neutralises_line_terminators():
    for payload in GO_INJECTION_PAYLOADS:
        escaped = _escape_identifier(payload)
        assert not any(character in escaped for character in LINE_TERMINATORS), (
            f'{payload!r} kept a line terminator: {escaped!r}'
        )
        assert '\x00' not in escaped


def test_quote_literal_neutralises_line_terminators():
    for payload in GO_INJECTION_PAYLOADS:
        quoted = _quote_literal(payload)
        assert not any(character in quoted for character in LINE_TERMINATORS), (
            f'{payload!r} kept a line terminator: {quoted!r}'
        )


def test_escaped_identifier_cannot_split_a_generated_batch():
    payload = 'id\nGO\nDROP TABLE users;\nGO\n--'
    script = f'CREATE TABLE [dbo].[t] ([{_escape_identifier(payload)}] INT)'
    assert _split_go_batches(script) == [
        'CREATE TABLE [dbo].[t] ([id GO DROP TABLE users; GO --] INT)'
    ]
    assert _naive_client_split(script) == _split_go_batches(script)


def _naive_client_split(script):
    """Split like sqlcmd/SSMS do: any line whose trimmed content is ``GO``.

    Deliberately *not* :func:`_split_go_batches`. The region-aware splitter is
    this module's own defence in depth; the threat model is the naive client
    that actually executes the script, so that is what these tests model.
    """
    batches, current = [], []
    for line in re.split(r'\r\n|\r|\n', script):
        if line.strip().upper() == 'GO':
            batches.append('\n'.join(current))
            current = []
        else:
            current.append(line)
    batches.append('\n'.join(current))
    return [batch for batch in batches if batch.strip()]


def test_unescaped_payload_would_split_proving_the_check_is_not_vacuous():
    """The vulnerable form must still split, or the test above proves nothing."""
    unsafe = 'CREATE TABLE [dbo].[t] ([id\nGO\nDROP TABLE users;\nGO\n--] INT)'
    assert len(_naive_client_split(unsafe)) == 3
    assert _naive_client_split(unsafe)[1] == 'DROP TABLE users;'

    payload = 'id\nGO\nDROP TABLE users;\nGO\n--'
    safe = f'CREATE TABLE [dbo].[t] ([{_escape_identifier(payload)}] INT)'
    assert len(_naive_client_split(safe)) == 1


def test_escaping_preserves_printable_characters():
    assert _escape_identifier('Order Total (\u00a5)') == 'Order Total (\u00a5)'
    assert _escape_identifier('First Name') == 'First Name'
    assert _quote_literal("O'Brien") == "O''Brien"
    assert (
        _quote_literal('https://a.blob.core.windows.net/c/f.csv')
        == 'https://a.blob.core.windows.net/c/f.csv'
    )


def test_split_go_batches_ignores_go_inside_quoted_regions():
    assert _split_go_batches("SELECT 'a\nGO\nb';\nGO\nSELECT 2;") == [
        "SELECT 'a\nGO\nb';",
        'SELECT 2;',
    ]
    assert _split_go_batches('SELECT [a\nGO\nb];\nGO\nSELECT 2;') == [
        'SELECT [a\nGO\nb];',
        'SELECT 2;',
    ]
    assert _split_go_batches('/* a\nGO\nb */\nSELECT 1;\nGO\nSELECT 2;') == [
        '/* a\nGO\nb */\nSELECT 1;',
        'SELECT 2;',
    ]
    assert _split_go_batches('SELECT 1; -- GO\nGO\nSELECT 2;') == [
        'SELECT 1; -- GO',
        'SELECT 2;',
    ]


def test_split_go_batches_handles_doubled_delimiters_and_crlf():
    # '' inside a literal and ]] inside an identifier do not end the region.
    assert _split_go_batches("SELECT 'a''b';\r\nGO\r\nSELECT 2;") == [
        "SELECT 'a''b';",
        'SELECT 2;',
    ]
    assert _split_go_batches('SELECT [a]]b];\nGO\nSELECT 2;') == [
        'SELECT [a]]b];',
        'SELECT 2;',
    ]


def _all_statements(metadata, **kwargs):
    """Every generated section for *metadata*, as one list of strings."""
    generated = SQLGenerator().generate_all_statements(metadata, **kwargs)
    collected = []
    for value in generated.values():
        if isinstance(value, str):
            collected.append(value)
        elif isinstance(value, dict):
            collected.extend(str(item) for item in value.values())
        elif isinstance(value, (list, tuple)):
            collected.extend(str(item) for item in value)
    collected = [item for item in collected if item.strip()]
    assert collected, 'generate_all_statements produced nothing to assert on'
    return collected


def _assert_no_smuggled_batch(script, context):
    """No batch a naive client would run may be attacker-authored."""
    for batch in _naive_client_split(script):
        assert not batch.strip().upper().startswith('DROP TABLE'), (
            f'{context}: splitting on GO produced an attacker batch:\n{batch}'
        )
    assert len(_naive_client_split(script)) == len(_split_go_batches(script)), (
        f'{context}: the naive client and the region-aware splitter disagree, '
        f'which means a line terminator survived escaping:\n{script}'
    )


def test_malicious_csv_header_cannot_open_a_new_batch():
    metadata = {
        'file_type': 'csv',
        'file_path': 'data.csv',
        'delimiter': ',',
        'encoding': 'utf-8',
        'schema': [('id\nGO\nDROP TABLE users;\nGO\n--', 'int64'), ('ok', 'str')],
        'sample_rows': [['1', 'a']],
    }
    for script in _all_statements(metadata, storage_url='https://a.blob.core.windows.net/c/data.csv'):
        _assert_no_smuggled_batch(script, 'csv header')


def test_malicious_json_key_cannot_open_a_new_batch():
    metadata = {
        'file_type': 'json',
        'file_path': 'data.json',
        'json_format': 'array',
        'encoding': 'utf-8',
        'schema': [('k\nGO\nDROP TABLE users;\nGO\n--', 'str')],
    }
    for script in _all_statements(metadata, storage_url='https://a.blob.core.windows.net/c/data.json'):
        _assert_no_smuggled_batch(script, 'json key')


def test_malicious_file_path_cannot_open_a_new_batch():
    metadata = {
        'file_type': 'csv',
        'file_path': 'C:/data/e\nGO\nDROP TABLE users;\nGO\n--/evil.csv',
        'delimiter': ',',
        'encoding': 'utf-8',
        'schema': [('id', 'int64')],
    }
    for script in _all_statements(metadata):
        _assert_no_smuggled_batch(script, 'file path')


def test_malicious_data_source_name_cannot_open_a_new_batch():
    metadata = {
        'file_type': 'parquet',
        'file_path': 'data.parquet',
        'schema': [('id', 'int64')],
    }
    evil = 'ds\nGO\nDROP TABLE users;\nGO\n--'
    for script in _all_statements(
        metadata,
        storage_url='https://a.blob.core.windows.net/c/data.parquet',
        data_source=evil,
    ):
        _assert_no_smuggled_batch(script, 'data source')


def test_malicious_table_and_schema_names_cannot_open_a_new_batch():
    metadata = {
        'file_type': 'csv',
        'file_path': 'data.csv',
        'delimiter': ',',
        'encoding': 'utf-8',
        'schema': [('id', 'int64')],
    }
    evil = 't\nGO\nDROP TABLE users;\nGO\n--'
    for script in _all_statements(metadata, table_name=evil, schema_name=evil):
        _assert_no_smuggled_batch(script, 'table name')


def test_sql_type_override_rejects_non_ascii_digits_and_trailing_newline():
    # Python's ``\\d`` is Unicode-aware and its ``$`` matches before a trailing
    # newline; both would widen the allowlist past what the native engine
    # accepts, so the pattern is anchored with \\A/\\Z and compiled ASCII-only.
    assert _safe_sql_type('NVARCHAR(\uff12\uff15\uff15)') == 'NVARCHAR(MAX)'
    assert _safe_sql_type('INT\nDROP TABLE users;') == 'NVARCHAR(MAX)'
    assert _safe_sql_type('INT') == 'INT'


def test_sql_type_override_rejects_internal_line_breaks():
    # ``_safe_sql_type`` returns the accepted candidate verbatim, so it is the
    # one generator path that never runs through ``_collapse_control_characters``.
    # An ``\s*`` between the type name and its length would therefore put a real
    # line break inside CREATE TABLE. Only space and tab are allowed there.
    for separator in ('\n', '\r', '\r\n', '\x0b', '\x0c'):
        assert _safe_sql_type('NVARCHAR%s(255)' % separator) == 'NVARCHAR(MAX)'
        assert _safe_sql_type('DECIMAL(18,%s4)' % separator) == 'NVARCHAR(MAX)'
    # Space and tab remain legitimate.
    assert _safe_sql_type('NVARCHAR (255)') == 'NVARCHAR (255)'
    assert _safe_sql_type('NVARCHAR\t(255)') == 'NVARCHAR\t(255)'


def test_accepted_sql_types_never_carry_a_line_break_into_ddl():
    # The end-to-end statement of the rule: whatever the allowlist accepts must
    # be safe to interpolate into DDL verbatim.
    hostile = [
        'NVARCHAR\n(255)',
        'NVARCHAR\r\n(255)',
        'INT\nGO\nDROP TABLE users;\nGO\n--',
        'DECIMAL(18,\r4)',
        'NVARCHAR(255)\x0bGO',
    ]
    for candidate in hostile:
        accepted = _safe_sql_type(candidate)
        assert not _CONTROL_CHARACTERS.search(accepted), (
            'accepted type %r carries a control character' % accepted
        )
        assert len(_naive_client_split(accepted)) == 1


def test_json_path_key_with_a_newline_is_neutralised():
    path = _quote_json_path('a\nGO\nb')
    assert '\n' not in path
    assert path == '$."a GO b"'

