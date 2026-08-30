import type { StatementKind, TargetPlatform } from './native';
import { PLATFORM_LABELS, supports } from './native';

export const DOCUMENTATION_IDS = [
    'create_table',
    'bulk_insert',
    'openrowset',
    'copy_into',
    'create_external_table',
    'create_external_file_format',
    'create_external_data_source',
    'create_database_scoped_credential',
    'json_functions',
    'for_json',
    'polybase_install',
    'server_configuration',
] as const;

export type DocumentationId = (typeof DOCUMENTATION_IDS)[number];

export interface DocumentationLink {
    readonly id: DocumentationId;
    readonly label: string;
}

const PATHS: Readonly<Record<DocumentationId, string>> = {
    create_table: 't-sql/statements/create-table-transact-sql',
    bulk_insert: 't-sql/statements/bulk-insert-transact-sql',
    openrowset: 't-sql/functions/openrowset-bulk-transact-sql',
    copy_into: 't-sql/statements/copy-into-transact-sql',
    create_external_table: 't-sql/statements/create-external-table-transact-sql',
    create_external_file_format: 't-sql/statements/create-external-file-format-transact-sql',
    create_external_data_source: 't-sql/statements/create-external-data-source-transact-sql',
    create_database_scoped_credential:
        't-sql/statements/create-database-scoped-credential-transact-sql',
    json_functions: 't-sql/functions/json-functions-transact-sql',
    for_json: 't-sql/queries/select-for-clause-transact-sql',
    polybase_install: 'relational-databases/polybase/polybase-installation',
    server_configuration:
        'database-engine/configure-windows/server-configuration-options-sql-server',
};

const VIEWS: Readonly<Record<TargetPlatform, string>> = {
    sql_server_2019: 'sql-server-ver15',
    sql_server_2022: 'sql-server-ver16',
    sql_server_2025: 'sql-server-ver17',
    azure_sql_db: 'azuresqldb-current',
    azure_sql_mi: 'azuresqldb-mi-current',
    fabric_sql_db: 'fabric-sqldb',
};

const COMMAND_LABELS: Readonly<Partial<Record<DocumentationId, string>>> = {
    create_table: 'CREATE TABLE',
    bulk_insert: 'BULK INSERT',
    openrowset: 'OPENROWSET',
    copy_into: 'COPY INTO',
    create_external_table: 'CREATE EXTERNAL TABLE',
    create_external_file_format: 'CREATE EXTERNAL FILE FORMAT',
    create_external_data_source: 'CREATE EXTERNAL DATA SOURCE',
    create_database_scoped_credential: 'CREATE DATABASE SCOPED CREDENTIAL',
    json_functions: 'JSON functions',
    for_json: 'FOR JSON',
};

const STATEMENT_DOCUMENTATION: Readonly<
    Partial<Record<StatementKind, readonly DocumentationId[]>>
> = {
    create_table: ['create_table'],
    bulk_insert: ['bulk_insert'],
    openrowset: ['openrowset'],
    copy_into: ['copy_into'],
    external_file_format: ['create_external_file_format'],
    create_external_table: ['create_external_table'],
    json_functions: ['json_functions'],
    for_json: ['for_json'],
    credential_setup: [
        'create_database_scoped_credential',
        'create_external_data_source',
    ],
    best_practices: [],
};

function available(id: DocumentationId, platform: TargetPlatform): boolean {
    switch (id) {
        case 'bulk_insert':
            return supports('bulk_insert', platform);
        case 'copy_into':
            return false;
        case 'polybase_install':
        case 'server_configuration':
            return platform === 'sql_server_2019' || platform === 'sql_server_2022';
        default:
            return true;
    }
}

export function documentationLink(
    id: DocumentationId,
    platform: TargetPlatform,
): DocumentationLink | null {
    if (!available(id, platform)) {
        return null;
    }
    const command = COMMAND_LABELS[id];
    const label = command
        ? `Learn about ${command} for ${PLATFORM_LABELS[platform]}`
        : id === 'polybase_install'
            ? `Install PolyBase for ${PLATFORM_LABELS[platform]}`
            : `Configure PolyBase for ${PLATFORM_LABELS[platform]}`;
    return { id, label };
}

export function statementDocumentation(
    statement: StatementKind,
    platform: TargetPlatform,
): readonly DocumentationLink[] {
    const ids = STATEMENT_DOCUMENTATION[statement] ?? [];
    return ids
        .map((id) => documentationLink(id, platform))
        .filter((link): link is DocumentationLink => link !== null);
}

export function resolveDocumentationUrl(
    id: DocumentationId,
    platform: TargetPlatform,
): string | null {
    if (!available(id, platform)) {
        return null;
    }
    const url = new URL(`https://learn.microsoft.com/en-us/sql/${PATHS[id]}`);
    url.searchParams.set('view', VIEWS[platform]);
    url.searchParams.set('preserve-view', 'true');
    if (id === 'for_json') {
        url.hash = 'json';
    }
    if (url.protocol !== 'https:' || url.hostname !== 'learn.microsoft.com') {
        return null;
    }
    return url.toString();
}
