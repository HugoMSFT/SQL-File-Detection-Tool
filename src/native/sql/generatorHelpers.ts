/**
 * Shared building blocks for the native SQL generator.
 *
 * These are one-for-one ports of the private helpers on the Python
 * `SQLGenerator` class. They are kept in their own module so the main
 * generator stays readable and so the fiddly formatting rules (column padding,
 * comment truncation, encoding keyword normalisation) can be unit-tested in
 * isolation.
 *
 * Every function here is deliberately pure: it takes metadata in and returns
 * strings out, with no filesystem or network access.
 */

import type { GeneratorMetadata, SchemaField, TargetPlatform } from '../types';
import {
    escapeIdentifier,
    cleanIdentifier,
    padRight,
    quoteJsonPath,
    quoteLiteral,
    safeSqlType,
    sqlComment,
    truncateCodePoints,
    codePointLength,
    displayDelimiter,
    validateUniqueColumnNames,
} from './escaping';
import {
    COMPRESSION_CODECS,
    hasIncompleteTypeEvidence,
    inferredColumnSqlType,
    NO_EXTERNAL_FORMAT_FILE_TYPES,
    PLATFORM_LABELS,
    type ExternalFormatType,
} from './typeMapping';

/**
 * Metadata accepted by the generator; re-exported from `../types` so callers
 * only ever need to import from the SQL layer.
 */
export type { GeneratorMetadata };

/** Resolve a column's effective SQL type, with explicit safe overrides first. */
export function columnSqlType(
    metadata: GeneratorMetadata,
    columnName: string,
    detectedType: unknown,
): string {
    const overrides = metadata.sql_type_overrides ?? {};
    return Object.prototype.hasOwnProperty.call(overrides, columnName)
        ? safeSqlType(overrides[columnName])
        : inferredColumnSqlType(metadata, columnName, detectedType);
}

/** Configuration for `CREATE EXTERNAL FILE FORMAT`. */
export interface ExternalFileFormatConfig {
    /** Empty when the file type has no external file format at all. */
    format_type: ExternalFormatType | '';
    field_terminator: string | null;
    string_delimiter: string | null;
    date_format: string | null;
    use_type_default: boolean;
    encoding: string;
    first_row: number;
    data_compression: string | null;
    serde_method: string | null;
}

/**
 * Widest option keyword emitted by the CSV reader option builder, so every
 * generated block lines its `=` signs up the same way.
 *
 * Mirrors `SQLGenerator.CSV_OPTION_WIDTH = len('FIELDTERMINATOR')`.
 */
export const CSV_OPTION_WIDTH = 'FIELDTERMINATOR'.length;

/** Python's `os.path.splitext(name)[0]` for a bare file name. */
export function splitextRoot(name: string): string {
    const sepIndex = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
    const dotIndex = name.lastIndexOf('.');
    if (dotIndex > sepIndex) {
        // A name made only of leading dots ('.bashrc', '..') has no extension.
        for (let i = sepIndex + 1; i < dotIndex; i += 1) {
            if (name[i] !== '.') {
                return name.slice(0, dotIndex);
            }
        }
    }
    return name;
}

/** `metadata.get(key, fallback) or fallback` for string-ish values. */
function stringOr(value: unknown, fallback: string): string {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    return String(value);
}

/** Resolve the display name used in generated comments. */
export function displayFileName(metadata: GeneratorMetadata): string {
    return metadata.file_name ?? metadata.file_path;
}

/**
 * Build the shared CSV reader options from detected file metadata.
 *
 * Emits `FORMAT`, `FIRSTROW`, `FIELDTERMINATOR`, `ROWTERMINATOR` and
 * `CODEPAGE` so that `BULK INSERT` and every `OPENROWSET` variant agree on the
 * detected delimiter, header row and code page. Note that
 * `OPENROWSET`/`BULK INSERT` use `FIRSTROW` (no underscore); `FIRST_ROW` is a
 * `CREATE EXTERNAL FILE FORMAT` option.
 */
export function csvReaderOptions(
    metadata: GeneratorMetadata,
    options: { indent?: number; prefix?: string; trailingComma?: boolean } = {},
): string[] {
    const indent = options.indent ?? 4;
    const prefix = options.prefix ?? '';
    const trailingComma = options.trailingComma ?? false;

    const overrides = metadata.parser_overrides;
    const delimiter = stringOr(overrides?.fieldDelimiter ?? metadata.delimiter, ',');
    const hasHeader = overrides?.firstRow === undefined
        ? metadata.has_header ?? true
        : overrides.firstRow > 1;
    const firstRow = overrides?.firstRow ?? (hasHeader ? 2 : 1);
    const encoding = stringOr(metadata.encoding, 'utf-8').toUpperCase();
    const codepage = stringOr(overrides?.codepage ?? metadata.codepage, '65001');
    const rowTerminator = stringOr(overrides?.rowTerminator, '0x0a');
    const delimEscaped = quoteLiteral(displayDelimiter(delimiter));
    const pad = `${prefix}${' '.repeat(indent)}`;
    const width = CSV_OPTION_WIDTH;
    const tail = trailingComma ? ',' : '';

    return [
        `${pad}${padRight('FORMAT', width)} = 'CSV',`,
        `${pad}${padRight('FIRSTROW', width)} = ${firstRow},` +
            (hasHeader
                ? '        -- skip the header row'
                : '        -- no header row detected'),
        `${pad}${padRight('FIELDTERMINATOR', width)} = '${delimEscaped}',`,
        `${pad}${padRight('ROWTERMINATOR', width)} = '${quoteLiteral(rowTerminator)}',` +
            (overrides?.rowTerminator === undefined
                ? "        -- LF (use '0x0d0a' for CRLF)"
                : '        -- user override'),
        ...(overrides?.quoteCharacter === undefined
            ? []
            : [
                  `${pad}${padRight('FIELDQUOTE', width)} = '${quoteLiteral(
                      overrides.quoteCharacter,
                  )}',`,
              ]),
        `${pad}${padRight('CODEPAGE', width)} = '${quoteLiteral(codepage)}'${tail}` +
            `  -- ${sqlComment(encoding)}`,
    ];
}

/**
 * Options that make the CSV reader return whole JSON text per row.
 *
 * This framing is for the *virtualization* connectors (`abs://` / `adls://`),
 * which reject `SINGLE_CLOB`/`SINGLE_NCLOB`/`SINGLE_BLOB`. A
 * `TYPE = BLOB_STORAGE` data source accepts the single-LOB options directly, so
 * use {@link jsonSingleLobOptions} there instead.
 *
 * Live certification also showed the `https://` BLOB_STORAGE connector rejects
 * `FIELDTERMINATOR`/`FIELDQUOTE`/`ROWTERMINATOR` with error 5369, so NDJSON row
 * framing must go through the virtualization source.
 */
export function jsonRowFrameOptions(
    indent = 4,
    rowTerminator = '0x0b',
): string[] {
    const pad = ' '.repeat(indent);
    const width = CSV_OPTION_WIDTH;
    return [
        `${pad}${padRight('FORMAT', width)} = 'CSV',`,
        `${pad}${padRight('FIELDTERMINATOR', width)} = '0x0b',`,
        `${pad}${padRight('FIELDQUOTE', width)} = '0x0b',`,
        `${pad}${padRight('ROWTERMINATOR', width)} = '${rowTerminator}'`,
    ];
}

/**
 * Encodings whose whole-file `OPENROWSET` read needs `SINGLE_NCLOB`.
 *
 * `SINGLE_CLOB` fails with error 4806 ("SINGLE_CLOB requires a double-byte
 * character set (DBCS) input file; the file specified is Unicode") when the file
 * is UTF-16. Live certification reproduced this against a UTF-16 server-local
 * text file, where the identical read with `SINGLE_NCLOB` succeeded.
 */
const WIDE_TEXT_ENCODINGS = ['UTF16', 'UCS2'];

/** Return `SINGLE_NCLOB` for UTF-16 input, else `SINGLE_CLOB`. */
export function singleLobKeyword(encoding: string | null | undefined): string {
    const normalised = (encoding ?? '')
        .toUpperCase()
        .split('-')
        .join('')
        .split('_')
        .join('');
    return WIDE_TEXT_ENCODINGS.some((wide) => normalised.startsWith(wide))
        ? 'SINGLE_NCLOB'
        : 'SINGLE_CLOB';
}

/**
 * Whole-document read options for a `TYPE = BLOB_STORAGE` data source.
 *
 * Live certification against Azure SQL Database 12.0.2000.8 and SQL Server 2025
 * 17.0.4065.4 read a public blob with
 * `OPENROWSET(BULK '<relative path>', DATA_SOURCE = '<blob storage source>',
 * SINGLE_CLOB)` and got the exact document back on both engines. The single-LOB
 * options do combine with a data source, as long as that source is
 * `TYPE = BLOB_STORAGE` rather than `abs://`.
 */
export function jsonSingleLobOptions(
    encoding: string | null | undefined,
    indent = 4,
): string[] {
    return [`${' '.repeat(indent)}${singleLobKeyword(encoding)}`];
}

/** Return a comment block saying a feature is not available on *platform*. */
export function notSupportedMessage(
    featureLabel: string,
    platform: string,
    alternatives = '',
): string {
    const label = PLATFORM_LABELS[platform as TargetPlatform] ?? platform;
    const lines = [
        '-- ====================================================================',
        `-- ${sqlComment(featureLabel)}`,
        `-- NOT AVAILABLE on ${sqlComment(label)}`,
        '-- ====================================================================',
    ];
    if (alternatives) {
        lines.push(`-- ${sqlComment(alternatives)}`);
    }
    return lines.join('\n');
}

/** Column definitions for `CREATE TABLE` / `OPENROWSET ... WITH (...)`. */
export function generateColumnDefinitions(
    metadata: GeneratorMetadata,
    options: { includeNullability?: boolean; indent?: number } = {},
): string[] {
    const includeNullability = options.includeNullability ?? false;
    const indent = options.indent ?? 4;
    const schema = Array.isArray(metadata.schema) ? metadata.schema : undefined;
    if (!schema || schema.length === 0) {
        return [];
    }
    const nullableSet = new Set(
        Array.isArray(metadata.nullable_columns) ? metadata.nullable_columns : [],
    );
    const pad = ' '.repeat(indent);
    const columns: string[] = [];

    validateUniqueColumnNames(schema);

    for (const [colName, colType] of schema) {
        const cleanName = escapeIdentifier(colName);
        // An explicit SQL type from the schema editor always wins, but is still
        // run through the allowlist so it can never inject arbitrary SQL.
        const sqlType = columnSqlType(metadata, colName, colType);
        if (includeNullability) {
            const nullKeyword = nullableSet.has(colName) ? 'NULL' : 'NOT NULL';
            columns.push(`${pad}[${cleanName}] ${padRight(sqlType, 22)} ${nullKeyword}`);
        } else {
            columns.push(`${pad}[${cleanName}] ${sqlType}`);
        }
    }
    return columns;
}

/**
 * Build the WITH-clause column list for `OPENJSON`.
 *
 * Uses `json_nesting` to emit `AS JSON` for nested objects/arrays so callers
 * can drill into them with a second `OPENJSON` rather than getting NULLs.
 */
export function generateOpenjsonColumns(
    metadata: GeneratorMetadata,
    indent = 4,
): string[] {
    const schema = Array.isArray(metadata.schema) ? metadata.schema : [];
    const nesting = metadata.json_nesting ?? {};
    const overrides = metadata.sql_type_overrides ?? {};
    const pad = ' '.repeat(indent);
    const cols: string[] = [];

    validateUniqueColumnNames(schema);
    if (
        metadata.json_typed_projection_safe === false ||
        (
            hasIncompleteTypeEvidence(metadata) &&
            schema.some(([columnName]) =>
                !Object.prototype.hasOwnProperty.call(overrides, columnName)
            )
        )
    ) {
        return [];
    }

    for (const [colName, colType] of schema) {
        const clean = escapeIdentifier(colName);
        const kind = nesting[colName] ?? 'scalar';
        if (kind === 'object' || kind === 'array') {
            cols.push(
                `${pad}[${clean}] NVARCHAR(MAX) '${quoteJsonPath(colName)}' AS JSON`,
            );
        } else {
            const sqlType = columnSqlType(metadata, colName, colType);
            cols.push(`${pad}[${clean}] ${sqlType} '${quoteJsonPath(colName)}'`);
        }
    }
    return cols;
}

/**
 * Emit an explicit `WITH (...)` column list for OPENROWSET.
 *
 * Without it the CSV reader returns untyped columns and, when the file has a
 * header row, the header can end up in the result set.
 */
export function openrowsetWithSchema(
    metadata: GeneratorMetadata,
    options: { indent?: number; terminator?: string } = {},
): string[] {
    const indent = options.indent ?? 4;
    const terminator = options.terminator ?? ')';
    const cols = generateColumnDefinitions(metadata, { indent });
    const body =
        cols.length > 0
            ? cols.join(',\n')
            : `${' '.repeat(indent)}[data] NVARCHAR(MAX)`;
    return ['WITH (', body, terminator];
}

/** A bracketed comma-separated column list, or `*` when the schema is unknown. */
export function columnNameList(metadata: GeneratorMetadata): string {
    const schema = Array.isArray(metadata.schema) ? metadata.schema : [];
    const names = schema.map(
        ([name]) => `[${escapeIdentifier(cleanIdentifier(name))}]`,
    );
    return names.length > 0 ? names.join(', ') : '*';
}

/** Render sample data rows as SQL comments for context. */
export function formatSampleRows(metadata: GeneratorMetadata): string[] {
    const sampleRows = metadata.sample_rows;
    const schema = Array.isArray(metadata.schema) ? metadata.schema : undefined;
    const jsonSamples = metadata.json_sample_values;

    if (!schema || schema.length === 0) {
        return [];
    }

    const lines: string[] = [];

    if (sampleRows && sampleRows.length > 0) {
        const colNames = schema.map(([name]) => name);
        // Truncate wide tables to the first 8 columns for readability.
        const maxDisplay = 8;
        const truncated = colNames.length > maxDisplay;
        const displayCols = colNames.slice(0, maxDisplay);
        lines.push('');
        lines.push('-- Sample data (first rows from file):');
        let header = displayCols
            .map((n) => truncateCodePoints(sqlComment(n), 20))
            .join(' | ');
        if (truncated) {
            header += ` | ... (${colNames.length - maxDisplay} more)`;
        }
        lines.push(`-- ${header}`);
        lines.push(`-- ${'-'.repeat(codePointLength(header))}`);
        for (const row of sampleRows.slice(0, 3)) {
            const displayVals = row.slice(0, maxDisplay);
            let vals = displayVals
                .map((v) =>
                    truncateCodePoints(sqlComment(v === null ? 'NULL' : v), 20),
                )
                .join(' | ');
            if (truncated) {
                vals += ' | ...';
            }
            lines.push(`-- ${vals}`);
        }
    } else if (jsonSamples && Object.keys(jsonSamples).length > 0) {
        lines.push('');
        lines.push('-- Sample data (first record):');
        for (const [colName] of schema.slice(0, 10)) {
            const raw = Object.prototype.hasOwnProperty.call(jsonSamples, colName)
                ? jsonSamples[colName]
                : '';
            const valStr = truncateCodePoints(sqlComment(raw), 60);
            lines.push(`--   ${sqlComment(colName)}: ${valStr}`);
        }
    }

    return lines;
}

/**
 * Normalise a detected encoding name to a legal `ENCODING` keyword.
 *
 * `CREATE EXTERNAL FILE FORMAT` accepts only `UTF8` and `UTF16`. Anything else
 * (CP932, Latin-1, ...) is dropped rather than passed through, because an
 * unknown keyword is a syntax error, not a graceful fallback.
 */
function externalFormatEncoding(rawEncoding: string): string {
    const encoding = rawEncoding.toUpperCase();
    const normalised = encoding.split('-').join('').split('_').join('');
    if (normalised === 'UTF8' || normalised === 'UTF8SIG') {
        return 'UTF8';
    }
    if (normalised.startsWith('UTF16')) {
        return 'UTF16';
    }
    return '';
}

function formatConfig(
    partial: Partial<ExternalFileFormatConfig> & { format_type: ExternalFormatType | '' },
): ExternalFileFormatConfig {
    return {
        field_terminator: null,
        string_delimiter: null,
        date_format: null,
        use_type_default: false,
        encoding: 'UTF8',
        first_row: 1,
        data_compression: null,
        serde_method: null,
        ...partial,
    };
}

/** Choose the `CREATE EXTERNAL FILE FORMAT` settings for the detected file. */
export function determineFormatConfig(
    metadata: GeneratorMetadata,
): ExternalFileFormatConfig {
    const fileType = metadata.parser_overrides?.format ?? metadata.file_type ?? 'text';
    const encoding = externalFormatEncoding(stringOr(metadata.encoding, 'utf-8'));

    if (fileType === 'csv') {
        const delimiter = stringOr(
            metadata.parser_overrides?.fieldDelimiter ?? metadata.delimiter,
            ',',
        );
        const hasHeader = metadata.parser_overrides?.firstRow === undefined
            ? metadata.has_header ?? false
            : metadata.parser_overrides.firstRow > 1;
        return formatConfig({
            format_type: 'DELIMITEDTEXT',
            field_terminator: delimiter.split('\t').join('\\t'),
            string_delimiter: metadata.parser_overrides?.quoteCharacter ?? '"',
            first_row: metadata.parser_overrides?.firstRow ?? (hasHeader ? 2 : 1),
            encoding,
            // USE_TYPE_DEFAULT = FALSE preserves the source's missing-value
            // semantics. Live certification against Azure SQL Database showed
            // TRUE silently rewriting a missing numeric to 0 and a missing
            // string to '', which cannot be told apart from real values.
            use_type_default: false,
        });
    }
    if (fileType === 'json') {
        return formatConfig({ format_type: 'JSON' });
    }
    if (fileType === 'parquet') {
        const comp = (
            metadata.parser_overrides?.compression ?? metadata.compression ?? ''
        ).toUpperCase();
        return formatConfig({
            format_type: 'PARQUET',
            data_compression: COMPRESSION_CODECS[comp] ?? null,
        });
    }
    if (fileType === 'delta') {
        return formatConfig({ format_type: 'DELTA' });
    }
    if (fileType === 'orc') {
        const comp = (
            metadata.parser_overrides?.compression ?? metadata.compression ?? ''
        ).toUpperCase();
        return formatConfig({
            format_type: 'ORC',
            data_compression: COMPRESSION_CODECS[comp] ?? null,
        });
    }
    if (fileType === 'rc') {
        const comp = (
            metadata.parser_overrides?.compression ?? metadata.compression ?? ''
        ).toUpperCase();
        return formatConfig({
            format_type: 'RCFILE',
            serde_method: 'org.apache.hadoop.hive.serde2.columnar.ColumnarSerDe',
            data_compression: COMPRESSION_CODECS[comp] ?? null,
        });
    }
    if (NO_EXTERNAL_FORMAT_FILE_TYPES.has(fileType)) {
        // Excel workbooks and Iceberg tables have no external file format.
        // Falling through to DELIMITEDTEXT below would emit a statement the
        // engine accepts but that reads the container bytes as text, so the
        // format type is left unset and the caller emits guidance instead.
        return formatConfig({ format_type: '' });
    }
    return formatConfig({
        format_type: 'DELIMITEDTEXT',
        field_terminator: '\\n',
        encoding,
    });
}

/** Column names as a plain list, used by best-practice validation SQL. */
export function schemaColumnNames(schema: readonly SchemaField[]): string[] {
    return schema.map(([name]) => name);
}

/**
 * Authentication methods the generator can emit for storage access.
 *
 * `managed_identity` is preferred and is the default wherever the platform
 * supports it. Live certification against Azure SQL Database proved that
 * `CREATE DATABASE SCOPED CREDENTIAL ... WITH IDENTITY = 'MANAGED IDENTITY'`
 * succeeds with **no database master key**: the master key count was 0 before
 * the credential was created, 0 while it existed, and 0 after it was dropped.
 * That removes the need to invent and store a master key password or a SAS
 * token, so it is both simpler and secret-free.
 */
export const AUTH_METHODS = [
    'managed_identity',
    'user_identity',
    'sas',
    's3_access_key',
    'storage_key',
    'public',
] as const;

export type AuthMethod = (typeof AUTH_METHODS)[number];

/** Platforms that can use `IDENTITY = 'MANAGED IDENTITY'`. */
export const MANAGED_IDENTITY_PLATFORMS: ReadonlySet<string> = new Set([
    'azure_sql_db',
    'azure_sql_mi',
    'sql_server_2025',
]);

/** Platforms that can use Microsoft Entra passthrough. */
export const USER_IDENTITY_PLATFORMS: ReadonlySet<string> = new Set([
    'azure_sql_db',
    'fabric_sql_db',
]);

/** Why the master key step is skipped, per secret-free authentication method. */
const AUTH_NO_MASTER_KEY_NOTE: Record<string, readonly string[]> = {
    managed_identity: [
        "IDENTITY = 'MANAGED IDENTITY' stores no secret, so there is",
        'nothing for a database master key to encrypt.',
    ],
    user_identity: [
        "IDENTITY = 'USER IDENTITY' stores no secret, so there is",
        'nothing for a database master key to encrypt.',
    ],
    public: [
        'The container allows anonymous read access, so no credential',
        'and no database master key are created.',
    ],
};

/** Return the effective authentication method for a platform. */
export function resolveAuthMethod(
    authMethod: string | null | undefined,
    targetPlatform: string,
): AuthMethod {
    if (authMethod && (AUTH_METHODS as readonly string[]).includes(authMethod)) {
        const selected = authMethod as AuthMethod;
        if (
            selected === 'public'
            || (selected === 'managed_identity' && MANAGED_IDENTITY_PLATFORMS.has(targetPlatform))
            || (selected === 'user_identity' && USER_IDENTITY_PLATFORMS.has(targetPlatform))
            || (
                selected === 's3_access_key'
                && (targetPlatform === 'sql_server_2022' || targetPlatform === 'sql_server_2025')
            )
            || (
                (selected === 'sas' || selected === 'storage_key')
                && targetPlatform !== 'fabric_sql_db'
            )
        ) {
            return selected;
        }
    }
    if (targetPlatform === 'fabric_sql_db') {
        return 'user_identity';
    }
    if (targetPlatform === 'azure_sql_db' || targetPlatform === 'azure_sql_mi') {
        return 'managed_identity';
    }
    return 'sas';
}

/** Return the escaped database scoped credential identifier. */
export function credentialIdentifier(
    dataSource: string,
    credentialName?: string | null,
): string {
    return escapeIdentifier(credentialName || `cred_${dataSource}`);
}

/** Return the master key section, which secret-free methods do not need. */
export function masterKeyLines(authMethod: AuthMethod): string[] {
    const note = AUTH_NO_MASTER_KEY_NOTE[authMethod];
    if (note) {
        return [
            '-- 1. Master key: NOT required.',
            ...note.map((line) => `-- ${sqlComment(line)}`),
            '',
        ];
    }
    return [
        '-- 1. Master key (required once to protect the credential secret)',
        "IF NOT EXISTS (SELECT * FROM sys.symmetric_keys WHERE name = '##MS_DatabaseMasterKey##')",
        "    CREATE MASTER KEY ENCRYPTION BY PASSWORD = '<StrongPassword!>';",
        'GO',
        '',
    ];
}

/**
 * Return the credential DDL lines for one authentication method.
 *
 * `public` returns only a comment: a container that allows anonymous read
 * needs no credential at all, and emitting one would force an unnecessary
 * secret into the script.
 */
export function credentialDdl(
    credIdent: string,
    authMethod: AuthMethod,
    stepLabel: string,
): string[] {
    const prefix = stepLabel ? ` ${stepLabel} ` : ' ';
    if (authMethod === 'public') {
        return [
            `--${prefix}Database scoped credential: not required for public access.`,
        ];
    }
    if (authMethod === 'managed_identity') {
        return [
            `--${prefix}Database scoped credential: managed identity`,
            '-- Grant the configured identity read access to the storage source.',
            `CREATE DATABASE SCOPED CREDENTIAL [${credIdent}]`,
            'WITH',
            "    IDENTITY = 'MANAGED IDENTITY';",
            'GO',
        ];
    }
    if (authMethod === 'user_identity') {
        return [
            `--${prefix}Database scoped credential: Microsoft Entra passthrough`,
            `CREATE DATABASE SCOPED CREDENTIAL [${credIdent}]`,
            'WITH',
            "    IDENTITY = 'USER IDENTITY';",
            'GO',
        ];
    }
    if (authMethod === 's3_access_key') {
        return [
            `--${prefix}Database scoped credential: S3 access key`,
            '-- Replace credential placeholders in a secure SQL editor.',
            `CREATE DATABASE SCOPED CREDENTIAL [${credIdent}]`,
            'WITH',
            "    IDENTITY = 'S3 ACCESS KEY',",
            "    SECRET   = '<access_key_id>:<secret_access_key>';",
            'GO',
        ];
    }
    if (authMethod === 'storage_key') {
        return [
            `--${prefix}Database scoped credential: storage account key`,
            '-- Replace credential placeholders in a secure SQL editor.',
            `CREATE DATABASE SCOPED CREDENTIAL [${credIdent}]`,
            'WITH',
            "    IDENTITY = '<storage_account_name>',",
            "    SECRET   = '<storage_account_key>';",
            'GO',
        ];
    }
    return [
        `--${prefix}Database scoped credential: SAS token`,
        '-- Replace credential placeholders in a secure SQL editor.',
        `CREATE DATABASE SCOPED CREDENTIAL [${credIdent}]`,
        'WITH',
        "    IDENTITY = 'SHARED ACCESS SIGNATURE',",
        "    SECRET   = '<SAS_token_without_leading_?>';",
        'GO',
    ];
}

/** Return the trailing `CREDENTIAL = [...]` line, if one is needed. */
export function credentialClause(
    credIdent: string,
    authMethod: AuthMethod,
): string[] {
    return authMethod === 'public' ? [] : [`    CREDENTIAL = [${credIdent}]`];
}
