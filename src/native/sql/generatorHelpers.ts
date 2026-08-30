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
    PLATFORM_LABELS,
    mapTypeToSql,
    type ExternalFormatType,
} from './typeMapping';

/**
 * Metadata accepted by the generator; re-exported from `../types` so callers
 * only ever need to import from the SQL layer.
 */
export type { GeneratorMetadata };

/** Configuration for `CREATE EXTERNAL FILE FORMAT`. */
export interface ExternalFileFormatConfig {
    format_type: ExternalFormatType;
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

    const delimiter = stringOr(metadata.delimiter, ',');
    const hasHeader = metadata.has_header ?? true;
    const encoding = stringOr(metadata.encoding, 'utf-8').toUpperCase();
    const codepage = stringOr(metadata.codepage, '65001');
    const delimEscaped = quoteLiteral(displayDelimiter(delimiter));
    const pad = `${prefix}${' '.repeat(indent)}`;
    const width = CSV_OPTION_WIDTH;
    const tail = trailingComma ? ',' : '';

    return [
        `${pad}${padRight('FORMAT', width)} = 'CSV',`,
        `${pad}${padRight('FIRSTROW', width)} = ${hasHeader ? 2 : 1},` +
            (hasHeader
                ? '        -- skip the header row'
                : '        -- no header row detected'),
        `${pad}${padRight('FIELDTERMINATOR', width)} = '${delimEscaped}',`,
        `${pad}${padRight('ROWTERMINATOR', width)} = '0x0a',` +
            "        -- LF (use '0x0d0a' for CRLF)",
        `${pad}${padRight('CODEPAGE', width)} = '${quoteLiteral(codepage)}'${tail}` +
            `  -- ${sqlComment(encoding)}`,
    ];
}

/**
 * Options that make the CSV reader return whole JSON text per row.
 *
 * `SINGLE_CLOB`/`SINGLE_NCLOB`/`SINGLE_BLOB` cannot be combined with a
 * `DATA_SOURCE`, so remote JSON is read through the CSV reader with
 * non-printing field/row framing characters instead.
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
    const schema = metadata.schema;
    if (!schema || schema.length === 0) {
        return [];
    }
    const nullableSet = new Set(metadata.nullable_columns ?? []);
    const maxLengths = metadata.max_string_lengths ?? {};
    const overrides = metadata.sql_type_overrides ?? {};
    const pad = ' '.repeat(indent);
    const columns: string[] = [];

    validateUniqueColumnNames(schema);

    for (const [colName, colType] of schema) {
        const cleanName = escapeIdentifier(colName);
        // An explicit SQL type from the schema editor always wins, but is still
        // run through the allowlist so it can never inject arbitrary SQL.
        const sqlType = Object.prototype.hasOwnProperty.call(overrides, colName)
            ? safeSqlType(overrides[colName])
            : mapTypeToSql(colType, maxLengths[colName]);
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
    const schema = metadata.schema ?? [];
    const nesting = metadata.json_nesting ?? {};
    const maxLengths = metadata.max_string_lengths ?? {};
    const overrides = metadata.sql_type_overrides ?? {};
    const pad = ' '.repeat(indent);
    const cols: string[] = [];

    validateUniqueColumnNames(schema);

    for (const [colName, colType] of schema) {
        const clean = escapeIdentifier(colName);
        const kind = nesting[colName] ?? 'scalar';
        if (kind === 'object' || kind === 'array') {
            cols.push(
                `${pad}[${clean}] NVARCHAR(MAX) '${quoteJsonPath(colName)}' AS JSON`,
            );
        } else {
            const sqlType = Object.prototype.hasOwnProperty.call(overrides, colName)
                ? safeSqlType(overrides[colName])
                : mapTypeToSql(colType, maxLengths[colName]);
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
    const schema = metadata.schema ?? [];
    const names = schema.map(
        ([name]) => `[${escapeIdentifier(cleanIdentifier(name))}]`,
    );
    return names.length > 0 ? names.join(', ') : '*';
}

/** Render sample data rows as SQL comments for context. */
export function formatSampleRows(metadata: GeneratorMetadata): string[] {
    const sampleRows = metadata.sample_rows;
    const schema = metadata.schema;
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

/** Normalise a detected encoding name to the SQL Server keyword. */
function externalFormatEncoding(rawEncoding: string): string {
    const encoding = rawEncoding.toUpperCase();
    if (
        encoding === 'UTF-8' ||
        encoding === 'UTF_8' ||
        encoding === 'UTF8-SIG' ||
        encoding === 'UTF-8-SIG'
    ) {
        return 'UTF8';
    }
    if (encoding === 'UTF-16' || encoding === 'UTF_16') {
        return 'UTF16';
    }
    return encoding;
}

function formatConfig(
    partial: Partial<ExternalFileFormatConfig> & { format_type: ExternalFormatType },
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
    const fileType = metadata.file_type ?? 'text';
    const encoding = externalFormatEncoding(stringOr(metadata.encoding, 'utf-8'));

    if (fileType === 'csv') {
        const delimiter = stringOr(metadata.delimiter, ',');
        const hasHeader = metadata.has_header ?? false;
        return formatConfig({
            format_type: 'DELIMITEDTEXT',
            field_terminator: delimiter.split('\t').join('\\t'),
            string_delimiter: '"',
            first_row: hasHeader ? 2 : 1,
            encoding,
            use_type_default: true,
        });
    }
    if (fileType === 'json') {
        return formatConfig({ format_type: 'JSON' });
    }
    if (fileType === 'parquet') {
        const comp = (metadata.compression ?? '').toUpperCase();
        return formatConfig({
            format_type: 'PARQUET',
            data_compression: COMPRESSION_CODECS[comp] ?? null,
        });
    }
    if (fileType === 'delta') {
        return formatConfig({ format_type: 'DELTA' });
    }
    if (fileType === 'orc') {
        const comp = (metadata.compression ?? '').toUpperCase();
        return formatConfig({
            format_type: 'ORC',
            data_compression: COMPRESSION_CODECS[comp] ?? null,
        });
    }
    if (fileType === 'rc') {
        const comp = (metadata.compression ?? '').toUpperCase();
        return formatConfig({
            format_type: 'RCFILE',
            serde_method: 'org.apache.hadoop.hive.serde2.columnar.ColumnarSerDe',
            data_compression: COMPRESSION_CODECS[comp] ?? null,
        });
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
