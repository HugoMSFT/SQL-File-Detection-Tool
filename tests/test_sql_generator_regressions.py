"""Regression tests for the platform-accuracy fixes in the SQL generator.

Each test here pins a behaviour that was previously wrong and would silently
produce a script that fails when executed against the target platform.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from external_file_detection.external_file_detector import (  # noqa: E402
    ExternalFileDetectorApp,
)
from external_file_detection.sql_generator import (  # noqa: E402
    SQLGenerator,
    _delta_table_folder,
)

AZURE_URL = 'https://acct.blob.core.windows.net/raw/landing/orders.csv'
ADLS_URL = 'abfss://raw@acct.dfs.core.windows.net/landing/orders.csv'
S3_URL = 's3://bucket/landing/orders.csv'


def code_only(sql):
    """Drop whole-line ``--`` comments so assertions see executable SQL only."""
    return '\n'.join(
        line for line in sql.splitlines()
        if not line.strip().startswith('--')
    )


def csv_meta(**overrides):
    meta = {
        'file_type': 'csv',
        'file_path': 'orders.csv',
        'file_name': 'orders.csv',
        'schema': [('id', 'int64'), ('name', 'object')],
        'delimiter': ',',
        'has_header': True,
        'encoding': 'utf-8',
        'codepage': '65001',
        'file_size': 2048,
    }
    meta.update(overrides)
    return meta


# ---------------------------------------------------------------------------
# Fix 1 / 5: remote BULK paths use a TYPE = BLOB_STORAGE data source
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('platform',
                         ['sql_server_2019', 'sql_server_2022', 'sql_server_2025'])
def test_bulk_insert_azure_uses_relative_path_and_bulk_source(platform):
    gen = SQLGenerator()
    sql = gen.generate_bulk_insert(
        csv_meta(), 'orders', target_platform=platform,
        storage_url=AZURE_URL, data_source='LakeDS')

    assert "FROM 'landing/orders.csv'" in sql
    assert "DATA_SOURCE     = 'LakeDS_Bulk'" in sql
    assert 'TYPE = BLOB_STORAGE' in sql
    assert ("LOCATION = 'https://acct.blob.core.windows.net/raw'" in sql)
    # The absolute URL must never be used as the BULK/FROM path itself.
    assert "FROM 'https://" not in sql
    assert "FROM N'https://" not in sql


@pytest.mark.parametrize('platform',
                         ['sql_server_2019', 'sql_server_2022', 'sql_server_2025'])
def test_bulk_insert_s3_never_emits_url_as_path(platform):
    gen = SQLGenerator()
    sql = gen.generate_bulk_insert(
        csv_meta(), 'orders', target_platform=platform,
        storage_url=S3_URL, data_source='LakeDS')

    assert "FROM 's3://" not in sql
    assert "FROM N's3://" not in sql
    assert 'cannot read S3-compatible object storage' in sql
    assert 'DATA_SOURCE' not in code_only(sql)


def test_bulk_insert_sql_server_2019_s3_has_no_openrowset_promise():
    """S3 bulk access starts at SQL Server 2022, so 2019 must not suggest it."""
    gen = SQLGenerator()
    sql = gen.generate_bulk_insert(
        csv_meta(), 'orders', target_platform='sql_server_2019',
        storage_url=S3_URL, data_source='LakeDS')
    assert 'Use OPENROWSET with an s3:// data source' not in sql


def test_credential_setup_adds_bulk_source_for_sql_server_azure():
    gen = SQLGenerator()
    sql = gen.generate_credential_setup(
        'LakeDS', metadata=csv_meta(), target_platform='sql_server_2022',
        storage_url=ADLS_URL)
    assert 'CREATE EXTERNAL DATA SOURCE [LakeDS]' in sql
    assert 'CREATE EXTERNAL DATA SOURCE [LakeDS_Bulk]' in sql
    assert 'TYPE = BLOB_STORAGE' in sql


def test_credential_setup_has_no_bulk_source_for_local_files():
    gen = SQLGenerator()
    sql = gen.generate_credential_setup(
        'LakeDS', metadata=csv_meta(), target_platform='sql_server_2022')
    assert 'LakeDS_Bulk' not in sql


def test_credential_setup_2019_keeps_hadoop_source_for_external_tables():
    """TYPE = BLOB_STORAGE cannot back an external table, so both are emitted."""
    gen = SQLGenerator()
    sql = gen.generate_credential_setup(
        'LakeDS', metadata=csv_meta(), target_platform='sql_server_2019',
        storage_url=AZURE_URL)
    assert 'TYPE = HADOOP' in sql
    assert 'TYPE = BLOB_STORAGE' in sql
    assert 'CREATE EXTERNAL DATA SOURCE [LakeDS_Bulk]' in sql


# ---------------------------------------------------------------------------
# Fix 3: Delta relative paths point at the table folder
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('relative_path,expected', [
    ('sales', 'sales/'),
    ('sales/', 'sales/'),
    ('warehouse/sales_delta', 'warehouse/sales_delta/'),
    ('a/b/c', 'a/b/c/'),
    ('', '<delta_table_folder>/'),
    ('/', '<delta_table_folder>/'),
])
def test_delta_table_folder(relative_path, expected):
    assert _delta_table_folder(relative_path) == expected


@pytest.mark.parametrize('platform,url', [
    ('azure_sql_db', 'abs://raw@acct.blob.core.windows.net/sales_delta'),
    ('sql_server_2022', 'abfss://raw@acct.dfs.core.windows.net/sales_delta'),
])
def test_delta_openrowset_uses_table_folder_at_container_root(platform, url):
    gen = SQLGenerator()
    meta = {
        'file_type': 'delta', 'file_path': 'sales_delta',
        'file_name': 'sales_delta', 'schema': [('id', 'int64')],
    }
    sql = gen.generate_openrowset(meta, storage_url=url,
                                  data_source='LakeDS',
                                  target_platform=platform)
    assert "BULK 'sales_delta/'" in sql
    assert "BULK ''" not in sql


@pytest.mark.parametrize('platform,url', [
    ('azure_sql_db',
     'abs://raw@acct.blob.core.windows.net/warehouse/sales_delta'),
    ('sql_server_2022',
     'abfss://raw@acct.dfs.core.windows.net/warehouse/sales_delta'),
])
def test_delta_openrowset_uses_nested_table_folder(platform, url):
    gen = SQLGenerator()
    meta = {
        'file_type': 'delta', 'file_path': 'sales_delta',
        'file_name': 'sales_delta', 'schema': [('id', 'int64')],
    }
    sql = gen.generate_openrowset(meta, storage_url=url,
                                  data_source='LakeDS',
                                  target_platform=platform)
    assert "BULK 'warehouse/sales_delta/'" in sql
    # The parent folder alone would read the sibling tables too.
    assert "BULK 'warehouse/'" not in sql


# ---------------------------------------------------------------------------
# Fix 7: contextual identifier escaping for <data_source>_Bulk
# ---------------------------------------------------------------------------

def test_bulk_source_name_escaped_once_per_context():
    gen = SQLGenerator()
    sql = gen.generate_bulk_insert(
        csv_meta(), 'orders', target_platform='azure_sql_db',
        storage_url=AZURE_URL, data_source='Lake]DS')

    # Bracket identifiers double the closing bracket exactly once.
    assert 'CREATE EXTERNAL DATA SOURCE [Lake]]DS_Bulk]' in sql
    assert 'CREATE DATABASE SCOPED CREDENTIAL [cred_Lake]]DS_Bulk]' in sql
    # A string literal keeps the raw name; only quotes would be doubled.
    assert "DATA_SOURCE     = 'Lake]DS_Bulk'" in sql
    assert 'Lake]]]]DS' not in sql


def test_bulk_source_name_with_quote_is_literal_escaped():
    gen = SQLGenerator()
    sql = gen.generate_bulk_insert(
        csv_meta(), 'orders', target_platform='azure_sql_db',
        storage_url=AZURE_URL, data_source="Lake'DS")
    assert "DATA_SOURCE     = 'Lake''DS_Bulk'" in sql
    assert "CREATE EXTERNAL DATA SOURCE [Lake'DS_Bulk]" in sql


def test_credential_setup_bulk_source_escaping():
    gen = SQLGenerator()
    sql = gen.generate_credential_setup(
        'Lake]DS', metadata=csv_meta(), target_platform='azure_sql_db',
        storage_url=AZURE_URL)
    assert 'CREATE EXTERNAL DATA SOURCE [Lake]]DS_Bulk]' in sql
    assert 'Lake]]]]DS' not in sql


# ---------------------------------------------------------------------------
# Fix 8: FIRST_ROW gating in CREATE EXTERNAL FILE FORMAT
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('platform', ['sql_server_2022', 'sql_server_2025',
                                      'fabric_sql_db'])
def test_first_row_emitted_where_supported(platform):
    gen = SQLGenerator()
    sql = gen.generate_external_file_format(
        csv_meta(), 'ff_csv', target_platform=platform)
    assert 'FIRST_ROW = 2' in sql


@pytest.mark.parametrize('platform', ['sql_server_2019', 'azure_sql_mi'])
def test_first_row_not_emitted_where_unsupported(platform):
    gen = SQLGenerator()
    sql = gen.generate_external_file_format(
        csv_meta(), 'ff_csv', target_platform=platform)
    assert 'FIRST_ROW = 2' not in code_only(sql)
    assert 'FIRST_ROW is not a FORMAT_OPTIONS option' in sql


def test_openrowset_keeps_firstrow_without_underscore():
    """FIRSTROW is a different, supported OPENROWSET / BULK INSERT option."""
    gen = SQLGenerator()
    sql = gen.generate_openrowset(
        csv_meta(), storage_url='abs://raw@acct.blob.core.windows.net/orders.csv',
        data_source='LakeDS', target_platform='azure_sql_db')
    assert 'FIRSTROW        = 2' in sql
    assert 'FIRST_ROW' not in sql


# ---------------------------------------------------------------------------
# Fix 6: Fabric BULK INSERT alternatives carry the detected CSV options
# ---------------------------------------------------------------------------

def test_fabric_bulk_alternatives_include_detected_csv_options():
    gen = SQLGenerator()
    sql = gen.generate_bulk_insert(
        csv_meta(delimiter='\t'), 'orders', target_platform='fabric_sql_db',
        storage_url='https://onelake.dfs.fabric.microsoft.com/ws/lh.Lakehouse/Files/orders.csv',
        data_source='LakeDS')
    assert 'FIRSTROW        = 2' in sql
    assert "FIELDTERMINATOR = '\\t'" in sql
    assert "CODEPAGE        = '65001'" in sql
    # An untyped SELECT * into a typed table is a data-loss trap.
    assert 'SELECT *' not in sql
    assert '[id], [name]' in sql
    assert 'WITH (' in sql


def test_fabric_bulk_alternatives_never_mention_bulk_insert_statement():
    gen = SQLGenerator()
    sql = gen.generate_bulk_insert(
        csv_meta(), 'orders', target_platform='fabric_sql_db',
        data_source='LakeDS')
    assert 'NOT AVAILABLE on Microsoft Fabric SQL Database' in sql
    assert 'COPY INTO' not in sql
    assert 'PARSER_VERSION' not in sql
    assert 'HEADER_ROW' not in sql
    assert 'Synapse' not in sql


# ---------------------------------------------------------------------------
# Fix 11: best-practice validation queries use the resolved table name
# ---------------------------------------------------------------------------

def test_best_practices_uses_caller_table_name_verbatim():
    gen = SQLGenerator()
    bp = gen.generate_best_practices(
        csv_meta(), target_platform='sql_server_2022',
        table_name='Orders_2024', schema_name='staging')
    assert 'FROM [staging].[Orders_2024];' in bp


def test_best_practices_cleans_derived_leading_digit_name():
    gen = SQLGenerator()
    bp = gen.generate_best_practices(
        csv_meta(file_name='2024 sales.csv'),
        target_platform='sql_server_2022')
    assert '[col_2024_sales]' in bp


def test_complete_ddl_validation_matches_create_table():
    gen = SQLGenerator()
    script = gen.generate_complete_ddl(
        csv_meta(file_path='2024 sales.csv', file_name='2024 sales.csv'),
        target_platform='sql_server_2022')
    assert 'CREATE TABLE [dbo].[col_2024_sales]' in script
    assert 'FROM [dbo].[col_2024_sales];' in script


# ---------------------------------------------------------------------------
# Fix 2: multi-file export deduplicates shared prerequisite objects
# ---------------------------------------------------------------------------

def _shared_object_counts(script):
    return {
        'master_key': script.count('CREATE MASTER KEY'),
        'credential': script.count('CREATE DATABASE SCOPED CREDENTIAL [cred_LakeDS]'),
        'data_source': script.count('CREATE EXTERNAL DATA SOURCE [LakeDS]'),
        'file_format': script.count('CREATE EXTERNAL FILE FORMAT [ff_csv_format]'),
    }


def test_two_file_export_creates_shared_objects_once(tmp_path):
    gen = SQLGenerator()
    first = gen.generate_complete_ddl(
        csv_meta(file_path='orders.csv', file_name='orders.csv'),
        table_name='orders', data_source='LakeDS',
        target_platform='sql_server_2022', storage_url=ADLS_URL)
    second = gen.generate_complete_ddl(
        csv_meta(file_path='customers.csv', file_name='customers.csv'),
        table_name='customers', data_source='LakeDS',
        target_platform='sql_server_2022',
        storage_url='abfss://raw@acct.dfs.core.windows.net/landing/customers.csv')

    app = ExternalFileDetectorApp()
    results = {
        'location': str(tmp_path),
        'files_found': 2,
        'files': [
            {'file_path': 'orders.csv',
             'metadata': {'file_type': 'csv'}, 'sql_ddl': first},
            {'file_path': 'customers.csv',
             'metadata': {'file_type': 'csv'}, 'sql_ddl': second},
        ],
    }
    output = tmp_path / 'export.sql'
    app.export_results(results, str(output), format='sql')
    script = output.read_text(encoding='utf-8')

    counts = _shared_object_counts(script)
    assert counts == {
        # Managed identity is the default, so no master key is emitted at all.
        'master_key': 0, 'credential': 1, 'data_source': 1, 'file_format': 1
    }, counts
    # Both files still get their own table and load statements.
    assert 'CREATE TABLE [dbo].[orders]' in script
    assert 'CREATE TABLE [dbo].[customers]' in script
    assert script.count('CREATE EXTERNAL DATA SOURCE [LakeDS_Bulk]') == 1


def test_deduplicate_keeps_first_occurrence_only():
    gen = SQLGenerator()
    script = (
        'CREATE EXTERNAL FILE FORMAT [ff_a]\nWITH (FORMAT_TYPE = PARQUET);\n'
        'GO\n'
        'CREATE TABLE [dbo].[t1] ([id] INT);\n'
        'GO\n'
    )
    seen = set()
    first = gen.deduplicate_shared_prerequisites(script, seen)
    second = gen.deduplicate_shared_prerequisites(script, seen)
    assert 'CREATE EXTERNAL FILE FORMAT [ff_a]' in first
    assert 'CREATE EXTERNAL FILE FORMAT [ff_a]' not in second
    # File-specific statements survive in both.
    assert second.count('CREATE TABLE [dbo].[t1]') == 1


def test_deduplicate_does_not_split_on_go_inside_identifier():
    gen = SQLGenerator()
    script = "SELECT [GO_STATUS], 'GO' AS x FROM [dbo].[t];\n"
    assert gen.deduplicate_shared_prerequisites(script) == script.strip()


# ---------------------------------------------------------------------------
# Cross-platform validation matrix
# ---------------------------------------------------------------------------

MATRIX_FILES = {
    'csv': csv_meta(),
    'parquet': {
        'file_type': 'parquet', 'file_path': 'orders.parquet',
        'file_name': 'orders.parquet', 'file_size': 4096,
        'schema': [('id', 'int64'), ('name', 'string')],
        'compression': 'SNAPPY',
    },
    'json': {
        'file_type': 'json', 'file_path': 'orders.json',
        'file_name': 'orders.json', 'file_size': 1024,
        'json_format': 'array', 'schema': [('id', 'int64')],
        'json_nesting': {'id': 'scalar'},
    },
    'delta': {
        'file_type': 'delta', 'file_path': 'orders_delta',
        'file_name': 'orders_delta', 'file_size': 8192,
        'schema': [('id', 'int64')],
        'delta_metadata': {'version': 0, 'partition_columns': []},
    },
}

MATRIX_URLS = {
    'csv': 'abs://raw@acct.blob.core.windows.net/landing/orders.csv',
    'parquet': 'abs://raw@acct.blob.core.windows.net/landing/orders.parquet',
    'json': 'abs://raw@acct.blob.core.windows.net/landing/orders.json',
    'delta': 'abs://raw@acct.blob.core.windows.net/warehouse/orders_delta',
}

# Text that must never appear in a generated script.
FORBIDDEN_MARKERS = (
    'PARSER_VERSION',
    'HEADER_ROW',
    'Synapse',
    'Dedicated SQL Pool',
)


@pytest.mark.parametrize('platform', SQLGenerator.PLATFORMS)
@pytest.mark.parametrize('file_type', sorted(MATRIX_FILES))
def test_platform_matrix_scripts_are_structurally_sound(platform, file_type):
    gen = SQLGenerator()
    script = gen.generate_complete_ddl(
        MATRIX_FILES[file_type], table_name='orders', data_source='LakeDS',
        target_platform=platform, storage_url=MATRIX_URLS[file_type])

    executable = code_only(script)

    # 1. No absolute remote URL used as a BULK / FROM path.
    for prefix in ("BULK '", "BULK N'", "FROM '", "FROM N'"):
        for scheme in ('https://', 'http://', 's3://', 'abs://', 'adls://',
                       'abfss://', 'wasbs://'):
            assert f'{prefix}{scheme}' not in executable, (
                platform, file_type, prefix, scheme)

    # 2. Never an empty BULK path.
    assert "BULK ''" not in executable
    assert "BULK N''" not in executable

    # 3. Shared prerequisite objects are created at most once.
    for statement in ('CREATE MASTER KEY',
                      'CREATE DATABASE SCOPED CREDENTIAL [cred_LakeDS]',
                      'CREATE EXTERNAL DATA SOURCE [LakeDS]',
                      'CREATE EXTERNAL DATA SOURCE [LakeDS_Bulk]'):
        assert executable.count(statement) <= 1, (platform, file_type, statement)

    # 4. At most one DECLARE @json per batch.
    for batch in script.split('\nGO\n'):
        assert batch.count('DECLARE @json ') <= 1, (platform, file_type)

    # 5. JSON parse/DML section only for JSON input.
    if file_type != 'json':
        assert 'JSON FUNCTIONS' not in script, (platform, file_type)

    # 6. Single-LOB readers only ever appear with a TYPE = BLOB_STORAGE data
    #    source (the "_Bulk" one), never with an abs:// / adls:// virtualization
    #    source. Live certification on Azure SQL Database and SQL Server 2025
    #    proved SINGLE_CLOB works through a BLOB_STORAGE source, and that the
    #    virtualization connectors are the ones that reject it.
    for batch in executable.split('\n\n'):
        if 'DATA_SOURCE' not in batch:
            continue
        for reader in ('SINGLE_CLOB', 'SINGLE_NCLOB', 'SINGLE_BLOB'):
            if reader in batch:
                assert '_Bulk' in batch, (platform, file_type, reader)

    # 7. No stale product guidance.
    for marker in FORBIDDEN_MARKERS:
        assert marker not in script, (platform, file_type, marker)

    # 8. S3 is never recommended for an Azure SQL / Fabric target.
    if platform in ('azure_sql_db', 'azure_sql_mi', 'fabric_sql_db'):
        assert 's3://' not in script, (platform, file_type)


@pytest.mark.parametrize('platform', SQLGenerator.PLATFORMS)
def test_platform_matrix_local_files_have_no_data_source_bulk(platform):
    """A local file must not reference a bulk data source that is never made."""
    gen = SQLGenerator()
    script = gen.generate_complete_ddl(
        csv_meta(), table_name='orders', data_source='LakeDS',
        target_platform=platform)
    if 'LakeDS_Bulk' in script:
        assert 'CREATE EXTERNAL DATA SOURCE [LakeDS_Bulk]' in script


# -- absent metadata ---------------------------------------------------------

# Fields that feed string operations somewhere in the generator. A detection
# result routinely carries these keys with ``None``: a Parquet file has no
# delimiter, an undecided CSV probe has no quote character, and a caller
# building metadata by hand rarely fills in every key.
OPTIONAL_TEXT_FIELDS = (
    'file_name', 'file_type', 'encoding', 'delimiter', 'has_header',
    'file_size', 'row_count', 'compression', 'columns', 'json_format',
    'sheet_name', 'quote_char',
)


def _complete_meta():
    return {
        'file_path': 'C:/data/sample.csv',
        'file_name': 'sample.csv',
        'file_type': 'csv',
        'encoding': 'utf-8',
        'delimiter': ',',
        'has_header': True,
        'file_size': 1024,
        'row_count': 10,
        'compression': None,
        'columns': [{'name': 'a', 'sql_type': 'INT', 'nullable': True}],
    }


@pytest.mark.parametrize('field', OPTIONAL_TEXT_FIELDS)
@pytest.mark.parametrize('mode', ('none', 'absent', 'empty'))
@pytest.mark.parametrize('platform', SQLGenerator.PLATFORMS)
def test_generation_survives_missing_metadata(field, mode, platform):
    """No single absent metadata field may abort a whole script.

    ``metadata.get(key, fallback)`` only falls back when the key is *absent*;
    a key present with ``None`` returned ``None`` and reached ``.upper()`` or
    an iteration. That crashed generation for a value that usually only feeds
    a comment.
    """
    meta = _complete_meta()
    if mode == 'none':
        meta[field] = None
    elif mode == 'empty':
        meta[field] = ''
    else:
        meta.pop(field, None)

    gen = SQLGenerator()
    statements = gen.generate_all_statements(meta, target_platform=platform)
    assert statements['create_table']
    assert gen.generate_complete_ddl(meta, target_platform=platform)
    assert gen.generate_best_practices(meta, target_platform=platform)


@pytest.mark.parametrize('value', (None, '', ','))
def test_delimiter_always_reads_as_a_comma_when_absent(value):
    """The exact crash the live certification plan hit, pinned per entry point."""
    meta = _complete_meta()
    meta['delimiter'] = value

    gen = SQLGenerator()
    guidance = gen.generate_best_practices(meta).splitlines()
    detected = [line for line in guidance if 'Detected:' in line]
    assert detected
    for line in detected:
        assert 'None' not in line, line
    assert any('comma-delimited' in line for line in detected)

    for script in (gen.generate_complete_ddl(meta),
                   '\n'.join(gen.generate_all_statements(meta).values())):
        assert "FIELDTERMINATOR = ','" in script
