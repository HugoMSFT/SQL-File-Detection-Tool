/**
 * OPENROWSET generation for every supported target platform.
 *
 * Split out of `generator.ts` because the OPENROWSET surface is by far the most
 * platform-divergent part of the tool: SQL Server 2019, SQL Server 2022+,
 * Azure SQL DB/MI and Fabric SQL Database each need a different data-source
 * shape, and JSON needs a completely different access pattern from the others
 * because the `abs://` / `adls://` virtualization connectors reject
 * `SINGLE_CLOB`. A `TYPE = BLOB_STORAGE` source accepts it.
 */

import type { TargetPlatform } from '../types';
import {
    deltaTableFolder,
    folderOf,
    quoteLiteral,
    sqlComment,
    bulkDataSourceNames,
} from './escaping';
import {
    PLATFORM_LABELS,
    supports,
    AZURE_SQL_PLATFORMS,
} from './typeMapping';
import {
    azureBulkStorageParts,
    azureVirtualizationParts,
    fabricOnelakeParts,
    sqlServerStorageParts,
    storageUrlKind,
    storageUrlSupportedByPlatform,
} from './storage';
import {
    csvReaderOptions,
    generateColumnDefinitions,
    generateOpenjsonColumns,
    jsonRowFrameOptions,
    jsonSingleLobOptions,
    singleLobKeyword,
    notSupportedMessage,
    openrowsetWithSchema,
    displayFileName,
    exceedsTargetTableColumnLimit,
    targetTableColumnLimitGuidance,
    type GeneratorMetadata,
} from './generatorHelpers';

/** Options accepted by {@link generateOpenrowset}. */
export interface OpenrowsetOptions {
    storageUrl?: string | null;
    dataSource?: string;
    targetPlatform: TargetPlatform;
}

function stringOr(value: unknown, fallback: string): string {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    return String(value);
}

/** Column body for a `WITH (...)` clause, falling back to a single text column. */
function columnBody(metadata: GeneratorMetadata): string {
    const cols = generateColumnDefinitions(metadata, { indent: 4 });
    return cols.length > 0 ? cols.join(',\n') : '    [data] NVARCHAR(MAX)';
}

/** Generate OPENROWSET queries for CSV, Parquet, Delta and JSON. */
export function generateOpenrowset(
    metadata: GeneratorMetadata,
    options: OpenrowsetOptions,
): string {
    const targetPlatform = options.targetPlatform;
    const storageUrl = options.storageUrl ?? null;
    const dataSource = options.dataSource ?? 'MyDataSource';
    const fileType = stringOr(metadata.file_type, 'csv');
    const exceedsColumnLimit = exceedsTargetTableColumnLimit(metadata);
    const wideJson = exceedsColumnLimit && fileType === 'json';

    if (storageUrl && !storageUrlSupportedByPlatform(storageUrl, targetPlatform)) {
        return notSupportedMessage(
            'STORAGE LOCATION',
            targetPlatform,
            'The supplied storage location is not supported by this SQL platform and was not replaced.',
        );
    }

    if (fileType === 'orc' || fileType === 'rc' || fileType === 'iceberg') {
        const alternative =
            fileType === 'iceberg'
                ? 'Query the Iceberg table through a catalog-aware engine, or select its underlying Parquet data files.'
                : supports('external_table', targetPlatform)
                    ? 'Use a documented external table/file format combination for this platform, or convert the source to Parquet.'
                    : 'Convert the source to Parquet before querying it from this platform.';
        return notSupportedMessage(
            `OPENROWSET (${fileType.toUpperCase()})`,
            targetPlatform,
            alternative,
        );
    }

    if (
        exceedsColumnLimit &&
        fileType !== 'json' &&
        fileType !== 'parquet' &&
        fileType !== 'delta'
    ) {
        return targetTableColumnLimitGuidance(metadata, 'OPENROWSET TYPED PROJECTION');
    }

    if (!supports('openrowset', targetPlatform)) {
        const alts: string[] = [];
        if (supports('bulk_insert', targetPlatform)) {
            alts.push('BULK INSERT (see BULK INSERT tab)');
        }
        if (supports('json_openjson', targetPlatform)) {
            alts.push('OPENJSON after reading the document as text');
        }
        const altText =
            alts.length > 0
                ? alts.join(', ')
                : 'Use the appropriate data access method for your platform.';
        return notSupportedMessage(
            'OPENROWSET',
            targetPlatform,
            `Alternative: ${altText}`,
        );
    }

    const fileName = displayFileName(metadata);
    const localPath = quoteLiteral(
        stringOr(metadata.file_path, '').split('\\').join('/'),
    );

    const platformLabel = PLATFORM_LABELS[targetPlatform] ?? targetPlatform;
    const lines = [
        ...(wideJson
            ? [
                ...targetTableColumnLimitGuidance(
                    metadata,
                    'OPENROWSET RAW-JSON ACCESS',
                ).split('\n'),
                '',
            ]
            : []),
        '-- ====================================================================',
        '-- OPENROWSET',
        `-- Source  : ${sqlComment(fileName)}  (${sqlComment(fileType.toUpperCase())})`,
        `-- Target  : ${sqlComment(platformLabel)}`,
        '-- Use for : Ad-hoc / exploratory queries without creating a table',
        '-- ====================================================================',
        '',
    ];

    if (targetPlatform === 'fabric_sql_db') {
        return openrowsetFabric(metadata, lines, storageUrl, dataSource);
    }

    if (AZURE_SQL_PLATFORMS.has(targetPlatform)) {
        return openrowsetAzure(
            metadata,
            lines,
            storageUrl,
            dataSource,
            targetPlatform,
        );
    }

    if (targetPlatform === 'sql_server_2019') {
        return openrowsetSqlServer2019(
            metadata,
            lines,
            localPath,
            storageUrl,
            dataSource,
        );
    }

    // SQL Server 2022 / 2025. Object storage formats always use a data source;
    // text formats do too as soon as a storage URL is known.
    if (fileType === 'parquet' || fileType === 'delta' || storageUrl) {
        return openrowsetSqlServerObjectStorage(
            metadata,
            lines,
            storageUrl,
            dataSource,
            targetPlatform,
        );
    }

    return openrowsetLocal(metadata, lines, localPath, targetPlatform);
}

/** SQL Server 2019 OPENROWSET: local paths plus Azure Blob bulk access. */
/**
 * NDJSON read for a cloud source.
 *
 * Every line is its own document, so the file is framed into rows and each row
 * is parsed on its own. There is deliberately no whole-file read: handing
 * OPENJSON a concatenation of documents is not valid JSON.
 */
function ndjsonCloudLines(
    metadata: GeneratorMetadata,
    bulkPath: string,
    sourceName: string,
): string[] {
    const lines = [
        '-- ---- NDJSON / JSON Lines: one document per row -----------------------',
        '-- Row framing uses the data-virtualization source. The https://',
        '-- BLOB_STORAGE connector rejects FIELDTERMINATOR /',
        '-- FIELDQUOTE / ROWTERMINATOR with error 5369.',
        '-- The file is never read whole here: concatenated NDJSON is not one',
        '-- JSON document, so SINGLE_CLOB + OPENJSON would fail on it.',
    ];
    const cols = generateOpenjsonColumns(metadata, 4);
    lines.push(
        cols.length > 0 ? 'SELECT TOP (100) [j].*' : 'SELECT TOP (100) [src].doc',
        'FROM OPENROWSET(',
        `    BULK '${bulkPath}',`,
        `    DATA_SOURCE     = '${sourceName}',`,
    );
    lines.push(...jsonRowFrameOptions(metadata, 4, '0x0a'));
    if (cols.length > 0) {
        lines.push(
            ') WITH (doc NVARCHAR(MAX)) AS [src]  -- LF: one document per line',
            'CROSS APPLY OPENJSON([src].doc)',
            'WITH (',
            cols.join(',\n'),
            ') AS [j];',
        );
    } else {
        lines.push(') WITH (doc NVARCHAR(MAX)) AS [src];  -- LF: one document per line');
    }
    return lines;
}

/** NDJSON read for a server-local path, framed into one document per line. */
function ndjsonLocalLines(
    metadata: GeneratorMetadata,
    localPath: string,
): string[] {
    const cols = generateOpenjsonColumns(metadata, 4);
    const lines = [
        '-- ---- NDJSON / JSON Lines: one document per row -----------------------',
        '-- FORMAT = CSV is used only to frame LF-delimited JSON documents.',
        cols.length > 0 ? 'SELECT TOP (100) [j].*' : 'SELECT TOP (100) [src].doc',
        'FROM OPENROWSET(',
        `    BULK N'${localPath}',`,
        ...jsonRowFrameOptions(metadata, 4, '0x0a'),
    ];
    if (cols.length > 0) {
        lines.push(
            ') WITH (doc NVARCHAR(MAX)) AS [src]  -- LF: one document per line',
            'CROSS APPLY OPENJSON([src].doc)',
            'WITH (',
            cols.join(',\n'),
            ') AS [j];',
        );
    } else {
        lines.push(') WITH (doc NVARCHAR(MAX)) AS [src];  -- LF: one document per line');
    }
    return lines;
}

function openrowsetSqlServer2019(
    metadata: GeneratorMetadata,
    lines: string[],
    localPath: string,
    storageUrl: string | null,
    dataSource: string,
): string {
    const fileType = stringOr(metadata.file_type, 'csv');

    if (fileType === 'parquet' || fileType === 'delta') {
        const formatLabel = fileType === 'parquet' ? 'Parquet' : 'Delta Lake';
        lines.push(
            `-- ${formatLabel} file access is not available on SQL Server 2019.`,
            '-- SQL Server 2022 or later is required for ' +
                `OPENROWSET FORMAT = '${fileType.toUpperCase()}'.`,
            '-- Convert the data to CSV for SQL Server 2019.',
        );
        return lines.join('\n');
    }

    const storageKind = storageUrlKind(storageUrl);

    if (storageKind === 'azure') {
        // SQL Server 2017+ can bulk-read Azure Blob Storage through a
        // TYPE = BLOB_STORAGE external data source. BULK stays relative to
        // that source; an absolute URL is never a valid BULK path.
        return openrowsetBlobStorageBulk(metadata, lines, storageUrl, dataSource);
    }

    if (storageUrl) {
        // Never emit BULK N'https://...' or BULK 's3://...': SQL Server 2019
        // OPENROWSET cannot reach S3 or arbitrary URLs.
        lines.push(
            '-- SQL Server 2019 OPENROWSET cannot read this object storage URL.',
            `-- Detected remote source: ${sqlComment(storageUrl)}`,
            '-- Azure Blob Storage is reachable through a TYPE = BLOB_STORAGE',
            '-- external data source, but s3:// requires SQL Server 2022 or later.',
            '--',
            '-- Staging options:',
            '--   1. Copy the file to a local disk or UNC share, then use',
            '--      BULK INSERT / OPENROWSET(BULK) against that path.',
            '--   2. Copy the file to Azure Blob Storage and use a',
            '--      TYPE = BLOB_STORAGE data source with OPENROWSET(BULK).',
            "--   3. Upgrade to SQL Server 2022+ for s3:// data sources and",
            "--      FORMAT = 'PARQUET' / 'DELTA' support.",
        );
        return lines.join('\n');
    }

    return openrowsetLocal(metadata, lines, localPath, 'sql_server_2019');
}

/**
 * OPENROWSET(BULK) over an Azure Blob `TYPE = BLOB_STORAGE` data source.
 *
 * This is the only bulk-access shape available to SQL Server 2019 for remote
 * files: `FORMAT = 'CSV'` with a container-relative `BULK` path. A
 * `TYPE = BLOB_STORAGE` source does accept `SINGLE_CLOB`/`SINGLE_NCLOB`, so a
 * whole JSON document is read that way rather than through CSV framing.
 */
function openrowsetBlobStorageBulk(
    metadata: GeneratorMetadata,
    lines: string[],
    storageUrl: string | null,
    dataSource: string,
): string {
    const fileType = stringOr(metadata.file_type, 'csv');
    const fileName = displayFileName(metadata);
    const [bulkIdent, bulkLiteral, bulkCredIdent] = bulkDataSourceNames(dataSource);
    const [sourceRoot, relativePath] = azureBulkStorageParts(storageUrl, fileName);
    const bulkPath = quoteLiteral(relativePath);

    lines.push(
        '-- Azure Blob Storage bulk access (SQL Server 2017 and later).',
        '-- BULK is relative to the TYPE = BLOB_STORAGE data source root;',
        '-- an absolute https:// URL is not a valid BULK path.',
        `-- Data source root: ${sqlComment(sourceRoot)}`,
        '',
        '-- Prerequisite (see the credential setup section):',
        `--   CREATE EXTERNAL DATA SOURCE [${bulkIdent}]`,
        `--   WITH (TYPE = BLOB_STORAGE, LOCATION = '${quoteLiteral(sourceRoot)}',`,
        `--         CREDENTIAL = [${bulkCredIdent}]);`,
        '',
    );

    if (fileType === 'json') {
        if (metadata.json_format === 'ndjson') {
            lines.push(
                '-- NDJSON cannot use SINGLE_CLOB through this BLOB_STORAGE source:',
                '-- it would return concatenated documents, while this connector rejects',
                '-- the row-framing options needed to separate them. Preserve each line',
                '-- as raw NVARCHAR(MAX) JSON by staging the file on a local/UNC path or',
                '-- by using a data-virtualization source on a newer/Azure SQL target.',
            );
            return lines.join('\n');
        }
        const lob = singleLobKeyword(metadata.encoding);
        lines.push(
            `-- JSON: a TYPE = BLOB_STORAGE data source accepts ${lob},`,
            '-- so the whole document arrives as one value and is parsed with',
            '-- OPENJSON. (The single-LOB options are rejected only by the',
            '-- abs:// / adls:// virtualization connectors.)',
            'SELECT j.*',
            'FROM OPENROWSET(',
            `    BULK '${bulkPath}',`,
            `    DATA_SOURCE     = '${bulkLiteral}',`,
        );
        lines.push(...jsonSingleLobOptions(metadata.encoding));
        lines.push(
            ') AS src',
            'CROSS APPLY OPENJSON(src.BulkColumn) AS j;',
        );
        return lines.join('\n');
    }

    lines.push(
        "-- Delimited text (FORMAT = 'CSV' is the only format available on 2019):",
        'SELECT TOP 100 *',
        'FROM OPENROWSET(',
        `    BULK '${bulkPath}',`,
        `    DATA_SOURCE     = '${bulkLiteral}',`,
    );
    lines.push(...csvReaderOptions(metadata));
    lines.push(')');
    lines.push(...openrowsetWithSchema(metadata));
    lines.push('AS src;');
    return lines.join('\n');
}

/** Fabric SQL Database OPENROWSET over Lakehouse Files. */
function openrowsetFabric(
    metadata: GeneratorMetadata,
    lines: string[],
    storageUrl: string | null,
    dataSource: string,
): string {
    const fileType = stringOr(metadata.file_type, 'csv');
    const fileName = displayFileName(metadata);

    const [sourceLocation, relativePath] = fabricOnelakeParts(storageUrl, fileName);
    const bulkPath = quoteLiteral(relativePath);
    const sourceName = quoteLiteral(dataSource);

    lines.push(
        '-- Fabric SQL Database data virtualization (preview).',
        '-- Access is authorised with Microsoft Entra passthrough, so the',
        '-- external data source carries no credential or secret.',
        `-- Data source location: ${sqlComment(sourceLocation)}`,
        '-- https://learn.microsoft.com/fabric/database/sql/data-virtualization',
        '',
    );

    if (fileType === 'delta') {
        lines.push(
            '-- Delta is NOT supported by Fabric SQL Database OPENROWSET.',
            '-- Create a OneLake shortcut to the Delta table from a Lakehouse',
            '-- or Warehouse and query it there, or convert it to Parquet',
            '-- inside the Lakehouse Files section first.',
        );
        return lines.join('\n');
    }

    if (fileType === 'parquet') {
        lines.push(
            '-- ---- Parquet ---------------------------------------------------------',
            'SELECT TOP (100) *',
            'FROM OPENROWSET(',
            `    BULK '${bulkPath}',`,
            `    DATA_SOURCE = '${sourceName}',`,
            "    FORMAT = 'PARQUET'",
            ') AS [result];',
        );
        return lines.join('\n');
    }

    if (fileType === 'json') {
        if (metadata.json_format === 'ndjson') {
            lines.push(...ndjsonCloudLines(metadata, bulkPath, sourceName));
            return lines.join('\n');
        }
        lines.push(
            '-- JSON has no OPENROWSET file format on Fabric SQL Database.',
            '-- Read the document as one text column via the CSV reader,',
            '-- then shred it with OPENJSON.',
            '-- ---- JSON -> relational ----------------------------------------------',
            'SELECT j.*',
            'FROM OPENROWSET(',
            `    BULK '${bulkPath}',`,
            `    DATA_SOURCE     = '${sourceName}',`,
        );
        lines.push(...jsonRowFrameOptions(metadata));
        lines.push(
            ') WITH (json_doc NVARCHAR(MAX)) AS [src]',
        );
        const openjsonCols = generateOpenjsonColumns(metadata, 4);
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
        return lines.join('\n');
    }

    // CSV / delimited text
    lines.push(
        '-- ---- CSV with explicit schema ----------------------------------------',
        'SELECT TOP (100) *',
        'FROM OPENROWSET(',
        `    BULK '${bulkPath}',`,
        `    DATA_SOURCE     = '${sourceName}',`,
    );
    lines.push(...csvReaderOptions(metadata));
    lines.push(') WITH (');
    lines.push(columnBody(metadata));
    lines.push(') AS [result];');
    return lines.join('\n');
}

/** Azure SQL data virtualization OPENROWSET statements. */
function openrowsetAzure(
    metadata: GeneratorMetadata,
    lines: string[],
    storageUrl: string | null,
    dataSource: string,
    targetPlatform: TargetPlatform,
): string {
    const fileType = stringOr(metadata.file_type, 'csv');
    const fileName = displayFileName(metadata);
    const jsonFormat = stringOr(metadata.json_format, 'array');
    const platformLabel = PLATFORM_LABELS[targetPlatform] ?? targetPlatform;

    const [sourceLocation, relativePath] = azureVirtualizationParts(
        storageUrl,
        fileName,
    );
    const bulkPath = quoteLiteral(relativePath);
    const sourceName = quoteLiteral(dataSource);

    lines.push(
        '-- Azure SQL data virtualization: BULK is relative to the external',
        '-- data source, whose LOCATION uses abs:// or adls:// (not https://).',
        `-- Data source location: ${sqlComment(sourceLocation)}`,
        '-- See the PREREQUISITE SETUP section for the CREATE EXTERNAL',
        '-- DATA SOURCE statement that this DATA_SOURCE name refers to.',
        '',
    );

    if (fileType === 'delta') {
        if (targetPlatform === 'azure_sql_mi') {
            lines.push(
                `-- Delta is NOT supported on ${sqlComment(platformLabel)}.`,
                '-- Azure SQL Managed Instance data virtualization reads CSV',
                '-- and Parquet only. Convert the Delta table to Parquet.',
            );
            return lines.join('\n');
        }
        lines.push(
            '-- ---- Delta Lake ------------------------------------------------------',
            '-- BULK points at the Delta table folder, not a single file.',
            'SELECT TOP (100) *',
            'FROM OPENROWSET(',
            `    BULK '${quoteLiteral(deltaTableFolder(relativePath))}',`,
            `    DATA_SOURCE = '${sourceName}',`,
            "    FORMAT = 'DELTA'",
            ') AS [result];',
        );
        return lines.join('\n');
    }

    if (fileType === 'parquet') {
        lines.push(
            '-- ---- Parquet ---------------------------------------------------------',
            'SELECT TOP (100) *',
            'FROM OPENROWSET(',
            `    BULK '${bulkPath}',`,
            `    DATA_SOURCE = '${sourceName}',`,
            "    FORMAT = 'PARQUET'",
            ') AS [result];',
            '',
            '-- ---- Wildcard folder scan --------------------------------------------',
            'SELECT *',
            'FROM OPENROWSET(',
            `    BULK '${quoteLiteral(folderOf(relativePath))}*.parquet',`,
            `    DATA_SOURCE = '${sourceName}',`,
            "    FORMAT = 'PARQUET'",
            ') AS [result];',
        );
        return lines.join('\n');
    }

    if (fileType === 'json') {
        const [bulkIdent, bulkLiteral] = bulkDataSourceNames(dataSource);
        const [, bulkRelative] = azureBulkStorageParts(storageUrl, fileName);
        const lob = singleLobKeyword(metadata.encoding);
        if (jsonFormat === 'ndjson') {
            lines.push(...ndjsonCloudLines(metadata, bulkPath, sourceName));
            return lines.join('\n');
        }
        lines.push(
            '-- ---- Whole document -> OPENJSON --------------------------------------',
            `-- ${lob} needs the TYPE = BLOB_STORAGE data source [${bulkIdent}],`,
            '-- not the abs:// virtualization source: the single-LOB options are',
            '-- rejected by abs:// / adls:// but accepted by https:// BLOB_STORAGE.',
            '-- BULK is relative to that source root.',
            'DECLARE @json NVARCHAR(MAX);',
            'SELECT @json = BulkColumn',
            'FROM OPENROWSET(',
            `    BULK '${quoteLiteral(bulkRelative)}',`,
            `    DATA_SOURCE     = '${bulkLiteral}',`,
        );
        lines.push(...jsonSingleLobOptions(metadata.encoding));
        lines.push(
            ') AS [src];',
            '',
            'SELECT * FROM OPENJSON(@json)',
        );
        const openjsonCols = generateOpenjsonColumns(metadata, 4);
        if (openjsonCols.length > 0) {
            lines.push('WITH (', openjsonCols.join(',\n'), ');');
        } else {
            lines.push(';');
        }
        return lines.join('\n');
    }

    // CSV / delimited text
    lines.push(
        '-- ---- CSV with explicit schema ----------------------------------------',
        'SELECT TOP (100) *',
        'FROM OPENROWSET(',
        `    BULK '${bulkPath}',`,
        `    DATA_SOURCE     = '${sourceName}',`,
    );
    lines.push(...csvReaderOptions(metadata));
    lines.push(') WITH (');
    lines.push(columnBody(metadata));
    lines.push(
        ') AS [result];',
        '',
        '-- ---- Whole file as one value (small files) ---------------------------',
        '-- The single-LOB options need the TYPE = BLOB_STORAGE data source;',
        '-- the abs:// / adls:// virtualization connectors reject them.',
        'SELECT BulkColumn AS file_text',
        'FROM OPENROWSET(',
        `    BULK '${quoteLiteral(azureBulkStorageParts(storageUrl, fileName)[1])}',`,
        `    DATA_SOURCE     = '${bulkDataSourceNames(dataSource)[1]}',`,
    );
    lines.push(...jsonSingleLobOptions(metadata.encoding));
    lines.push(') AS [src];');
    return lines.join('\n');
}

/** OPENROWSET(BULK ...) for on-prem SQL Server using local file paths. */
function openrowsetLocal(
    metadata: GeneratorMetadata,
    lines: string[],
    localPath: string,
    targetPlatform: TargetPlatform,
): string {
    const fileType = stringOr(metadata.file_type, 'csv');
    const encoding = stringOr(metadata.encoding, 'utf-8');
    const jsonFormat = stringOr(metadata.json_format, 'array');

    if (fileType === 'csv' || fileType === 'text') {
        // A FORMATFILE placeholder makes this statement unrunnable: there is no
        // format file, and the reader cannot write one without knowing the
        // on-disk byte layout. SQL Server 2017 and later accept FORMAT = 'CSV'
        // with an inline WITH schema instead, which is executable as printed.
        const lob = singleLobKeyword(metadata.encoding);
        lines.push(
            '-- ---- CSV via OPENROWSET(BULK) — SQL Server local file -------------------',
            '-- The file must be readable by the SQL Server *service account* on the',
            '-- server itself (or on a UNC share it can reach). A path that is local to',
            '-- your workstation will not resolve.',
            'SELECT TOP 100 *',
            'FROM OPENROWSET(',
            `    BULK N'${localPath}',`,
            ...csvReaderOptions(metadata),
            ') WITH (',
            columnBody(metadata),
            ') AS [result];',
            '',
            "-- FORMAT = 'CSV' needs SQL Server 2017 or later. On SQL Server 2016 use a",
            '-- bcp-generated format file instead:',
            '--   bcp <db>.<schema>.<table> format nul -c -f fmt.xml -t , -T',
            "--   ... then FORMATFILE = N'<path_to_format_file.xml>' in place of the",
            '--   FORMAT/FIELDTERMINATOR/ROWTERMINATOR options above.',
            '',
            '-- ---- Alternative: whole file as one value (small files) ---',
            `-- ${sqlComment(encoding.toUpperCase())}: ${lob} is the encoding-correct choice here.`,
            '-- SINGLE_CLOB over a UTF-16 file fails with error 4806; SINGLE_NCLOB reads it.',
            'SELECT BulkColumn',
            `FROM OPENROWSET(BULK N'${localPath}', ${lob}) AS [src];`,
        );
    } else if (fileType === 'json') {
        if (jsonFormat === 'ndjson') {
            lines.push(...ndjsonLocalLines(metadata, localPath));
            return lines.join('\n');
        }
        lines.push(
            `-- ${sqlComment(PLATFORM_LABELS[targetPlatform])} does not support`,
            "-- FORMAT = 'JSON' or JSON external tables. This workaround",
            '-- loads JSON as text and parses it with OPENJSON.',
            '-- ---- JSON via single-LOB read + OPENJSON  (SQL Server 2016+) ----------',
            '-- Live evidence: a UTF-16 file read with SINGLE_CLOB fails with error 4806;',
            '-- SINGLE_NCLOB reads the same path successfully.',
            'DECLARE @json NVARCHAR(MAX);',
            'SELECT @json = BulkColumn',
            `FROM OPENROWSET(BULK N'${localPath}', ${singleLobKeyword(metadata.encoding)}) AS [src];`,
            '',
            'SELECT * FROM OPENJSON(@json)',
        );
        const openjsonCols = generateOpenjsonColumns(metadata, 4);
        if (openjsonCols.length > 0) {
            lines.push('WITH (', openjsonCols.join(',\n'), ');');
        } else {
            lines.push(';');
        }
    } else if (fileType === 'parquet') {
        lines.push(
            '-- Parquet OPENROWSET requires SQL Server 2022 or later and',
            '-- a supported object storage data source (ABS, ADLS, or S3).',
        );
    } else if (fileType === 'delta') {
        lines.push(
            '-- Delta OPENROWSET requires SQL Server 2022 or later and',
            '-- a supported object storage data source (ABS, ADLS, or S3).',
        );
    }

    return lines.join('\n');
}

/** SQL Server 2022+ OPENROWSET over an object storage source. */
function openrowsetSqlServerObjectStorage(
    metadata: GeneratorMetadata,
    lines: string[],
    storageUrl: string | null,
    dataSource: string,
    targetPlatform: TargetPlatform,
): string {
    const fileType = stringOr(metadata.file_type, 'parquet');
    const fileName = displayFileName(metadata);
    const jsonFormat = stringOr(metadata.json_format, 'array');

    const [sourceLocation, relativePath] = sqlServerStorageParts(
        storageUrl,
        fileName,
        targetPlatform,
    );
    const bulkPath = quoteLiteral(relativePath);
    const sourceName = quoteLiteral(dataSource);
    // The companion TYPE = BLOB_STORAGE source exists only for Azure URLs; for
    // S3 there is nothing to reference and no whole-file read to offer.
    const blobStorageBulkAvailable = storageUrlKind(storageUrl) === 'azure';

    lines.push(
        '-- SQL Server 2022+ reads external files from ABS, ADLS Gen2,',
        '-- or S3-compatible object storage. The external data source',
        '-- LOCATION must use abs://, adls://, or s3://, not https://.',
        '-- BULK is relative to that data source.',
        `-- Data source location: ${sqlComment(sourceLocation)}`,
        '',
    );

    if (fileType === 'parquet' || fileType === 'delta') {
        const formatKeyword = fileType.toUpperCase();
        const pathLiteral =
            fileType === 'delta'
                ? quoteLiteral(deltaTableFolder(relativePath))
                : bulkPath;
        lines.push(
            'SELECT TOP (100) *',
            'FROM OPENROWSET(',
            `    BULK '${pathLiteral}',`,
            `    DATA_SOURCE = '${sourceName}',`,
            `    FORMAT = '${formatKeyword}'`,
            ') AS [result];',
        );
        return lines.join('\n');
    }

    if (fileType === 'json') {
        const [bulkIdent, bulkLiteral] = bulkDataSourceNames(dataSource);
        const [, bulkRelative] = azureBulkStorageParts(storageUrl, fileName);
        const lob = singleLobKeyword(metadata.encoding);
        if (jsonFormat === 'ndjson') {
            lines.push(...ndjsonCloudLines(metadata, bulkPath, sourceName));
            return lines.join('\n');
        }
        if (!blobStorageBulkAvailable) {
            // A TYPE = BLOB_STORAGE source needs an https:// Azure endpoint, so
            // none is created for S3 and the single-LOB read has nothing to go
            // through. Saying so beats emitting a source that does not exist.
            lines.push(
                '-- ---- JSON -> OPENJSON ------------------------------------------------',
                "-- SQL Server has no OPENROWSET FORMAT = 'JSON', and the whole-document",
                `-- ${lob} read needs a TYPE = BLOB_STORAGE data source, which only`,
                '-- accepts an https:// Azure endpoint. This location is not reachable',
                '-- that way, so stage the document in Azure Blob Storage or ADLS Gen2',
                '-- to read it whole.',
            );
            return lines.join('\n');
        }
        lines.push(
            '-- ---- JSON -> OPENJSON ------------------------------------------------',
            "-- SQL Server has no OPENROWSET FORMAT = 'JSON'. Read the whole",
            `-- document with ${lob} through the TYPE = BLOB_STORAGE data source`,
            `-- [${bulkIdent}], then parse it with OPENJSON. The single-LOB`,
            '-- options are rejected only by the abs:// / adls:// connectors.',
            'DECLARE @json NVARCHAR(MAX);',
            'SELECT @json = BulkColumn',
            'FROM OPENROWSET(',
            `    BULK '${quoteLiteral(bulkRelative)}',`,
            `    DATA_SOURCE     = '${bulkLiteral}',`,
        );
        lines.push(...jsonSingleLobOptions(metadata.encoding));
        lines.push(
            ') AS [src];',
            '',
            'SELECT * FROM OPENJSON(@json)',
        );
        const openjsonCols = generateOpenjsonColumns(metadata, 4);
        if (openjsonCols.length > 0) {
            lines.push('WITH (', openjsonCols.join(',\n'), ');');
        } else {
            lines.push(';');
        }
        return lines.join('\n');
    }

    // CSV / delimited text
    lines.push(
        '-- ---- CSV with explicit schema ----------------------------------------',
        'SELECT TOP (100) *',
        'FROM OPENROWSET(',
        `    BULK '${bulkPath}',`,
        `    DATA_SOURCE     = '${sourceName}',`,
    );
    lines.push(...csvReaderOptions(metadata));
    lines.push(') WITH (');
    lines.push(columnBody(metadata));
    lines.push(') AS [result];');
    if (!blobStorageBulkAvailable) {
        return lines.join('\n');
    }
    lines.push(
        '',
        '-- ---- Whole file as one value (small files) ---------------------------',
        '-- The single-LOB options need the TYPE = BLOB_STORAGE data source;',
        '-- the abs:// / adls:// virtualization connectors reject them.',
        'SELECT BulkColumn AS file_text',
        'FROM OPENROWSET(',
        `    BULK '${quoteLiteral(azureBulkStorageParts(storageUrl, fileName)[1])}',`,
        `    DATA_SOURCE     = '${bulkDataSourceNames(dataSource)[1]}',`,
    );
    lines.push(...jsonSingleLobOptions(metadata.encoding));
    lines.push(') AS [src];');
    return lines.join('\n');
}
