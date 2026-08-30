/**
 * Best-practice guidance blocks for the native SQL generator.
 *
 * Ported line for line from the `_best_practices_*` helpers in
 * `external_file_detection/sql_generator.py` so the generated guidance stays
 * byte-identical to the Python implementation for the same metadata.
 */

import type { GeneratorMetadata, TargetPlatform } from '../types';
import { pythonStringRepr } from '../analysis/jsonValue';
import { displayDelimiter, escapeIdentifier, sqlComment } from './escaping';
import { DEFAULT_TARGET_PLATFORM } from './typeMapping';

/** Render a list of strings the way Python's `str(list)` would. */
export function pyListRepr(items: readonly string[]): string {
    return `[${items.map((item) => pythonStringRepr(item)).join(', ')}]`;
}

function titleCase(value: string): string {
    return value.replace(/[A-Za-z]+/g, (word) =>
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

export function bestPracticesSummary(
    metadata: GeneratorMetadata,
    targetPlatform: TargetPlatform,
    sizeMb: number,
): string[] {
    const fileType = metadata.file_type ?? 'csv';

    let recommended = 'CREATE TABLE + INSERT validation flow';
    let fastest = 'OPENROWSET for preview / exploratory access';
    const lowestCost = 'OPENROWSET with projection/filtering';
    let staging = 'Load to a staging table first, then transform into the final schema';

    if (targetPlatform === 'fabric_sql_db') {
        recommended = 'OPENROWSET with SELECT INTO / INSERT INTO ... SELECT';
        fastest = 'OPENROWSET for direct external access';
        // `lowest_cost` is overwritten in Python for Fabric; keep the same value.
        return summaryLines(
            recommended,
            fastest,
            'OPENROWSET over parquet with projected columns',
            stagingFor(staging, sizeMb),
        );
    }

    if (targetPlatform.startsWith('sql_server_')
        || targetPlatform === 'azure_sql_db' || targetPlatform === 'azure_sql_mi') {
        if (fileType === 'csv' || fileType === 'text') {
            recommended = 'BULK INSERT for load, then validate in SQL';
            fastest = 'BULK INSERT for local or staged CSV/text files';
        } else if (fileType === 'json') {
            recommended =
                'Load JSON as text with OPENROWSET(SINGLE_CLOB), then parse with OPENJSON';
            fastest = 'OPENJSON after loading the file as NVARCHAR(MAX)';
        } else if (fileType === 'parquet' || fileType === 'delta') {
            if (targetPlatform === 'sql_server_2019') {
                recommended =
                    `${titleCase(fileType)} is not supported; convert to CSV before loading`;
                fastest = 'Convert to CSV, then use BULK INSERT';
            } else {
                recommended =
                    `OPENROWSET FORMAT='${fileType.toUpperCase()}' over ABS, ADLS, or S3 storage`;
                fastest = 'OPENROWSET with projected columns';
            }
        }
    }

    staging = stagingFor(staging, sizeMb);
    return summaryLines(recommended, fastest, lowestCost, staging);
}

function stagingFor(staging: string, sizeMb: number): string {
    if (sizeMb > 512) {
        return 'For large files, land data in staging and validate in batches';
    }
    if (sizeMb < 25) {
        return 'For small files, direct load is fine, but keep a validation query ready';
    }
    return staging;
}

function summaryLines(
    recommended: string, fastest: string, lowestCost: string, staging: string,
): string[] {
    return [
        '-- RECOMMENDED PATH',
        `--   Best option   : ${recommended}`,
        `--   Fastest path  : ${fastest}`,
        `--   Lowest cost   : ${lowestCost}`,
        `--   Staging       : ${staging}`,
        '',
    ];
}

export function bestPracticesWarnings(metadata: GeneratorMetadata): string[] {
    const warnings: string[] = [];
    const encoding = metadata.encoding;
    const confidence = metadata.encoding_confidence;
    const fileType = metadata.file_type ?? 'csv';
    const jsonNesting = metadata.json_nesting ?? {};
    const maxLengths = metadata.max_string_lengths ?? {};
    const nullable = new Set(metadata.nullable_columns ?? []);
    const schema = metadata.schema ?? [];

    if (encoding && encoding !== 'binary'
        && confidence !== undefined && confidence !== null && confidence < 70) {
        warnings.push(
            `--   Low encoding confidence (${confidence}%). Verify file encoding before loading.`);
    }
    if (metadata.row_count_estimated) {
        warnings.push('--   Row count is estimated. Validate with a post-load COUNT(*) query.');
    }
    if (fileType === 'json'
        && Object.values(jsonNesting).some((kind) => kind === 'object' || kind === 'array')) {
        warnings.push(
            '--   Nested JSON detected. Expect flattening or OPENJSON WITH (...) work before production load.');
    }
    if (Object.values(maxLengths).some((length) => length > 4000)) {
        warnings.push(
            '--   Very long strings detected. Consider NVARCHAR(MAX) columns and downstream truncation checks.');
    }

    const numericMarkers = ['int', 'float', 'double', 'decimal', 'numeric', 'real'];
    const nullableNumeric = schema
        .filter(([name, dtype]) =>
            nullable.has(name)
            && numericMarkers.some((marker) => String(dtype).toLowerCase().includes(marker)))
        .map(([name]) => name);
    if (nullableNumeric.length > 0) {
        const columnList = sqlComment(nullableNumeric.slice(0, 5).join(', '));
        warnings.push(
            `--   Nullable numeric columns detected: ${columnList}. `
            + 'Stage as text if source quality is inconsistent.');
    }

    if (warnings.length === 0) {
        return [];
    }
    return ['-- WARNINGS / WATCH-OUTS', ...warnings, ''];
}

export function bestPracticesValidationSql(
    metadata: GeneratorMetadata,
    tableName: string,
    schemaName = 'dbo',
): string[] {
    const schema = metadata.schema ?? [];
    const cols = schema.slice(0, 3).map(([col]) => escapeIdentifier(col));
    const selectCols = cols.length > 0 ? cols.map((c) => `[${c}]`).join(', ') : '*';
    const safeTable = escapeIdentifier(tableName);
    const safeSchema = escapeIdentifier(schemaName || 'dbo');
    const target = `[${safeSchema}].[${safeTable}]`;

    const lines = [
        '',
        '-- VALIDATION SQL AFTER LOAD',
        '-- 1. Row count',
        `SELECT COUNT(*) AS loaded_rows FROM ${target};`,
        '',
        '-- 2. Sample rows',
        `SELECT TOP 10 ${selectCols} FROM ${target};`,
    ];

    if (cols.length > 0) {
        const nullChecks = cols
            .map((c) => `SUM(CASE WHEN [${c}] IS NULL THEN 1 ELSE 0 END) AS [${c}_nulls]`)
            .join(', ');
        lines.push('', '-- 3. Null distribution check', `SELECT ${nullChecks} FROM ${target};`);
    }

    lines.push('');
    return lines;
}

const CSV_DELIMITER_NAMES: Readonly<Record<string, string>> = {
    ',': 'comma', '\t': 'tab', '|': 'pipe', ';': 'semicolon',
};

export function bestPracticesCsv(
    _sizeMb: number,
    encoding: string,
    delimiter: string,
    hasHeader: boolean,
    _compression: string | null,
    targetPlatform: TargetPlatform = DEFAULT_TARGET_PLATFORM,
): string[] {
    const delimName = CSV_DELIMITER_NAMES[delimiter] ?? pythonStringRepr(delimiter);
    const displayed = sqlComment(displayDelimiter(delimiter));
    const isFabric = targetPlatform === 'fabric_sql_db';
    const isAzureSql = targetPlatform === 'azure_sql_db' || targetPlatform === 'azure_sql_mi';

    let toolSelection: string[];
    if (isFabric) {
        toolSelection = [
            '--    Any size → OPENROWSET over Lakehouse Files (data virtualization, preview)',
            '--    Repeated loads → CREATE EXTERNAL TABLE + INSERT INTO ... SELECT',
            '--    Orchestrated loads → Fabric Data Pipelines / Dataflows Gen2',
        ];
    } else if (isAzureSql) {
        toolSelection = [
            '--    < 1 GB   → BULK INSERT with a BLOB_STORAGE data source',
            '--    Any size → OPENROWSET over an abs:// or adls:// data source',
            '--    Repeated loads → CREATE EXTERNAL TABLE (data virtualization)',
        ];
    } else {
        toolSelection = [
            '--    < 1 GB   → BULK INSERT into SQL Server (fastest local load)',
            '--    Any size → OPENROWSET over a local path or object storage data source',
            '--    Repeated loads → CREATE EXTERNAL TABLE (avoid materialising data)',
        ];
    }

    const lines = [
        `-- Detected: ${sqlComment(delimName)}-delimited, encoding ${sqlComment(encoding)}`,
        '',
        '-- 1. TOOL SELECTION',
        ...toolSelection,
        '',
        '-- 2. ENCODING',
        `--    Detected encoding : ${sqlComment(encoding)}`,
        '--    Always specify CODEPAGE to avoid silent data corruption.',
        "--    UTF-8 → CODEPAGE = '65001'   |   UTF-16 → CODEPAGE = '1200'",
        "--    Latin-1 / CP1252 → CODEPAGE = '1252'",
        '',
        '-- 3. HEADER ROW',
        `--    has_header = ${hasHeader ? 'True' : 'False'} → `
        + `${hasHeader ? 'FIRSTROW = 2 (skip header)' : 'FIRSTROW = 1 (no header detected)'}`,
        '',
        '-- 4. STAGING PATTERN (recommended)',
        '--    a. Load raw data into a STAGING table (all columns NVARCHAR).',
        '--    b. Validate / transform into the final typed table.',
        '--    c. This avoids cryptic conversion errors on bad rows.',
        '',
        '-- 5. PERFORMANCE',
        '--    Split large files into 256 MB chunks before importing.',
        '--    Pre-sort by the partition key when possible.',
        '',
    ];

    if (isFabric) {
        lines.push(
            '-- 6. ERROR HANDLING',
            '--    OPENROWSET has no reject options: stage to NVARCHAR columns and',
            '--    validate with TRY_CONVERT before writing the typed table.',
            '',
            '-- 7. LOAD PATTERN (Fabric SQL Database)',
            '--    INSERT INTO [dbo].[MyTable]',
            '--    SELECT * FROM OPENROWSET(',
            "--        BULK 'folder/file.csv',",
            "--        DATA_SOURCE = 'MyDataSource',",
            "--        FORMAT = 'CSV',",
            `--        FIRSTROW = ${hasHeader ? 2 : 1},`,
            `--        FIELDTERMINATOR = '${displayed}',`,
            "--        CODEPAGE = '65001'",
            '--    ) WITH ([col1] INT, [col2] NVARCHAR(255)) AS [src];',
        );
        return lines;
    }

    lines.push(
        '-- 6. ERROR HANDLING',
        '--    Use MAXERRORS to log bad rows before aborting.',
        '--    Pair with ERRORFILE to capture rejected rows for inspection.',
        '',
        '-- 7. BULK INSERT TEMPLATE',
    );
    if (isAzureSql) {
        lines.push(
            '--    BULK INSERT [dbo].[MyTable]',
            "--    FROM 'folder/file.csv'",
            '--    WITH (',
            "--        DATA_SOURCE = 'MyDataSource_Bulk',  -- TYPE = BLOB_STORAGE",
            `--        FIRSTROW = ${hasHeader ? 2 : 1},`,
            `--        FIELDTERMINATOR = '${displayed}',`,
            "--        CODEPAGE = '65001',",
            '--        TABLOCK',
            '--    );',
        );
    } else {
        lines.push(
            '--    BULK INSERT [dbo].[MyTable]',
            "--    FROM 'C:\\data\\file.csv'",
            '--    WITH (',
            `--        FIRSTROW = ${hasHeader ? 2 : 1},`,
            `--        FIELDTERMINATOR = '${displayed}',`,
            "--        CODEPAGE = '65001',",
            '--        TABLOCK',
            '--    );',
        );
    }
    return lines;
}

export function bestPracticesParquet(
    _sizeMb: number,
    compression: string | null,
    metadata: GeneratorMetadata,
    targetPlatform: TargetPlatform = DEFAULT_TARGET_PLATFORM,
): string[] {
    const rowGroupsValue = metadata.parquet_metadata?.num_row_groups;
    const rowGroups = rowGroupsValue === undefined || rowGroupsValue === null
        ? 'unknown'
        : String(rowGroupsValue);
    const compLabel = compression || 'UNCOMPRESSED';

    let toolSelection: string[];
    if (targetPlatform === 'fabric_sql_db') {
        toolSelection = [
            "--    Fabric SQL Database → OPENROWSET FORMAT='PARQUET' over Lakehouse Files",
            '--    Repeated access     → CREATE EXTERNAL TABLE with FORMAT_TYPE = PARQUET',
            '--    Managed access      → OneLake shortcut from a Lakehouse or Warehouse',
        ];
    } else if (targetPlatform === 'sql_server_2019') {
        toolSelection = [
            '--    SQL Server 2019 → Parquet is not supported; convert to CSV first',
            "--    Or upgrade to SQL Server 2022+ for OPENROWSET FORMAT='PARQUET'",
        ];
    } else if (targetPlatform === 'azure_sql_db' || targetPlatform === 'azure_sql_mi') {
        toolSelection = [
            "--    Azure SQL → OPENROWSET FORMAT='PARQUET' over abs:// or adls://",
            '--    Repeated access → CREATE EXTERNAL TABLE with FORMAT_TYPE = PARQUET',
        ];
    } else {
        toolSelection = [
            "--    SQL Server 2022+ → OPENROWSET FORMAT='PARQUET' over ABS/ADLS/S3",
            '--    Repeated access  → CREATE EXTERNAL TABLE with FORMAT_TYPE = PARQUET',
        ];
    }

    return [
        `-- Detected: Parquet, compression=${sqlComment(compLabel)}, `
        + `row_groups=${sqlComment(rowGroups)}`,
        '',
        '-- 1. TOOL SELECTION',
        ...toolSelection,
        '',
        '-- 2. COMPRESSION',
        `--    Detected: ${sqlComment(compLabel)}`,
        '--    Snappy → best balance of speed and ratio (recommended for analytics)',
        '--    ZSTD   → better compression, requires pyarrow/Spark write options',
        '--    LZ4    → fastest decompression, slightly larger files',
        '--    Avoid GZIP for Parquet (not splittable)',
        '',
        '-- 3. PARTITIONING',
        '--    For large datasets write Parquet partitioned by date or region:',
        '--    df.write.partitionBy("year","month").parquet("path/")',
        "--    Then use folder wildcards:  BULK 'path/year=*/month=*/*.parquet'",
        '',
        '-- 4. ROW GROUP SIZE',
        '--    Ideal row group size: 128 MB (Spark default).',
        `--    This file has ${sqlComment(rowGroups)} row group(s).`,
        '--    Too many small row groups → slow reads. Repartition / coalesce before write.',
        '',
        '-- 5. SCHEMA EVOLUTION',
        '--    Add new nullable columns at the end of the schema.',
        '--    OPENROWSET reads only the columns requested — missing columns return NULL.',
        '',
        '-- 6. STATISTICS',
        '--    Create column statistics after loading for the query optimiser:',
        '--    CREATE STATISTICS stats_col1 ON [dbo].[MyTable]([col1]);',
    ];
}

export function bestPracticesDelta(
    metadata: GeneratorMetadata,
    targetPlatform: TargetPlatform,
): string[] {
    const deltaMetadata = metadata.delta_metadata ?? null;
    const versionValue = deltaMetadata?.version;
    const version = versionValue === undefined || versionValue === null
        ? 'unknown'
        : String(versionValue);
    const partitionCols = deltaMetadata?.partition_columns ?? [];

    let platformGuidance: string[];
    if (targetPlatform === 'sql_server_2022' || targetPlatform === 'sql_server_2025') {
        platformGuidance = [
            "--    SQL Server 2022+ → OPENROWSET FORMAT='DELTA' over ABS/ADLS/S3",
            '--    Point BULK at the Delta table folder, not a single file.',
        ];
    } else if (targetPlatform === 'azure_sql_db') {
        platformGuidance = [
            "--    Azure SQL Database → OPENROWSET FORMAT='DELTA' over abs:// or adls://",
            '--    Point BULK at the Delta table folder, not a single file.',
        ];
    } else if (targetPlatform === 'azure_sql_mi') {
        platformGuidance = [
            '--    Azure SQL Managed Instance → Delta is NOT supported.',
            "--    Convert the table to Parquet, then use FORMAT='PARQUET'.",
        ];
    } else if (targetPlatform === 'fabric_sql_db') {
        platformGuidance = [
            '--    Fabric SQL Database → Delta is NOT supported by OPENROWSET.',
            '--    Create a OneLake shortcut to the Delta table from a Lakehouse or',
            '--    Warehouse, or convert the table to Parquet in Lakehouse Files.',
        ];
    } else {
        platformGuidance = [
            '--    SQL Server 2019 → Delta is not supported; convert to CSV or Parquet',
            '--    and upgrade to SQL Server 2022+ for native Delta access.',
        ];
    }

    const partitionLabel = partitionCols.length > 0 ? pyListRepr(partitionCols) : 'none';
    const partitionPruning = partitionCols.length > 0
        ? pyListRepr(partitionCols)
        : '< not partitioned >';

    return [
        `-- Detected: Delta Lake table  (version ${sqlComment(version)})`,
        `-- Partition columns: ${sqlComment(partitionLabel)}`,
        '',
        '-- 1. TOOL SELECTION',
        ...platformGuidance,
        '',
        '-- 2. TIME TRAVEL',
        '--    Delta time travel is a writer-engine feature (Spark / Databricks):',
        '--    spark.read.format("delta").option("versionAsOf", 5).load("...")',
        '--    Vacuum regularly to avoid bloat:  VACUUM delta.`path` RETAIN 168 HOURS',
        '',
        '-- 3. QUERY TEMPLATE',
        '--    SELECT TOP 100 *',
        '--    -- MyDataSource LOCATION uses adls:// or abs://',
        '--    FROM OPENROWSET(',
        "--        BULK '<delta_folder>/',",
        "--        DATA_SOURCE = 'MyDataSource',",
        "--        FORMAT = 'DELTA'",
        '--    ) AS [result];',
        '',
        '-- 4. PARTITION PRUNING',
        `--    Partition by: ${sqlComment(partitionPruning)}`,
        '--    Add matching WHERE clauses to eliminate partition scans.',
        '',
        '-- 5. OPTIMIZE & ZORDER (Databricks / OSS Delta)',
        '--    OPTIMIZE delta.`path` ZORDER BY (event_date, user_id)',
        '--    Reduces file scans for selective queries significantly.',
        '',
        '-- 6. CONVERT DELTA → PARQUET when the target does not support Delta',
        '--    spark.read.format("delta").load("path").write.parquet("out/")',
        '--    Then use CREATE EXTERNAL TABLE with FORMAT_TYPE = PARQUET.',
    ];
}

export function bestPracticesJson(
    _sizeMb: number,
    targetPlatform: TargetPlatform = DEFAULT_TARGET_PLATFORM,
): string[] {
    const remoteExample = targetPlatform === 'fabric_sql_db'
        ? [
            '-- 3. FABRIC SQL DATABASE — JSON via OPENROWSET + OPENJSON',
            '--    Fabric SQL Database has no JSON file format, so the CSV reader',
            '--    is used with non-printing delimiters to read whole documents.',
            '--    SELECT j.*',
            "--    FROM OPENROWSET(BULK 'folder/file.json',",
            "--        DATA_SOURCE = 'MyDataSource', FORMAT = 'CSV',",
            "--        FIELDTERMINATOR = '0x0b', FIELDQUOTE = '0x0b')",
            '--    WITH (json_doc NVARCHAR(MAX)) AS src',
            '--    CROSS APPLY OPENJSON(src.json_doc)',
            '--    WITH ([col1] INT, [col2] NVARCHAR(255)) AS j;',
        ]
        : [
            '-- 3. OBJECT STORAGE — JSON via OPENROWSET + OPENJSON',
            '--    SELECT j.*',
            "--    FROM OPENROWSET(BULK 'folder/file.json',",
            "--        DATA_SOURCE = 'MyDataSource', FORMAT = 'CSV',",
            "--        FIELDTERMINATOR = '0x0b', FIELDQUOTE = '0x0b')",
            '--    WITH (json_doc NVARCHAR(MAX)) AS src',
            '--    CROSS APPLY OPENJSON(src.json_doc)',
            '--    WITH ([col1] INT, [col2] NVARCHAR(255)) AS j;',
        ];

    return [
        '-- Detected: JSON file',
        '',
        '-- 1. TOOL SELECTION',
        '--    Small files (< 100 MB): OPENJSON directly in T-SQL',
        '--    Large files           : Convert to Parquet with pandas/Spark, then use Parquet path',
        '',
        '-- 2. OPENJSON (SQL Server 2016+ / Azure SQL / Fabric SQL DB)',
        '--    DECLARE @json NVARCHAR(MAX) = (SELECT BulkColumn FROM OPENROWSET(',
        "--        BULK 'file.json', DATA_SOURCE = 'MyDataSource', SINGLE_CLOB) AS j);",
        '--    SELECT * FROM OPENJSON(@json)',
        '--    WITH (',
        "--        [col1] INT     '$.col1',",
        "--        [col2] NVARCHAR(255) '$.col2'",
        '--    );',
        '',
        ...remoteExample,
        '',
        '-- 4. PERFORMANCE',
        '--    JSON parsing in T-SQL is CPU-intensive.',
        '--    Pre-process JSON to Parquet with pandas/pyarrow for large datasets:',
        '--       import pandas as pd; df = pd.read_json("file.json")',
        '--       df.to_parquet("file.parquet", compression="snappy")',
    ];
}

export function bestPracticesGeneric(): string[] {
    return [
        '-- 1. Identify the exact file format and encoding before loading.',
        '-- 2. Use a staging table (all columns NVARCHAR) for initial load.',
        '-- 3. Validate and transform into typed production table.',
        '-- 4. Add column statistics after loading for the query optimiser.',
    ];
}
