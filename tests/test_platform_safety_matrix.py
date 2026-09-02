"""Permanent 6-platform safety matrix for generated storage SQL."""

import re

from external_file_detection.sql_generator import (
    SQLGenerator,
    _storage_url_supported_by_platform,
)


PLATFORMS = (
    'sql_server_2019',
    'sql_server_2022',
    'sql_server_2025',
    'azure_sql_db',
    'azure_sql_mi',
    'fabric_sql_db',
)

REMOTE_STATEMENTS = (
    'bulk_insert',
    'openrowset',
    'copy_into',
    'create_external_table',
    'json_functions',
    'credential_setup',
)

FORMATS = (
    ('csv', 'csv', 'orders.csv', {}),
    ('tsv', 'csv', 'orders.tsv', {'delimiter': '\t'}),
    ('dat', 'csv', 'orders.dat', {'delimiter': '|'}),
    ('text', 'text', 'orders.txt', {}),
    ('json', 'json', 'orders.json', {'json_format': 'array'}),
    ('ndjson', 'json', 'orders.jsonl', {'json_format': 'ndjson'}),
    ('parquet', 'parquet', 'orders.parquet', {}),
    ('delta', 'delta', 'orders_delta', {}),
    ('iceberg', 'iceberg', 'v1.metadata.json', {}),
    ('orc', 'orc', 'orders.orc', {}),
    ('rcfile', 'rc', 'orders.rc', {}),
)

LOCATIONS = (
    ('local', None, None),
    ('unc', None, r'\\server\share\orders'),
    ('abs', 'abs://raw@acct.blob.core.windows.net/landing/orders', None),
    ('adls', 'adls://raw@acct.dfs.core.windows.net/landing/orders', None),
    (
        'blob-https',
        'https://acct.blob.core.windows.net/raw/landing/orders',
        None,
    ),
    (
        'onelake',
        'abfss://workspace@onelake.dfs.fabric.microsoft.com/'
        'lakehouse.Lakehouse/Files/landing/orders',
        None,
    ),
    ('s3', 's3://s3.amazonaws.com/audit-bucket/landing/orders', None),
    (
        'lookalike-host',
        'abs://raw@acct.blob.core.windows.net.attacker.example/orders',
        None,
    ),
)


def executable_sql(sql):
    """Return SQL with whole-line comments and blanks removed."""
    return '\n'.join(
        line for line in sql.splitlines()
        if line.strip() and not line.lstrip().startswith('--')
    )


def metadata(file_type, file_name, extra):
    """Build one representative schema without sharing mutable values."""
    result = {
        'file_path': f'C:/audit/{file_name}',
        'file_name': file_name,
        'file_type': file_type,
        'file_size': 4096,
        'schema': [('id', 'int64'), ('name', 'string')],
        'max_string_lengths': {'name': 40},
        'nullable_columns': ['name'],
        'encoding': 'utf-8',
        'codepage': '65001',
        'delimiter': ',',
        'has_header': True,
        'json_typed_projection_safe': True,
    }
    result.update(extra)
    return result


def test_528_case_platform_format_location_matrix_is_safe():
    generator = SQLGenerator()
    failures = []
    cases = 0

    for platform in PLATFORMS:
        for format_name, file_type, file_name, extra in FORMATS:
            for location_name, storage_url, file_path in LOCATIONS:
                cases += 1
                context = f'{platform}/{format_name}/{location_name}'
                source = metadata(file_type, file_name, extra)
                if file_path:
                    source['file_path'] = f'{file_path}/{file_name}'
                statements = generator.generate_all_statements(
                    source,
                    target_platform=platform,
                    storage_url=storage_url,
                    data_source='AuditDS',
                    credential_name='AuditCredential',
                )

                for name, sql in statements.items():
                    if (
                        not isinstance(sql, str)
                        or not sql
                        or re.search(r'\b(?:undefined|NaN|\[object Object\])\b', sql)
                    ):
                        failures.append(f'{context}/{name}: invalid output')

                if not _storage_url_supported_by_platform(storage_url, platform):
                    for key in REMOTE_STATEMENTS:
                        if executable_sql(statements[key]):
                            failures.append(
                                f'{context}/{key}: incompatible storage is executable'
                            )
                        if 'NOT AVAILABLE' not in statements[key]:
                            failures.append(
                                f'{context}/{key}: incompatibility is not explicit'
                            )
                    continue

                if format_name in {'orc', 'rcfile', 'iceberg'}:
                    for key in ('bulk_insert', 'openrowset', 'json_functions'):
                        code = executable_sql(statements[key])
                        if re.search(r'\b(?:BULK INSERT|OPENROWSET)\b', code, re.I):
                            failures.append(
                                f'{context}/{key}: unsupported read is executable'
                            )
                        if re.search(r"FORMAT\s*=\s*'CSV'", statements[key], re.I):
                            failures.append(
                                f'{context}/{key}: binary/table source fell through to CSV'
                            )

                if format_name == 'ndjson':
                    for key in ('bulk_insert', 'openrowset', 'json_functions'):
                        framed_reads = [
                            block
                            for block in statements[key].split('FROM OPENROWSET(')[1:]
                            if re.search(r"FORMAT\s*=\s*'CSV'", block)
                        ]
                        for block in framed_reads:
                            if not re.search(r"ROWTERMINATOR\s*=\s*'0x0a'", block):
                                failures.append(
                                    f'{context}/{key}: NDJSON read lacks LF framing'
                                )

                if (
                    location_name == 's3'
                    and platform in {'sql_server_2022', 'sql_server_2025'}
                    and executable_sql(statements['credential_setup'])
                ):
                    if "IDENTITY = 'S3 ACCESS KEY'" not in statements['credential_setup']:
                        failures.append(f'{context}: S3 credential is not an access key')
                    if 'SHARED ACCESS SIGNATURE' in statements['credential_setup']:
                        failures.append(f'{context}: S3 credential fell back to SAS')

                if (
                    platform == 'sql_server_2019'
                    and location_name in {'abs', 'blob-https'}
                    and executable_sql(statements['credential_setup'])
                ):
                    main_start = statements['credential_setup'].find(
                        'CREATE DATABASE SCOPED CREDENTIAL [AuditCredential]'
                    )
                    main_end = statements['credential_setup'].find('GO', main_start)
                    main_credential = statements['credential_setup'][
                        main_start:main_end
                    ]
                    if '<storage_account_key>' not in main_credential:
                        failures.append(f'{context}: WASBS credential is not a storage key')
                    if 'SHARED ACCESS SIGNATURE' in main_credential:
                        failures.append(f'{context}: SQL Server 2019 WASBS uses SAS')

    assert cases == 528
    assert failures == []
