import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DOCUMENTATION_IDS,
    documentationLink,
    resolveDocumentationUrl,
    statementDocumentation,
} from '../documentation';
import { PLATFORMS, type StatementKind } from '../native';

const VIEW = {
    sql_server_2019: 'sql-server-ver15',
    sql_server_2022: 'sql-server-ver16',
    sql_server_2025: 'sql-server-ver17',
    azure_sql_db: 'azuresqldb-current',
    azure_sql_mi: 'azuresqldb-mi-current',
    fabric_sql_db: 'fabric-sqldb',
} as const;

test('every platform uses its authoritative Microsoft Learn product view', () => {
    for (const platform of PLATFORMS) {
        for (const id of DOCUMENTATION_IDS) {
            const url = resolveDocumentationUrl(id, platform);
            if (!url) {
                continue;
            }
            const parsed = new URL(url);
            assert.equal(parsed.protocol, 'https:');
            assert.equal(parsed.hostname, 'learn.microsoft.com');
            assert.equal(parsed.searchParams.get('view'), VIEW[platform]);
            assert.equal(parsed.searchParams.get('preserve-view'), 'true');
        }
    }
});

test('statement families map to platform-aware command documentation', () => {
    const statements: readonly StatementKind[] = [
        'create_table',
        'bulk_insert',
        'openrowset',
        'external_file_format',
        'create_external_table',
        'json_functions',
        'for_json',
        'credential_setup',
    ];
    for (const platform of PLATFORMS) {
        for (const statement of statements) {
            const links = statementDocumentation(statement, platform);
            if (statement === 'bulk_insert' && platform === 'fabric_sql_db') {
                assert.deepEqual(links, []);
            } else {
                assert.ok(links.length > 0, `${statement} on ${platform}`);
                for (const link of links) {
                    assert.match(link.label, new RegExp(escapeRegExp(platformLabel(platform))));
                }
            }
        }
    }
});

test('SQL Server 2022 external-table documentation uses the version 16 view', () => {
    assert.equal(
        resolveDocumentationUrl('create_external_table', 'sql_server_2022'),
        'https://learn.microsoft.com/en-us/sql/t-sql/statements/create-external-table-transact-sql?view=sql-server-ver16&preserve-view=true',
    );
    assert.equal(
        documentationLink('create_external_table', 'sql_server_2022')?.label,
        'Learn about CREATE EXTERNAL TABLE for SQL Server 2022',
    );
});

test('unsupported commands never receive a support-implying command link', () => {
    for (const platform of PLATFORMS) {
        assert.equal(documentationLink('copy_into', platform), null);
        assert.deepEqual(statementDocumentation('copy_into', platform), []);
    }
    assert.equal(documentationLink('bulk_insert', 'fabric_sql_db'), null);
    assert.deepEqual(statementDocumentation('bulk_insert', 'fabric_sql_db'), []);
});

test('PolyBase links exist only for SQL Server 2019 and 2022', () => {
    for (const platform of PLATFORMS) {
        const expected = platform === 'sql_server_2019' || platform === 'sql_server_2022';
        assert.equal(documentationLink('polybase_install', platform) !== null, expected);
        assert.equal(documentationLink('server_configuration', platform) !== null, expected);
    }
});

function platformLabel(platform: (typeof PLATFORMS)[number]): string {
    return {
        sql_server_2019: 'SQL Server 2019',
        sql_server_2022: 'SQL Server 2022',
        sql_server_2025: 'SQL Server 2025',
        azure_sql_db: 'Azure SQL Database',
        azure_sql_mi: 'Azure SQL Managed Instance',
        fabric_sql_db: 'Microsoft Fabric SQL Database',
    }[platform];
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
