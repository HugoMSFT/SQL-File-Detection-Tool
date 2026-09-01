/**
 * Bounded-parsing limits.
 *
 * Every value here mirrors the Python detector so that the two backends agree
 * on when a file is "too big to read exactly", plus a few extra ceilings that
 * only matter for a long-lived extension host process (unbounded string
 * buffers, zip bombs, pathological row widths).
 */

/** Bytes of a delimited file read to sniff delimiter and header. */
export const CSV_SAMPLE_SIZE = 4096;

/** Bytes fed to the encoding detector. */
export const ENCODING_DETECTION_BYTES = 65536;

/** Files at or above this size skip exact row counting. */
export const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;

/** Largest JSON document parsed in full. */
export const JSON_FULL_PARSE_MAX_BYTES = 32 * 1024 * 1024;

/** Largest JSON prefix decoded when sampling a big array. */
export const JSON_SAMPLE_MAX_CHARS = 4 * 1024 * 1024;

/** Rows sampled from a JSON document when inferring its schema. */
export const JSON_SCHEMA_SAMPLE_ROWS = 200;

/** Distinct JSON object keys retained for schema inference. */
export const JSON_SCHEMA_MAX_COLUMNS = 4096;

/** Entries retained by the analysis cache. */
export const CACHE_MAX_ENTRIES = 256;

/** Rows read from a delimited file when inferring its schema. */
export const CSV_SCHEMA_SAMPLE_ROWS = 1000;

/** Rows echoed back as `sample_rows`. */
export const SAMPLE_ROW_COUNT = 3;

/** Largest number of preview rows a caller may request. */
export const PREVIEW_MAX_ROWS = 10000;

/** Default number of preview rows. */
export const PREVIEW_DEFAULT_ROWS = 100;

/** Chunk size used by the streaming readers. */
export const STREAM_CHUNK_BYTES = 256 * 1024;

/**
 * Hard ceiling on a single delimited field, guarding against a file with an
 * unterminated quote turning into an unbounded string allocation.
 */
export const MAX_FIELD_CHARS = 4 * 1024 * 1024;

/** Hard ceiling on columns per row. */
export const MAX_COLUMNS = 4096;

/** Largest single entry the XLSX reader will inflate (zip-bomb guard). */
export const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;

/** Largest total inflated size across the XLSX entries we read. */
export const MAX_ZIP_TOTAL_BYTES = 128 * 1024 * 1024;

/** Largest compression ratio tolerated for a single zip entry. */
export const MAX_ZIP_RATIO = 500;

/** Largest Parquet/ORC footer-bearing file read fully into memory. */
export const MAX_IN_MEMORY_BYTES = 256 * 1024 * 1024;

/** Largest Delta transaction log (in commits) replayed for metadata. */
export const MAX_DELTA_LOG_FILES = 5000;

/** Largest single JSON line accepted from an NDJSON stream. */
export const MAX_NDJSON_LINE_BYTES = 16 * 1024 * 1024;

/** How often bounded loops poll the cancellation token. */
export const CANCELLATION_POLL_INTERVAL = 512;
