import assert from 'node:assert/strict';
import test from 'node:test';

import {
    generateAllStatements,
} from '../../native/sql/generator';
import {
    PLATFORMS,
} from '../../native/sql/typeMapping';
import {
    storageUrlSupportedByPlatform,
} from '../../native/sql/storage';
import type {
    GeneratorMetadata,
    StatementKind,
    TargetPlatform,
} from '../../native/types';

const REMOTE_STATEMENTS: readonly StatementKind[] = [
    'bulk_insert',
    'openrowset',
    'copy_into',
    'create_external_table',
    'json_functions',
    'credential_setup',
];

function executableSql(sql: string): string {
    return sql
        .split('\n')
        .filter((line) => line.trim() && !line.trimStart().startsWith('--'))
        .join('\n');
}

function metadata(
    fileType: NonNullable<GeneratorMetadata['file_type']>,
    fileName: string,
    extra: Partial<GeneratorMetadata> = {},
): GeneratorMetadata {
    return {
        file_path: `C:/audit/${fileName}`,
        file_name: fileName,
        file_type: fileType,
        file_size: 4096,
        schema: [
            ['id', 'int64'],
            ['name', 'string'],
        ],
        max_string_lengths: { name: 40 },
        nullable_columns: ['name'],
        encoding: 'utf-8',
        codepage: '65001',
        delimiter: ',',
        has_header: true,
        json_typed_projection_safe: true,
        ...extra,
    };
}

const FORMATS: ReadonlyArray<{
    readonly name: string;
    readonly build: () => GeneratorMetadata;
}> = [
    { name: 'csv', build: () => metadata('csv', 'orders.csv') },
    {
        name: 'tsv',
        build: () => metadata('csv', 'orders.tsv', { delimiter: '\t' }),
    },
    {
        name: 'dat',
        build: () => metadata('csv', 'orders.dat', { delimiter: '|' }),
    },
    { name: 'text', build: () => metadata('text', 'orders.txt') },
    {
        name: 'json',
        build: () => metadata('json', 'orders.json', { json_format: 'array' }),
    },
    {
        name: 'ndjson',
        build: () => metadata('json', 'orders.jsonl', { json_format: 'ndjson' }),
    },
    { name: 'parquet', build: () => metadata('parquet', 'orders.parquet') },
    { name: 'delta', build: () => metadata('delta', 'orders_delta') },
    { name: 'iceberg', build: () => metadata('iceberg', 'v1.metadata.json') },
    { name: 'orc', build: () => metadata('orc', 'orders.orc') },
    { name: 'rcfile', build: () => metadata('rc', 'orders.rc') },
];

const LOCATIONS: ReadonlyArray<{
    readonly name: string;
    readonly storageUrl: string | null;
    readonly filePath?: string;
}> = [
    { name: 'local', storageUrl: null },
    { name: 'unc', storageUrl: null, filePath: '\\\\server\\share\\orders' },
    {
        name: 'abs',
        storageUrl: 'abs://raw@acct.blob.core.windows.net/landing/orders',
    },
    {
        name: 'adls',
        storageUrl: 'adls://raw@acct.dfs.core.windows.net/landing/orders',
    },
    {
        name: 'blob-https',
        storageUrl: 'https://acct.blob.core.windows.net/raw/landing/orders',
    },
    {
        name: 'onelake',
        storageUrl:
            'abfss://workspace@onelake.dfs.fabric.microsoft.com/'
            + 'lakehouse.Lakehouse/Files/landing/orders',
    },
    {
        name: 's3',
        storageUrl: 's3://s3.amazonaws.com/audit-bucket/landing/orders',
    },
    {
        name: 'lookalike-host',
        storageUrl: 'abs://raw@acct.blob.core.windows.net.attacker.example/orders',
    },
];

function shouldSupport(platform: TargetPlatform, storageUrl: string | null): boolean {
    return storageUrlSupportedByPlatform(storageUrl, platform);
}

test('528-case platform/format/location matrix stays safe and internally consistent', () => {
    const failures: string[] = [];
    let cases = 0;

    for (const platform of PLATFORMS) {
        for (const format of FORMATS) {
            for (const location of LOCATIONS) {
                cases += 1;
                const context = `${platform}/${format.name}/${location.name}`;
                const source = format.build();
                if (location.filePath) {
                    source.file_path = `${location.filePath}/${source.file_name}`;
                }
                const statements = generateAllStatements(source, {
                    targetPlatform: platform,
                    storageUrl: location.storageUrl,
                    dataSource: 'AuditDS',
                    credentialName: 'AuditCredential',
                });

                for (const [name, sql] of Object.entries(statements)) {
                    if (
                        typeof sql !== 'string'
                        || sql.length === 0
                        || /\b(?:undefined|NaN|\[object Object\])\b/.test(sql)
                    ) {
                        failures.push(`${context}/${name}: invalid output`);
                    }
                }

                if (!shouldSupport(platform, location.storageUrl)) {
                    for (const key of REMOTE_STATEMENTS) {
                        if (executableSql(statements[key])) {
                            failures.push(`${context}/${key}: incompatible storage is executable`);
                        }
                        if (!/NOT AVAILABLE/.test(statements[key])) {
                            failures.push(`${context}/${key}: incompatibility is not explicit`);
                        }
                    }
                    continue;
                }

                if (['orc', 'rcfile', 'iceberg'].includes(format.name)) {
                    for (const key of ['bulk_insert', 'openrowset', 'json_functions'] as const) {
                        const code = executableSql(statements[key]);
                        if (/\b(?:BULK INSERT|OPENROWSET)\b/i.test(code)) {
                            failures.push(`${context}/${key}: unsupported read is executable`);
                        }
                        if (/FORMAT\s*=\s*'CSV'/i.test(statements[key])) {
                            failures.push(`${context}/${key}: binary/table source fell through to CSV`);
                        }
                    }
                }

                if (format.name === 'ndjson') {
                    for (const key of ['bulk_insert', 'openrowset', 'json_functions'] as const) {
                        for (const block of statements[key]
                            .split('FROM OPENROWSET(')
                            .slice(1)
                            .filter((value) => /FORMAT\s*=\s*'CSV'/.test(value))) {
                            if (!/ROWTERMINATOR\s*=\s*'0x0a'/.test(block)) {
                                failures.push(`${context}/${key}: NDJSON read lacks LF framing`);
                            }
                        }
                    }
                }

                if (
                    location.name === 's3'
                    && (platform === 'sql_server_2022' || platform === 'sql_server_2025')
                    && executableSql(statements.credential_setup)
                ) {
                    if (!/IDENTITY\s*=\s*'S3 ACCESS KEY'/.test(statements.credential_setup)) {
                        failures.push(`${context}: S3 credential is not S3 ACCESS KEY`);
                    }
                    if (/SHARED ACCESS SIGNATURE/.test(statements.credential_setup)) {
                        failures.push(`${context}: S3 credential fell back to SAS`);
                    }
                }

                if (
                    platform === 'sql_server_2019'
                    && (location.name === 'abs' || location.name === 'blob-https')
                    && executableSql(statements.credential_setup)
                ) {
                    const mainStart = statements.credential_setup.indexOf(
                        'CREATE DATABASE SCOPED CREDENTIAL [AuditCredential]',
                    );
                    const mainCredential = statements.credential_setup.slice(
                        mainStart,
                        statements.credential_setup.indexOf('GO', mainStart),
                    );
                    if (!/<storage_account_key>/.test(mainCredential)) {
                        failures.push(`${context}: WASBS credential is not a storage key`);
                    }
                    if (/SHARED ACCESS SIGNATURE/.test(mainCredential)) {
                        failures.push(`${context}: SQL Server 2019 WASBS uses SAS`);
                    }
                }
            }
        }
    }

    assert.equal(cases, 528);
    assert.deepEqual(failures, []);
});
