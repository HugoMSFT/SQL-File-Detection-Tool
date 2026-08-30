/**
 * File-type detection and metadata orchestration.
 *
 * This is the native counterpart of the Python `FileDetector` class: the same
 * extension table, the same directory recognition rules, the same base metadata
 * dictionary, and the same "a per-format failure becomes `metadata.error`
 * rather than an exception" contract.
 */

import * as fs from 'fs';
import * as path from 'path';

import { throwIfCancelled, type CancellationToken } from './cancellation';
import { detectEncoding, encodingToCodepage } from './encoding';
import { NativeAnalysisError } from './errors';
import { CACHE_MAX_ENTRIES, CSV_SAMPLE_SIZE } from './limits';
import { directorySize, listContainedEntries } from './paths';
import { readDecodedPrefix } from './streams';
import type { FileMetadata, FileType, NativeSupport, StorageReference, SupportedFormat } from './types';
import { analyzeDelimited } from './analysis/csv';
import { analyzeDelta, isDeltaTableDirectory } from './analysis/delta';
import { analyzeExcel } from './analysis/excel';
import { analyzeIceberg, isIcebergTableDirectory } from './analysis/iceberg';
import { analyzeJson } from './analysis/json';
import { analyzeOrc, analyzeRc } from './analysis/orc';
import { analyzeParquet } from './analysis/parquet';
import { analyzeText } from './analysis/text';

/** Extension to file-type table, identical to the Python `SUPPORTED_EXTENSIONS`. */
export const SUPPORTED_EXTENSIONS: Readonly<Record<string, FileType>> = Object.freeze({
    '.txt': 'text',
    '.csv': 'csv',
    '.tsv': 'csv',
    '.parquet': 'parquet',
    '.snappy': 'parquet',
    '.json': 'json',
    '.jsonl': 'json',
    '.ndjson': 'json',
    '.orc': 'orc',
    '.rc': 'rc',
    '.delta': 'delta',
    '.xlsx': 'excel',
    '.xls': 'excel',
});

/** How completely the native core handles each recognised family. */
export const NATIVE_SUPPORT_BY_TYPE: Readonly<Record<FileType, NativeSupport>> = Object.freeze({
    csv: 'supported',
    text: 'supported',
    json: 'supported',
    parquet: 'supported',
    excel: 'supported',
    delta: 'supported',
    iceberg: 'supported',
    orc: 'unsupported_native',
    rc: 'recognition_only',
    unknown: 'recognition_only',
});

/** Formats surfaced to UI callers. */
export function listSupportedFormats(): SupportedFormat[] {
    return [
        {
            fileType: 'csv',
            extensions: ['.csv', '.tsv'],
            label: 'Delimited text (CSV / TSV / pipe)',
            support: 'supported',
            notes:
                'Streaming delimiter, header, encoding, nullability and length ' +
                'inference with exact row counts below 100 MB.',
        },
        {
            fileType: 'json',
            extensions: ['.json', '.jsonl', '.ndjson'],
            label: 'JSON, JSON Lines and NDJSON',
            support: 'supported',
            notes: 'Bounded sampling with nested object and array detection.',
        },
        {
            fileType: 'parquet',
            extensions: ['.parquet', '.snappy'],
            label: 'Apache Parquet',
            support: 'supported',
            notes:
                'Footer-only metadata, Arrow logical types, compression, row ' +
                'groups and bounded row previews.',
        },
        {
            fileType: 'excel',
            extensions: ['.xlsx'],
            label: 'Excel workbook',
            support: 'supported',
            notes: 'First worksheet, first 200 rows, no macro or binary (.xls) support.',
        },
        {
            fileType: 'delta',
            extensions: [],
            label: 'Delta Lake table folder',
            support: 'supported',
            notes: 'Schema, partition columns and version read from `_delta_log`.',
        },
        {
            fileType: 'iceberg',
            extensions: [],
            label: 'Apache Iceberg table folder',
            support: 'supported',
            notes: 'Current schema, partition spec and snapshot row count.',
        },
        {
            fileType: 'text',
            extensions: ['.txt'],
            label: 'Plain text',
            support: 'supported',
            notes: 'Line counting and encoding detection.',
        },
        {
            fileType: 'orc',
            extensions: ['.orc'],
            label: 'Apache ORC',
            support: 'unsupported_native',
            notes:
                'Recognised, and SQL generation works from a supplied schema, but ' +
                'native schema reading is unavailable; use the Python backend.',
        },
        {
            fileType: 'rc',
            extensions: ['.rc'],
            label: 'RCFile',
            support: 'recognition_only',
            notes: 'Recognition only; supply the column list or convert to Parquet/ORC.',
        },
    ];
}

/** Detect the file family for an already-validated reference. */
export async function detectFileType(reference: StorageReference): Promise<FileType> {
    if (reference.isDirectory) {
        if (await isDeltaTableDirectory(reference.realPath)) {
            return 'delta';
        }
        if (await isIcebergTableDirectory(reference.realPath)) {
            return 'iceberg';
        }
        return 'unknown';
    }

    const extension = path.extname(reference.realPath).toLowerCase();
    const known = SUPPORTED_EXTENSIONS[extension];
    if (known !== undefined) {
        return known;
    }
    try {
        return await detectByContent(reference.realPath);
    } catch {
        return 'unknown';
    }
}

/** Sniff an unknown file by looking at a bounded prefix. */
async function detectByContent(filePath: string): Promise<FileType> {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const magic = Buffer.alloc(4);
        const read = await handle.read(magic, 0, 4, 0);
        if (read.bytesRead === 4 && magic.toString('latin1') === 'PAR1') {
            return 'parquet';
        }
        if (read.bytesRead >= 3 && magic.subarray(0, 3).toString('latin1') === 'ORC') {
            return 'orc';
        }
    } finally {
        await handle.close();
    }

    let sample: string;
    try {
        sample = await readDecodedPrefix(filePath, 8192, 'utf-8');
    } catch {
        return 'text';
    }
    const stripped = sample.replace(/^[\uFEFF\s]+/, '');
    if (stripped.startsWith('{') || stripped.startsWith('[')) {
        return 'json';
    }

    // A delimiter that appears the same number of times on each of the first
    // few lines is the same heuristic the Python sniffer applies.
    const lines = sample.split(/\r\n|\r|\n/).filter((line) => line.length > 0).slice(0, 5);
    if (lines.length >= 2) {
        for (const delimiter of [',', '\t', ';', '|']) {
            const counts = lines.map((line) => line.split(delimiter).length - 1);
            if (counts[0] > 0 && counts.every((count) => count === counts[0])) {
                return 'csv';
            }
        }
    }
    return 'text';
}

interface CacheEntry {
    signature: string;
    metadata: FileMetadata;
}

const metadataCache = new Map<string, CacheEntry>();

async function cacheSignature(reference: StorageReference): Promise<string | null> {
    try {
        const stats = await fs.promises.stat(reference.realPath);
        return `${reference.realPath}|${stats.size}|${stats.mtimeMs}`;
    } catch {
        return null;
    }
}

function cacheGet(key: string, signature: string): FileMetadata | null {
    const entry = metadataCache.get(key);
    if (entry === undefined || entry.signature !== signature) {
        return null;
    }
    // Refresh recency so the map doubles as an LRU.
    metadataCache.delete(key);
    metadataCache.set(key, entry);
    return structuredClone(entry.metadata);
}

function cacheSet(key: string, signature: string, metadata: FileMetadata): void {
    metadataCache.set(key, { signature, metadata: structuredClone(metadata) });
    while (metadataCache.size > CACHE_MAX_ENTRIES) {
        const oldest = metadataCache.keys().next();
        if (oldest.done === true) {
            break;
        }
        metadataCache.delete(oldest.value);
    }
}

/** Clear the metadata cache. Exposed for tests and for explicit refreshes. */
export function clearMetadataCache(): void {
    metadataCache.clear();
}

/**
 * Analyse one file or table directory.
 *
 * Mirrors `FileDetector.analyze_file_metadata`: a fixed base dictionary is
 * built first, then the per-format analyser's keys are merged over it.
 */
export async function analyzeFileMetadata(
    reference: StorageReference,
    token?: CancellationToken,
): Promise<FileMetadata> {
    throwIfCancelled(token);
    const signature = await cacheSignature(reference);
    if (signature !== null) {
        const cached = cacheGet(reference.realPath, signature);
        if (cached !== null) {
            return cached;
        }
    }

    const fileType = await detectFileType(reference);
    const textual = fileType === 'csv' || fileType === 'text' || fileType === 'json';

    let encoding = 'binary';
    let confidence = 1;
    if (textual) {
        const detection = await detectEncoding(reference.realPath);
        encoding = detection.encoding;
        confidence = detection.confidence;
    }

    const fileSize = reference.isDirectory
        ? await directorySize(reference)
        : reference.sizeBytes;

    const metadata: FileMetadata = {
        file_path: reference.realPath,
        file_name: path.basename(reference.realPath),
        file_type: fileType,
        file_size: fileSize,
        schema: null,
        row_count: null,
        column_count: null,
        delimiter: null,
        encoding,
        encoding_confidence: Math.round(confidence * 100),
        codepage: encodingToCodepage(encoding),
        has_header: false,
        compression: null,
        nullable_columns: [],
        parquet_metadata: null,
        delta_metadata: null,
        native_support: NATIVE_SUPPORT_BY_TYPE[fileType],
    };

    if (textual && confidence < 0.5) {
        metadata.encoding_warning =
            `Low confidence (${Math.round(confidence * 100)}%) for encoding "${encoding}". ` +
            'Verify encoding manually or specify it explicitly.';
    }

    try {
        Object.assign(metadata, await analyzeByType(fileType, reference, encoding, fileSize, token));
    } catch (error) {
        if (error instanceof NativeAnalysisError && error.code === 'cancelled') {
            throw error;
        }
        metadata.error = error instanceof Error ? error.message : String(error);
    }

    if (signature !== null) {
        cacheSet(reference.realPath, signature, metadata);
    }
    return metadata;
}

async function analyzeByType(
    fileType: FileType,
    reference: StorageReference,
    encoding: string,
    fileSize: number,
    token?: CancellationToken,
): Promise<Partial<FileMetadata>> {
    switch (fileType) {
        case 'csv':
            return analyzeDelimited(reference.realPath, fileSize, { encoding, token });
        case 'json':
            return analyzeJson(reference.realPath, fileSize, { encoding, token });
        case 'text':
            return analyzeText(reference.realPath, encoding, token);
        case 'parquet':
            return analyzeParquet(reference.realPath, token);
        case 'excel':
            return analyzeExcel(reference.realPath, token);
        case 'delta':
            return analyzeDelta(reference.realPath, token);
        case 'iceberg':
            return analyzeIceberg(reference.realPath, token);
        case 'orc':
            return analyzeOrc(reference.realPath, token);
        case 'rc':
            return analyzeRc();
        default:
            return {};
    }
}

/** The first non-whitespace character of a text file's bounded prefix. */
export async function firstCharacter(filePath: string, encoding: string): Promise<string> {
    const prefix = await readDecodedPrefix(filePath, CSV_SAMPLE_SIZE, encoding);
    const stripped = prefix.replace(/^[\uFEFF \t\r\n]+/, '');
    return stripped.length > 0 ? stripped[0] : '';
}

/**
 * Recursively analyse every supported file beneath a directory.
 *
 * Delta and Iceberg folders are reported as a single table entry and are not
 * descended into, matching `FileDetector.scan_directory`.
 */
export async function scanDirectory(
    reference: StorageReference,
    token?: CancellationToken,
): Promise<FileMetadata[]> {
    if (!reference.isDirectory) {
        throw new NativeAnalysisError(
            'not_a_directory',
            `Directory does not exist: ${reference.requestedPath}`,
        );
    }
    if (
        (await isDeltaTableDirectory(reference.realPath)) ||
        (await isIcebergTableDirectory(reference.realPath))
    ) {
        return [await analyzeFileMetadata(reference, token)];
    }

    const results: FileMetadata[] = [];
    const queue: StorageReference[] = [reference];
    const visited = new Set<string>();

    while (queue.length > 0) {
        const current = queue.shift() as StorageReference;
        if (visited.has(current.realPath)) {
            continue;
        }
        visited.add(current.realPath);
        throwIfCancelled(token);

        const entries = await listContainedEntries(current);
        const directories: StorageReference[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory) {
                continue;
            }
            const name = path.basename(entry.realPath);
            if (name.startsWith('.') || name === '__pycache__') {
                continue;
            }
            if (
                (await isDeltaTableDirectory(entry.realPath)) ||
                (await isIcebergTableDirectory(entry.realPath))
            ) {
                results.push(await analyzeFileMetadata(entry, token));
            } else {
                directories.push(entry);
            }
        }

        for (const entry of entries) {
            if (entry.isDirectory) {
                continue;
            }
            if ((await detectFileType(entry)) !== 'unknown') {
                results.push(await analyzeFileMetadata(entry, token));
            }
        }
        queue.push(...directories);
    }
    return results;
}
