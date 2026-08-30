"""Tests for SQL generator functionality."""

from external_file_detection.sql_generator import SQLGenerator


def code_only(sql: str) -> str:
    """Return *sql* with whole-line ``--`` comments removed.

    Lets assertions check what the script actually executes without
    matching explanatory comment text.
    """
    return '\n'.join(
        line for line in sql.splitlines()
        if not line.strip().startswith('--')
    )


def test_csv_file_format_generation():
    """Test CSV file format generation on a platform that supports FIRST_ROW."""
    generator = SQLGenerator()
    
    metadata = {
        'file_type': 'csv',
        'delimiter': ',',
        'has_header': True,
        'encoding': 'utf-8',
        'schema': [('id', 'int64'), ('name', 'object'), ('age', 'int64')]
    }
    
    ddl = generator.generate_external_file_format(
        metadata, 'test_csv_format', target_platform='sql_server_2022'
    )
    
    assert 'CREATE EXTERNAL FILE FORMAT [test_csv_format]' in ddl
    assert 'FORMAT_TYPE = DELIMITEDTEXT' in ddl
    assert 'FORMAT_OPTIONS (' in ddl
    assert "FIELD_TERMINATOR = ','" in ddl
    assert 'FIRST_ROW = 2' in ddl
    # Live evidence (Azure SQL DB 12.0.2000.8 / SQL Server 2025 17.0.4065.4):
    # USE_TYPE_DEFAULT = TRUE replaces missing values with 0 / '' and destroys
    # source NULL semantics, so the generator defaults to FALSE and always
    # states the choice explicitly.
    assert 'USE_TYPE_DEFAULT = FALSE' in ddl


def test_csv_file_format_default_platform_is_azure_sql_database():
    """With no explicit platform the generator targets Azure SQL Database.

    Live certification proved Azure SQL Database *does* accept the FIRST_ROW
    format option: without it a header row raises error 4864, and with
    ``FIRST_ROW = 2`` the same external table returns every data row.
    """
    generator = SQLGenerator()

    metadata = {
        'file_type': 'csv',
        'delimiter': ',',
        'has_header': True,
        'encoding': 'utf-8',
        'schema': [('id', 'int64'), ('name', 'object')],
    }

    ddl = generator.generate_external_file_format(metadata, 'test_csv_format')

    assert 'Azure SQL Database' in ddl
    assert 'FIRST_ROW = 2' in ddl
    assert 'FORMAT_TYPE = DELIMITEDTEXT' in ddl


def test_json_file_format_generation():
    """JSON external file formats are rejected for exposed SQL targets."""
    generator = SQLGenerator()
    
    metadata = {
        'file_type': 'json',
        'schema': [('id', 'int'), ('name', 'str'), ('active', 'bool')]
    }
    
    ddl = generator.generate_external_file_format(metadata, 'test_json_format')
    
    assert 'NOT AVAILABLE' in ddl
    assert 'OPENROWSET with OPENJSON' in ddl


def test_parquet_file_format_generation():
    """Test Parquet file format generation."""
    generator = SQLGenerator()
    
    metadata = {
        'file_type': 'parquet',
        'compression': 'snappy',
        'schema': [('id', 'int64'), ('name', 'string')]
    }
    
    ddl = generator.generate_external_file_format(metadata, 'test_parquet_format')
    
    assert 'CREATE EXTERNAL FILE FORMAT [test_parquet_format]' in ddl
    assert 'FORMAT_TYPE = PARQUET' in ddl
    assert (
        "DATA_COMPRESSION = "
        "'org.apache.hadoop.io.compress.SnappyCodec'"
    ) in ddl


def test_parquet_file_format_not_available_on_sql_server_2019():
    """SQL Server 2019 does not support Parquet external file formats."""
    generator = SQLGenerator()
    ddl = generator.generate_external_file_format(
        {'file_type': 'parquet'},
        target_platform='sql_server_2019',
    )

    assert 'NOT AVAILABLE' in ddl
    assert 'FORMAT_TYPE = PARQUET' not in ddl


def test_rc_file_format_uses_serde_method_on_sql_server_2019():
    """RCFILE uses the documented SERDE_METHOD option name."""
    generator = SQLGenerator()
    ddl = generator.generate_external_file_format(
        {'file_type': 'rc'}, 'test_rc_format',
        target_platform='sql_server_2019',
    )

    assert 'FORMAT_TYPE = RCFILE' in ddl
    assert 'SERDE_METHOD' in ddl
    assert 'SERIALIZER_METHOD' not in ddl
    assert 'DESERIALIZER_METHOD' not in ddl
    assert 'DATA_COMPRESSION' not in ddl


def test_rc_file_format_emits_only_explicit_compression():
    """RCFile compression must not be guessed from absent metadata."""
    generator = SQLGenerator()
    ddl = generator.generate_external_file_format(
        {'file_type': 'rc', 'compression': 'gzip'},
        'test_rc_format',
        target_platform='sql_server_2019',
    )

    assert (
        "DATA_COMPRESSION = 'org.apache.hadoop.io.compress.GzipCodec'"
        in ddl
    )


def test_orc_file_format_does_not_guess_compression():
    """ORC metadata without a codec should not declare DefaultCodec."""
    generator = SQLGenerator()
    ddl = generator.generate_external_file_format(
        {'file_type': 'orc'},
        'test_orc_format',
        target_platform='sql_server_2019',
    )

    assert 'DATA_COMPRESSION' not in ddl


def test_external_table_generation():
    """Test external table generation."""
    generator = SQLGenerator()
    
    metadata = {
        'file_type': 'csv',
        'file_path': 'test_data/sample.csv',
        'schema': [('id', 'int64'), ('name', 'object'), ('age', 'int64')]
    }
    
    ddl = generator.generate_external_table(
        metadata, 
        table_name='test_table',
        data_source='test_source',
        location='test_location',
        file_format='test_format'
    )
    
    assert 'CREATE EXTERNAL TABLE [dbo].[test_table]' in ddl
    assert '[id] BIGINT' in ddl
    assert '[name] NVARCHAR(255)' in ddl
    assert '[age] BIGINT' in ddl
    assert 'DATA_SOURCE = [test_source]' in ddl
    assert "LOCATION = 'test_location'" in ddl
    assert 'FILE_FORMAT = [test_format]' in ddl


def test_type_mapping():
    """Test data type mapping to SQL types."""
    generator = SQLGenerator()
    
    assert generator._map_type_to_sql('int64') == 'BIGINT'
    assert generator._map_type_to_sql('int32') == 'INT'
    assert generator._map_type_to_sql('float64') == 'FLOAT'
    assert generator._map_type_to_sql('bool') == 'BIT'
    assert generator._map_type_to_sql('object') == 'NVARCHAR(255)'
    assert generator._map_type_to_sql('unknown_type') == 'NVARCHAR(255)'


def test_column_name_cleaning():
    """Test column name cleaning for SQL compatibility."""
    from external_file_detection.sql_generator import _clean_identifier
    
    assert _clean_identifier('valid_name') == 'valid_name'
    assert _clean_identifier('123invalid') == 'col_123invalid'
    assert _clean_identifier('name with spaces') == 'name_with_spaces'
    assert _clean_identifier('name-with-dashes') == 'name_with_dashes'
    assert _clean_identifier('') == 'column_1'


def test_complete_ddl_generation():
    """Test complete DDL generation."""
    generator = SQLGenerator()
    
    metadata = {
        'file_type': 'csv',
        'file_path': 'test.csv',
        'schema': [('id', 'int64'), ('name', 'object')],
        'delimiter': ',',
        'has_header': True
    }
    
    ddl = generator.generate_complete_ddl(metadata, 'test_table', 'test_source', 'test_location')
    
    assert 'CREATE EXTERNAL TABLE' in ddl


# -------------------------------------------------------------------
# generate_create_table
# -------------------------------------------------------------------

def test_create_table_sql_server():
    """CREATE TABLE for SQL Server should NOT have distribution/heap."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'test.csv',
        'schema': [('id', 'int64'), ('val', 'float64')],
    }
    sql = gen.generate_create_table(meta, 'tbl', target_platform='sql_server_2022')
    assert 'CREATE TABLE [dbo].[tbl]' in sql
    assert 'DISTRIBUTION' not in sql
    assert 'HEAP' not in sql
    assert "BULK 'https://" not in sql
    assert 'adls://<container>@<storage_account>.dfs.core.windows.net' in sql


def test_create_table_quick_load_uses_relative_adls_path():
    """CREATE TABLE guidance uses DATA_SOURCE rather than a BULK HTTPS URL."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'parquet',
        'file_path': 'sample.parquet',
        'file_name': 'sample.parquet',
        'schema': [('id', 'int64')],
    }
    sql = gen.generate_create_table(
        meta,
        'sample',
        target_platform='sql_server_2025',
        storage_url=(
            'https://account.dfs.core.windows.net/'
            'container/folder/sample.parquet'
        ),
        data_source='LakeDS',
    )

    assert "BULK 'folder/sample.parquet'" in sql
    assert "DATA_SOURCE = 'LakeDS'" in sql
    assert "FORMAT = 'PARQUET'" in sql
    assert 'adls://container@account.dfs.core.windows.net' in sql
    assert "BULK 'https://" not in sql


def test_create_table_quick_load_rejects_sql_server_2019_parquet():
    """SQL Server 2019 CREATE TABLE guidance does not fake Parquet access."""
    gen = SQLGenerator()
    sql = gen.generate_create_table(
        {
            'file_type': 'parquet',
            'file_path': 'sample.parquet',
            'schema': [('id', 'int64')],
        },
        target_platform='sql_server_2019',
    )

    assert 'not available on SQL Server 2019' in sql
    assert 'FROM OPENROWSET(' not in sql


def test_create_table_quick_load_routes_json_to_openjson():
    """JSON CREATE TABLE guidance does not emit FORMAT=JSON or CSV."""
    gen = SQLGenerator()
    sql = gen.generate_create_table(
        {
            'file_type': 'json',
            'file_path': 'sample.json',
            'schema': [('id', 'int64')],
        },
        target_platform='sql_server_2022',
    )

    assert 'JSON Functions tab' in sql
    assert 'FORMAT =' not in sql
    assert 'FROM OPENROWSET(' not in sql


def test_create_table_azure_sql():
    """CREATE TABLE for Azure SQL omits distribution clause."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'parquet', 'file_path': 'data.parquet',
        'schema': [('a', 'int32'), ('b', 'string')],
    }
    sql = gen.generate_create_table(meta, target_platform='azure_sql_db')
    assert 'CREATE TABLE' in sql
    assert 'DISTRIBUTION' not in sql


def test_create_table_invalid_platform_fallback():
    """Invalid platform should fall back to sql_server_2022."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'x.csv',
        'schema': [('c', 'int64')],
    }
    sql = gen.generate_create_table(meta, target_platform='not_a_platform')
    assert 'CREATE TABLE' in sql   # fell back to sql_server_2022


# -------------------------------------------------------------------
# generate_bulk_insert
# -------------------------------------------------------------------

def test_bulk_insert_csv():
    """BULK INSERT generates correct syntax for CSV."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'data.csv',
        'encoding': 'utf-8', 'codepage': '65001',
        'delimiter': ',', 'has_header': True,
    }
    sql = gen.generate_bulk_insert(meta, 'tbl', target_platform='sql_server_2022')
    assert 'BULK INSERT [dbo].[tbl]' in sql
    assert "FIRSTROW        = 2" in sql
    assert "FIELDTERMINATOR = ','" in sql
    assert "CODEPAGE        = '65001'" in sql


def test_bulk_insert_non_csv():
    """BULK INSERT for non-CSV files returns a hint comment."""
    gen = SQLGenerator()
    meta = {'file_type': 'parquet', 'file_path': 'data.parquet'}
    sql = gen.generate_bulk_insert(meta, 'tbl', target_platform='sql_server_2022')
    assert 'PARQUET' in sql
    assert 'OPENROWSET' in sql or 'EXTERNAL TABLE' in sql


# -------------------------------------------------------------------
# Platform-specific tests
# -------------------------------------------------------------------

def test_copy_into_not_supported_on_sql_server_on_prem():
    """COPY INTO is only for Synapse Dedicated, not on-prem SQL Server."""
    gen = SQLGenerator()
    meta = {'file_type': 'csv', 'file_path': 'data.csv',
            'delimiter': ',', 'has_header': True,
            'schema': [('a', 'int64')]}
    sql = gen.generate_copy_into(meta, 'tbl', target_platform='sql_server_2022')
    assert 'not supported' in sql.lower() or 'alternative' in sql.lower()


def test_windows_backslashes_normalized_in_bulk_insert():
    """BULK INSERT should handle Windows backslash paths."""
    gen = SQLGenerator()
    meta = {'file_type': 'csv', 'file_path': 'D:\\data\\files\\test.csv',
            'delimiter': ',', 'has_header': True,
            'encoding': 'utf-8', 'codepage': '65001'}
    sql = gen.generate_bulk_insert(meta, 'tbl', target_platform='sql_server_2022')
    assert 'D:/data/files/test.csv' in sql
    assert '\\\\' not in sql  # no double backslashes


def test_windows_backslashes_normalized_in_openrowset():
    """OPENROWSET for on-prem SQL Server should normalize backslashes."""
    gen = SQLGenerator()
    meta = {'file_type': 'csv', 'file_path': 'D:\\data\\test.csv',
            'file_name': 'test.csv',
            'delimiter': ',', 'has_header': True,
            'encoding': 'utf-8', 'codepage': '65001',
            'schema': [('a', 'int64')]}
    sql = gen.generate_openrowset(meta, target_platform='sql_server_2022')
    assert 'D:/data/test.csv' in sql


# -------------------------------------------------------------------
# generate_openrowset
# -------------------------------------------------------------------

def test_openrowset_csv():
    """OPENROWSET for CSV includes PARSER_VERSION and HEADER_ROW."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'data.csv',
        'encoding': 'utf-8', 'delimiter': ',', 'has_header': True,
        'schema': [('a', 'int64'), ('b', 'object')],
    }
    sql = gen.generate_openrowset(meta)
    assert 'OPENROWSET' in sql
    assert 'CSV' in sql


def test_openrowset_parquet():
    """SQL Server 2022 OPENROWSET reads Parquet from object storage."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'parquet', 'file_path': 'x.parquet',
        'schema': [('id', 'int64')],
    }
    sql = gen.generate_openrowset(meta)
    assert "FORMAT = 'PARQUET'" in sql
    assert "DATA_SOURCE = 'MyDataSource'" in sql
    assert 'does not natively read Parquet' not in sql


def test_openrowset_delta():
    """OPENROWSET for Delta includes FORMAT = 'DELTA'."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'delta', 'file_path': '/delta_folder',
        'schema': [('id', 'int64')],
    }
    sql = gen.generate_openrowset(meta)
    assert "FORMAT = 'DELTA'" in sql


def test_openrowset_parquet_and_delta_not_available_on_sql_server_2019():
    """SQL Server 2019 cannot query Parquet or Delta files."""
    gen = SQLGenerator()

    for file_type in ('parquet', 'delta'):
        sql = gen.generate_openrowset(
            {
                'file_type': file_type,
                'file_path': f'data.{file_type}',
                'schema': [('id', 'int64')],
            },
            target_platform='sql_server_2019',
        )
        assert 'not available on SQL Server 2019' in sql
        assert f"FORMAT = '{file_type.upper()}'." in sql
        assert 'FROM OPENROWSET(' not in sql


def test_openrowset_json_on_sql_server_2019_is_text_workaround():
    """SQL Server 2019 parses JSON text but has no JSON file format."""
    gen = SQLGenerator()
    sql = gen.generate_openrowset(
        {
            'file_type': 'json',
            'file_path': 'data.json',
            'schema': [('id', 'int64')],
        },
        target_platform='sql_server_2019',
    )

    assert "FORMAT = 'JSON' or JSON external tables" in sql
    assert 'SINGLE_CLOB' in sql
    assert 'OPENJSON' in sql


def test_openrowset_parquet_on_sql_server_2025_uses_relative_storage_path():
    """SQL Server 2025 uses ADLS data sources and relative BULK paths."""
    gen = SQLGenerator()
    sql = gen.generate_openrowset(
        {
            'file_type': 'parquet',
            'file_path': 'sample.parquet',
            'schema': [('id', 'int64')],
        },
        storage_url=(
            'https://account.dfs.core.windows.net/'
            'container/folder/sample.parquet'
        ),
        data_source='LakeDS',
        target_platform='sql_server_2025',
    )

    assert "BULK 'folder/sample.parquet'" in sql
    assert "DATA_SOURCE = 'LakeDS'" in sql
    assert "FORMAT = 'PARQUET'" in sql
    assert 'adls://container@account.dfs.core.windows.net' in sql
    assert "BULK 'https://" not in sql


# -------------------------------------------------------------------
# generate_best_practices
# -------------------------------------------------------------------

def test_best_practices_csv():
    """Best practices for CSV mentions encoding and delimiter."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'data.csv',
        'encoding': 'utf-8', 'delimiter': ',', 'has_header': True,
        'file_size': 1024,
    }
    bp = gen.generate_best_practices(meta)
    assert 'BEST PRACTICES' in bp
    assert 'CSV' in bp
    assert 'RECOMMENDED PATH' in bp
    assert 'VALIDATION SQL AFTER LOAD' in bp


def test_best_practices_parquet():
    """Best practices for Parquet mentions PARQUET."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'parquet', 'file_path': 'data.parquet',
        'file_size': 1024 * 1024 * 50,
        'compression': 'snappy',
    }
    bp = gen.generate_best_practices(meta)
    assert 'PARQUET' in bp


def test_best_practices_warnings_for_nested_json_and_long_strings():
    """Best practices should surface metadata-driven warnings."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'json',
        'file_path': 'data.json',
        'file_name': 'data.json',
        'file_size': 2048,
        'encoding': 'utf-8',
        'encoding_confidence': 45,
        'json_nesting': {'id': 'scalar', 'payload': 'object'},
        'schema': [('id', 'int64'), ('payload', 'object'), ('notes', 'object')],
        'max_string_lengths': {'notes': 5001},
        'nullable_columns': ['id'],
    }
    bp = gen.generate_best_practices(meta, target_platform='fabric_sql_db')
    assert 'WARNINGS / WATCH-OUTS' in bp
    assert 'Nested JSON detected' in bp
    assert 'Very long strings detected' in bp
    assert 'Low encoding confidence' in bp


def test_best_practices_validation_sql_uses_table_name():
    """Best practices should include reusable post-load validation SQL."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv',
        'file_path': 'sales_orders.csv',
        'file_name': 'sales_orders.csv',
        'file_size': 1024,
        'schema': [('order_id', 'object'), ('customer_id', 'int64'), ('amount', 'float64')],
    }
    bp = gen.generate_best_practices(meta, target_platform='sql_server_2022')
    assert 'SELECT COUNT(*) AS loaded_rows FROM [dbo].[sales_orders];' in bp
    assert 'SELECT TOP 10 [order_id], [customer_id], [amount] FROM [dbo].[sales_orders];' in bp


# -------------------------------------------------------------------
# generate_all_statements
# -------------------------------------------------------------------

def test_all_statements_returns_all_keys():
    """generate_all_statements returns a dict with all required keys."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'test.csv',
        'schema': [('id', 'int64'), ('name', 'object')],
        'delimiter': ',', 'has_header': True,
        'encoding': 'utf-8', 'codepage': '65001',
    }
    stmts = gen.generate_all_statements(meta)
    expected_keys = {
        'create_table', 'bulk_insert', 'openrowset',
        'external_file_format', 'create_external_table', 'best_practices',
        'copy_into', 'json_functions', 'for_json', 'credential_setup',
    }
    assert set(stmts.keys()) == expected_keys
    for key, val in stmts.items():
        assert isinstance(val, str), f'{key} should be a string'
        assert len(val) > 10, f'{key} should not be empty'


def test_all_statements_passes_target_platform():
    """generate_all_statements propagates target_platform to create_table."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'test.csv',
        'schema': [('id', 'int64')],
        'delimiter': ',', 'has_header': True,
    }
    stmts = gen.generate_all_statements(meta, target_platform='sql_server_2022')
    assert 'DISTRIBUTION' not in stmts['create_table']


# -------------------------------------------------------------------
# max_string_lengths / NVARCHAR sizing
# -------------------------------------------------------------------

def test_nvarchar_sizing_with_max_string_lengths():
    """max_string_lengths should influence NVARCHAR size in column defs."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'test.csv',
        'schema': [('short_col', 'object'), ('long_col', 'object')],
        'max_string_lengths': {'short_col': 50, 'long_col': 5000},
    }
    sql = gen.generate_create_table(meta, 'tbl')
    # short_col stays NVARCHAR(255) default; long_col should be NVARCHAR(MAX) (>4000)
    assert 'NVARCHAR(MAX)' in sql


def test_best_practices_render_tab_delimiter_visibly():
    """Control delimiters should not disappear from generated guidance."""
    generator = SQLGenerator()
    metadata = {
        'file_type': 'csv',
        'file_path': 'events.tsv',
        'file_name': 'events.tsv',
        'file_size': 100,
        'encoding': 'utf-8',
        'delimiter': '\t',
        'has_header': True,
        'schema': [('id', 'int64')],
    }

    sql = generator.generate_best_practices(metadata)

    assert "FIELDTERMINATOR = '\\t'" in sql


# -------------------------------------------------------------------
# generate_copy_into
# -------------------------------------------------------------------

def test_copy_into_csv():
    """COPY INTO for CSV on SQL Server 2022 shows NOT AVAILABLE."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'data.csv', 'file_name': 'data.csv',
        'delimiter': ',', 'has_header': True, 'encoding': 'utf-8',
        'schema': [('id', 'int64'), ('name', 'object')],
    }
    sql = gen.generate_copy_into(meta, 'tbl')
    assert 'NOT AVAILABLE' in sql
    assert 'BULK INSERT' in sql  # should suggest alternative


def test_copy_into_parquet():
    """COPY INTO for Parquet on SQL Server 2022 shows NOT AVAILABLE."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'parquet', 'file_path': 'data.parquet', 'file_name': 'data.parquet',
        'schema': [('id', 'int64')],
    }
    sql = gen.generate_copy_into(meta, 'tbl')
    assert 'NOT AVAILABLE' in sql


def test_copy_into_json_fallback():
    """COPY INTO for JSON on SQL Server 2022 shows NOT AVAILABLE."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'json', 'file_path': 'data.json', 'file_name': 'data.json',
        'schema': [('id', 'int64')],
    }
    sql = gen.generate_copy_into(meta, 'tbl')
    assert 'NOT AVAILABLE' in sql


def test_copy_into_delta_fallback():
    """COPY INTO for Delta on SQL Server 2022 shows NOT AVAILABLE."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'delta', 'file_path': '/delta', 'file_name': 'delta_table',
        'schema': [('id', 'int64')],
    }
    sql = gen.generate_copy_into(meta, 'tbl')
    assert 'NOT AVAILABLE' in sql


# -------------------------------------------------------------------
# generate_credential_setup
# -------------------------------------------------------------------

def test_credential_setup():
    """Credential setup defaults to managed identity and needs no master key.

    Live evidence (Azure SQL Database): creating a database scoped credential
    with IDENTITY = 'MANAGED IDENTITY' left the database master key count at 0
    before, during and after, so the master key step is not emitted.
    """
    gen = SQLGenerator()
    sql = gen.generate_credential_setup('TestDS', 'ff_csv', {'file_type': 'csv'})
    assert "IDENTITY = 'MANAGED IDENTITY'" in sql
    assert 'CREATE MASTER KEY' not in sql
    assert 'DATABASE SCOPED CREDENTIAL' in sql
    assert 'EXTERNAL DATA SOURCE [TestDS]' in sql
    assert 'cred_TestDS' in sql


def test_credential_setup_sas_still_emits_master_key():
    """Opting into a SAS token restores the master key prerequisite."""
    gen = SQLGenerator()
    sql = gen.generate_credential_setup(
        'TestDS', 'ff_csv', {'file_type': 'csv'}, auth_method='sas'
    )
    assert "IDENTITY = 'SHARED ACCESS SIGNATURE'" in sql
    assert 'CREATE MASTER KEY' in sql


def test_credential_setup_public_container_needs_no_credential():
    """A public container gets no credential, no secret and no master key."""
    gen = SQLGenerator()
    sql = gen.generate_credential_setup(
        'TestDS', 'ff_csv', {'file_type': 'csv'}, auth_method='public'
    )
    assert 'CREATE DATABASE SCOPED CREDENTIAL' not in sql
    assert 'CREATE MASTER KEY' not in sql
    assert 'SECRET' not in sql
    assert 'CREDENTIAL = [' not in sql
    assert 'EXTERNAL DATA SOURCE [TestDS]' in sql


def test_credential_name_override_is_propagated():
    """A caller-supplied credential name replaces every derived one."""
    gen = SQLGenerator()
    sql = gen.generate_credential_setup(
        'TestDS', 'ff_csv', {'file_type': 'csv'},
        credential_name='sqlfdt_cert_abc_cred',
        storage_url='https://acct.blob.core.windows.net/raw/x.csv',
    )
    assert 'CREATE DATABASE SCOPED CREDENTIAL [sqlfdt_cert_abc_cred]' in sql
    assert 'CREATE DATABASE SCOPED CREDENTIAL [sqlfdt_cert_abc_cred_Bulk]' in sql
    assert 'cred_TestDS' not in sql


def test_credential_setup_uses_adls_without_type_on_sql_server_2022():
    """SQL Server 2022 infers ADLS from its URI and rejects TYPE=HADOOP."""
    gen = SQLGenerator()
    sql = gen.generate_credential_setup(
        'LakeDS',
        metadata={'file_type': 'parquet', 'file_name': 'sample.parquet'},
        target_platform='sql_server_2022',
        storage_url=(
            'https://account.dfs.core.windows.net/'
            'container/folder/sample.parquet'
        ),
    )

    assert (
        "LOCATION = 'adls://container@account.dfs.core.windows.net'"
        in sql
    )
    assert 'TYPE = HADOOP' not in sql
    # The data virtualization source must not use https://; the separate
    # TYPE = BLOB_STORAGE bulk source must.
    virtualization_source = sql.split('-- 4.')[0]
    assert "LOCATION = 'https://" not in virtualization_source
    assert "TYPE = BLOB_STORAGE" in sql
    assert ("LOCATION = 'https://account.blob.core.windows.net/container'"
            in sql)
    # Managed identity is now the default, so no SAS secret is emitted.
    assert "IDENTITY = 'MANAGED IDENTITY'" in sql
    assert 'SECRET' not in sql


def test_credential_setup_uses_abs_for_blob_storage_on_sql_server_2025():
    """SQL Server 2025 converts Azure Blob HTTPS URLs to abs:// sources."""
    gen = SQLGenerator()
    sql = gen.generate_credential_setup(
        'BlobDS',
        metadata={'file_type': 'parquet', 'file_name': 'sample.parquet'},
        target_platform='sql_server_2025',
        storage_url=(
            'https://account.blob.core.windows.net/'
            'container/folder/sample.parquet'
        ),
    )

    assert (
        "LOCATION = 'abs://container@account.blob.core.windows.net'"
        in sql
    )
    assert 'TYPE = HADOOP' not in sql


def test_external_setup_not_generated_for_sql_server_2019_parquet():
    """Unsupported SQL Server 2019 formats do not emit data source setup."""
    gen = SQLGenerator()
    sql = gen.generate_credential_setup(
        'LakeDS',
        metadata={'file_type': 'parquet', 'file_name': 'sample.parquet'},
        target_platform='sql_server_2019',
    )

    assert 'NOT AVAILABLE' in sql
    assert 'CREATE EXTERNAL DATA SOURCE' not in sql


def test_all_statements_use_relative_external_table_location():
    """The external table path is relative to the ADLS data source root."""
    gen = SQLGenerator()
    statements = gen.generate_all_statements(
        {
            'file_type': 'parquet',
            'file_path': 'sample.parquet',
            'file_name': 'sample.parquet',
            'schema': [('id', 'int64')],
        },
        data_source='LakeDS',
        target_platform='sql_server_2022',
        storage_url=(
            'adls://container@account.dfs.core.windows.net/'
            'folder/sample.parquet'
        ),
    )

    assert "LOCATION = 'folder/sample.parquet'" in (
        statements['create_external_table']
    )
    assert "BULK 'folder/sample.parquet'" in statements['create_table']
    assert "BULK 'https://" not in statements['create_table']
    assert 'TYPE = HADOOP' not in statements['credential_setup']


# -------------------------------------------------------------------
# generate_json_functions
# -------------------------------------------------------------------

def _json_meta():
    """Helper returning typical JSON metadata."""
    return {
        'file_type': 'json', 'file_path': 'data.json', 'file_name': 'data.json',
        'json_format': 'array',
        'json_nesting': {'id': 'scalar', 'name': 'scalar', 'address': 'object', 'tags': 'array'},
        'schema': [('id', 'int64'), ('name', 'object'), ('address', 'object'), ('tags', 'object')],
    }


def test_json_functions_openjson():
    """JSON Functions tab contains OPENJSON with typed WITH clause."""
    gen = SQLGenerator()
    sql = gen.generate_json_functions(_json_meta(), 'tbl', target_platform='sql_server_2022')
    assert 'OPENJSON' in sql
    assert 'SINGLE_CLOB' in sql
    assert '$.id' in sql
    assert '$.name' in sql
    assert 'AS JSON' in sql  # nested columns should have AS JSON


def test_json_functions_validation():
    """JSON Functions tab contains ISJSON validation."""
    gen = SQLGenerator()
    sql = gen.generate_json_functions(_json_meta(), 'tbl', target_platform='sql_server_2022')
    assert 'ISJSON' in sql


def test_json_functions_nested_cross_apply():
    """JSON Functions tab has CROSS APPLY for nested objects."""
    gen = SQLGenerator()
    sql = gen.generate_json_functions(_json_meta(), 'tbl', target_platform='sql_server_2022')
    assert 'CROSS APPLY OPENJSON' in sql
    assert '$.address' in sql or '$.tags' in sql


def test_json_functions_json_modify():
    """JSON Functions tab has JSON_MODIFY example."""
    gen = SQLGenerator()
    sql = gen.generate_json_functions(_json_meta(), 'tbl', target_platform='sql_server_2022')
    assert 'JSON_MODIFY' in sql


def test_json_functions_object_format():
    """JSON Functions for object format uses JSON_VALUE directly."""
    gen = SQLGenerator()
    meta = _json_meta()
    meta['json_format'] = 'object'
    sql = gen.generate_json_functions(meta, 'tbl', target_platform='sql_server_2022')
    assert 'JSON_VALUE' in sql or 'JSON_QUERY' in sql


# -------------------------------------------------------------------
# generate_for_json_path
# -------------------------------------------------------------------

def test_for_json_path():
    """FOR JSON PATH generates various FOR JSON examples."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'json', 'file_path': 'data.json',
        'schema': [('id', 'int64'), ('name', 'object')],
        'json_nesting': {'id': 'scalar', 'name': 'scalar'},
    }
    sql = gen.generate_for_json_path(meta, 'tbl', target_platform='sql_server_2022')
    assert 'FOR JSON PATH' in sql
    assert 'ROOT' in sql
    assert 'INCLUDE_NULL_VALUES' in sql
    assert 'WITHOUT_ARRAY_WRAPPER' in sql
    assert 'JSON_OBJECT' in sql


def test_for_json_path_nested():
    """FOR JSON PATH re-nests objects via JSON_QUERY."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'json', 'file_path': 'data.json',
        'schema': [('id', 'int64'), ('addr', 'object')],
        'json_nesting': {'id': 'scalar', 'addr': 'object'},
    }
    sql = gen.generate_for_json_path(meta, 'tbl', target_platform='sql_server_2022')
    assert 'JSON_QUERY' in sql


# -------------------------------------------------------------------
# _generate_openjson_columns
# -------------------------------------------------------------------

def test_openjson_columns_scalar():
    """Scalar columns get SQL type and JSON path."""
    gen = SQLGenerator()
    meta = {
        'schema': [('id', 'int64'), ('name', 'object')],
        'json_nesting': {'id': 'scalar', 'name': 'scalar'},
    }
    cols = gen._generate_openjson_columns(meta, indent=4)
    assert len(cols) == 2
    assert "'$.id'" in cols[0]
    assert 'BIGINT' in cols[0]


def test_openjson_columns_nested():
    """Nested object/array columns get NVARCHAR(MAX) AS JSON."""
    gen = SQLGenerator()
    meta = {
        'schema': [('data', 'object')],
        'json_nesting': {'data': 'object'},
    }
    cols = gen._generate_openjson_columns(meta, indent=4)
    assert len(cols) == 1
    assert 'NVARCHAR(MAX)' in cols[0]
    assert 'AS JSON' in cols[0]


# -------------------------------------------------------------------
# REJECT_TYPE comma fix
# -------------------------------------------------------------------

def test_external_table_no_trailing_comma_reject_type():
    """REJECT_TYPE = VALUE should not produce a double-comma."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'data.csv',
        'schema': [('id', 'int64')],
    }
    sql = gen.generate_external_table(meta, 'tbl', 'ds', 'loc', 'fmt',
                                      target_platform='sql_server_2019')
    # No double-comma (the old bug had VALUE, followed by ,\n from join)
    assert 'VALUE,,' not in sql
    assert 'REJECT_TYPE = VALUE' in sql


def test_external_table_reject_options_only_for_hadoop_sources():
    """REJECT_TYPE/REJECT_VALUE are PolyBase HADOOP-only options."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'data.csv',
        'schema': [('id', 'int64')],
    }
    for platform in ('sql_server_2022', 'sql_server_2025', 'azure_sql_db',
                     'azure_sql_mi', 'fabric_sql_db'):
        sql = gen.generate_external_table(meta, 'tbl', 'ds', 'loc', 'fmt',
                                          target_platform=platform)
        assert 'REJECT_TYPE' not in sql, platform
        assert 'REJECT_VALUE' not in sql, platform


# -------------------------------------------------------------------
# Platform gating — features not available
# -------------------------------------------------------------------

def test_copy_into_not_on_sql_server():
    """COPY INTO should show NOT AVAILABLE on SQL Server."""
    gen = SQLGenerator()
    meta = {'file_type': 'csv', 'file_path': 'x.csv', 'schema': [('id', 'int64')]}
    sql = gen.generate_copy_into(meta, 'tbl', target_platform='sql_server_2022')
    assert 'NOT AVAILABLE' in sql
    assert 'BULK INSERT' in sql or 'OPENROWSET' in sql  # alternatives shown


def test_bulk_insert_fabric_sql_db_openrowset_fallbacks():
    """Fabric SQL DB BULK INSERT guidance should include OPENROWSET load patterns."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv',
        'file_path': 'x.csv',
        'file_name': 'x.csv',
        'delimiter': ',',
        'has_header': True,
    }
    sql = gen.generate_bulk_insert(meta, target_platform='fabric_sql_db')
    assert 'NOT AVAILABLE on Microsoft Fabric SQL Database' in sql
    assert 'SELECT *' in sql and 'INTO [dbo].[stg_' in sql
    assert 'INSERT INTO [dbo].[' in sql
    assert 'FROM OPENROWSET(' in sql


def test_copy_into_fabric_sql_db_alternatives():
    """COPY INTO on Fabric SQL DB should provide practical alternatives."""
    gen = SQLGenerator()
    meta = {'file_type': 'csv', 'file_path': 'x.csv', 'schema': [('id', 'int64')]}
    sql = gen.generate_copy_into(meta, target_platform='fabric_sql_db')
    assert 'NOT AVAILABLE on Microsoft Fabric SQL Database' in sql
    assert 'OPENROWSET' in sql
    assert 'Data Pipelines' in sql or 'Dataflows' in sql


def test_openrowset_available_on_fabric_sql_db():
    """OPENROWSET should be generated for Fabric SQL DB."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'parquet',
        'file_path': 'x.parquet',
        'file_name': 'x.parquet',
        'schema': [('id', 'int64')],
    }
    sql = gen.generate_openrowset(meta, target_platform='fabric_sql_db')
    assert 'OPENROWSET' in sql
    assert 'NOT AVAILABLE' not in sql


def test_bulk_insert_on_azure_sql_mi():
    """BULK INSERT should work on Azure SQL Managed Instance."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'x.csv', 'file_name': 'x.csv',
        'delimiter': ',', 'has_header': True, 'encoding': 'utf-8',
        'codepage': '65001', 'schema': [('id', 'int64')],
    }
    sql = gen.generate_bulk_insert(meta, 'tbl', target_platform='azure_sql_mi')
    assert 'BULK INSERT' in sql
    assert 'NOT AVAILABLE' not in sql


def test_openrowset_azure_sql_db_data_virtualization():
    """Azure SQL DB OPENROWSET uses a relative BULK path plus DATA_SOURCE."""
    gen = SQLGenerator()
    meta = {'file_type': 'csv', 'file_path': 'x.csv', 'schema': [('id', 'int64')]}
    sql = gen.generate_openrowset(
        meta,
        storage_url='https://acct.blob.core.windows.net/raw/landing/x.csv',
        data_source='LakeDS', target_platform='azure_sql_db')
    assert "BULK 'landing/x.csv'" in sql
    assert "DATA_SOURCE     = 'LakeDS'" in sql
    # The row-oriented read uses the abs:// virtualization source; only the
    # single-LOB whole-file read may reference the TYPE = BLOB_STORAGE source.
    assert 'BLOB_STORAGE' not in sql.split('-- ---- Whole file as one value')[0]
    assert 'https://' not in sql.split('-- Data source location')[1].split('\n')[1]
    assert 'abs://raw@acct.blob.core.windows.net' in sql


def test_openrowset_local_on_sql_server_2022():
    """OPENROWSET on SQL Server 2022 should generate local file syntax."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': r'C:\data\test.csv',
        'schema': [('id', 'int64')], 'encoding': 'utf-8',
        'codepage': '65001', 'delimiter': ',', 'has_header': True,
    }
    sql = gen.generate_openrowset(meta, target_platform='sql_server_2022')
    assert 'OPENROWSET' in sql
    assert 'BULK' in sql
    assert 'NOT AVAILABLE' not in sql


def test_external_table_not_on_azure_sql_mi():
    """CREATE EXTERNAL TABLE should show NOT AVAILABLE on Azure SQL MI."""
    gen = SQLGenerator()
    meta = {'file_type': 'csv', 'file_path': 'x.csv', 'schema': [('id', 'int64')]}
    sql = gen.generate_external_table(meta, target_platform='azure_sql_mi')
    assert 'CREATE EXTERNAL TABLE [dbo].[ext_x]' in sql


def test_external_table_on_fabric_sql_db_preview():
    """Fabric SQL Database supports CREATE EXTERNAL TABLE in preview."""
    gen = SQLGenerator()
    meta = {'file_type': 'csv', 'file_path': 'x.csv', 'schema': [('id', 'int64')]}
    sql = gen.generate_external_table(meta, target_platform='fabric_sql_db')
    assert 'CREATE EXTERNAL TABLE [dbo].[ext_x]' in sql
    assert 'preview' in sql
    assert 'Entra passthrough' in sql
    assert 'Synapse' not in sql


def test_for_json_on_azure_sql_db():
    """FOR JSON should work on Azure SQL Database."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'json', 'file_path': 'x.json',
        'schema': [('id', 'int64'), ('name', 'object')],
        'json_nesting': {'id': 'scalar', 'name': 'scalar'},
    }
    sql = gen.generate_for_json_path(meta, 'tbl', target_platform='azure_sql_db')
    assert 'FOR JSON PATH' in sql
    assert 'NOT AVAILABLE' not in sql


def test_json_path_exists_not_on_sql_2019():
    """JSON_PATH_EXISTS should be noted as unavailable on SQL Server 2019."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'json', 'file_path': 'x.json',
        'schema': [('id', 'int64')],
        'json_nesting': {'id': 'scalar'},
        'json_format': 'array',
    }
    sql = gen.generate_json_functions(meta, 'tbl', target_platform='sql_server_2019')
    # Should NOT have actual JSON_PATH_EXISTS statement, but a note
    assert 'NOT available' in sql or 'not available' in sql.lower()


def test_json_path_exists_on_sql_2022():
    """JSON_PATH_EXISTS should appear on SQL Server 2022."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'json', 'file_path': 'x.json',
        'schema': [('id', 'int64')],
        'json_nesting': {'id': 'scalar'},
        'json_format': 'array',
    }
    sql = gen.generate_json_functions(meta, 'tbl', target_platform='sql_server_2022')
    assert 'JSON_PATH_EXISTS' in sql
    # Should have actual statement not just a "not available" note
    assert 'SELECT JSON_PATH_EXISTS' in sql


def test_credential_not_on_azure_sql_mi():
    """Credential setup not available on Azure SQL MI."""
    gen = SQLGenerator()
    sql = gen.generate_credential_setup('DS', 'ff', target_platform='azure_sql_mi')
    assert 'CREATE EXTERNAL DATA SOURCE [DS]' in sql
    assert 'CREATE EXTERNAL DATA SOURCE [DS_Bulk]' in sql
    assert 'TYPE = BLOB_STORAGE' in sql


def test_best_practices_includes_platform_methods():
    """Best practices should list recommended loading methods for the platform."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'x.csv',
        'encoding': 'utf-8', 'file_size': 1024,
    }
    bp = gen.generate_best_practices(meta, target_platform='sql_server_2022')
    assert 'CREATE EXTERNAL TABLE' in bp

    bp2 = gen.generate_best_practices(meta, target_platform='sql_server_2022')
    assert 'BULK INSERT' in bp2
    assert 'OPENROWSET' in bp2


# -------------------------------------------------------------------
# New tests: Azure SQL DB OPENROWSET, schema overrides, storage_url
# -------------------------------------------------------------------

def test_openrowset_azure_sql_db_json():
    """Whole-document JSON uses the BLOB_STORAGE `_Bulk` source + SINGLE_CLOB.

    Live certification (Azure SQL DB and SQL Server 2025, public blob
    ``azcliprod/cli/vm/aliases.json``) proved SINGLE_CLOB *is* valid with a
    DATA_SOURCE whose TYPE is BLOB_STORAGE. The restriction applies only to
    the abs:// / adls:// virtualization connectors.
    """
    gen = SQLGenerator()
    meta = {
        'file_type': 'json', 'file_path': 'data.json',
        'schema': [('id', 'int64'), ('name', 'object')],
        'json_nesting': {'id': 'scalar', 'name': 'scalar'},
    }
    sql = gen.generate_openrowset(meta, data_source='LakeDS',
                                  target_platform='azure_sql_db')
    code = code_only(sql)
    assert 'SINGLE_CLOB' in code
    assert "DATA_SOURCE     = 'LakeDS_Bulk'" in code
    assert 'BulkColumn' in code
    assert 'OPENJSON' in sql
    # A whole JSON document is never row-framed.
    assert "FIELDQUOTE      = '0x0b'" not in code


def test_openrowset_azure_sql_mi():
    """OPENROWSET on Azure SQL MI uses data virtualization syntax."""
    gen = SQLGenerator()
    meta = {'file_type': 'csv', 'file_path': 'x.csv', 'schema': [('id', 'int64')]}
    sql = gen.generate_openrowset(meta, target_platform='azure_sql_mi')
    # The row-oriented read uses data virtualization; the single-LOB whole-file
    # read is the only place a TYPE = BLOB_STORAGE source may appear.
    assert 'BLOB_STORAGE' not in sql.split('-- ---- Whole file as one value')[0]
    assert 'DATA_SOURCE' in sql
    assert "FORMAT          = 'CSV'" in sql


def test_openrowset_azure_sql_mi_delta_unsupported():
    """Azure SQL MI has no Delta support."""
    gen = SQLGenerator()
    meta = {'file_type': 'delta', 'file_path': 'x', 'schema': [('id', 'int64')]}
    sql = gen.generate_openrowset(meta, target_platform='azure_sql_mi')
    assert 'Delta is NOT supported' in sql


def test_storage_url_in_openrowset():
    """Storage URL appears in OPENROWSET for CSV on SQL Server."""
    gen = SQLGenerator()
    meta = {'file_type': 'csv', 'file_path': 'x.csv', 'schema': [('id', 'int64')],
            'encoding': 'utf-8', 'delimiter': ',', 'has_header': True}
    sql = gen.generate_openrowset(meta, target_platform='sql_server_2022')
    assert 'OPENROWSET' in sql


def test_storage_url_in_copy_into():
    """Storage URL is injected into COPY INTO blob path."""
    gen = SQLGenerator()
    meta = {'file_type': 'csv', 'file_path': 'x.csv', 'schema': [('id', 'int64')],
            'encoding': 'utf-8', 'delimiter': ',', 'has_header': True}
    url = 'https://myaccount.blob.core.windows.net/data/x.csv'
    sql = gen.generate_copy_into(meta, 'tbl', storage_url=url, target_platform='sql_server_2022')
    assert 'NOT AVAILABLE' in sql or 'myaccount.blob.core.windows.net' in sql


def test_sql_type_overrides_in_column_definitions():
    """SQL type overrides are applied in _generate_column_definitions."""
    gen = SQLGenerator()
    meta = {
        'schema': [('id', 'int64'), ('name', 'object')],
        'nullable_columns': ['name'],
        'sql_type_overrides': {'name': 'VARCHAR(500)'},
    }
    cols = gen._generate_column_definitions(meta, include_nullability=True)
    assert any('VARCHAR(500)' in c for c in cols)


def test_sql_type_overrides_in_openjson_columns():
    """SQL type overrides are applied in _generate_openjson_columns."""
    gen = SQLGenerator()
    meta = {
        'schema': [('id', 'int64'), ('amount', 'float64')],
        'json_nesting': {'id': 'scalar', 'amount': 'scalar'},
        'sql_type_overrides': {'amount': 'DECIMAL(18,4)'},
    }
    cols = gen._generate_openjson_columns(meta)
    assert any('DECIMAL(18,4)' in c for c in cols)


def test_generate_all_statements_passes_storage_url():
    """generate_all_statements returns valid SQL for all keys."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'x.csv',
        'schema': [('id', 'int64')],
        'encoding': 'utf-8', 'delimiter': ',', 'has_header': True,
    }
    stmts = gen.generate_all_statements(meta, target_platform='sql_server_2022')
    assert 'OPENROWSET' in stmts['openrowset']
    assert 'BULK INSERT' in stmts['bulk_insert']


def test_fabric_sql_db_bulk_insert_alternatives():
    """Fabric SQL DB has no BULK INSERT and offers OPENROWSET alternatives."""
    gen = SQLGenerator()
    meta = {'file_type': 'csv', 'file_path': 'x.csv', 'schema': [('id', 'int64')],
            'delimiter': ',', 'has_header': True}
    sql = gen.generate_bulk_insert(meta, target_platform='fabric_sql_db')
    assert 'FROM OPENROWSET(' in sql
    assert 'COPY INTO' not in sql
    assert 'Synapse' not in sql


# -------------------------------------------------------------------
# Sample data comments
# -------------------------------------------------------------------

def test_sample_rows_in_create_table():
    """CREATE TABLE should include sample rows as comments."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'test.csv',
        'schema': [('id', 'int64'), ('name', 'object')],
        'sample_rows': [[1, 'Alice'], [2, 'Bob']],
    }
    sql = gen.generate_create_table(meta, 'tbl', target_platform='sql_server_2022')
    assert '-- Sample data' in sql
    assert 'Alice' in sql
    assert 'Bob' in sql


def test_sample_rows_truncated_for_wide_tables():
    """Sample rows should be truncated to 8 columns for wide tables."""
    gen = SQLGenerator()
    cols = [(f'col_{i}', 'int64') for i in range(20)]
    rows = [list(range(20)), list(range(20, 40))]
    meta = {
        'file_type': 'csv', 'file_path': 'wide.csv',
        'schema': cols,
        'sample_rows': rows,
    }
    sql = gen.generate_create_table(meta, 'wide_tbl', target_platform='sql_server_2022')
    assert '-- Sample data' in sql
    assert '12 more' in sql
    assert '...' in sql


def test_json_sample_values_in_create_table():
    """CREATE TABLE for JSON should include sample values."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'json', 'file_path': 'data.json',
        'schema': [('id', 'int'), ('name', 'str')],
        'json_sample_values': {'id': 1, 'name': 'Alice'},
    }
    sql = gen.generate_create_table(meta, 'tbl', target_platform='sql_server_2022')
    assert '-- Sample data (first record)' in sql
    assert 'id: 1' in sql
    assert 'name: Alice' in sql


def test_credential_setup_in_all_statements():
    """generate_all_statements should include credential_setup."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'test.csv',
        'schema': [('id', 'int64')],
        'delimiter': ',', 'has_header': True,
        'encoding': 'utf-8', 'codepage': '65001',
    }
    stmts = gen.generate_all_statements(meta)
    assert 'credential_setup' in stmts
    setup = stmts['credential_setup']
    # Managed identity is the default, so no master key is emitted.
    assert (
        "IDENTITY = 'MANAGED IDENTITY'" in setup or 'NOT AVAILABLE' in setup
    )


def test_all_statements_object_name_overrides():
    """Every generated object name can be overridden by the caller.

    This is what lets a run confine its objects to a disposable prefix instead
    of writing into dbo, where real tables such as the TPC-H `orders` table
    live.
    """
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'orders.csv',
        'schema': [('id', 'int64')],
        'delimiter': ',', 'has_header': True, 'encoding': 'utf-8',
    }
    stmts = gen.generate_all_statements(
        meta,
        table_name='sqlfdt_cert_abc_tbl',
        schema_name='sqlfdt_cert_abc',
        data_source='sqlfdt_cert_abc_ds',
        format_name='sqlfdt_cert_abc_fmt',
        external_table_name='sqlfdt_cert_abc_ext',
        credential_name='sqlfdt_cert_abc_cred',
        target_platform='azure_sql_db',
        storage_url='https://acct.blob.core.windows.net/raw/orders.csv',
    )
    joined = '\n'.join(stmts.values())
    code = '\n'.join(
        line for line in joined.split('\n')
        if not line.lstrip().startswith('--')
    )
    assert 'ff_csv_format' not in code
    assert 'ext_orders' not in code
    assert 'cred_sqlfdt_cert_abc_ds' not in code
    assert '[dbo]' not in code
    assert 'sqlfdt_cert_abc_fmt' in stmts['external_file_format']
    assert 'sqlfdt_cert_abc_ext' in stmts['create_external_table']
    assert 'sqlfdt_cert_abc_cred' in stmts['credential_setup']


# -------------------------------------------------------------------
# Type mapping accuracy
# -------------------------------------------------------------------

def test_int8_maps_to_smallint_and_uint8_to_tinyint():
    """Arrow int8 is signed and cannot use TINYINT (0-255)."""
    gen = SQLGenerator()
    assert gen._map_type_to_sql('int8') == 'SMALLINT'
    assert gen._map_type_to_sql('uint8') == 'TINYINT'


def test_structural_types_map_to_nvarchar_max():
    """Struct/list/map/union types are serialised as text."""
    gen = SQLGenerator()
    for arrow_type in (
        'struct<a: int64, b: string>',
        'list<item: int64>',
        'large_list<item: string>',
        'fixed_size_list<item: int64>[4]',
        'map<string, int64>',
        'dense_union<a: int64>',
    ):
        assert gen._map_type_to_sql(arrow_type) == 'NVARCHAR(MAX)', arrow_type


def test_nested_string_type_does_not_become_bigint():
    """A nested type containing int64 must not fall back to BIGINT."""
    gen = SQLGenerator()
    assert gen._map_type_to_sql('list<item: int64>') == 'NVARCHAR(MAX)'
    assert gen._map_type_to_sql('struct<id: int64>') == 'NVARCHAR(MAX)'


def test_decimal_precision_and_scale_preserved():
    gen = SQLGenerator()
    assert gen._map_type_to_sql('decimal128(18,4)') == 'DECIMAL(18,4)'
    assert gen._map_type_to_sql('decimal256(20,2)') == 'DECIMAL(20,2)'
    assert gen._map_type_to_sql('decimal(10,2)') == 'DECIMAL(10,2)'
    assert gen._map_type_to_sql('numeric(9,3)') == 'DECIMAL(9,3)'
    assert gen._map_type_to_sql('decimal128(38,0)') == 'DECIMAL(38,0)'


def test_decimal_out_of_range_or_negative_scale_is_safe():
    gen = SQLGenerator()
    assert gen._map_type_to_sql('decimal256(50,4)') == 'NVARCHAR(MAX)'
    # Negative scale is absorbed into the precision budget.
    assert gen._map_type_to_sql('decimal128(10,-2)') == 'DECIMAL(12,0)'
    assert gen._map_type_to_sql('decimal128(38,-4)') == 'NVARCHAR(MAX)'


def test_timestamp_units_and_timezone():
    gen = SQLGenerator()
    assert gen._map_type_to_sql('timestamp[s]') == 'DATETIME2(0)'
    assert gen._map_type_to_sql('timestamp[ms]') == 'DATETIME2(3)'
    assert gen._map_type_to_sql('timestamp[us]') == 'DATETIME2(6)'
    assert gen._map_type_to_sql('timestamp[ns]') == 'DATETIME2(7)'
    assert gen._map_type_to_sql('timestamp[us, tz=UTC]') == 'DATETIMEOFFSET(6)'
    assert gen._map_type_to_sql('timestamp[ns, tz=UTC]') == 'DATETIMEOFFSET(7)'
    assert gen._map_type_to_sql('datetime64[ns]') == 'DATETIME2(7)'


# -------------------------------------------------------------------
# Remote SQL Server OPENROWSET routing
# -------------------------------------------------------------------

def test_openrowset_sql_server_2022_remote_csv_uses_data_source():
    """Remote CSV on 2022 must use a relative BULK path + DATA_SOURCE."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'orders.csv', 'file_name': 'orders.csv',
        'schema': [('id', 'int64')], 'encoding': 'utf-8', 'codepage': '65001',
        'delimiter': ',', 'has_header': True,
    }
    sql = gen.generate_openrowset(
        meta,
        storage_url='abfss://raw@acct.dfs.core.windows.net/landing/orders.csv',
        data_source='LakeDS', target_platform='sql_server_2022')
    assert "BULK 'landing/orders.csv'" in sql
    assert "DATA_SOURCE     = 'LakeDS'" in sql
    assert "FORMATFILE" not in sql
    assert "BULK N'" not in sql


def test_openrowset_sql_server_2022_remote_json_uses_data_source():
    gen = SQLGenerator()
    meta = {
        'file_type': 'json', 'file_path': 'orders.json',
        'file_name': 'orders.json',
        'schema': [('id', 'int64')], 'json_nesting': {'id': 'scalar'},
    }
    sql = gen.generate_openrowset(
        meta,
        storage_url='abfss://raw@acct.dfs.core.windows.net/landing/orders.json',
        data_source='LakeDS', target_platform='sql_server_2022')
    assert "BULK 'landing/orders.json'" in sql
    assert "DATA_SOURCE     = 'LakeDS_Bulk'" in sql
    # Live evidence: SINGLE_CLOB is valid with a TYPE = BLOB_STORAGE source.
    assert 'SINGLE_CLOB' in code_only(sql)
    assert 'BulkColumn' in code_only(sql)
    assert 'OPENJSON' in sql
    assert "BULK N'" not in sql


def test_openrowset_sql_server_2019_remote_gives_staging_guidance():
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'orders.csv', 'file_name': 'orders.csv',
        'schema': [('id', 'int64')], 'delimiter': ',', 'has_header': True,
    }
    sql = gen.generate_openrowset(
        meta, storage_url='s3://bucket/landing/orders.csv',
        target_platform='sql_server_2019')
    assert 'cannot read this object storage URL' in sql
    assert "BULK N'https://" not in sql
    assert "BULK 's3://" not in sql
    assert 'SQL Server 2022' in sql
    assert 'TYPE = BLOB_STORAGE' in sql


def test_openrowset_sql_server_2019_azure_blob_uses_bulk_data_source():
    """SQL Server 2017+ can bulk-read Azure Blob via TYPE = BLOB_STORAGE."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'orders.csv', 'file_name': 'orders.csv',
        'schema': [('id', 'int64')], 'delimiter': ',', 'has_header': True,
        'encoding': 'utf-8', 'codepage': '65001',
    }
    sql = gen.generate_openrowset(
        meta,
        storage_url='https://acct.blob.core.windows.net/raw/landing/orders.csv',
        data_source='LakeDS', target_platform='sql_server_2019')
    assert "BULK 'landing/orders.csv'" in sql
    assert "DATA_SOURCE     = 'LakeDS_Bulk'" in sql
    assert "FIRSTROW        = 2" in sql
    # An absolute URL must never appear as a BULK path.
    assert "BULK 'https://" not in sql
    assert "BULK N'https://" not in sql


def test_openrowset_local_still_used_without_storage_url():
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': r'C:\data\orders.csv',
        'schema': [('id', 'int64')], 'delimiter': ',', 'has_header': True,
        'encoding': 'utf-8', 'codepage': '65001',
    }
    sql = gen.generate_openrowset(meta, target_platform='sql_server_2022')
    assert "BULK N'C:/data/orders.csv'" in sql
    assert 'DATA_SOURCE' not in sql


def test_azure_url_never_used_as_bulk_insert_path():
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'orders.csv', 'file_name': 'orders.csv',
        'schema': [('id', 'int64')], 'delimiter': ',', 'has_header': True,
        'encoding': 'utf-8', 'codepage': '65001',
    }
    sql = gen.generate_bulk_insert(
        meta, 'orders',
        storage_url='https://acct.blob.core.windows.net/raw/landing/orders.csv',
        data_source='LakeDS', target_platform='azure_sql_db')
    assert "FROM 'landing/orders.csv'" in sql
    assert "DATA_SOURCE     = 'LakeDS_Bulk'" in sql
    assert 'TYPE = BLOB_STORAGE' in sql
    assert "FROM 'https://" not in sql


def test_internal_azure_scheme_url_is_split():
    """azure://container/path from the storage handler must not leak."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'parquet', 'file_path': 'orders.parquet',
        'file_name': 'orders.parquet', 'schema': [('id', 'int64')],
    }
    sql = gen.generate_openrowset(
        meta, storage_url='azure://raw/landing/orders.parquet',
        data_source='LakeDS', target_platform='sql_server_2022')
    assert "BULK 'landing/orders.parquet'" in sql
    assert 'azure://' not in sql


# -------------------------------------------------------------------
# Best-practice validation SQL targets the real table
# -------------------------------------------------------------------

def test_best_practices_validation_uses_resolved_table_and_schema():
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': '2024 sales.csv',
        'file_name': '2024 sales.csv', 'schema': [('id', 'int64')],
        'encoding': 'utf-8', 'file_size': 1024,
    }
    stmts = gen.generate_all_statements(meta, table_name='2024 sales',
                                        schema_name='staging')
    assert 'CREATE TABLE [staging].[col_2024_sales]' in stmts['create_table']
    assert ('SELECT COUNT(*) AS loaded_rows FROM [staging].[col_2024_sales];'
            in stmts['best_practices'])
    assert 'CREATE EXTERNAL TABLE [staging].[ext_col_2024_sales]' in \
        stmts['create_external_table']


def test_complete_ddl_has_distinct_regular_and_external_tables():
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'orders.csv', 'file_name': 'orders.csv',
        'schema': [('id', 'int64')], 'encoding': 'utf-8', 'codepage': '65001',
        'delimiter': ',', 'has_header': True, 'file_size': 1024,
    }
    script = gen.generate_complete_ddl(meta, table_name='orders',
                                       data_source='LakeDS')
    assert 'CREATE TABLE [dbo].[orders]' in script
    assert 'CREATE EXTERNAL TABLE [dbo].[ext_orders]' in script
    assert '\nGO\nGO' not in script
    assert script.count('CREATE TABLE [dbo].[orders]') == 1


def test_complete_ddl_contains_all_sections():
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'orders.csv', 'file_name': 'orders.csv',
        'schema': [('id', 'int64')], 'encoding': 'utf-8', 'codepage': '65001',
        'delimiter': ',', 'has_header': True, 'file_size': 1024,
    }
    script = gen.generate_complete_ddl(meta, target_platform='sql_server_2022')
    for marker in ('PREREQUISITE SETUP', 'CREATE EXTERNAL FILE FORMAT',
                   'CREATE EXTERNAL TABLE', 'CREATE TABLE', 'BULK INSERT',
                   'OPENROWSET', 'FOR JSON',
                   'BEST PRACTICES', 'COPY INTO'):
        assert marker in script, marker
    # The JSON parse / DML section is gated to JSON input.
    assert 'JSON FUNCTIONS' not in script


def test_complete_ddl_includes_json_functions_for_json_input():
    gen = SQLGenerator()
    meta = {
        'file_type': 'json', 'file_path': 'orders.json',
        'file_name': 'orders.json', 'json_format': 'array',
        'schema': [('id', 'int64')], 'json_nesting': {'id': 'scalar'},
        'encoding': 'utf-8', 'file_size': 1024,
    }
    script = gen.generate_complete_ddl(meta, target_platform='sql_server_2022')
    assert 'JSON FUNCTIONS' in script


def test_complete_ddl_declares_json_variable_at_most_once_per_batch():
    """Two DECLARE @json statements in one batch would fail to compile."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'json', 'file_path': 'orders.json',
        'file_name': 'orders.json', 'json_format': 'array',
        'schema': [('id', 'int64')], 'json_nesting': {'id': 'scalar'},
        'encoding': 'utf-8', 'file_size': 1024,
    }
    for platform in SQLGenerator.PLATFORMS:
        script = gen.generate_complete_ddl(
            meta, target_platform=platform,
            storage_url='abs://raw@acct.blob.core.windows.net/landing/orders.json')
        for batch in script.split('\nGO\n'):
            assert batch.count('DECLARE @json ') <= 1, platform


def test_complete_ddl_does_not_duplicate_bulk_data_source():
    """The _Bulk BLOB_STORAGE source must be created exactly once."""
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'orders.csv', 'file_name': 'orders.csv',
        'schema': [('id', 'int64')], 'encoding': 'utf-8', 'codepage': '65001',
        'delimiter': ',', 'has_header': True, 'file_size': 1024,
    }
    script = gen.generate_complete_ddl(
        meta, table_name='orders', data_source='LakeDS',
        target_platform='azure_sql_db',
        storage_url='https://acct.blob.core.windows.net/raw/landing/orders.csv')
    assert script.count('CREATE EXTERNAL DATA SOURCE [LakeDS_Bulk]') == 1
    assert script.count('CREATE DATABASE SCOPED CREDENTIAL [cred_LakeDS_Bulk]') == 1
    assert script.count('CREATE EXTERNAL DATA SOURCE [LakeDS]') == 1
    # The BULK INSERT section still references it.
    assert "DATA_SOURCE     = 'LakeDS_Bulk'" in script


def test_bulk_insert_standalone_still_includes_prereq():
    gen = SQLGenerator()
    meta = {
        'file_type': 'csv', 'file_path': 'orders.csv', 'file_name': 'orders.csv',
        'schema': [('id', 'int64')], 'encoding': 'utf-8', 'codepage': '65001',
        'delimiter': ',', 'has_header': True,
    }
    sql = gen.generate_bulk_insert(
        meta, 'orders', target_platform='azure_sql_db', data_source='LakeDS',
        storage_url='https://acct.blob.core.windows.net/raw/landing/orders.csv')
    assert 'CREATE EXTERNAL DATA SOURCE [LakeDS_Bulk]' in sql


if __name__ == '__main__':
    import sys
    import pytest
    sys.exit(pytest.main([__file__, '-v']))