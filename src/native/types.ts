/**
 * Typed models for the native analysis core.
 *
 * The native core is a from-scratch TypeScript port of the Python detector and
 * SQL generator that ships with the extension today. Its metadata objects use
 * the same snake_case keys as the Python/Flask contract so that:
 *
 *   * the future WebviewView can consume either backend without a translation
 *     layer, and
 *   * automated parity tests can compare the two implementations key by key.
 *
 * Nothing in this module imports `vscode`, so the core is unit-testable with
 * plain `node --test`.
 */

/** File families the detector can recognise. */
export type FileType =
    | 'csv'
    | 'text'
    | 'json'
    | 'parquet'
    | 'orc'
    | 'rc'
    | 'delta'
    | 'iceberg'
    | 'excel'
    | 'unknown';

/**
 * How completely the native core can analyse a recognised format.
 *
 * `unsupported_native` is an explicit, typed outcome rather than an error: the
 * format is recognised and the SQL generator still produces platform-correct
 * statements from a caller-supplied schema, but the native core deliberately
 * does not fabricate a schema it cannot read.
 */
export type NativeSupport =
    | 'supported'
    | 'recognition_only'
    | 'unsupported_native';

/** A `[column_name, detected_type]` pair, mirroring the Python tuple list. */
export type SchemaField = [name: string, dataType: string];

/** JSON-safe scalar used for sample values and preview cells. */
export type SampleValue = string | number | boolean | null;

/** How a schema was derived. */
export type SchemaInference =
    | 'sampled'
    | 'full'
    | 'delta_log'
    | 'iceberg_metadata'
    | 'underlying_parquet_file'
    | 'parquet_metadata';

/** Classification of a JSON field one level deep. */
export type JsonNestingKind = 'scalar' | 'object' | 'array';

/** Shape of a JSON document. */
export type JsonFormat = 'array' | 'ndjson' | 'object';

/** Parquet footer facts surfaced to callers and best-practice guidance. */
export interface ParquetMetadata {
    created_by: string | null;
    num_row_groups: number;
    serialized_size?: number | null;
    format_version: string;
    key_value_metadata: Record<string, string>;
}

/** Delta Lake transaction-log facts. */
export interface DeltaMetadata {
    version: number | null;
    name: string | null;
    description: string | null;
    partition_columns: string[];
    created_time: string | null;
    configuration: Record<string, string>;
}

/** Apache Iceberg table metadata facts. */
export interface IcebergMetadata {
    format_version: number | null;
    table_uuid: string | null;
    location: string | null;
    last_updated: number | null;
    current_schema_id: number | null;
    default_spec_id: number | null;
    partition_spec: unknown[];
    metadata_file: string;
    snapshot_count?: number;
}

/**
 * Detected metadata for one file or table directory.
 *
 * Optional members are omitted (rather than set to `undefined`) when they do
 * not apply, matching how the Python implementation builds its dictionary.
 */
export interface FileMetadata {
    file_path: string;
    file_name: string;
    file_type: FileType;
    file_size: number;
    schema: SchemaField[] | null;
    row_count: number | null;
    column_count: number | null;
    delimiter: string | null;
    encoding: string;
    encoding_confidence: number;
    codepage: string;
    has_header: boolean;
    compression: string | null;
    nullable_columns: string[];
    parquet_metadata: ParquetMetadata | null;
    delta_metadata: DeltaMetadata | null;

    native_support?: NativeSupport;
    iceberg_metadata?: IcebergMetadata;
    error?: string;
    warning?: string;
    encoding_warning?: string;
    schema_inference?: SchemaInference;
    schema_sample_size?: number;
    nullability_inference?: 'conservative';
    observed_max_string_lengths?: Record<string, number>;
    max_string_lengths?: Record<string, number>;
    sample_rows?: SampleValue[][];
    row_count_estimated?: boolean;
    row_count_lower_bound?: number | null;
    json_format?: JsonFormat;
    json_nesting?: Record<string, JsonNestingKind>;
    json_sample_values?: Record<string, SampleValue>;
    analysis_truncated?: boolean;
    /** Caller-supplied explicit SQL types keyed by column name. */
    sql_type_overrides?: Record<string, string>;
}

/**
 * Metadata accepted by the SQL generator.
 *
 * The generator is deliberately tolerant: callers (the CLI, the Flask API and
 * the future webview) may hand it a partially populated object, exactly as the
 * Python implementation accepts a plain `dict`. Only `file_path` is required.
 */
export type GeneratorMetadata = Partial<Omit<FileMetadata, 'file_path'>> & {
    file_path: string;
};

/** One column header in a tabular preview. */
export interface PreviewColumn {
    name: string;
    type: string;
}

/** Bounded tabular preview of a file. */
export interface PreviewResult {
    columns: PreviewColumn[];
    rows: SampleValue[][];
    total_rows: number | null;
    truncated: boolean;
    error?: string;
}

/** SQL products the generator can target. */
export type TargetPlatform =
    | 'sql_server_2019'
    | 'sql_server_2022'
    | 'sql_server_2025'
    | 'azure_sql_db'
    | 'azure_sql_mi'
    | 'fabric_sql_db';

/** Named tabs / sections produced by the generator. */
export type StatementKind =
    | 'create_table'
    | 'bulk_insert'
    | 'openrowset'
    | 'copy_into'
    | 'external_file_format'
    | 'create_external_table'
    | 'json_functions'
    | 'for_json'
    | 'credential_setup'
    | 'best_practices';

/** Every generated statement, keyed by tab. */
export type GeneratedStatements = Record<StatementKind, string>;

/** Options shared by every generator entry point. */
export interface GenerateOptions {
    tableName?: string | null;
    schemaName?: string;
    dataSource?: string;
    location?: string | null;
    targetPlatform?: TargetPlatform;
    storageUrl?: string | null;
}

/** How a storage location was classified. */
export type StorageKind = 'azure' | 's3' | 'onelake' | 'other' | 'local';

/** A resolved reference to something the core is allowed to read. */
export interface StorageReference {
    /** Absolute, symlink-resolved path on disk. */
    readonly realPath: string;
    /** Path as supplied by the caller, for display only. */
    readonly requestedPath: string;
    /** Allowed root the reference was validated against. */
    readonly allowedRoot: string;
    /** True when the reference points at a directory. */
    readonly isDirectory: boolean;
    /** Size in bytes (0 for directories). */
    readonly sizeBytes: number;
}

/** A supported format entry for UI surfaces. */
export interface SupportedFormat {
    fileType: FileType;
    extensions: string[];
    label: string;
    support: NativeSupport;
    notes: string;
}
