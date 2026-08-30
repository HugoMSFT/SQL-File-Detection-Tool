/**
 * Target-platform capabilities and Arrow/pandas → T-SQL type mapping.
 *
 * A faithful port of the class-level tables in
 * `external_file_detection/sql_generator.py`. The corrected edge cases the
 * Python implementation carries are preserved exactly:
 *
 *   * Arrow `int8` is signed, so it maps to `SMALLINT` and never to the
 *     unsigned `TINYINT`; `uint8` is the type that maps to `TINYINT`.
 *   * `uint64` exceeds `BIGINT`, so it becomes `DECIMAL(20,0)`.
 *   * `decimal256` and every structural (list/struct/map/union) type serialise
 *     as `NVARCHAR(MAX)` rather than being coerced to a numeric type.
 *   * A negative decimal scale is folded into the precision because SQL Server
 *     has no equivalent; out-of-range precision degrades to `NVARCHAR(MAX)`.
 *   * Timestamps with a timezone become `DATETIMEOFFSET(p)`, without one
 *     `DATETIME2(p)`, using Arrow's unit → precision table.
 */

import type { TargetPlatform } from '../types';

/**
 * Canonical product-wide default SQL target platform.
 *
 * Every entry point resolves an unspecified target platform to this single
 * constant so the default can never drift between layers.
 */
export const DEFAULT_TARGET_PLATFORM: TargetPlatform = 'azure_sql_db';

/** Every supported target platform, in the Python declaration order. */
export const PLATFORMS: readonly TargetPlatform[] = [
    'sql_server_2019', 'sql_server_2022', 'sql_server_2025',
    'azure_sql_db', 'azure_sql_mi',
    'fabric_sql_db',
];

const PLATFORM_SET = new Set<string>(PLATFORMS);

/** Return a supported platform, falling back to the product default. */
export function normalizePlatform(targetPlatform: string | null | undefined): TargetPlatform {
    return targetPlatform && PLATFORM_SET.has(targetPlatform)
        ? targetPlatform as TargetPlatform
        : DEFAULT_TARGET_PLATFORM;
}

/** Feature keys whose availability differs between platforms. */
export type PlatformFeature =
    | 'create_table'
    | 'bulk_insert'
    | 'openrowset'
    | 'openrowset_format_keyword'
    | 'openrowset_bulk_local'
    | 'openrowset_data_source'
    | 'external_table'
    | 'credential_setup'
    | 'json_openjson'
    | 'json_path_exists'
    | 'json_object_array'
    | 'for_json';

const ALL_PLATFORMS: readonly TargetPlatform[] = PLATFORMS;
const MODERN_PLATFORMS: readonly TargetPlatform[] = [
    'sql_server_2022', 'sql_server_2025',
    'azure_sql_db', 'azure_sql_mi', 'fabric_sql_db',
];

/** Feature availability per platform. */
export const PLATFORM_FEATURES: Readonly<Record<PlatformFeature, ReadonlySet<TargetPlatform>>> = {
    create_table: new Set(ALL_PLATFORMS),
    bulk_insert: new Set<TargetPlatform>([
        'sql_server_2019', 'sql_server_2022', 'sql_server_2025',
        'azure_sql_db', 'azure_sql_mi',
    ]),
    openrowset: new Set(ALL_PLATFORMS),
    // OPENROWSET(BULK ..., FORMAT = ...)
    openrowset_format_keyword: new Set(MODERN_PLATFORMS),
    // OPENROWSET(BULK '\\path') over local files
    openrowset_bulk_local: new Set<TargetPlatform>([
        'sql_server_2019', 'sql_server_2022', 'sql_server_2025',
    ]),
    // OPENROWSET(BULK ..., DATA_SOURCE = ds)
    openrowset_data_source: new Set(MODERN_PLATFORMS),
    external_table: new Set(ALL_PLATFORMS),
    credential_setup: new Set(ALL_PLATFORMS),
    // OPENJSON, JSON_VALUE, JSON_QUERY, ISJSON
    json_openjson: new Set(ALL_PLATFORMS),
    // JSON_PATH_EXISTS (SQL Server 2022+)
    json_path_exists: new Set(MODERN_PLATFORMS),
    // JSON_OBJECT / JSON_ARRAY (SQL Server 2022+)
    json_object_array: new Set(MODERN_PLATFORMS),
    for_json: new Set(ALL_PLATFORMS),
};

/** Return true when *platform* supports *feature*. */
export function supports(feature: PlatformFeature, platform: TargetPlatform): boolean {
    return PLATFORM_FEATURES[feature].has(platform);
}

/**
 * Platforms whose external data sources are the SQL Server 2019 PolyBase
 * `HADOOP` type; only those accept `REJECT_TYPE` / `REJECT_VALUE`.
 */
export const HADOOP_EXTERNAL_SOURCE_PLATFORMS: ReadonlySet<TargetPlatform> =
    new Set<TargetPlatform>(['sql_server_2019']);

/**
 * Azure SQL family targets that use `abs://` / `adls://` data virtualization
 * rather than on-box file access.
 */
export const AZURE_SQL_PLATFORMS: ReadonlySet<TargetPlatform> =
    new Set<TargetPlatform>(['azure_sql_db', 'azure_sql_mi']);

/** Human-readable platform labels. */
export const PLATFORM_LABELS: Readonly<Record<TargetPlatform, string>> = {
    sql_server_2019: 'SQL Server 2019',
    sql_server_2022: 'SQL Server 2022',
    sql_server_2025: 'SQL Server 2025',
    azure_sql_db: 'Azure SQL Database',
    azure_sql_mi: 'Azure SQL Managed Instance',
    fabric_sql_db: 'Microsoft Fabric SQL Database',
};

/** Label for a platform, falling back to the raw key. */
export function platformLabel(platform: string): string {
    return PLATFORM_LABELS[platform as TargetPlatform] ?? platform;
}

/** `CREATE EXTERNAL FILE FORMAT` type names. */
export type ExternalFormatType =
    | 'DELIMITEDTEXT' | 'PARQUET' | 'DELTA' | 'ORC' | 'RCFILE' | 'JSON';

/**
 * `CREATE EXTERNAL FILE FORMAT` availability by SQL product and format.
 *
 * JSON is only supported by Azure SQL Edge, which is not one of the targets
 * this application exposes, so it maps to the empty set.
 */
export const EXTERNAL_FORMAT_PLATFORMS:
    Readonly<Record<ExternalFormatType, ReadonlySet<TargetPlatform>>> = {
    DELIMITEDTEXT: new Set(ALL_PLATFORMS),
    PARQUET: new Set<TargetPlatform>([
        'sql_server_2022', 'sql_server_2025',
        'azure_sql_db', 'azure_sql_mi', 'fabric_sql_db',
    ]),
    // Delta external file format exists on SQL Server 2022+ and Azure SQL
    // Database, but not on Azure SQL Managed Instance or Fabric SQL Database.
    DELTA: new Set<TargetPlatform>(['sql_server_2022', 'sql_server_2025', 'azure_sql_db']),
    ORC: new Set<TargetPlatform>(['sql_server_2019']),
    RCFILE: new Set<TargetPlatform>(['sql_server_2019']),
    JSON: new Set<TargetPlatform>(),
};

/**
 * `FIRST_ROW` is a `CREATE EXTERNAL FILE FORMAT` / `FORMAT_OPTIONS` option on
 * SQL Server 2022+ and on Fabric SQL Database data virtualization. It is not
 * documented for SQL Server 2019 or the Azure SQL external file formats.
 * `FIRSTROW` (no underscore) is a different, widely supported
 * `OPENROWSET` / `BULK INSERT` option.
 */
export const FIRST_ROW_FORMAT_PLATFORMS: ReadonlySet<TargetPlatform> =
    new Set<TargetPlatform>(['sql_server_2022', 'sql_server_2025', 'fabric_sql_db']);

/** Hadoop compression codec class names by detected compression. */
export const COMPRESSION_CODECS: Readonly<Record<string, string>> = {
    SNAPPY: 'org.apache.hadoop.io.compress.SnappyCodec',
    GZIP: 'org.apache.hadoop.io.compress.GzipCodec',
    GZ: 'org.apache.hadoop.io.compress.GzipCodec',
    DEFAULT: 'org.apache.hadoop.io.compress.DefaultCodec',
};

/** Delimiter display names for comments. */
export const DELIMITER_NAMES: Readonly<Record<string, string>> = {
    ',': 'comma',
    '\t': 'tab',
    '|': 'pipe',
    ';': 'semicolon',
    ' ': 'space',
};

/**
 * Mapping from detected types to SQL Server data types.
 *
 * Declaration order matters: the substring fallback sorts these keys
 * longest-first with a stable sort, so `large_string` can never resolve
 * through the shorter `string` key.
 */
export const TYPE_MAPPING: ReadonlyMap<string, string> = new Map([
    ['int64', 'BIGINT'],
    ['int32', 'INT'],
    ['int16', 'SMALLINT'],
    ['int8', 'SMALLINT'],        // Arrow int8 is signed; TINYINT is unsigned
    ['int', 'INT'],
    ['uint64', 'DECIMAL(20,0)'],
    ['uint32', 'BIGINT'],
    ['uint16', 'INT'],
    ['uint8', 'TINYINT'],        // Arrow uint8 matches SQL Server TINYINT
    ['float64', 'FLOAT'],
    ['float32', 'REAL'],
    ['float', 'FLOAT'],
    ['double', 'FLOAT'],
    ['half_float', 'REAL'],
    ['bool', 'BIT'],
    ['boolean', 'BIT'],
    ['object', 'NVARCHAR(255)'],
    ['str', 'NVARCHAR(255)'],
    ['string', 'NVARCHAR(255)'],
    ['large_string', 'NVARCHAR(MAX)'],
    ['datetime64[ns]', 'DATETIME2(7)'],
    ['datetime64[us]', 'DATETIME2(6)'],
    ['timestamp[us]', 'DATETIME2(6)'],
    ['timestamp[ns]', 'DATETIME2(7)'],
    ['timestamp', 'DATETIME2(7)'],
    ['timestamptz', 'DATETIMEOFFSET(7)'],
    ['datetime64', 'DATETIME2(7)'],
    ['date32', 'DATE'],
    ['date64', 'DATE'],
    ['date', 'DATE'],
    ['time', 'TIME(7)'],
    ['time64[us]', 'TIME(6)'],
    ['decimal128', 'DECIMAL(38,10)'],
    ['decimal256', 'NVARCHAR(MAX)'],   // up to 76 digits; exceeds DECIMAL(38)
    ['binary', 'VARBINARY(MAX)'],
    ['large_binary', 'VARBINARY(MAX)'],
    ['list', 'NVARCHAR(MAX)'],         // JSON serialised
    ['struct', 'NVARCHAR(MAX)'],       // JSON serialised
    ['dict', 'NVARCHAR(MAX)'],
    ['map', 'NVARCHAR(MAX)'],
    ['union', 'NVARCHAR(MAX)'],
    ['null', 'NVARCHAR(255)'],
]);

/** TYPE_MAPPING keys ordered longest-first for safe substring matching. */
const SUBSTRING_TYPE_KEYS: readonly string[] = [...TYPE_MAPPING.keys()]
    .map((key, index) => ({ key, index }))
    .sort((a, b) => (b.key.length - a.key.length) || (a.index - b.index))
    .map((entry) => entry.key);

const UNIT_PRECISION: Readonly<Record<string, number>> = { s: 0, ms: 3, us: 6, ns: 7 };

const STRUCTURAL_TYPE_RE =
    /^(struct|list|large_list|fixed_size_list|map|union|dense_union|sparse_union|dictionary)\s*[<(]/;

const STRUCTURAL_TYPE_NAMES = new Set([
    'struct', 'list', 'large_list', 'fixed_size_list', 'map', 'union',
    'dense_union', 'sparse_union', 'dictionary', 'dict', 'object[]',
]);

const DECIMAL_TYPE_RE = /^(?:decimal128|decimal256|decimal|numeric)\s*\(\s*(\d+)\s*(?:,\s*(-?\d+)\s*)?\)$/;
const TIMESTAMP_TYPE_RE = /^(?:timestamp|datetime64)\s*\[\s*(s|ms|us|ns)\s*(?:,\s*(.+?)\s*)?\]$/;
const TIME_TYPE_RE = /^time(?:32|64)?\s*\[\s*(s|ms|us|ns)\s*\]$/;

/** SQL Server's maximum `DECIMAL` precision. */
export const MAX_SQL_DECIMAL_PRECISION = 38;

/** Return true for Arrow container types that must serialise as text. */
export function isStructuralType(lowered: string): boolean {
    return STRUCTURAL_TYPE_NAMES.has(lowered) || STRUCTURAL_TYPE_RE.test(lowered);
}

/** Map a `decimal(p,s)`-style type to a SQL Server `DECIMAL`, else null. */
export function decimalSqlType(lowered: string): string | null {
    const match = DECIMAL_TYPE_RE.exec(lowered);
    if (!match) {
        return null;
    }
    let precision = Number.parseInt(match[1]!, 10);
    let scale = match[2] !== undefined ? Number.parseInt(match[2], 10) : 0;
    if (scale < 0) {
        // A negative scale widens the integer part; SQL Server has no
        // equivalent, so absorb it into the precision.
        precision += -scale;
        scale = 0;
    }
    if (precision < 1 || precision > MAX_SQL_DECIMAL_PRECISION || scale > precision) {
        return 'NVARCHAR(MAX)';
    }
    return `DECIMAL(${precision},${scale})`;
}

/** Map Arrow/pandas timestamp and time types to SQL Server types. */
export function temporalSqlType(lowered: string): string | null {
    const timestamp = TIMESTAMP_TYPE_RE.exec(lowered);
    if (timestamp) {
        const precision = UNIT_PRECISION[timestamp[1]!]!;
        const timezone = (timestamp[2] ?? '').trim();
        return timezone ? `DATETIMEOFFSET(${precision})` : `DATETIME2(${precision})`;
    }
    const time = TIME_TYPE_RE.exec(lowered);
    if (time) {
        return `TIME(${UNIT_PRECISION[time[1]!]!})`;
    }
    return null;
}

/** Map a detected Arrow/pandas/Iceberg type name to a SQL Server type. */
export function mapTypeToSql(dataType: unknown, maxLength?: number | null): string {
    const lowered = String(dataType).trim().toLowerCase();

    // Container types must serialise as text before anything else, so a nested
    // type such as `struct<id: int64>` can never become BIGINT.
    if (isStructuralType(lowered)) {
        return 'NVARCHAR(MAX)';
    }

    const decimalType = decimalSqlType(lowered);
    if (decimalType) {
        return decimalType;
    }

    const temporalType = temporalSqlType(lowered);
    if (temporalType) {
        return temporalType;
    }

    const exact = TYPE_MAPPING.get(lowered);
    if (exact !== undefined) {
        // Override NVARCHAR(255) with a smarter size when string length data exists.
        if (exact === 'NVARCHAR(255)' && maxLength !== undefined && maxLength !== null) {
            if (maxLength > 4000) {
                return 'NVARCHAR(MAX)';
            }
            if (maxLength > 200) {
                const size = (Math.floor(maxLength / 50) + 1) * 50;
                return `NVARCHAR(${Math.min(size, 4000)})`;
            }
        }
        return exact;
    }

    // Any remaining parameterised/nested shape is unsafe to guess at.
    if (lowered.includes('<') || lowered.includes('{')) {
        return 'NVARCHAR(MAX)';
    }

    for (const key of SUBSTRING_TYPE_KEYS) {
        if (lowered.includes(key)) {
            return TYPE_MAPPING.get(key)!;
        }
    }

    if (lowered.includes('decimal') || lowered.includes('numeric')) {
        return 'DECIMAL(18,4)';
    }
    return 'NVARCHAR(255)';
}
