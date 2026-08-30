"""Regression tests for SQL-injection / escaping safety in generated DDL.

These assert that attacker-controlled values (file column names, table/schema
names, storage URLs, file paths, delimiters and schema-editor type overrides)
cannot break out of the bracket identifiers or string literals they are placed
into.
"""

from external_file_detection.sql_generator import (
    SQLGenerator,
    _escape_identifier,
    _quote_literal,
    _quote_json_path,
    _safe_sql_type,
)


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
