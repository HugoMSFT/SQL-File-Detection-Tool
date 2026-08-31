/**
 * Parquet analysis backed by `hyparquet`, a pure-JavaScript reader.
 *
 * Only the footer is read for metadata; row data is read one bounded range at a
 * time for previews. When the writer stored an `ARROW:schema` key/value entry —
 * every Arrow-based writer does — the logical Arrow types are decoded from it so
 * that `large_string`, `large_binary` and timestamp time zones survive, which is
 * information the Parquet schema alone does not carry.
 */

import * as zlib from 'zlib';

import type {
    FileMetaData,
    SchemaElement,
    SchemaTree,
} from 'hyparquet' with { 'resolution-mode': 'import' };

import { throwIfCancelled, type CancellationToken } from '../cancellation';
import { NativeAnalysisError } from '../errors';
import type { FileMetadata, SampleValue, SchemaField } from '../types';
import { decodeArrowSchema, type ArrowField } from './arrowSchema';

type HyparquetModule = typeof import('hyparquet', { with: { 'resolution-mode': 'import' } });

let hyparquetPromise: Promise<HyparquetModule> | null = null;

/**
 * Load the ESM-only `hyparquet` package from CommonJS output.
 *
 * The import is cached so repeated analyses do not pay for module evaluation,
 * and it is deliberately lazy so activating the extension does not.
 */
export async function loadHyparquet(): Promise<HyparquetModule> {
    if (hyparquetPromise === null) {
        hyparquetPromise = import('hyparquet');
    }
    return hyparquetPromise;
}

/**
 * Decompressors built on Node's own `zlib`.
 *
 * `hyparquet` handles `UNCOMPRESSED` and `SNAPPY` itself; the rest are wired up
 * here so no extra dependency (or WebAssembly payload) is needed. Codecs Node
 * cannot decompress raise a typed error instead of returning wrong data.
 */
export function buildCompressors(): Record<string, (input: Uint8Array, outputLength: number) => Uint8Array> {
    const compressors: Record<string, (input: Uint8Array, outputLength: number) => Uint8Array> = {
        GZIP: (input) => new Uint8Array(zlib.gunzipSync(Buffer.from(input))),
        BROTLI: (input) => new Uint8Array(zlib.brotliDecompressSync(Buffer.from(input))),
    };
    const zstd = (zlib as unknown as {
        zstdDecompressSync?: (buffer: Buffer) => Buffer;
    }).zstdDecompressSync;
    if (typeof zstd === 'function') {
        compressors.ZSTD = (input) => new Uint8Array(zstd(Buffer.from(input)));
    }
    return compressors;
}

const TIME_UNIT_NAMES: Readonly<Record<string, string>> = Object.freeze({
    MILLIS: 'ms',
    MICROS: 'us',
    NANOS: 'ns',
});

interface LogicalTypeLike {
    type: string;
    bitWidth?: number;
    isSigned?: boolean;
    isAdjustedToUTC?: boolean;
    unit?: string;
    precision?: number;
    scale?: number;
}

function logicalUnit(logical: LogicalTypeLike | undefined): string {
    const unit = logical?.unit;
    if (typeof unit === 'string') {
        return TIME_UNIT_NAMES[unit] ?? 'ms';
    }
    if (unit && typeof unit === 'object') {
        const key = Object.keys(unit as Record<string, unknown>)[0];
        return TIME_UNIT_NAMES[String(key).toUpperCase()] ?? 'ms';
    }
    return 'ms';
}

function decimalName(element: SchemaElement, logical: LogicalTypeLike | undefined): string {
    const precision = logical?.precision ?? element.precision ?? 0;
    const scale = logical?.scale ?? element.scale ?? 0;
    return `decimal128(${precision}, ${scale})`;
}

/**
 * Render a Parquet schema node using `pyarrow`'s type-name vocabulary.
 *
 * Used when a file carries no Arrow schema, for example one written by Spark
 * or by `parquet-mr`.
 */
export function parquetTypeName(node: SchemaTree): string {
    const element = node.element;
    const logical = element.logical_type as LogicalTypeLike | undefined;
    const converted = element.converted_type;

    if (!element.type) {
        // Group node: LIST, MAP or a plain struct.
        if (logical?.type === 'LIST' || converted === 'LIST') {
            const item = node.children[0]?.children[0] ?? node.children[0];
            return item
                ? `list<${item.element.name}: ${parquetTypeName(item)}>`
                : 'list<element: null>';
        }
        if (logical?.type === 'MAP' || converted === 'MAP' || converted === 'MAP_KEY_VALUE') {
            const entries = node.children[0];
            const key = entries?.children[0];
            const value = entries?.children[1];
            return `map<${key ? parquetTypeName(key) : 'null'}, ${value ? parquetTypeName(value) : 'null'}>`;
        }
        return `struct<${node.children
            .map((child) => `${child.element.name}: ${parquetTypeName(child)}`)
            .join(', ')}>`;
    }

    switch (element.type) {
        case 'BOOLEAN':
            return 'bool';
        case 'FLOAT':
            return 'float';
        case 'DOUBLE':
            return 'double';
        case 'INT96':
            return 'timestamp[ns]';
        case 'INT32': {
            if (logical?.type === 'INT') {
                return `${logical.isSigned === false ? 'u' : ''}int${logical.bitWidth ?? 32}`;
            }
            if (logical?.type === 'DATE' || converted === 'DATE') {
                return 'date32[day]';
            }
            if (logical?.type === 'TIME' || converted === 'TIME_MILLIS') {
                return `time32[${logicalUnit(logical)}]`;
            }
            if (logical?.type === 'DECIMAL' || converted === 'DECIMAL') {
                return decimalName(element, logical);
            }
            if (converted === 'INT_8') { return 'int8'; }
            if (converted === 'INT_16') { return 'int16'; }
            if (converted === 'UINT_8') { return 'uint8'; }
            if (converted === 'UINT_16') { return 'uint16'; }
            if (converted === 'UINT_32') { return 'uint32'; }
            return 'int32';
        }
        case 'INT64': {
            if (logical?.type === 'INT') {
                return `${logical.isSigned === false ? 'u' : ''}int${logical.bitWidth ?? 64}`;
            }
            if (logical?.type === 'TIMESTAMP') {
                const unit = logicalUnit(logical);
                return logical.isAdjustedToUTC
                    ? `timestamp[${unit}, tz=UTC]`
                    : `timestamp[${unit}]`;
            }
            if (converted === 'TIMESTAMP_MILLIS') { return 'timestamp[ms]'; }
            if (converted === 'TIMESTAMP_MICROS') { return 'timestamp[us]'; }
            if (logical?.type === 'TIME' || converted === 'TIME_MICROS') {
                return `time64[${logicalUnit(logical)}]`;
            }
            if (logical?.type === 'DECIMAL' || converted === 'DECIMAL') {
                return decimalName(element, logical);
            }
            if (converted === 'UINT_64') { return 'uint64'; }
            return 'int64';
        }
        case 'BYTE_ARRAY': {
            if (logical?.type === 'STRING' || converted === 'UTF8' || converted === 'JSON') {
                return 'string';
            }
            if (logical?.type === 'DECIMAL' || converted === 'DECIMAL') {
                return decimalName(element, logical);
            }
            return 'binary';
        }
        case 'FIXED_LEN_BYTE_ARRAY': {
            if (logical?.type === 'DECIMAL' || converted === 'DECIMAL') {
                return decimalName(element, logical);
            }
            if (logical?.type === 'UUID') {
                return 'fixed_size_binary[16]';
            }
            return `fixed_size_binary[${element.type_length ?? 0}]`;
        }
        default:
            return 'binary';
    }
}

/** Everything the analyser needs from a Parquet footer. */
export interface ParquetFooter {
    metadata: FileMetaData;
    tree: SchemaTree;
    fields: SchemaField[];
    nullableColumns: string[];
    keyValueMetadata: Record<string, string>;
    compression: string | null;
    rowCount: number;
    physicalTypes: Record<string, string>;
}

function keyValueToRecord(metadata: FileMetaData): Record<string, string> {
    const record: Record<string, string> = {};
    for (const entry of metadata.key_value_metadata ?? []) {
        if (typeof entry.key === 'string' && typeof entry.value === 'string') {
            record[entry.key] = entry.value;
        }
    }
    return record;
}

function arrowFieldsFor(keyValues: Record<string, string>): ArrowField[] | null {
    const encoded = keyValues['ARROW:schema'];
    return encoded ? decodeArrowSchema(encoded) : null;
}

function isListGroup(element: SchemaElement): boolean {
    const logical = element.logical_type as { type?: string; } | undefined;
    return logical?.type === 'LIST' || element.converted_type === 'LIST';
}

function isMapGroup(element: SchemaElement): boolean {
    const logical = element.logical_type as { type?: string; } | undefined;
    return (
        logical?.type === 'MAP' ||
        element.converted_type === 'MAP' ||
        element.converted_type === 'MAP_KEY_VALUE'
    );
}

/**
 * Reconcile an Arrow-derived type name with the Parquet schema.
 *
 * `pyarrow` reports Parquet nested types using the *Parquet* child names, not
 * the ones recorded in `ARROW:schema`: a LIST always shows its `element` field,
 * and a MAP whose entries group is not literally called `entries` gets that
 * name appended. Matching this keeps type strings identical across backends.
 */
function alignWithParquet(typeName: string, node: SchemaTree | undefined): string {
    if (node === undefined) {
        return typeName;
    }
    const element = node.element;

    if (isListGroup(element)) {
        const childName = node.children[0]?.children[0]?.element.name;
        if (childName !== undefined) {
            for (const prefix of ['list<', 'large_list<', 'fixed_size_list<']) {
                if (typeName.startsWith(prefix)) {
                    const separator = typeName.indexOf(':');
                    if (separator > 0) {
                        return `${prefix}${childName}${typeName.slice(separator)}`;
                    }
                }
            }
        }
        return typeName;
    }

    if (
        isMapGroup(element) &&
        typeName.startsWith('map<') &&
        typeName.endsWith('>') &&
        !/\('[^']*'\)>$/.test(typeName) &&
        element.name !== 'entries'
    ) {
        return `${typeName.slice(0, -1)} ('${element.name}')>`;
    }
    return typeName;
}

/** Read and interpret the Parquet footer. */
export async function readParquetFooter(
    filePath: string,
    token?: CancellationToken,
): Promise<ParquetFooter> {
    throwIfCancelled(token);
    const hyparquet = await loadHyparquet();
    const buffer = await hyparquet.asyncBufferFromFile(filePath);
    const metadata = await hyparquet.parquetMetadataAsync(buffer);
    const tree = hyparquet.parquetSchema(metadata);
    const keyValueMetadata = keyValueToRecord(metadata);

    const arrowFields = arrowFieldsFor(keyValueMetadata);
    const fields: SchemaField[] = [];
    const nullableColumns: string[] = [];

    if (arrowFields !== null && arrowFields.length === tree.children.length) {
        arrowFields.forEach((field, index) => {
            const node = tree.children[index];
            const name = field.name || node.element.name;
            fields.push([name, alignWithParquet(field.typeName, node)]);
            if (field.nullable) {
                nullableColumns.push(name);
            }
        });
    } else {
        for (const child of tree.children) {
            const name = child.element.name;
            fields.push([name, parquetTypeName(child)]);
            if (child.element.repetition_type !== 'REQUIRED') {
                nullableColumns.push(name);
            }
        }
    }

    let compression: string | null = null;
    const firstColumn = metadata.row_groups[0]?.columns?.[0];
    const codec = firstColumn?.meta_data?.codec;
    if (typeof codec === 'string') {
        compression = codec;
    }

    return {
        metadata,
        tree,
        fields,
        nullableColumns,
        keyValueMetadata,
        compression,
        rowCount: Number(metadata.num_rows),
        physicalTypes: Object.fromEntries(
            tree.children
                .filter((child) => typeof child.element.type === 'string')
                .map((child) => [child.element.name, child.element.type as string]),
        ),
    };
}

/** Analyse a Parquet file, mirroring the Python `_analyze_parquet` keys. */
export async function analyzeParquet(
    filePath: string,
    token?: CancellationToken,
): Promise<Partial<FileMetadata>> {
    try {
        const footer = await readParquetFooter(filePath, token);
        return {
            schema: footer.fields,
            row_count: footer.rowCount,
            column_count: footer.fields.length,
            compression: footer.compression,
            nullable_columns: footer.nullableColumns,
            encoding: 'binary',
            parquet_physical_types: footer.physicalTypes,
            parquet_metadata: {
                created_by: footer.metadata.created_by ?? null,
                num_row_groups: footer.metadata.row_groups.length,
                format_version: footer.metadata.version === 1 ? '1.0' : '2.6',
                key_value_metadata: footer.keyValueMetadata,
            },
        };
    } catch (error) {
        if (error instanceof NativeAnalysisError && error.code === 'cancelled') {
            throw error;
        }
        return {
            error: error instanceof Error ? error.message : String(error),
            encoding: 'binary',
        };
    }
}

/** Convert a decoded Parquet cell into a JSON-safe preview value. */
export function parquetCellToSample(value: unknown): SampleValue {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'bigint') {
        return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'boolean' || typeof value === 'string') {
        return value;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value).toString('hex');
    }
    try {
        return JSON.stringify(value, (_key, item) =>
            typeof item === 'bigint' ? item.toString() : item,
        ) ?? String(value);
    } catch {
        return String(value);
    }
}

/** Read a bounded number of rows for the preview surface. */
export async function readParquetPreview(
    filePath: string,
    maxRows: number,
    token?: CancellationToken,
): Promise<{ columns: SchemaField[]; rows: SampleValue[][]; totalRows: number; }> {
    const hyparquet = await loadHyparquet();
    const footer = await readParquetFooter(filePath, token);
    const buffer = await hyparquet.asyncBufferFromFile(filePath);
    const columnNames = footer.fields.map(([name]) => name);
    const rows: SampleValue[][] = [];

    if (footer.rowCount > 0 && maxRows > 0) {
        throwIfCancelled(token);
        const raw = await hyparquet.parquetReadObjects({
            file: buffer,
            metadata: footer.metadata,
            rowStart: 0,
            rowEnd: Math.min(maxRows, footer.rowCount),
            compressors: buildCompressors(),
        });
        for (const row of raw) {
            rows.push(columnNames.map((name) => parquetCellToSample(row[name])));
        }
    }

    return { columns: footer.fields, rows, totalRows: footer.rowCount };
}
