/**
 * Native TypeScript port of the platform-aware Python `SQLGenerator`.
 *
 * This is a behavioural port, not a wrapper: nothing here shells out to Python.
 * Every statement builder mirrors the corresponding Python method so that the
 * generated T-SQL stays semantically identical across both implementations,
 * including the corrected edge cases the Python version accumulated:
 *
 *   * `TYPE = BLOB_STORAGE` bulk data sources are separate from the
 *     `abs://`/`adls://` data-virtualization sources used by external tables,
 *     and are named with a `_Bulk` suffix that is escaped in its own context.
 *   * `SINGLE_CLOB` is never combined with a `DATA_SOURCE`.
 *   * `FIRST_ROW` is only emitted as a `FORMAT_OPTIONS` option on platforms
 *     that accept it; `FIRSTROW` (no underscore) is the OPENROWSET spelling.
 *   * `REJECT_TYPE`/`REJECT_VALUE` are PolyBase (`TYPE = HADOOP`) options and
 *     are only emitted for SQL Server 2019.
 *   * Delta `BULK` paths point at the table folder with a trailing slash.
 *
 * All identifier and literal interpolation goes through the escaping helpers,
 * so caller-controlled names, paths and delimiters cannot break out of their
 * SQL context.
 */

import type {
    GeneratedStatements,
    GeneratorMetadata,
    StatementKind,
    TargetPlatform,
} from '../types';
import type { ExternalDataSourceType } from './credentialWizard';
import {
    effectiveStorageUrl,
    normalizeDataSourceType,
} from './credentialWizard';
import {
    bulkDataSourceNames,
    cleanIdentifier,
    displayDelimiter,
    escapeIdentifier,
    formatKeyword,
    formatMegabytes,
    quoteJsonPath,
    quoteLiteral,
    pythonStrip,
    splitGoBatches,
    sqlComment,
} from './escaping';
import {
    AZURE_SQL_PLATFORMS,
    DDL_ONLY_CERTIFIED_FORMATS,
    FORMATS_READ_WITHOUT_FILE_FORMAT,
    DEFAULT_TARGET_PLATFORM,
    externalFormatPlatforms,
    FIRST_ROW_FORMAT_PLATFORMS,
    HADOOP_EXTERNAL_SOURCE_PLATFORMS,
    isStructuralType,
    noExternalFormatGuidance,
    PLATFORM_LABELS,
    DELIMITER_NAMES,
    mapTypeToSql,
    normalizePlatform,
    supports,
} from './typeMapping';
import {
    S3_BULK_PLATFORMS,
    azureBulkStorageParts,
    azureVirtualizationParts,
    baseName,
    fabricOnelakeParts,
    looksLikeCloudUrl,
    sqlServerStorageParts,
    storageUrlKind,
} from './storage';
import {
    csvReaderOptions,
    credentialClause,
    credentialDdl,
    credentialIdentifier,
    determineFormatConfig,
    displayFileName,
    columnSqlType,
    generateColumnDefinitions,
    generateOpenjsonColumns,
    jsonRowFrameOptions,
    jsonSingleLobOptions,
    masterKeyLines,
    notSupportedMessage,
    openrowsetWithSchema,
    columnNameList,
    formatSampleRows,
    resolveAuthMethod,
    singleLobKeyword,
    splitextRoot,
} from './generatorHelpers';
import {
    bestPracticesCsv,
    bestPracticesDelta,
    bestPracticesGeneric,
    bestPracticesJson,
    bestPracticesParquet,
    bestPracticesSummary,
    bestPracticesValidationSql,
    bestPracticesWarnings,
} from './bestPractices';
import { generateOpenrowset } from './openrowset';
import { pythonStringRepr } from '../analysis/jsonValue';

function stringOr(value: unknown, fallback: string): string {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    return String(value);
}

/**
 * The file's stem, for deriving a default object name.
 *
 * The detector seeds every metadata key empty and only fills it in when the
 * per-format analyser succeeds, swallowing any failure, so a caller can be
 * handed a result whose file path is missing. Mirrors Python's
 * `_metadata_base_name`.
 */
function derivedBaseName(metadata: GeneratorMetadata, fallback = 'data'): string {
    const source = stringOr(metadata.file_path, '') || stringOr(metadata.file_name, '');
    return splitextRoot(baseName(source)) || fallback;
}

/** Derive a table name from the file path, matching Python's default. */
function derivedTableName(metadata: GeneratorMetadata): string {
    return cleanIdentifier(derivedBaseName(metadata));
}

/** True when bulk access needs a `TYPE = BLOB_STORAGE` data source. */
function bulkDataSourceSupported(
    targetPlatform: TargetPlatform,
    storageUrl: string | null,
): boolean {
    if (AZURE_SQL_PLATFORMS.has(targetPlatform)) {
        return true;
    }
    if (targetPlatform.startsWith('sql_server_')) {
        return storageUrlKind(storageUrl) === 'azure';
    }
    return false;
}

/** Resolve `[external data source location, relative path]` per platform. */
function externalSourceParts(
    storageUrl: string | null,
    fileName: string,
    targetPlatform: TargetPlatform,
): [string, string] {
    if (targetPlatform === 'fabric_sql_db') {
        return fabricOnelakeParts(storageUrl, fileName);
    }
    if (AZURE_SQL_PLATFORMS.has(targetPlatform)) {
        return azureVirtualizationParts(storageUrl, fileName);
    }
    return sqlServerStorageParts(storageUrl, fileName, targetPlatform);
}

/**
 * Comment lines telling the user to stage local files in Azure storage.
 *
 * Azure SQL Database and Azure SQL Managed Instance cannot read a path on the
 * machine that ran the analysis, so the generated script uses placeholders.
 * Make the upload step explicit rather than letting the placeholders imply the
 * script is runnable as-is.
 */
function cloudStagingNotice(
    storageUrl: string | null,
    targetPlatform: TargetPlatform,
    fileName: string,
): string[] {
    if (!AZURE_SQL_PLATFORMS.has(targetPlatform)) {
        return [];
    }
    if (storageUrl && looksLikeCloudUrl(storageUrl)) {
        return [];
    }
    const base = baseName(String(fileName).split('\\').join('/')) || '<file>';
    const label = PLATFORM_LABELS[targetPlatform] ?? targetPlatform;
    return [
        `-- ${sqlComment(label)} cannot read local file ${sqlComment(base)}.`,
        '-- Upload it to Azure Storage, replace the location placeholders, and grant read access.',
        '',
    ];
}

// ---------------------------------------------------------------------------
// CREATE TABLE
// ---------------------------------------------------------------------------

/** Options shared by most statement builders. */
export interface StatementOptions {
    tableName?: string | null;
    schemaName?: string;
    targetPlatform?: TargetPlatform | string | null;
    storageUrl?: string | null;
    dataSource?: string;
    /**
     * Path the *engine* can open, replacing the analysed client path. A file is
     * analysed on the client and the statement runs on the server, and those are
     * not the same filesystem.
     */
    filePathOverride?: string | null;
}

/** Build platform-specific quick-load guidance appended to CREATE TABLE. */
function createTableQuickLoad(
    metadata: GeneratorMetadata,
    schemaName: string,
    tableName: string,
    targetPlatform: TargetPlatform,
    storageUrl: string | null,
    dataSource: string,
): string[] {
    const fileType = stringOr(metadata.file_type, 'csv');
    const fileName = displayFileName(metadata);
    const lines = [
        '',
        '-- ====================================================================',
        '-- QUICK LOAD',
        '-- ====================================================================',
    ];

    if (fileType === 'json') {
        return lines.concat([
            '-- JSON is not an OPENROWSET file format.',
            '-- Use the OPENROWSET tab for SINGLE_CLOB + OPENJSON.',
        ]);
    }

    if (targetPlatform === 'sql_server_2019') {
        if (fileType === 'csv' || fileType === 'text') {
            return lines.concat([
                '-- Use the BULK INSERT tab for local or network CSV/text files.',
                '-- Cloud OPENROWSET file access requires SQL Server 2022 or later.',
            ]);
        }
        return lines.concat([
            `-- ${fileType.toUpperCase()} file access is not available on SQL Server 2019.`,
            '-- Convert the source to CSV before loading.',
        ]);
    }

    if (targetPlatform === 'fabric_sql_db') {
        if (fileType === 'csv' || fileType === 'text' || fileType === 'parquet') {
            const [sourceLocation, bulkPath] = fabricOnelakeParts(storageUrl, fileName);
            return lines.concat([
                '-- Fabric SQL Database reads Lakehouse Files through an',
                '-- external data source (Microsoft Entra passthrough).',
                `-- Data source location: ${sqlComment(sourceLocation)}`,
                `-- INSERT INTO [${sqlComment(schemaName)}].[${sqlComment(tableName)}]`,
                '-- SELECT *',
                '-- FROM OPENROWSET(',
                `--     BULK '${sqlComment(quoteLiteral(bulkPath))}',`,
                `--     DATA_SOURCE = '${sqlComment(quoteLiteral(dataSource))}',`,
                `--     FORMAT = '${formatKeyword(fileType)}'`,
                '-- ) AS src;',
            ]);
        }
        return lines.concat([
            `-- ${fileType.toUpperCase()} is not readable by Fabric SQL Database ` +
                'OPENROWSET.',
            '-- Convert the source to CSV or Parquet in the Lakehouse first.',
        ]);
    }

    if (AZURE_SQL_PLATFORMS.has(targetPlatform)) {
        if (fileType === 'delta' && targetPlatform === 'azure_sql_mi') {
            return lines.concat([
                '-- Delta is not supported by Azure SQL Managed Instance.',
                '-- Convert the table to Parquet or CSV before loading.',
            ]);
        }
        const [sourceLocation, bulkPath] = azureVirtualizationParts(storageUrl, fileName);
        return lines.concat([
            '-- Azure SQL data virtualization uses an external data source',
            '-- whose LOCATION starts with abs:// or adls:// (not https://).',
            `-- Data source location: ${sqlComment(sourceLocation)}`,
            `-- INSERT INTO [${sqlComment(schemaName)}].[${sqlComment(tableName)}]`,
            '-- SELECT *',
            '-- FROM OPENROWSET(',
            `--     BULK '${sqlComment(quoteLiteral(bulkPath))}',`,
            `--     DATA_SOURCE = '${sqlComment(quoteLiteral(dataSource))}',`,
            `--     FORMAT = '${formatKeyword(fileType)}'`,
            '-- ) AS src;',
        ]);
    }

    const objectStoragePlatform =
        targetPlatform === 'sql_server_2022' || targetPlatform === 'sql_server_2025';
    const objectStorageFormat =
        fileType === 'csv' ||
        fileType === 'text' ||
        fileType === 'parquet' ||
        fileType === 'delta';
    if (!objectStoragePlatform || !objectStorageFormat) {
        return lines.concat([
            '-- See the OPENROWSET tab for platform-specific loading syntax.',
        ]);
    }

    const [sourceLocation, bulkPath] = sqlServerStorageParts(
        storageUrl,
        fileName,
        targetPlatform,
    );
    return lines.concat([
        '-- SQL Server object storage uses an external data source whose',
        '-- LOCATION starts with adls://, abs://, or s3:// (not https://).',
        `-- Data source location: ${sqlComment(sourceLocation)}`,
        `-- INSERT INTO [${sqlComment(schemaName)}].[${sqlComment(tableName)}]`,
        '-- SELECT *',
        '-- FROM OPENROWSET(',
        `--     BULK '${sqlComment(quoteLiteral(bulkPath))}',`,
        `--     DATA_SOURCE = '${sqlComment(quoteLiteral(dataSource))}',`,
        `--     FORMAT = '${formatKeyword(fileType)}'`,
        '-- ) AS src;',
    ]);
}

/** Generate a standard `CREATE TABLE` statement. */
export function generateCreateTable(
    metadata: GeneratorMetadata,
    options: StatementOptions = {},
): string {
    const targetPlatform = normalizePlatform(options.targetPlatform);
    const storageUrl = options.storageUrl ?? null;
    const dataSource = options.dataSource ?? 'MyDataSource';

    if (!supports('create_table', targetPlatform)) {
        return notSupportedMessage(
            'CREATE TABLE',
            targetPlatform,
            'Use CREATE EXTERNAL TABLE instead (see EXT TABLE tab).',
        );
    }

    const tableName = escapeIdentifier(
        options.tableName ? options.tableName : derivedTableName(metadata),
    );
    const schemaName = escapeIdentifier(options.schemaName ?? 'dbo');

    let columns = generateColumnDefinitions(metadata, { includeNullability: true });
    if (columns.length === 0) {
        columns = ['    [data] NVARCHAR(MAX) NULL'];
    }

    const fileType = stringOr(metadata.file_type, 'unknown').toUpperCase();
    const fileName = displayFileName(metadata);
    const platformLabel = PLATFORM_LABELS[targetPlatform] ?? targetPlatform;

    const lines = [
        '-- ====================================================================',
        '-- CREATE TABLE',
        `-- Source : ${sqlComment(fileName)}  (${sqlComment(fileType)})`,
        `-- Target : ${sqlComment(platformLabel)}`,
        '-- ====================================================================',
        '',
        `CREATE TABLE [${schemaName}].[${tableName}]`,
        '(',
    ];
    lines.push(columns.join(',\n'));
    lines.push(')');
    lines.push(';');

    lines.push(...formatSampleRows(metadata));
    lines.push(
        ...createTableQuickLoad(
            metadata,
            schemaName,
            tableName,
            targetPlatform,
            storageUrl,
            dataSource,
        ),
    );

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// BULK INSERT
// ---------------------------------------------------------------------------

/** Fabric SQL Database has no BULK INSERT; show OPENROWSET load patterns. */
function bulkInsertFabricAlternatives(
    metadata: GeneratorMetadata,
    rawTableName: string | null | undefined,
    rawSchemaName: string,
    storageUrl: string | null,
    dataSource: string,
): string {
    const fileType = stringOr(metadata.file_type, 'csv');
    const fileName = displayFileName(metadata);
    const detectedType = fileType.toUpperCase();
    const [sourceLocation, relativePath] = fabricOnelakeParts(storageUrl, fileName);
    const bulkPath = quoteLiteral(relativePath);
    const sourceName = quoteLiteral(dataSource);

    const tableName = escapeIdentifier(
        rawTableName ? rawTableName : derivedTableName(metadata),
    );
    const schemaName = escapeIdentifier(rawSchemaName);

    const header = [
        '-- ====================================================================',
        '-- BULK INSERT',
        '-- NOT AVAILABLE on Microsoft Fabric SQL Database',
        '-- ====================================================================',
        '-- Use OPENROWSET instead (data virtualization, preview):',
        '-- https://learn.microsoft.com/fabric/database/sql/data-virtualization',
        `-- Data source location: ${sqlComment(sourceLocation)}`,
        '',
    ];

    if (fileType === 'delta') {
        return header
            .concat([
                '-- Delta is not readable by Fabric SQL Database OPENROWSET.',
                '-- Create a OneLake shortcut to the Delta table from a Lakehouse',
                '-- and query it there, or convert the table to Parquet.',
            ])
            .join('\n');
    }

    if (fileType === 'json') {
        return header
            .concat([
                '-- JSON has no OPENROWSET file format on Fabric SQL Database.',
                '-- Fabric has no TYPE = BLOB_STORAGE data source, which is what',
                '-- makes SINGLE_CLOB usable elsewhere, so the CSV reader is framed',
                '-- with non-printing characters to return each document as one',
                '-- value, then parsed with OPENJSON. This also reads NDJSON',
                '-- correctly, because every line arrives as its own row.',
                '',
                `INSERT INTO [${schemaName}].[${tableName}]`,
                'SELECT j.*',
                'FROM OPENROWSET(',
                `    BULK '${bulkPath}',`,
                `    DATA_SOURCE     = '${sourceName}',`,
            ])
            .concat(jsonRowFrameOptions())
            .concat([
                ') WITH (json_doc NVARCHAR(MAX)) AS src',
                'CROSS APPLY OPENJSON(src.json_doc) AS j;',
            ])
            .join('\n');
    }

    const keyword = formatKeyword(fileType);
    const columnList = columnNameList(metadata);
    // Reuse the shared CSV option builder so the detected header row, delimiter
    // and code page are honoured; without FIRSTROW the header would be loaded
    // as a data row.
    const readerOptions =
        fileType === 'csv' || fileType === 'text'
            ? csvReaderOptions(metadata)
            : [`    FORMAT          = '${keyword}'`];

    const withSchema = openrowsetWithSchema(metadata);

    const body = [
        '-- Option 1: SELECT INTO from OPENROWSET (creates a new staging table)',
        `SELECT ${columnList}`,
        `INTO [${schemaName}].[stg_${tableName}]`,
        'FROM OPENROWSET(',
        `    BULK '${bulkPath}',`,
        `    DATA_SOURCE     = '${sourceName}',`,
    ]
        .concat(readerOptions)
        .concat([')'])
        .concat(withSchema)
        .concat([
            'AS src;',
            '',
            '-- Option 2: INSERT INTO from OPENROWSET (loads an existing typed table)',
            `INSERT INTO [${schemaName}].[${tableName}] (${columnList})`,
            `SELECT ${columnList}`,
            'FROM OPENROWSET(',
            `    BULK '${bulkPath}',`,
            `    DATA_SOURCE     = '${sourceName}',`,
        ])
        .concat(readerOptions)
        .concat([')'])
        .concat(withSchema)
        .concat([
            'AS src;',
            '',
            `-- Detected source type: ${sqlComment(detectedType)}`,
            '-- For JSON payloads, combine OPENROWSET with OPENJSON (see OPENROWSET tab).',
        ]);

    return header.concat(body).join('\n');
}

/** Options for {@link generateBulkInsert}. */
export interface BulkInsertOptions extends StatementOptions {
    filePathOverride?: string | null;
    includePrereq?: boolean;
    credentialName?: string | null;
    authMethod?: string | null;
}

/** Generate a `BULK INSERT` statement (CSV / delimited text files only). */
export function generateBulkInsert(
    metadata: GeneratorMetadata,
    options: BulkInsertOptions = {},
): string {
    const targetPlatform = normalizePlatform(options.targetPlatform);
    const storageUrl = options.storageUrl ?? null;
    const dataSource = options.dataSource ?? 'MyDataSource';
    const includePrereq = options.includePrereq ?? true;
    const rawSchemaName = options.schemaName ?? 'dbo';

    if (!supports('bulk_insert', targetPlatform)) {
        if (targetPlatform === 'fabric_sql_db') {
            return bulkInsertFabricAlternatives(
                metadata,
                options.tableName,
                rawSchemaName,
                storageUrl,
                dataSource,
            );
        }
        const alts: string[] = [];
        if (supports('openrowset', targetPlatform)) {
            alts.push('OPENROWSET (see OPENROWSET tab)');
        }
        if (supports('external_table', targetPlatform)) {
            alts.push('CREATE EXTERNAL TABLE (see EXT TABLE tab)');
        }
        const altText =
            alts.length > 0
                ? alts.join(', ')
                : 'Use the appropriate data loading method for your platform.';
        return notSupportedMessage(
            'BULK INSERT',
            targetPlatform,
            `Alternative: ${altText}`,
        );
    }

    const tableName = escapeIdentifier(
        options.tableName ? options.tableName : derivedTableName(metadata),
    );
    const schemaName = escapeIdentifier(rawSchemaName);

    const fileType = stringOr(metadata.file_type, '');
    const fileName = displayFileName(metadata);
    const encoding = stringOr(metadata.encoding, 'utf-8');
    const codepage = stringOr(metadata.codepage, '65001');

    if (fileType !== 'csv' && fileType !== 'text') {
        return (
            '-- BULK INSERT is designed for delimited text / CSV files.\n' +
            `-- This file is ${sqlComment(fileType.toUpperCase())} — ` +
            'use OPENROWSET or CREATE EXTERNAL TABLE instead.\n'
        );
    }

    const delimiter = stringOr(metadata.delimiter, ',');
    const delimEscaped = quoteLiteral(displayDelimiter(delimiter));
    const delimName = DELIMITER_NAMES[delimiter] ?? pythonStringRepr(delimiter);

    const platformLabel = PLATFORM_LABELS[targetPlatform] ?? targetPlatform;
    const storageKind = storageUrlKind(storageUrl);
    const needsBulkSource = bulkDataSourceSupported(targetPlatform, storageUrl);
    let prereqLines: string[] = [];
    let dataSourceLine: string | null = null;
    let fromPath: string;

    if (needsBulkSource) {
        // BULK INSERT reads Azure storage through a TYPE = BLOB_STORAGE
        // external data source (SQL Server 2017+, Azure SQL DB / MI); FROM must
        // be relative to that source's container, never an absolute URL. This
        // source is separate from the abs:// / adls:// data virtualization
        // source used by external tables.
        const [bulkIdent, bulkLiteral, bulkCredIdent] = bulkDataSourceNames(
            dataSource,
            options.credentialName,
        );
        const bulkAuth = resolveAuthMethod(options.authMethod, targetPlatform);
        const bulkCredClause = credentialClause(bulkCredIdent, bulkAuth);
        const [sourceRoot, relativePath] = azureBulkStorageParts(storageUrl, fileName);
        fromPath = quoteLiteral(relativePath);
        dataSourceLine = `    DATA_SOURCE     = '${bulkLiteral}',`;
        prereqLines = includePrereq
            ? [
                  '-- BLOB_STORAGE source for this bulk load',
                  ...credentialDdl(bulkCredIdent, bulkAuth, ''),
                  '',
                  `CREATE EXTERNAL DATA SOURCE [${bulkIdent}]`,
                  'WITH (',
                  '    TYPE = BLOB_STORAGE,',
                  `    LOCATION = '${quoteLiteral(sourceRoot)}'` +
                      (bulkCredClause.length > 0 ? ',' : ''),
                  ...bulkCredClause,
                  ');',
                  'GO',
                  '',
              ]
            : [
                  `-- Uses BLOB_STORAGE source [${bulkIdent}] from the setup section.`,
                  '',
              ];
    } else if (
        storageKind === 's3' ||
        storageKind === 'onelake' ||
        storageKind === 'other'
    ) {
        // Never emit a remote URL as a local BULK path: BULK INSERT has no data
        // source type for these locations and would fail at run time.
        const label = {
            s3: 'S3-compatible object storage',
            onelake: 'OneLake',
            other: 'this URL scheme',
        }[storageKind];
        fromPath = quoteLiteral(
            `<local_or_UNC_staging_path>/${baseName(String(fileName))}`,
        );
        prereqLines = [
            `-- BULK INSERT cannot read ${sqlComment(label)} directly.`,
            `-- Stage ${sqlComment(String(storageUrl))} on a local or UNC path first.`,
        ];
        if (storageKind === 's3' && S3_BULK_PLATFORMS.has(targetPlatform)) {
            prereqLines.push(
                '-- OPENROWSET can query the S3 source without staging.',
            );
        }
        prereqLines.push('');
    } else {
        fromPath = quoteLiteral(
            stringOr(options.filePathOverride || metadata.file_path, '')
                .split('\\')
                .join('/'),
        );
    }

    const lines = [
        `-- BULK INSERT: ${sqlComment(fileName)} -> ${sqlComment(platformLabel)}`,
        `-- Encoding ${sqlComment(encoding.toUpperCase())} (${sqlComment(codepage)}); ` +
            `delimiter ${sqlComment(delimName)} ("${sqlComment(delimEscaped)}").`,
        '',
    ];
    lines.push(...prereqLines);
    lines.push(
        '-- Create the target table first.',
        `BULK INSERT [${schemaName}].[${tableName}]`,
        `FROM '${fromPath}'`,
        'WITH',
        '(',
    );
    if (dataSourceLine) {
        lines.push(dataSourceLine);
    }
    lines.push(...csvReaderOptions(metadata, { trailingComma: true }));
    lines.push(
        '    TABLOCK,',
        '    MAXERRORS       = 0,',
        '    BATCHSIZE       = 50000',
        ');',
        '',
        '-- Verify row count',
        `SELECT COUNT(*) AS loaded_rows FROM [${schemaName}].[${tableName}];`,
    );
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CREATE EXTERNAL FILE FORMAT
// ---------------------------------------------------------------------------

/** Generate a `CREATE EXTERNAL FILE FORMAT` statement. */
export function generateExternalFileFormat(
    metadata: GeneratorMetadata,
    options: { formatName?: string | null; targetPlatform?: TargetPlatform | string | null } = {},
): string {
    const targetPlatform = normalizePlatform(options.targetPlatform);

    if (!supports('external_table', targetPlatform)) {
        return notSupportedMessage(
            'CREATE EXTERNAL FILE FORMAT',
            targetPlatform,
            'External tables are not available on this platform.',
        );
    }

    const formatName = escapeIdentifier(
        options.formatName ? options.formatName : `ff_${metadata.file_type}_format`,
    );

    const config = determineFormatConfig(metadata);
    if (!config.format_type) {
        return notSupportedMessage(
            'CREATE EXTERNAL FILE FORMAT',
            targetPlatform,
            noExternalFormatGuidance(metadata.file_type ?? ''),
        );
    }
    const supportedPlatforms = externalFormatPlatforms(config.format_type);
    if (!supportedPlatforms || !supportedPlatforms.has(targetPlatform)) {
        const alternative =
            config.format_type === 'JSON'
                ? 'Use OPENROWSET with OPENJSON for JSON input.'
                : 'Choose a file format supported by the selected platform.';
        return notSupportedMessage(
            `CREATE EXTERNAL FILE FORMAT (${config.format_type})`,
            targetPlatform,
            alternative,
        );
    }
    const withOptions = [`    FORMAT_TYPE = ${config.format_type}`];
    const trailingNotes: string[] = [];

    if (config.format_type === 'DELIMITEDTEXT') {
        const delimitedOptions: string[] = [];
        if (config.field_terminator) {
            delimitedOptions.push(
                `        FIELD_TERMINATOR = '${quoteLiteral(config.field_terminator)}'`,
            );
        }
        if (config.string_delimiter) {
            delimitedOptions.push(
                `        STRING_DELIMITER = '${quoteLiteral(config.string_delimiter)}'`,
            );
        }
        if (config.date_format) {
            delimitedOptions.push(
                `        DATE_FORMAT = '${quoteLiteral(config.date_format)}'`,
            );
        }
        // Always emitted, never left implicit: USE_TYPE_DEFAULT decides whether
        // a missing field becomes the type default (0, '') or stays NULL, and
        // that difference is invisible in the generated DDL unless the option is
        // written out.
        delimitedOptions.push(
            `        USE_TYPE_DEFAULT = ${config.use_type_default ? 'TRUE' : 'FALSE'}`,
        );
        if (!config.use_type_default) {
            trailingNotes.push(
                '-- USE_TYPE_DEFAULT = FALSE keeps missing fields as NULL. TRUE '
                    + "would store 0 for numeric and '' for string columns, which "
                    + 'cannot be told apart from real values.',
            );
        }
        if (config.encoding) {
            delimitedOptions.push(`        ENCODING = '${quoteLiteral(config.encoding)}'`);
        }
        if (config.first_row !== 1) {
            if (FIRST_ROW_FORMAT_PLATFORMS.has(targetPlatform)) {
                delimitedOptions.push(`        FIRST_ROW = ${config.first_row}`);
            } else {
                const platformLabel = PLATFORM_LABELS[targetPlatform] ?? targetPlatform;
                trailingNotes.push(
                    '-- FIRST_ROW is not a FORMAT_OPTIONS option on ' +
                        `${sqlComment(platformLabel)}; a header row of ` +
                        `${config.first_row - 1} line(s) was detected.`,
                    '-- Filter the header out in queries (WHERE [col] <> ' +
                        "'<header value>'), strip it before loading, or use " +
                        'OPENROWSET with FIRSTROW.',
                );
            }
        }
        if (delimitedOptions.length > 0) {
            withOptions.push(
                '    FORMAT_OPTIONS (\n' + delimitedOptions.join(',\n') + '\n    )',
            );
        }
    }

    if (DDL_ONLY_CERTIFIED_FORMATS.has(config.format_type)) {
        trailingNotes.push(
            `-- ${config.format_type} is accepted as DDL on this platform, but reading `
                + `data through it was not certified. Verify a query against a real `
                + `${config.format_type} file before relying on it.`,
        );
    }

    if (config.serde_method) {
        withOptions.push(`    SERDE_METHOD = '${quoteLiteral(config.serde_method)}'`);
    }
    if (config.data_compression) {
        withOptions.push(
            `    DATA_COMPRESSION = '${quoteLiteral(config.data_compression)}'`,
        );
    }

    const sqlParts = [
        '-- CREATE EXTERNAL FILE FORMAT  ' +
            `(${sqlComment(PLATFORM_LABELS[targetPlatform] ?? targetPlatform)})`,
    ];
    sqlParts.push(...trailingNotes);
    sqlParts.push(
        `CREATE EXTERNAL FILE FORMAT [${formatName}]`,
        'WITH (',
        withOptions.join(',\n'),
        ');',
    );
    return sqlParts.join('\n');
}

// ---------------------------------------------------------------------------
// CREATE EXTERNAL TABLE
// ---------------------------------------------------------------------------

/** Options for {@link generateExternalTable}. */
export interface ExternalTableOptions extends StatementOptions {
    location?: string | null;
    fileFormat?: string | null;
}

/** Generate a `CREATE EXTERNAL TABLE` statement (data virtualization). */
export function generateExternalTable(
    metadata: GeneratorMetadata,
    options: ExternalTableOptions = {},
): string {
    const targetPlatform = normalizePlatform(options.targetPlatform);
    const storageUrl = options.storageUrl ?? null;

    if (!supports('external_table', targetPlatform)) {
        const alts: string[] = [];
        if (supports('bulk_insert', targetPlatform)) {
            alts.push('BULK INSERT (see BULK INSERT tab)');
        }
        if (supports('json_openjson', targetPlatform)) {
            alts.push('OPENROWSET with OPENJSON (see OPENROWSET tab)');
        }
        const altText =
            alts.length > 0 ? alts.join(', ') : 'Use the appropriate data access method.';
        return notSupportedMessage(
            'CREATE EXTERNAL TABLE',
            targetPlatform,
            `Alternative: ${altText}`,
        );
    }

    const config = determineFormatConfig(metadata);
    if (!config.format_type) {
        return notSupportedMessage(
            'CREATE EXTERNAL TABLE',
            targetPlatform,
            noExternalFormatGuidance(metadata.file_type ?? ''),
        );
    }
    const supportedPlatforms = externalFormatPlatforms(config.format_type);
    if (!supportedPlatforms || !supportedPlatforms.has(targetPlatform)) {
        const alternative =
            config.format_type === 'JSON'
                ? 'Use OPENROWSET with OPENJSON for JSON input.'
                : 'Choose a file format supported by the selected platform.';
        return notSupportedMessage(
            `CREATE EXTERNAL TABLE (${config.format_type})`,
            targetPlatform,
            alternative,
        );
    }
    const nestedParquetColumns =
        metadata.file_type === 'parquet' && Array.isArray(metadata.schema)
            ? metadata.schema
                .filter(([, detectedType]) => isStructuralType(String(detectedType).toLowerCase()))
                .map(([columnName]) => columnName)
            : [];
    if (nestedParquetColumns.length > 0) {
        return notSupportedMessage(
            'CREATE EXTERNAL TABLE (PARQUET with nested columns)',
            targetPlatform,
            `Flatten or remove nested columns first: ${nestedParquetColumns.join(', ')}.`,
        );
    }

    const rawTableName = options.tableName
        ? options.tableName
        : `ext_${derivedTableName(metadata)}`;
    const fileName = stringOr(metadata.file_name, '')
        || baseName(stringOr(metadata.file_path, ''));
    const [, relativePath] = externalSourceParts(
        storageUrl,
        fileName,
        targetPlatform,
    );
    const location = String(options.location || relativePath).split('\\').join('/');
    const fileFormat = escapeIdentifier(
        options.fileFormat ? options.fileFormat : `ff_${metadata.file_type}_format`,
    );
    const tableName = escapeIdentifier(rawTableName);
    const schemaName = escapeIdentifier(options.schemaName ?? 'dbo');
    const dataSource = escapeIdentifier(options.dataSource || 'MyDataSource');

    const externalTypeOverrides: Record<string, string> = {};
    const externalTypeMappingNotes: Record<string, string> = {};
    const physicalTypes = metadata.parquet_physical_types ?? {};
    if (metadata.file_type === 'parquet' && Array.isArray(metadata.schema)) {
        for (const [columnName, detectedType] of metadata.schema) {
            if (
                !Object.prototype.hasOwnProperty.call(metadata.sql_type_overrides ?? {}, columnName)
                && String(physicalTypes[columnName]).toUpperCase() === 'INT64'
                && /^timestamp\[ns(?:,\s*tz=[^\]]+)?\]$/i.test(String(detectedType))
            ) {
                externalTypeOverrides[columnName] = 'BIGINT';
                externalTypeMappingNotes[columnName] =
                    'Parquet TIMESTAMP(NANOS) physical INT64';
                continue;
            }
            const zonedTimestamp = /^timestamp\[(s|ms|us),\s*tz=[^\]]+\]$/i.exec(
                String(detectedType),
            );
            if (
                !Object.prototype.hasOwnProperty.call(metadata.sql_type_overrides ?? {}, columnName)
                && String(physicalTypes[columnName]).toUpperCase() === 'INT64'
                && zonedTimestamp
            ) {
                externalTypeOverrides[columnName] = mapTypeToSql(
                    `timestamp[${zonedTimestamp[1]}]`,
                );
                externalTypeMappingNotes[columnName] =
                    'Parquet timezone timestamp physical INT64';
            }
        }
    }
    const externalMetadata: GeneratorMetadata =
        Object.keys(externalTypeOverrides).length > 0
            ? {
                ...metadata,
                sql_type_overrides: {
                    ...externalTypeOverrides,
                    ...(metadata.sql_type_overrides ?? {}),
                },
            }
            : metadata;

    const externalSchema = Array.isArray(externalMetadata.schema)
        ? externalMetadata.schema
        : [];
    const externalLobColumns = externalSchema
        .map(([columnName, detectedType]) => ({
            columnName,
            sqlType: columnSqlType(externalMetadata, columnName, detectedType),
        }))
        .filter(({ sqlType }) =>
            /^(?:(?:N?VARCHAR|VARBINARY)\s*\(\s*MAX\s*\)|N?TEXT|IMAGE|XML)$/i.test(sqlType)
        );
    if (externalLobColumns.length > 0) {
        const rendered = externalLobColumns
            .map(({ columnName, sqlType }) => `[${columnName}] (${sqlType})`)
            .join(', ');
        return notSupportedMessage(
            `CREATE EXTERNAL TABLE (${config.format_type} with LOB columns)`,
            targetPlatform,
            `External tables cannot declare these inferred LOB columns directly: ${rendered}. ` +
            'After validating the complete source width, set explicit bounded SQL type ' +
            'overrides (for example NVARCHAR(4000) or VARBINARY(8000)).',
        );
    }

    const columns = generateColumnDefinitions(externalMetadata, { includeNullability: false });
    if (columns.length === 0) {
        return notSupportedMessage(
            `CREATE EXTERNAL TABLE (${config.format_type} without a bounded schema)`,
            targetPlatform,
            'Provide a schema with explicit bounded SQL type overrides before execution.',
        );
    }

    const withOptions = [
        `    DATA_SOURCE = [${dataSource}]`,
        `    LOCATION = '${quoteLiteral(location)}'`,
        `    FILE_FORMAT = [${fileFormat}]`,
    ];
    if (HADOOP_EXTERNAL_SOURCE_PLATFORMS.has(targetPlatform)) {
        // REJECT_TYPE / REJECT_VALUE are PolyBase (TYPE = HADOOP) options.
        // Modern abs:// / adls:// / Fabric sources reject them.
        withOptions.push('    REJECT_TYPE = VALUE');
        withOptions.push('    REJECT_VALUE = 0');
    }

    const platformLabel = PLATFORM_LABELS[targetPlatform] ?? targetPlatform;
    const header = [
        `-- CREATE EXTERNAL TABLE  (${sqlComment(platformLabel)})`,
        `-- Requires [${dataSource}] and [${fileFormat}]; LOCATION is relative to the data source.`,
    ];
    for (const columnName of Object.keys(externalTypeOverrides)) {
        header.push(
            `-- [${sqlComment(columnName)}] uses ${externalTypeOverrides[columnName]} ` +
            `(${externalTypeMappingNotes[columnName]}).`,
        );
    }
    if (targetPlatform === 'fabric_sql_db') {
        header.push('-- Fabric data virtualization uses Entra passthrough and is in preview.');
    }

    return header
        .concat([
            '',
            `CREATE EXTERNAL TABLE [${schemaName}].[${tableName}]`,
            '(',
            columns.join(',\n'),
            ')',
            'WITH',
            '(',
            withOptions.join(',\n'),
            ');',
        ])
        .join('\n');
}

// ---------------------------------------------------------------------------
// COPY INTO
// ---------------------------------------------------------------------------

/** Explain `COPY INTO` availability for the exposed SQL targets. */
export function generateCopyInto(
    _metadata: GeneratorMetadata,
    options: StatementOptions = {},
): string {
    const targetPlatform = normalizePlatform(options.targetPlatform);
    const platformLabel = PLATFORM_LABELS[targetPlatform] ?? targetPlatform;
    const lines = [
        '-- ====================================================================',
        '-- COPY INTO',
        `-- NOT AVAILABLE on ${sqlComment(platformLabel)}`,
        '-- ====================================================================',
        '-- Recommended alternatives:',
    ];
    const alternatives: string[] = [];
    if (supports('bulk_insert', targetPlatform)) {
        alternatives.push(
            'BULK INSERT for high-speed CSV/text ingestion (see BULK INSERT tab).',
        );
    }
    if (supports('openrowset', targetPlatform)) {
        alternatives.push(
            'OPENROWSET for ad-hoc reads and ELT patterns (see OPENROWSET tab).\n' +
                '--    Use SELECT INTO or INSERT INTO ... SELECT FROM OPENROWSET for loading.',
        );
    }
    if (supports('json_openjson', targetPlatform)) {
        alternatives.push('OPENROWSET with OPENJSON / JSON_VALUE for JSON ingestion.');
    }
    if (targetPlatform === 'fabric_sql_db') {
        alternatives.push(
            'Fabric Data Pipelines / Dataflows Gen2 for orchestrated ingestion.',
        );
    }
    alternatives.forEach((alternative, index) => {
        lines.push(`-- ${index + 1}. ${alternative}`);
    });
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CREDENTIAL + DATA SOURCE setup
// ---------------------------------------------------------------------------

/**
 * Build the `TYPE = BLOB_STORAGE` data source used by bulk operations.
 *
 * A `TYPE = BLOB_STORAGE` source cannot back an external table, and the
 * `abs://` / `adls://` / `wasbs://` sources used by external tables cannot back
 * `BULK INSERT` or `OPENROWSET(BULK ...)`. Both are therefore emitted, under
 * distinct names.
 */
function bulkDataSourceBlock(
    dataSourceRaw: string,
    storageUrl: string | null,
    fileName: string,
    targetPlatform: TargetPlatform,
    stepNumber = 4,
    credentialName?: string | null,
    authMethod?: string | null,
): string[] {
    if (!bulkDataSourceSupported(targetPlatform, storageUrl)) {
        return [];
    }
    const resolvedAuth = resolveAuthMethod(authMethod, targetPlatform);
    const [bulkIdent, , bulkCredIdent] = bulkDataSourceNames(
        dataSourceRaw,
        credentialName,
    );
    const [bulkLocation] = azureBulkStorageParts(storageUrl, fileName);
    const clause = credentialClause(bulkCredIdent, resolvedAuth);
    return [
        `-- ${stepNumber}. External Data Source for BULK INSERT / OPENROWSET(BULK)`,
        '-- Bulk access uses a separate BLOB_STORAGE source.',
        ...credentialDdl(bulkCredIdent, resolvedAuth, ''),
        '',
        `CREATE EXTERNAL DATA SOURCE [${bulkIdent}]`,
        'WITH (',
        '    TYPE = BLOB_STORAGE,',
        `    LOCATION = '${quoteLiteral(bulkLocation)}'` +
            (clause.length > 0 ? ',' : ''),
        ...clause,
        ');',
        'GO',
    ];
}

/** Options for {@link generateCredentialSetup}. */
export interface CredentialSetupOptions {
    dataSource?: string;
    fileFormat?: string;
    metadata?: GeneratorMetadata | null;
    targetPlatform?: TargetPlatform | string | null;
    storageUrl?: string | null;
    /**
     * Name for the generated database scoped credential. Defaults to
     * `cred_<dataSource>`; override it to keep every generated object under a
     * caller-controlled prefix.
     */
    credentialName?: string | null;
    /**
     * How the generated SQL authenticates to storage. Defaults to
     * `managed_identity` wherever the platform supports it, because a managed
     * identity needs neither a secret nor a database master key.
     */
    authMethod?: string | null;
}

/** Generate the prerequisite credential / data source / file format script. */
export function generateCredentialSetup(options: CredentialSetupOptions = {}): string {
    const targetPlatform = normalizePlatform(options.targetPlatform);
    const storageUrl = options.storageUrl ?? null;
    const dataSourceRaw = options.dataSource ?? 'MyDataSource';
    const authMethod = resolveAuthMethod(options.authMethod, targetPlatform);
    const credIdent = credentialIdentifier(dataSourceRaw, options.credentialName);

    if (!supports('credential_setup', targetPlatform)) {
        return notSupportedMessage(
            'CREDENTIAL / DATA SOURCE SETUP',
            targetPlatform,
            'External data sources are not supported on this platform. ' +
                'Use BULK INSERT or application-level data loading instead.',
        );
    }

    const platformLabel = PLATFORM_LABELS[targetPlatform] ?? targetPlatform;
    const metadata = options.metadata ?? null;
    const config = determineFormatConfig(
        metadata ?? ({ file_path: '' } as GeneratorMetadata),
    );
    const supportedPlatforms = externalFormatPlatforms(config.format_type);
    const formatSupported = Boolean(
        supportedPlatforms && supportedPlatforms.has(targetPlatform),
    );
    // A file format and a data source are different objects. JSON has no
    // CREATE EXTERNAL FILE FORMAT anywhere, but every remote JSON read this
    // generator emits goes through OPENROWSET(BULK ...) with a DATA_SOURCE, so
    // refusing to emit the data source leaves that statement referring to an
    // object nothing creates - which is error 12703 / 46501 at run time.
    if (!formatSupported && !FORMATS_READ_WITHOUT_FILE_FORMAT.has(config.format_type)) {
        return notSupportedMessage(
            `EXTERNAL DATA SOURCE SETUP (${config.format_type})`,
            targetPlatform,
            'SQL Server 2022 or later is required for this file format.',
        );
    }

    const dataSource = escapeIdentifier(dataSourceRaw);
    const fileName = metadata
        ? (metadata.file_name ?? metadata.file_path ?? '<file>')
        : '<file>';
    const [sourceLocation] = externalSourceParts(storageUrl, fileName, targetPlatform);

    if (targetPlatform === 'fabric_sql_db') {
        return [
            `-- PREREQUISITE SETUP (${sqlComment(platformLabel)})`,
            '-- OneLake uses ABFSS with USER IDENTITY (preview).',
            '',
            ...masterKeyLines(authMethod),
            ...credentialDdl(credIdent, authMethod, '2.'),
            '',
            '-- 3. External data source',
            `CREATE EXTERNAL DATA SOURCE [${dataSource}]`,
            'WITH (',
            `    LOCATION = '${quoteLiteral(sourceLocation)}',`,
            `    CREDENTIAL = [${credIdent}]`,
            ');',
            'GO',
            '',
            '-- Create the external file format from the File format tab.',
        ].join('\n');
    }

    const lines = [
        `-- PREREQUISITE SETUP (${sqlComment(platformLabel)})`,
        '-- Run once per database and storage source.',
        '',
    ];
    if (!formatSupported) {
        lines.push(
            `-- ${sqlComment(config.format_type)} has no external file format on ${sqlComment(platformLabel)}.`,
            '-- The data source is still required for OPENROWSET.',
            '',
        );
    }
    lines.push(...cloudStagingNotice(storageUrl, targetPlatform, fileName));
    lines.push(...masterKeyLines(authMethod));
    if (targetPlatform === 'sql_server_2025' && authMethod === 'managed_identity') {
        lines.push(
            '-- SQL Server 2025 managed identity requires an Azure Arc-enabled instance and a configured user-assigned identity.',
            '',
        );
    }

    if (targetPlatform === 'sql_server_2019') {
        lines.push(...credentialDdl(credIdent, authMethod, '2.'));
        const legacyClause = credentialClause(credIdent, authMethod);
        lines.push(
            '',
            '-- 3. External Data Source (external tables / PolyBase)',
            '-- SQL Server 2019 PolyBase uses TYPE = HADOOP.',
            `CREATE EXTERNAL DATA SOURCE [${dataSource}]`,
            'WITH (',
            '    TYPE = HADOOP,',
            `    LOCATION = '${quoteLiteral(sourceLocation)}'` +
                (legacyClause.length > 0 ? ',' : ''),
            ...legacyClause,
            ');',
            'GO',
        );
        lines.push(
            ...bulkDataSourceBlock(
                dataSourceRaw,
                storageUrl,
                fileName,
                targetPlatform,
                4,
                options.credentialName,
                authMethod,
            ),
        );
        return lines.join('\n');
    }

    lines.push(...credentialDdl(credIdent, authMethod, '2.'));
    lines.push('', '-- 3. External Data Source (data virtualization)');
    if (AZURE_SQL_PLATFORMS.has(targetPlatform)) {
        lines.push(
            '-- Use abs:// for Blob Storage or adls:// for ADLS Gen2.',
        );
    } else {
        lines.push(
            '-- SQL Server infers ABS, ADLS, or S3 from LOCATION.',
        );
    }
    const credClause = credentialClause(credIdent, authMethod);
    lines.push(
        `CREATE EXTERNAL DATA SOURCE [${dataSource}]`,
        'WITH (',
        `    LOCATION = '${quoteLiteral(sourceLocation)}'` +
            (credClause.length > 0 ? ',' : ''),
        ...credClause,
        ');',
        'GO',
    );

    lines.push(
        ...bulkDataSourceBlock(
            dataSourceRaw,
            storageUrl,
            fileName,
            targetPlatform,
            4,
            options.credentialName,
            authMethod,
        ),
    );

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON functions
// ---------------------------------------------------------------------------

/** Generate T-SQL JSON function examples using the file's real schema. */
export function generateJsonFunctions(
    metadata: GeneratorMetadata,
    options: StatementOptions = {},
): string {
    const targetPlatform = normalizePlatform(options.targetPlatform);
    const storageUrl = options.storageUrl ?? null;
    const dataSource = options.dataSource ?? 'MyDataSource';

    if (!supports('json_openjson', targetPlatform)) {
        const alts: string[] = [];
        if (supports('openrowset', targetPlatform)) {
            alts.push('OPENROWSET (see OPENROWSET tab)');
        }
        if (supports('external_table', targetPlatform)) {
            alts.push('CREATE EXTERNAL TABLE (see EXT TABLE tab)');
        }
        const altText =
            alts.length > 0
                ? alts.join(', ')
                : 'JSON functions may have limited support on this platform.';
        return notSupportedMessage(
            'JSON FUNCTIONS (OPENJSON / JSON_VALUE / JSON_QUERY)',
            targetPlatform,
            `Alternative: ${altText}`,
        );
    }

    const hasPathExists = supports('json_path_exists', targetPlatform);
    const isOnPrem = targetPlatform.startsWith('sql_server_');
    const hasOpenrowsetCloud = supports('openrowset_format_keyword', targetPlatform);

    const platformLabel = PLATFORM_LABELS[targetPlatform] ?? targetPlatform;
    const fileName = metadata.file_name ?? metadata.file_path ?? 'file';
    const jsonFormat = stringOr(metadata.json_format, 'array');
    const nesting = metadata.json_nesting ?? {};
    const schema = Array.isArray(metadata.schema) ? metadata.schema : [];

    const tableName = escapeIdentifier(
        options.tableName
            ? options.tableName
            : cleanIdentifier(splitextRoot(baseName(metadata.file_path ?? 'data'))),
    );
    const schemaName = escapeIdentifier(options.schemaName ?? 'dbo');

    // A file is analysed on the client and the statement runs on the engine, and
    // those are not the same filesystem. `filePathOverride` is how a caller
    // names the path the *server* can open.
    let filePathSql = quoteLiteral(
        String(options.filePathOverride || metadata.file_path || 'C:/data/file.json')
            .split('\\')
            .join('/'),
    );
    let jsonBulkSource: string | null = null;
    // The single-LOB read needs the separate TYPE = BLOB_STORAGE source, which
    // only exists on the platforms that can have one.
    let jsonSingleLobSource: string | null = null;
    let jsonSingleLobIdent = '';
    let jsonSingleLobPath = '';
    if (!isOnPrem || storageUrl) {
        const [, jsonRelative] = externalSourceParts(storageUrl, fileName, targetPlatform);
        filePathSql = quoteLiteral(jsonRelative);
        jsonBulkSource = quoteLiteral(dataSource || 'MyDataSource');
        if (bulkDataSourceSupported(targetPlatform, storageUrl)) {
            const [bulkIdent, bulkLiteral] = bulkDataSourceNames(
                dataSource || 'MyDataSource',
            );
            const [, bulkRelative] = azureBulkStorageParts(storageUrl, fileName);
            jsonSingleLobIdent = bulkIdent;
            jsonSingleLobSource = bulkLiteral;
            jsonSingleLobPath = quoteLiteral(bulkRelative);
        }
    }

    const lines = [
        '-- ====================================================================',
        `-- T-SQL JSON FUNCTIONS  —  ${sqlComment(fileName)}`,
        `-- Target  : ${sqlComment(platformLabel)}`,
        `-- JSON format : ${sqlComment(jsonFormat.toUpperCase())}`,
        `-- Columns     : ${schema.length}`,
        '-- ====================================================================',
        '',
    ];

    // ---- Section 1: read the document, then OPENJSON ---------------------
    const openjsonCols = generateOpenjsonColumns(metadata, 8);
    const openjsonWith = openjsonCols.join(',\n');

    if (jsonBulkSource && jsonFormat === 'ndjson') {
        // Every line is its own document. Reading the file whole would hand
        // OPENJSON a concatenation that is not valid JSON, so the rows are
        // framed out first and the rest of the script works on one of them.
        lines.push(
            '-- ----------------------------------------------------------------',
            '-- 1. OPENROWSET(BULK) + OPENJSON   (NDJSON: one document per line)',
            '--    Row framing needs the abs:// / adls:// virtualization source;',
            '--    the https:// BLOB_STORAGE connector rejects the framing',
            '--    options with error 5369.',
            '-- ----------------------------------------------------------------',
            '-- Every line at once:',
            'SELECT [j].*',
            'FROM OPENROWSET(',
            `    BULK '${filePathSql}',`,
            `    DATA_SOURCE     = '${jsonBulkSource}',`,
        );
        // LF, so each line is its own row. The default 0x0b framing returns
        // the whole file as one row, which is not a JSON document here.
        lines.push(...jsonRowFrameOptions(4, '0x0a'));
        lines.push(
            ') WITH (json_doc NVARCHAR(MAX)) AS [src]  -- LF: one document per line',
        );
        if (openjsonCols.length > 0) {
            lines.push(
                'CROSS APPLY OPENJSON([src].json_doc)',
                'WITH (',
                openjsonWith,
                ') AS [j];',
            );
        } else {
            lines.push('CROSS APPLY OPENJSON([src].json_doc) AS [j];');
        }
        lines.push(
            '',
            '-- The statements below work on one document at a time, so they',
            '-- read a single line. Concatenated NDJSON is not one document.',
            'DECLARE @json NVARCHAR(MAX);',
            'SELECT TOP (1) @json = json_doc',
            'FROM OPENROWSET(',
            `    BULK '${filePathSql}',`,
            `    DATA_SOURCE     = '${jsonBulkSource}',`,
        );
        lines.push(...jsonRowFrameOptions(4, '0x0a'));
        lines.push(
            ') WITH (json_doc NVARCHAR(MAX)) AS [src];  -- LF: one document per line',
            '',
        );
    } else if (jsonBulkSource && jsonSingleLobSource) {
        lines.push(
            '-- ----------------------------------------------------------------',
            '-- 1. OPENROWSET(BULK) + OPENJSON',
            `--    Whole document through the TYPE = BLOB_STORAGE source`,
            `--    [${jsonSingleLobIdent}]; BULK is relative to that source root.`,
            '--    Certified live: the single-LOB options work through a',
            '--    BLOB_STORAGE source and are rejected only by abs:// / adls://.',
            '-- ----------------------------------------------------------------',
            'DECLARE @json NVARCHAR(MAX);',
            'SELECT @json = BulkColumn',
            'FROM OPENROWSET(',
            `    BULK '${jsonSingleLobPath}',`,
            `    DATA_SOURCE     = '${jsonSingleLobSource}',`,
        );
        lines.push(...jsonSingleLobOptions(metadata.encoding));
        lines.push(') AS [src];', '');
    } else if (jsonBulkSource) {
        lines.push(
            '-- ----------------------------------------------------------------',
            '-- 1. OPENROWSET(BULK) + OPENJSON',
            `--    BULK is relative to external data source [${jsonBulkSource}].`,
            '--    This target has no TYPE = BLOB_STORAGE data source, which is',
            '--    what makes the single-LOB options usable, so the CSV reader is',
            '--    framed with non-printing characters to return the document.',
            '-- ----------------------------------------------------------------',
            'DECLARE @json NVARCHAR(MAX);',
            'SELECT @json = json_doc',
            'FROM OPENROWSET(',
            `    BULK '${filePathSql}',`,
            `    DATA_SOURCE     = '${jsonBulkSource}',`,
        );
        lines.push(...jsonRowFrameOptions());
        lines.push(') WITH (json_doc NVARCHAR(MAX)) AS j;', '');
    } else {
        const lobKeyword = singleLobKeyword(metadata.encoding);
        lines.push(
            '-- ----------------------------------------------------------------',
            '-- 1. OPENROWSET(BULK) + OPENJSON  (SQL Server 2016+ / Azure SQL)',
            '--    Loads the entire file as a single string, then parses as JSON.',
            `--    ${lobKeyword} is the encoding-correct choice for this file.`,
            '--    Live evidence: SINGLE_CLOB over a UTF-16 file fails with',
            '--    error 4806 because it requires a DBCS file; SINGLE_NCLOB reads it.',
            '-- ----------------------------------------------------------------',
            'DECLARE @json NVARCHAR(MAX);',
            'SELECT @json = BulkColumn',
            `FROM OPENROWSET(BULK N'${filePathSql}', ${lobKeyword}) AS j;`,
            '',
        );
        if (jsonFormat === 'ndjson') {
            // An NDJSON file is not a JSON document, so reading it whole and
            // handing it to OPENJSON cannot work - it is a sequence of
            // independent documents, one per line. Wrapping the lines into an
            // array makes the rest of this script mean what it says.
            lines.push(
                '-- NDJSON is a sequence of documents, one per line, not a single',
                '-- document. OPENJSON over the raw file text would fail, so the',
                '-- lines are wrapped into an array first. STRING_SPLIT does not',
                '-- guarantee order; each line is an independent document, so the',
                '-- set is the same either way.',
                "SELECT @json = N'[' + STRING_AGG("
                    + "REPLACE([value], CHAR(13), N''), N',') + N']'",
                'FROM STRING_SPLIT(@json, CHAR(10))',
                "WHERE LTRIM(RTRIM(REPLACE([value], CHAR(13), N''))) <> N'';",
                '',
            );
        }
    }

    if (jsonFormat === 'object') {
        // Single object: direct JSON_VALUE
        lines.push('-- Single JSON object — extract individual values', 'SELECT');
        const jv: string[] = [];
        for (const [colName] of schema) {
            const clean = escapeIdentifier(colName);
            const kind = nesting[colName] ?? 'scalar';
            if (kind === 'object' || kind === 'array') {
                jv.push(`    JSON_QUERY(@json, '${quoteJsonPath(colName)}') AS [${clean}]`);
            } else {
                jv.push(`    JSON_VALUE(@json, '${quoteJsonPath(colName)}') AS [${clean}]`);
            }
        }
        lines.push(jv.length > 0 ? `${jv.join(',\n')};` : '    @json;');
    } else {
        if (openjsonCols.length > 0) {
            lines.push(
                '-- Parse the JSON array into rows with typed columns',
                'SELECT *',
                'FROM OPENJSON(@json)',
                'WITH (',
                openjsonWith,
                ');',
            );
        } else {
            lines.push(
                '-- The sampled shape is not safe for a typed projection.',
                'SELECT [key], [value], [type]',
                'FROM OPENJSON(@json);',
            );
        }
    }

    // ---- Section 2: OPENJSON without schema ------------------------------
    lines.push(
        '',
        '-- ----------------------------------------------------------------',
        '-- 2. OPENJSON — schemaless (key / value / type discovery)',
        '-- ----------------------------------------------------------------',
        'SELECT [key], [value], [type]',
        'FROM OPENJSON(@json);',
    );

    // ---- Section 3: nested objects ---------------------------------------
    const nestedCols = Object.entries(nesting).filter(
        ([, kind]) => kind === 'object' || kind === 'array',
    );
    if (nestedCols.length > 0) {
        lines.push(
            '',
            '-- ----------------------------------------------------------------',
            '-- 3. NESTED OBJECTS / ARRAYS  — CROSS APPLY OPENJSON',
            '-- ----------------------------------------------------------------',
        );
        for (const [colName, kind] of nestedCols) {
            lines.push(
                '',
                `-- Expand nested ${kind === 'array' ? 'array' : 'object'}: ` +
                    `$.${sqlComment(colName)}`,
                'SELECT',
                '    parent.[key] AS parent_key,',
                '    child.[key]  AS child_key,',
                '    child.[value] AS child_value',
                'FROM OPENJSON(@json) AS parent',
                `CROSS APPLY OPENJSON(parent.[value], '${quoteJsonPath(colName)}') AS child;`,
            );
        }
    }

    // ---- Section 4: ISJSON validation ------------------------------------
    lines.push(
        '',
        '-- ----------------------------------------------------------------',
        '-- 4. VALIDATE JSON  — ISJSON  (SQL Server 2016+)',
        '-- ----------------------------------------------------------------',
        'SELECT',
        '    ISJSON(@json) AS is_valid_json,',
        "    CASE ISJSON(@json) WHEN 1 THEN 'Valid' ELSE 'Invalid' END AS status;",
    );

    // ---- Section 5: JSON_PATH_EXISTS -------------------------------------
    if (schema.length > 0 && hasPathExists) {
        const firstCol = schema[0][0];
        lines.push(
            '',
            '-- ----------------------------------------------------------------',
            `-- 5. JSON_PATH_EXISTS  (${sqlComment(platformLabel)})`,
            '-- ----------------------------------------------------------------',
            `SELECT JSON_PATH_EXISTS(@json, '${quoteJsonPath(firstCol)}') AS path_exists;`,
        );
    } else if (schema.length > 0 && !hasPathExists) {
        lines.push(
            '',
            '-- ----------------------------------------------------------------',
            `-- 5. JSON_PATH_EXISTS  — NOT available on ${sqlComment(platformLabel)}`,
            '--    Requires SQL Server 2022+ or Azure SQL Database',
            '-- ----------------------------------------------------------------',
        );
    }

    // ---- Section 6: JSON_MODIFY ------------------------------------------
    if (schema.length > 0) {
        const firstCol = schema[0][0];
        lines.push(
            '',
            '-- ----------------------------------------------------------------',
            '-- 6. JSON_MODIFY  — update a value in the JSON document',
            '-- ----------------------------------------------------------------',
            `SET @json = JSON_MODIFY(@json, '${quoteJsonPath(firstCol)}', 'new_value');`,
            '-- Verify: SELECT JSON_VALUE(@json, ' +
                `'${sqlComment(quoteJsonPath(firstCol))}');`,
        );
    }

    // ---- Section 7: object-storage OPENROWSET + OPENJSON -----------------
    if (hasOpenrowsetCloud && !isOnPrem) {
        const [cloudSourceLocation, cloudRelative] = externalSourceParts(
            storageUrl,
            fileName,
            targetPlatform,
        );
        const blobPath = quoteLiteral(cloudRelative);
        const cloudSource = quoteLiteral(dataSource || 'MyDataSource');
        lines.push(
            '',
            '-- ----------------------------------------------------------------',
            `-- 7. OPENROWSET + OPENJSON via external data source (${sqlComment(platformLabel)})`,
            `--    Data source location: ${sqlComment(cloudSourceLocation)}`,
            '-- ----------------------------------------------------------------',
            'SELECT j.*',
            'FROM OPENROWSET(',
            `    BULK '${blobPath}',`,
            `    DATA_SOURCE     = '${cloudSource}',`,
            "    FORMAT          = 'CSV',",
            "    FIELDTERMINATOR = '0x0b',",
            "    FIELDQUOTE      = '0x0b'",
            ') WITH (json_doc NVARCHAR(MAX)) AS src',
        );
        if (openjsonCols.length > 0) {
            lines.push(
                'CROSS APPLY OPENJSON(src.json_doc)',
                'WITH (',
                openjsonCols.join(',\n'),
                ') AS j;',
            );
        } else {
            lines.push('CROSS APPLY OPENJSON(src.json_doc) AS j;');
        }
    } else if (isOnPrem) {
        lines.push(
            '',
            '-- ----------------------------------------------------------------',
            `-- 7. Cloud OPENROWSET syntax is not available on ${sqlComment(platformLabel)}.`,
            '--    Use Section 1 (SINGLE_CLOB + OPENJSON) for local JSON files.',
            '-- ----------------------------------------------------------------',
        );
    }

    // ---- Section 8: INSERT parsed JSON into a table ----------------------
    if (schema.length > 0 && openjsonCols.length > 0) {
        const insertCols = schema
            .filter(([c]) => (nesting[c] ?? 'scalar') === 'scalar')
            .map(([c]) => `[${escapeIdentifier(c)}]`)
            .join(', ');
        if (insertCols) {
            lines.push(
                '',
                '-- ----------------------------------------------------------------',
                `-- 8. INSERT parsed JSON into [${sqlComment(schemaName)}].[${sqlComment(tableName)}]`,
                '--    (create the table first — see CREATE TABLE tab)',
                '-- ----------------------------------------------------------------',
                `INSERT INTO [${schemaName}].[${tableName}] (${insertCols})`,
                `SELECT ${insertCols}`,
                'FROM OPENJSON(@json)',
                'WITH (',
                openjsonWith,
                ');',
            );
        }
    }

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// FOR JSON PATH
// ---------------------------------------------------------------------------

/** Generate `FOR JSON PATH` examples for SQL-to-JSON export. */
export function generateForJsonPath(
    metadata: GeneratorMetadata,
    options: StatementOptions = {},
): string {
    const targetPlatform = normalizePlatform(options.targetPlatform);

    if (!supports('for_json', targetPlatform)) {
        return notSupportedMessage(
            'FOR JSON PATH',
            targetPlatform,
            'FOR JSON is not available on Data Warehouse platforms. ' +
                'Use application-level JSON serialisation instead.',
        );
    }

    const hasJsonObject = supports('json_object_array', targetPlatform);
    const platformLabel = PLATFORM_LABELS[targetPlatform] ?? targetPlatform;

    const rawTableName = options.tableName
        ? options.tableName
        : cleanIdentifier(splitextRoot(baseName(metadata.file_path ?? 'data')));
    const rootLabel = quoteLiteral(rawTableName); // literal context (FOR JSON ROOT)
    const tableName = escapeIdentifier(rawTableName);
    const schemaName = escapeIdentifier(options.schemaName ?? 'dbo');
    const schema = Array.isArray(metadata.schema) ? metadata.schema : [];
    const nesting = metadata.json_nesting ?? {};

    const selectCols: string[] = [];
    for (const [colName] of schema) {
        const clean = escapeIdentifier(colName);
        const kind = nesting[colName] ?? 'scalar';
        if (kind === 'object' || kind === 'array') {
            selectCols.push(`    JSON_QUERY([${clean}]) AS [${escapeIdentifier(colName)}]`);
        } else {
            selectCols.push(`    [${clean}] AS [${escapeIdentifier(colName)}]`);
        }
    }
    const colsStr = selectCols.length > 0 ? selectCols.join(',\n') : '    *';

    const lines = [
        '-- ====================================================================',
        '-- FOR JSON PATH  — export SQL rows back to JSON',
        `-- Target : ${sqlComment(platformLabel)}`,
        '-- ====================================================================',
        '',
        '-- 1. Basic array output (each row = one JSON object)',
        'SELECT',
        colsStr,
        `FROM [${schemaName}].[${tableName}]`,
        'FOR JSON PATH;',
        '',
        '-- 2. Wrapped in a root element',
        'SELECT',
        colsStr,
        `FROM [${schemaName}].[${tableName}]`,
        `FOR JSON PATH, ROOT('${rootLabel}');`,
        '',
        '-- 3. Include NULL values in output (omitted by default)',
        'SELECT',
        colsStr,
        `FROM [${schemaName}].[${tableName}]`,
        'FOR JSON PATH, INCLUDE_NULL_VALUES;',
        '',
        '-- 4. Single object (without array wrapper)',
        'SELECT TOP 1',
        colsStr,
        `FROM [${schemaName}].[${tableName}]`,
        'FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;',
    ];

    if (hasJsonObject) {
        lines.push(
            '',
            `-- 5. JSON_OBJECT / JSON_ARRAY  (${sqlComment(platformLabel)})`,
            'SELECT',
            '    JSON_OBJECT(',
        );
        const joPairs = schema
            .slice(0, 6)
            .map(
                ([colName]) =>
                    `        '${quoteLiteral(colName)}': [${escapeIdentifier(colName)}]`,
            );
        lines.push(joPairs.length > 0 ? joPairs.join(',\n') : "        'data': *");
        lines.push('    ) AS json_row', `FROM [${schemaName}].[${tableName}];`);
    } else {
        lines.push(
            '',
            `-- 5. JSON_OBJECT / JSON_ARRAY  — NOT available on ${sqlComment(platformLabel)}`,
            '--    Requires SQL Server 2022+ or Azure SQL Database',
        );
    }

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// BEST PRACTICES
// ---------------------------------------------------------------------------

/** Generate a best-practices guide for ingesting / querying this file type. */
export function generateBestPractices(
    metadata: GeneratorMetadata,
    options: StatementOptions = {},
): string {
    const targetPlatform = normalizePlatform(options.targetPlatform);
    const schemaName = options.schemaName ?? 'dbo';

    const platformLabel = PLATFORM_LABELS[targetPlatform] ?? targetPlatform;
    const fileType = stringOr(metadata.file_type, 'csv');
    const fileName = metadata.file_name ?? 'file';
    const rowCount = metadata.row_count;
    const encoding = stringOr(metadata.encoding, 'utf-8').toUpperCase();
    const compression = metadata.compression ?? null;
    const delimiter = stringOr(metadata.delimiter, ',');
    const hasHeader = metadata.has_header ?? true;

    const sizeBytes = metadata.file_size ?? 0;
    const sizeMb = sizeBytes / 1024 / 1024;
    const sizeLabel = `${formatMegabytes(sizeBytes)} MB`;
    const rowsLabel = rowCount ? String(rowCount) : 'unknown';

    // A caller-supplied table name is the exact name used by CREATE TABLE /
    // BULK INSERT, so the validation queries below must use it verbatim. Only a
    // derived name needs cleaning (e.g. a leading digit).
    const resolvedTableName =
        options.tableName || cleanIdentifier(splitextRoot(fileName) || 'data');

    const lines = [
        '-- ====================================================================',
        `-- BEST PRACTICES  —  ${sqlComment(fileName)}`,
        `-- Target   : ${sqlComment(platformLabel)}`,
        `-- File type : ${sqlComment(fileType.toUpperCase())}`,
        `-- File size : ${sizeLabel}`,
        `-- Row count : ${rowsLabel}`,
        `-- Encoding  : ${sqlComment(encoding)}`,
        '-- ====================================================================',
        '',
    ];

    lines.push(...bestPracticesSummary(metadata, targetPlatform, sizeMb));
    lines.push(...bestPracticesWarnings(metadata));

    // Platform-specific loading recommendation
    const loadMethods: string[] = [];
    if (
        supports('bulk_insert', targetPlatform) &&
        (fileType === 'csv' || fileType === 'text')
    ) {
        loadMethods.push('BULK INSERT (high-speed batch loads)');
    }
    const openrowsetSupported =
        (fileType !== 'parquet' && fileType !== 'delta') ||
        targetPlatform === 'sql_server_2022' ||
        targetPlatform === 'sql_server_2025' ||
        (fileType === 'parquet' &&
            (targetPlatform === 'azure_sql_db' ||
                targetPlatform === 'azure_sql_mi' ||
                targetPlatform === 'fabric_sql_db'));
    if (supports('openrowset', targetPlatform) && openrowsetSupported) {
        loadMethods.push('OPENROWSET (ad-hoc / exploratory queries)');
    }
    const config = determineFormatConfig(metadata);
    const formatPlatforms = externalFormatPlatforms(config.format_type);
    if (
        supports('external_table', targetPlatform) &&
        formatPlatforms &&
        formatPlatforms.has(targetPlatform)
    ) {
        loadMethods.push('CREATE EXTERNAL TABLE (persistent virtual table)');
    }
    if (supports('json_openjson', targetPlatform) && fileType === 'json') {
        loadMethods.push('OPENJSON / JSON_VALUE (native JSON parsing)');
    }
    if (supports('for_json', targetPlatform)) {
        loadMethods.push('FOR JSON PATH (export to JSON)');
    }

    if (loadMethods.length > 0) {
        lines.push(`-- RECOMMENDED LOADING METHODS for ${sqlComment(platformLabel)}:`);
        loadMethods.forEach((method, index) => {
            lines.push(`--   ${index + 1}. ${method}`);
        });
        lines.push('');
    }

    if (fileType === 'csv') {
        lines.push(
            ...bestPracticesCsv(
                sizeMb,
                encoding,
                delimiter,
                hasHeader,
                compression,
                targetPlatform,
            ),
        );
    } else if (fileType === 'parquet') {
        lines.push(...bestPracticesParquet(sizeMb, compression, metadata, targetPlatform));
    } else if (fileType === 'delta') {
        lines.push(...bestPracticesDelta(metadata, targetPlatform));
    } else if (fileType === 'json') {
        lines.push(...bestPracticesJson(sizeMb, targetPlatform));
    } else {
        lines.push(...bestPracticesGeneric());
    }

    lines.push(...bestPracticesValidationSql(metadata, resolvedTableName, schemaName));

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Aggregate entry points
// ---------------------------------------------------------------------------

/** Options for {@link generateAllStatements} and {@link generateCompleteDdl}. */
export interface GenerateAllOptions {
    tableName?: string | null;
    dataSource?: string | null;
    location?: string | null;
    schemaName?: string;
    targetPlatform?: TargetPlatform | string | null;
    storageUrl?: string | null;
    /** Connector selected by the guided external data source setup. */
    dataSourceType?: ExternalDataSourceType | string | null;
    /**
     * Name for the generated external file format. Defaults to
     * `ff_<file_type>_format`.
     */
    formatName?: string | null;
    /** Name for the generated external table. Defaults to `ext_<tableName>`. */
    externalTableName?: string | null;
    /**
     * Name for the generated database scoped credential. Defaults to
     * `cred_<dataSource>`.
     */
    credentialName?: string | null;
    /**
     * How the generated SQL authenticates to storage. Defaults to
     * `managed_identity` where the platform supports it.
     */
    authMethod?: string | null;
    /**
     * Emit the rerun truncate as a live statement rather than as commented
     * guidance. Only honoured together with an explicit schema and table name;
     * see {@link ownsLoadTarget}.
     */
    rerunTruncate?: boolean;
}

/**
 * Return the regular table name a caller-supplied override resolves to.
 *
 * `null`/blank derives the name from the file name, matching
 * {@link generateAllStatements}; anything else is cleaned but kept.
 */
export function resolveTableName(
    metadata: GeneratorMetadata,
    tableName?: string | null,
): string {
    if (!tableName) {
        return derivedTableName(metadata);
    }
    return cleanIdentifier(tableName);
}

/** Generate every statement tab for one file. */
export function generateAllStatements(
    metadata: GeneratorMetadata,
    options: GenerateAllOptions = {},
): GeneratedStatements {
    const targetPlatform = normalizePlatform(options.targetPlatform);
    const effectiveMetadata: GeneratorMetadata = metadata.parser_overrides?.format
        ? { ...metadata, file_type: metadata.parser_overrides.format }
        : metadata;
    const storageUrl = options.storageUrl ?? null;
    const schemaName = options.schemaName ?? 'dbo';
    const dataSource = options.dataSource || 'MyDataSource';
    const tableName = resolveTableName(effectiveMetadata, options.tableName);
    const selectedSourceType = options.dataSourceType
        ? normalizeDataSourceType(options.dataSourceType, targetPlatform)
        : null;
    const externalStorageUrl = selectedSourceType
        ? effectiveStorageUrl(
            targetPlatform,
            selectedSourceType,
            storageUrl,
            displayFileName(effectiveMetadata),
        )
        : storageUrl;
    const openrowsetStorageUrl = selectedSourceType ? externalStorageUrl : storageUrl;

    // The external table must not collide with the regular table in the same
    // script, so it always gets its own name.
    const externalTableName = options.externalTableName
        ? cleanIdentifier(options.externalTableName)
        : `ext_${tableName}`;
    const fmtName = options.formatName
        ? cleanIdentifier(options.formatName)
        : `ff_${stringOr(effectiveMetadata.file_type, 'csv')}_format`;

    const shared: StatementOptions = {
        tableName,
        schemaName,
        targetPlatform,
        storageUrl: openrowsetStorageUrl,
        dataSource,
    };

    return {
        create_table: generateCreateTable(effectiveMetadata, shared),
        bulk_insert: generateBulkInsert(effectiveMetadata, {
            ...shared,
            credentialName: options.credentialName,
            authMethod: options.authMethod,
        }),
        openrowset: generateOpenrowset(effectiveMetadata, {
            storageUrl: openrowsetStorageUrl,
            dataSource,
            targetPlatform,
        }),
        copy_into: generateCopyInto(effectiveMetadata, shared),
        external_file_format: generateExternalFileFormat(effectiveMetadata, {
            formatName: fmtName,
            targetPlatform,
        }),
        create_external_table: generateExternalTable(effectiveMetadata, {
            tableName: externalTableName,
            dataSource,
            location: options.location ?? null,
            fileFormat: fmtName,
            schemaName,
            targetPlatform,
            storageUrl: externalStorageUrl,
        }),
        json_functions: generateJsonFunctions(effectiveMetadata, shared),
        for_json: generateForJsonPath(effectiveMetadata, shared),
        credential_setup: generateCredentialSetup({
            dataSource,
            fileFormat: fmtName,
            metadata: effectiveMetadata,
            targetPlatform,
            storageUrl: externalStorageUrl,
            credentialName: options.credentialName,
            authMethod: options.authMethod,
        }),
        best_practices: generateBestPractices(effectiveMetadata, shared),
    };
}

// ---------------------------------------------------------------------------
// Rerun safety for the complete document
// ---------------------------------------------------------------------------

/**
 * Each guardable CREATE, with the existence test that makes re-running it safe.
 * `catalog` names a catalog view keyed by object name; `objectId` uses
 * `OBJECT_ID` because tables live in a schema and a bare name is ambiguous.
 */
const GUARDED_CREATES: ReadonlyArray<{
    readonly source: string;
    readonly kind: 'catalog' | 'objectId';
    readonly argument: string;
}> = [
    {
        source: 'CREATE\\s+EXTERNAL\\s+DATA\\s+SOURCE',
        kind: 'catalog',
        argument: 'sys.external_data_sources',
    },
    {
        source: 'CREATE\\s+EXTERNAL\\s+FILE\\s+FORMAT',
        kind: 'catalog',
        argument: 'sys.external_file_formats',
    },
    {
        source: 'CREATE\\s+DATABASE\\s+SCOPED\\s+CREDENTIAL',
        kind: 'catalog',
        argument: 'sys.database_scoped_credentials',
    },
    { source: 'CREATE\\s+EXTERNAL\\s+TABLE', kind: 'objectId', argument: 'U' },
    { source: 'CREATE\\s+TABLE', kind: 'objectId', argument: 'U' },
];

const GUARD_RE = new RegExp(
    `^([ \\t]*)(${GUARDED_CREATES.map((entry) => entry.source).join('|')})` +
        '\\s+(\\[[^\\]]+\\](?:\\.\\[[^\\]]+\\])?|[^\\s(;]+)',
    'i',
);

/**
 * A line every SQL client treats as a batch separator. Nothing a guard wraps
 * may cross one.
 */
const BATCH_SEPARATOR_RE = /^\s*GO\s*(?:--.*)?$/i;

/**
 * The schema a table lands in when nobody says otherwise - and therefore the
 * one schema this generator must never assume it owns.
 */
export const DEFAULT_SCHEMA_NAME = 'dbo';

/** The catalog form of an identifier: brackets off, doubling undone. */
function unbracket(name: string): string {
    const trimmed = name.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        return trimmed.slice(1, -1).replace(/\]\]/g, ']');
    }
    return trimmed;
}

/**
 * Index of the last line of the statement beginning at *start*.
 *
 * Semicolons inside string literals do not end a statement - a
 * semicolon-delimited CSV puts one in `FIELD_TERMINATOR = ';'` - so the scan
 * tracks quoting rather than looking for the character.
 *
 * Bracket-quoted identifiers are skipped for the same reason, and it matters
 * more than it looks: `escapeIdentifier` only doubles `]`, so a column called
 * `Employee's ID` arrives here as `[Employee's ID]` with a live apostrophe in
 * it. Treating that as the start of a string literal inverts the quote parity
 * for the rest of the scan, and the statement then "ends" at some unrelated
 * semicolon further down the document.
 *
 * The scan also stops at a `GO` batch separator. A guarded CREATE is wrapped in
 * `BEGIN`/`END`, and a mis-parse that swallowed a `GO` would leave the first
 * batch with an unterminated `BEGIN`, so this is the backstop that keeps a
 * lexer surprise from breaking the whole document.
 */
function statementEnd(lines: readonly string[], start: number): number {
    let inString = false;
    let inBracket = false;
    let inQuotedIdent = false;
    for (let index = start; index < lines.length; index += 1) {
        const line = lines[index];
        if (
            index > start &&
            !inString &&
            !inBracket &&
            !inQuotedIdent &&
            BATCH_SEPARATOR_RE.test(line)
        ) {
            return index - 1;
        }
        let position = 0;
        while (position < line.length) {
            const char = line[position];
            if (inString) {
                if (char === "'") {
                    if (line[position + 1] === "'") {
                        position += 1;
                    } else {
                        inString = false;
                    }
                }
            } else if (inBracket) {
                if (char === ']') {
                    if (line[position + 1] === ']') {
                        position += 1;
                    } else {
                        inBracket = false;
                    }
                }
            } else if (inQuotedIdent) {
                if (char === '"') {
                    if (line[position + 1] === '"') {
                        position += 1;
                    } else {
                        inQuotedIdent = false;
                    }
                }
            } else if (char === "'") {
                inString = true;
            } else if (char === '[') {
                inBracket = true;
            } else if (char === '"') {
                inQuotedIdent = true;
            } else if (char === '-' && line.slice(position, position + 2) === '--') {
                break;
            } else if (char === ';') {
                return index;
            }
            position += 1;
        }
    }
    return lines.length - 1;
}

/** The `IF NOT EXISTS` line that makes creating *name* rerunnable. */
function guardFor(head: string, name: string): string {
    const normalized = head.trim().replace(/\s+/g, ' ').toUpperCase();
    for (const entry of GUARDED_CREATES) {
        const full = new RegExp(`^${entry.source.replace(/\\s\+/g, ' ')}$`, 'i');
        if (!full.test(normalized)) {
            continue;
        }
        if (entry.kind === 'catalog') {
            return (
                `IF NOT EXISTS (SELECT 1 FROM ${entry.argument} ` +
                `WHERE name = N'${quoteLiteral(unbracket(name))}')`
            );
        }
        return `IF OBJECT_ID(N'${quoteLiteral(name)}', N'${entry.argument}') IS NULL`;
    }
    return '';
}

/**
 * Wrap every guardable CREATE in the document in an existence check.
 *
 * Re-running a script that created an external data source used to fail at
 * error 46502 on the second run. Nothing was wrong with the DDL; it simply said
 * CREATE where a document you may run twice has to say "create if it is not
 * already there".
 */
export function guardCreateStatements(sql: string): string {
    const lines = sql.split('\n');
    const output: string[] = [];
    let index = 0;
    while (index < lines.length) {
        const match = GUARD_RE.exec(lines[index]);
        const guard = match ? guardFor(match[2], match[3]) : '';
        if (!match || !guard) {
            output.push(lines[index]);
            index += 1;
            continue;
        }
        const end = statementEnd(lines, index);
        const indent = match[1];
        output.push(`${indent}${guard}`);
        output.push(`${indent}BEGIN`);
        for (const line of lines.slice(index, end + 1)) {
            output.push(line.trim() ? `    ${line}` : line);
        }
        output.push(`${indent}END`);
        index = end + 1;
    }
    return output.join('\n');
}

/**
 * A line that actually loads rows, as opposed to one describing a load. Comment
 * lines are excluded by the line anchor: the generator comments alternatives out.
 */
const LOAD_RE = /^[ \t]*(?:BULK\s+INSERT|INSERT\s+INTO|COPY\s+INTO)\s+(\S+)/gim;

/** True when *section* really loads rows into *targetTable*. */
function loadsInto(section: string, targetTable: string): boolean {
    LOAD_RE.lastIndex = 0;
    for (const match of section.matchAll(LOAD_RE)) {
        if ((match[1] ?? '').replace(/[;,]+$/, '') === targetTable) {
            return true;
        }
    }
    return false;
}

/**
 * The rerun-safety batch for the load target.
 *
 * Idempotence is not only about DDL. A script whose CREATEs are all guarded
 * still doubles its data on the second run, and a row count that quietly went
 * from 150 to 300 is a worse outcome than an error.
 *
 * Emptying the target is only safe when the document can be said to own it,
 * which is why `active` exists. A file called `orders.csv` derives the table
 * name `dbo.orders` - the exact name a TPC-H warehouse already uses - so the
 * default output only ever *describes* the truncate. The live statement is
 * emitted when the caller both asked for rerun safety and named a target of
 * their own.
 */
function truncateBeforeLoad(targetTable: string, active: boolean): string[] {
    const statement = [
        `IF OBJECT_ID(N'${quoteLiteral(targetTable)}', N'U') IS NOT NULL`,
        `    TRUNCATE TABLE ${targetTable};`,
    ];
    const lines = [
        '-- ====================================================================',
        '-- RERUN SAFETY',
        '-- ====================================================================',
        '-- Every CREATE above is guarded, so re-running this document will not',
        '-- fail on an object that already exists. Data is the other half: the',
        '-- load below appends, so a second run inserts the same rows into',
        `-- ${targetTable} again.`,
    ];
    if (active) {
        lines.push(
            '--',
            `-- Emptying ${targetTable} first is what makes the row count stable`,
            '-- across runs. It is enabled here because you named this target',
            '-- explicitly, so it is not a table this tool guessed at. Delete this',
            '-- batch if you mean to append to what is already there.',
        );
        return [...lines, ...statement, 'GO'];
    }
    lines.push(
        '--',
        `-- Emptying ${targetTable} first would make the row count stable, and`,
        '-- the two lines below do exactly that. They are commented out because',
        '-- this document cannot prove it created that table: the name was',
        '-- derived from the file name in the default schema, and a table of the',
        '-- same name may already exist and hold data that has nothing to do',
        '-- with this file. Silently emptying it would be data loss.',
        '--',
        "-- Uncomment them once you have confirmed the table is this document's",
        '-- to empty, or regenerate with an explicit schema and table name you',
        '-- own (--schema/--table) to have them emitted live.',
    );
    return [...lines, ...statement.map((line) => `-- ${line}`)];
}

/**
 * True when the caller named the load target rather than inheriting it.
 *
 * Both halves matter. An explicit table name in `dbo` is still a name that
 * collides with whatever else lives in `dbo`, and the run-owned schema is what
 * actually separates this document's objects from everyone else's.
 *
 * The trimming is {@link pythonStrip}, not `trim()`. This predicate decides
 * whether a `TRUNCATE` is emitted live or commented out, so the two generators
 * have to reach the same answer for the same input, and the two whitespace sets
 * are not the same one. Python strips `\x1c`-`\x1f` and `\x85`, which JS keeps;
 * JS strips `\uFEFF`, which Python keeps. The first direction is the dangerous
 * one: with `trim()`, `dbo\x1c` looks un-owned to Python and owned here, and
 * `collapseControlCharacters` then renders it as `[dbo ]` - which a
 * trailing-blank-insensitive collation resolves straight back to the `dbo` this
 * whole guard exists to protect.
 */
export function ownsLoadTarget(
    tableName: string | null | undefined,
    schemaName: string | null | undefined,
): boolean {
    const named = Boolean(pythonStrip(tableName ?? ''));
    const schema = pythonStrip(schemaName ?? '').toLowerCase();
    return named && schema !== '' && schema !== DEFAULT_SCHEMA_NAME;
}

/**
 * Return every generated section as one runnable, GO-separated script.
 *
 * The document is rerunnable. A single statement tab is something you copy into
 * an editor once, but a complete script is something people run again after
 * fixing a typo three sections down - and the first live run proved it:
 * re-executing the document failed at error 46502 because the external data
 * source it had just created still existed. So every CREATE here is guarded by
 * an existence check.
 *
 * Data needs the same treatment, but it cannot be handled the same way. A
 * guarded CREATE is harmless when the object already exists; emptying a table
 * that already exists is not. The default output therefore explains the
 * truncate and leaves it commented out. Pass `rerunTruncate` together with an
 * explicit schema and table name to have it emitted live - see
 * {@link ownsLoadTarget} for why both are required.
 */
export function generateCompleteDdl(
    metadata: GeneratorMetadata,
    options: GenerateAllOptions = {},
): string {
    const dataSource = options.dataSource || 'MyDataSource';
    const targetPlatform = normalizePlatform(options.targetPlatform);
    const storageUrl = options.storageUrl ?? null;
    const schemaName = options.schemaName ?? 'dbo';

    const statements = generateAllStatements(metadata, {
        ...options,
        dataSource,
        targetPlatform,
    });

    const orderedSections: StatementKind[] = [
        'credential_setup',
        'external_file_format',
        'create_external_table',
        'create_table',
        'bulk_insert',
        'openrowset',
    ];

    // The prerequisite setup section already creates the BLOB_STORAGE source
    // that BULK INSERT needs, so do not create it twice.
    const [bulkIdent] = bulkDataSourceNames(dataSource, options.credentialName);
    if (
        (statements.credential_setup || '').includes(
            `CREATE EXTERNAL DATA SOURCE [${bulkIdent}]`,
        )
    ) {
        statements.bulk_insert = generateBulkInsert(metadata, {
            tableName: resolveTableName(metadata, options.tableName),
            schemaName,
            targetPlatform,
            storageUrl,
            dataSource,
            includePrereq: false,
            credentialName: options.credentialName,
            authMethod: options.authMethod,
        });
    }

    const parts: string[] = [];
    const targetTable =
        `[${escapeIdentifier(schemaName)}].` +
        `[${escapeIdentifier(resolveTableName(metadata, options.tableName))}]`;
    let truncated = false;
    const truncateActive =
        Boolean(options.rerunTruncate) &&
        ownsLoadTarget(options.tableName, options.schemaName);
    for (const key of orderedSections) {
        const section = (statements[key] || '').trim();
        if (!section) {
            continue;
        }
        if (!truncated && loadsInto(section, targetTable)) {
            parts.push(truncateBeforeLoad(targetTable, truncateActive).join('\n'));
            truncated = true;
        }
        parts.push(section);
        if (!section.endsWith('GO')) {
            parts.push('GO');
        }
    }

    return `${guardCreateStatements(parts.join('\n\n'))}\n`;
}

// ---------------------------------------------------------------------------
// Multi-file export
// ---------------------------------------------------------------------------

/**
 * Objects shared by every file in a multi-file export, which must therefore be
 * created only once. The pattern source text doubles as the dedup key prefix so
 * two different object kinds with the same name never collide.
 */
const SHARED_OBJECT_PATTERNS: ReadonlyArray<{ source: string; regex: RegExp }> = [
    { source: '^\\s*CREATE\\s+MASTER\\s+KEY\\b', regex: /^\s*CREATE\s+MASTER\s+KEY\b/gim },
    {
        source: '^\\s*CREATE\\s+DATABASE\\s+SCOPED\\s+CREDENTIAL\\s+(\\[[^\\]]*\\]|\\S+)',
        regex: /^\s*CREATE\s+DATABASE\s+SCOPED\s+CREDENTIAL\s+(\[[^\]]*\]|\S+)/gim,
    },
    {
        source: '^\\s*CREATE\\s+EXTERNAL\\s+DATA\\s+SOURCE\\s+(\\[[^\\]]*\\]|\\S+)',
        regex: /^\s*CREATE\s+EXTERNAL\s+DATA\s+SOURCE\s+(\[[^\]]*\]|\S+)/gim,
    },
    {
        source: '^\\s*CREATE\\s+EXTERNAL\\s+FILE\\s+FORMAT\\s+(\\[[^\\]]*\\]|\\S+)',
        regex: /^\s*CREATE\s+EXTERNAL\s+FILE\s+FORMAT\s+(\[[^\]]*\]|\S+)/gim,
    },
];

/** Keys for the shared prerequisite objects created in *batch*. */
function sharedObjectsIn(batch: string): string[] {
    const keys: string[] = [];
    for (const { source, regex } of SHARED_OBJECT_PATTERNS) {
        regex.lastIndex = 0;
        for (const match of batch.matchAll(regex)) {
            const name = match[1] ?? '';
            keys.push(`${source}|${name.toUpperCase()}`);
        }
    }
    return keys;
}

/**
 * Comment out shared prerequisite batches that were already created.
 *
 * Concatenating per-file complete scripts repeats `CREATE MASTER KEY`,
 * `CREATE DATABASE SCOPED CREDENTIAL`, `CREATE EXTERNAL DATA SOURCE` and
 * `CREATE EXTERNAL FILE FORMAT`, which makes every file after the first fail. A
 * batch is skipped only when *every* shared object it creates has already been
 * created, so file-specific batches are never dropped.
 *
 * `seen` is mutated so a caller can carry state across several scripts.
 */
export function deduplicateSharedPrerequisites(
    script: string,
    seen: Set<string> = new Set<string>(),
): string {
    const kept: string[] = [];
    for (const batch of splitGoBatches(script)) {
        const keys = sharedObjectsIn(batch);
        if (keys.length > 0 && keys.every((key) => seen.has(key))) {
            kept.push(
                '-- Skipped: the shared prerequisite object(s) in this batch\n' +
                    '-- are already created earlier in this export.',
            );
            continue;
        }
        for (const key of keys) {
            seen.add(key);
        }
        kept.push(batch);
    }
    return kept.join('\nGO\n');
}

export { DEFAULT_TARGET_PLATFORM };
