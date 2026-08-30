/**
 * OPENROWSET generation for every supported target platform.
 *
 * Split out of `generator.ts` because the OPENROWSET surface is by far the most
 * platform-divergent part of the tool: SQL Server 2019, SQL Server 2022+,
 * Azure SQL DB/MI and Fabric SQL Database each need a different data-source
 * shape, and JSON needs a completely different access pattern from the others
 * because `SINGLE_CLOB` cannot be combined with `DATA_SOURCE`.
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
} from './storage';
import {
    csvReaderOptions,
    generateColumnDefinitions,
    generateOpenjsonColumns,
    jsonRowFrameOptions,
    notSupportedMessage,
    openrowsetWithSchema,
    displayFileName,
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

    if (!supports('openrowset', targetPlatform)) {
        const alts: string[] = [];
        if (supports('bulk_insert', targetPlatform)) {
            alts.push('BULK INSERT (see BULK INSERT tab)');
        }
        if (supports('json_openjson', targetPlatform)) {
            alts.push('JSON functions (see JSON Functions tab)');
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

    const fileType = stringOr(metadata.file_type, 'csv');
    const fileName = displayFileName(metadata);
    const localPath = quoteLiteral(metadata.file_path.split('\\').join('/'));

    const platformLabel = PLATFORM_LABELS[targetPlatform] ?? targetPlatform;
    const lines = [
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
 * files: `FORMAT = 'CSV'` with a container-relative `BULK` path.
 * `SINGLE_CLOB`/`SINGLE_NCLOB`/`SINGLE_BLOB` cannot be combined with a
 * `DATA_SOURCE`, so JSON is read row-framed instead.
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
        lines.push(
            '-- JSON: SINGLE_CLOB / SINGLE_NCLOB / SINGLE_BLOB cannot be used',
            '-- together with DATA_SOURCE. Read the document as one row using',
            '-- non-printing CSV framing characters, then parse it with OPENJSON.',
            'SELECT j.*',
            'FROM OPENROWSET(',
            `    BULK '${bulkPath}',`,
            `    DATA_SOURCE     = '${bulkLiteral}',`,
        );
        lines.push(...jsonRowFrameOptions());
        lines.push(
            ') WITH (json_doc NVARCHAR(MAX)) AS src',
            'CROSS APPLY OPENJSON(src.json_doc) AS j;',
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
    lines.push(...csvReaderOptions(metadata, { trailingComma: true }));
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
        lines.push(...jsonRowFrameOptions());
        lines.push(
            ') WITH (json_doc NVARCHAR(MAX)) AS [src]',
            'CROSS APPLY OPENJSON(src.json_doc)',
            'WITH (',
        );
        const openjsonCols = generateOpenjsonColumns(metadata, 4);
        lines.push(
            openjsonCols.length > 0
                ? openjsonCols.join(',\n')
                : '    [data] NVARCHAR(MAX)',
        );
        lines.push(') AS j;');
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
        if (jsonFormat === 'ndjson') {
            lines.push(
                '-- ---- NDJSON / JSON Lines: one document per row -----------------------',
                'SELECT TOP (100) doc',
                'FROM OPENROWSET(',
                `    BULK '${bulkPath}',`,
                `    DATA_SOURCE     = '${sourceName}',`,
            );
            lines.push(...jsonRowFrameOptions(4, '0x0a'));
            lines.push(
                ') WITH (doc NVARCHAR(MAX)) AS [src];' +
                    '  -- LF: one JSON document per line',
                '',
            );
        }
        lines.push(
            '-- ---- Whole document -> OPENJSON --------------------------------------',
            '-- SINGLE_CLOB / SINGLE_NCLOB / SINGLE_BLOB cannot be combined with',
            '-- DATA_SOURCE, so the CSV reader is framed with non-printing',
            '-- characters to return the whole document as a single value.',
            'DECLARE @json NVARCHAR(MAX);',
            'SELECT @json = json_doc',
            'FROM OPENROWSET(',
            `    BULK '${bulkPath}',`,
            `    DATA_SOURCE     = '${sourceName}',`,
        );
        lines.push(...jsonRowFrameOptions());
        lines.push(
            ') WITH (json_doc NVARCHAR(MAX)) AS [src];',
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
        '-- SINGLE_CLOB is not valid with DATA_SOURCE; frame the CSV reader',
        '-- so the whole file comes back as one NVARCHAR(MAX) value instead.',
        'SELECT file_text',
        'FROM OPENROWSET(',
        `    BULK '${bulkPath}',`,
        `    DATA_SOURCE     = '${sourceName}',`,
    );
    lines.push(...jsonRowFrameOptions());
    lines.push(') WITH (file_text NVARCHAR(MAX)) AS [src];');
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
    const codepage = stringOr(metadata.codepage, '65001');
    const hasHeader = metadata.has_header ?? true;

    if (fileType === 'csv' || fileType === 'text') {
        lines.push(
            '-- ---- CSV via OPENROWSET(BULK) — SQL Server local file -------------------',
            'SELECT TOP 100 *',
            'FROM OPENROWSET(',
            `    BULK N'${localPath}',`,
            "    FORMATFILE = N'<path_to_format_file.xml>',",
            `    CODEPAGE   = '${quoteLiteral(codepage)}',  ` +
                `-- ${sqlComment(encoding.toUpperCase())}`,
            `    FIRSTROW   = ${hasHeader ? 2 : 1}`,
            ') AS [result];',
            '',
            '-- ---- Alternative: ad-hoc with SINGLE_CLOB (small files) ---',
            'SELECT BulkColumn',
            `FROM OPENROWSET(BULK N'${localPath}', SINGLE_CLOB) AS [src];`,
        );
    } else if (fileType === 'json') {
        lines.push(
            `-- ${sqlComment(PLATFORM_LABELS[targetPlatform])} does not support`,
            "-- FORMAT = 'JSON' or JSON external tables. This workaround",
            '-- loads JSON as text and parses it with OPENJSON.',
            '-- ---- JSON via SINGLE_CLOB + OPENJSON  (SQL Server 2016+) ---------------',
            'DECLARE @json NVARCHAR(MAX);',
            'SELECT @json = BulkColumn',
            `FROM OPENROWSET(BULK N'${localPath}', SINGLE_CLOB) AS [src];`,
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
        if (jsonFormat === 'ndjson') {
            lines.push(
                '-- ---- NDJSON / JSON Lines: one document per row -----------------------',
                'SELECT TOP (100) doc',
                'FROM OPENROWSET(',
                `    BULK '${bulkPath}',`,
                `    DATA_SOURCE     = '${sourceName}',`,
            );
            lines.push(...jsonRowFrameOptions(4, '0x0a'));
            lines.push(
                ') WITH (doc NVARCHAR(MAX)) AS [src];' +
                    '  -- LF: one JSON document per line',
                '',
            );
        }
        lines.push(
            "-- SQL Server has no OPENROWSET FORMAT = 'JSON', and SINGLE_CLOB",
            '-- cannot be combined with DATA_SOURCE. Frame the CSV reader with',
            '-- non-printing characters so the whole document arrives as one',
            '-- value, then parse it with OPENJSON.',
            '-- ---- JSON -> OPENJSON ------------------------------------------------',
            'DECLARE @json NVARCHAR(MAX);',
            'SELECT @json = json_doc',
            'FROM OPENROWSET(',
            `    BULK '${bulkPath}',`,
            `    DATA_SOURCE     = '${sourceName}',`,
        );
        lines.push(...jsonRowFrameOptions());
        lines.push(
            ') WITH (json_doc NVARCHAR(MAX)) AS [src];',
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
        '-- SINGLE_CLOB is not valid with DATA_SOURCE; frame the CSV reader',
        '-- so the whole file comes back as one NVARCHAR(MAX) value instead.',
        'SELECT file_text',
        'FROM OPENROWSET(',
        `    BULK '${bulkPath}',`,
        `    DATA_SOURCE     = '${sourceName}',`,
    );
    lines.push(...jsonRowFrameOptions());
    lines.push(') WITH (file_text NVARCHAR(MAX)) AS [src];');
    return lines.join('\n');
}
