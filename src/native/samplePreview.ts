/**
 * Opt-in first previews. The byte budget includes the encoding/dialect probe;
 * incomplete records and decoder tails are never presented as real values.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as iconv from 'iconv-lite';

import { throwIfCancelled, type CancellationToken } from './cancellation';
import { baseMetadata } from './detector';
import { detectEncodingFromBuffer, toIconvName } from './encoding';
import { LimitExceededError, NativeAnalysisError } from './errors';
import {
    CSV_SAMPLE_SIZE,
    ENCODING_DETECTION_BYTES,
    FAST_PREVIEW_CHUNK_BYTES,
    FAST_PREVIEW_MAX_BYTES,
    FAST_PREVIEW_MAX_COLUMNS,
    FAST_PREVIEW_MAX_RECORD_CHARS,
    FAST_PREVIEW_MAX_ROWS,
    SAMPLE_ROW_COUNT,
} from './limits';
import { clampPreviewRows } from './preview';
import { normaliseHeader } from './analysis/csv';
import { DelimitedRowParser, inferColumn, sniffDialect } from './analysis/delimited';
import { buildJsonResult, jsonSafe } from './analysis/json';
import { parseJson, type JsonNode } from './analysis/jsonValue';
import type {
    AnalysisPreview,
    FileMetadata,
    FileType,
    PreviewSample,
    SampleValue,
    StorageReference,
} from './types';

interface SampleParser {
    readonly done: boolean;
    readonly logicalRows: number;
    readonly complete?: boolean;
    push(text: string): void;
    end(): void;
    result(): { metadata: Partial<FileMetadata>; rows: SampleValue[][] };
}

class DelimitedSample implements SampleParser {
    private readonly parser: DelimitedRowParser;
    private readonly dialect: { delimiter: string; hasHeader: boolean };
    private header: string[] | null = null;
    private readonly rows: string[][] = [];
    logicalRows = 0;

    constructor(
        text: string,
        filePath: string,
        private readonly limit: number,
    ) {
        this.dialect = sniffDialect(text.slice(0, CSV_SAMPLE_SIZE), filePath);
        this.parser = new DelimitedRowParser(this.dialect.delimiter, '"', {
            maxRecordChars: FAST_PREVIEW_MAX_RECORD_CHARS,
            maxColumns: FAST_PREVIEW_MAX_COLUMNS,
        });
    }

    get done(): boolean {
        return this.logicalRows >= this.limit + (this.dialect.hasHeader ? 1 : 0);
    }

    push(text: string): void {
        this.consume(this.parser.push(
            text,
            this.limit + (this.dialect.hasHeader ? 1 : 0) - this.logicalRows,
        ));
    }

    end(): void {
        if (!this.done) {
            this.consume(this.parser.end());
        }
    }

    private consume(rows: string[][]): void {
        for (const row of rows) {
            this.logicalRows += 1;
            if (row.length === 0) {
                continue;
            }
            if (this.header === null) {
                this.header = this.dialect.hasHeader
                    ? normaliseHeader(row)
                    : row.map((_, index) => `column_${index + 1}`);
                if (this.dialect.hasHeader) {
                    continue;
                }
            }
            if (row.length > this.header.length) {
                throw new NativeAnalysisError(
                    'malformed_input',
                    'A sample record has more fields than the detected header.',
                );
            }
            this.rows.push(row);
        }
    }

    result(): { metadata: Partial<FileMetadata>; rows: SampleValue[][] } {
        const header = this.header ?? [];
        const columns = header.map((_, index) =>
            inferColumn(this.rows.map((row) => row[index] ?? null)),
        );
        const rows = this.rows.map((_, rowIndex) => header.map((_, index) =>
            columns[index].values[rowIndex],
        ));
        return {
            rows,
            metadata: {
                delimiter: this.dialect.delimiter,
                has_header: this.dialect.hasHeader,
                schema: header.map((name, index) => [name, columns[index].dtype]),
                column_count: header.length,
                schema_sample_size: this.rows.length,
                nullable_columns: header.slice(),
                nullability_inference: 'conservative',
                observed_max_string_lengths: Object.fromEntries(header.flatMap((name, index) =>
                    columns[index].observedMaxLength === null
                        ? []
                        : [[name, columns[index].observedMaxLength]],
                )),
                max_string_lengths: {},
            },
        };
    }
}

type ObjectRow = Array<[string, JsonNode]>;

/** Frame object records; the existing exact JSON parser validates each one. */
class JsonSample implements SampleParser {
    private readonly rows: ObjectRow[] = [];
    private readonly keys = new Set<string>();
    private mode: 'array' | 'object' | 'ndjson' | undefined;
    private phase: 'value' | 'separator' | 'end' = 'value';
    private pending = '';
    private depth = 0;
    private inString = false;
    private escaped = false;
    private lineSeparated = false;
    private afterComma = false;

    constructor(private readonly limit: number, filePath: string) {
        if (/\.(ndjson|jsonl)$/i.test(path.extname(filePath))) {
            this.mode = 'ndjson';
        }
    }

    get logicalRows(): number {
        return this.rows.length;
    }

    get done(): boolean {
        return this.rows.length >= this.limit || this.phase === 'end';
    }

    get complete(): boolean {
        return this.phase === 'end';
    }

    push(text: string): void {
        for (let index = 0; index < text.length && !this.done; index += 1) {
            const char = text[index];
            if (this.depth === 0) {
                if (' \t\r\n'.includes(char)) {
                    this.lineSeparated ||= char === '\r' || char === '\n';
                    continue;
                }
                if (!this.mode) {
                    this.mode = char === '[' ? 'array' : 'object';
                    if (char === '[') {
                        continue;
                    }
                }
                if (this.mode === 'array') {
                    if (char === ']' && !this.afterComma) {
                        this.phase = 'end';
                        continue;
                    }
                    if (this.phase === 'separator' && char === ',') {
                        this.phase = 'value';
                        this.afterComma = true;
                        continue;
                    }
                    if (this.phase !== 'value') {
                        throw new NativeAnalysisError('malformed_input', 'Expected a comma between JSON sample records.');
                    }
                } else if (this.phase === 'separator') {
                    if (!this.lineSeparated) {
                        throw new NativeAnalysisError('malformed_input', 'Expected a newline between JSON sample records.');
                    }
                    this.mode = 'ndjson';
                }
                if (char !== '{') {
                    throw new NativeAnalysisError('malformed_input', 'Sample preview requires JSON object records.');
                }
                this.lineSeparated = false;
                this.afterComma = false;
            }
            this.pending += char;
            if (this.pending.length > FAST_PREVIEW_MAX_RECORD_CHARS) {
                throw new LimitExceededError('A JSON record exceeds the sample preview limit.');
            }
            if (this.inString) {
                if (this.escaped) {
                    this.escaped = false;
                } else if (char === '\\') {
                    this.escaped = true;
                } else if (char === '"') {
                    this.inString = false;
                }
            } else if (char === '"') {
                this.inString = true;
            } else if (char === '{' || char === '[') {
                this.depth += 1;
            } else if (char === '}' || char === ']') {
                this.depth -= 1;
                if (this.depth === 0) {
                    const node = parseJson(this.pending);
                    if (node.kind !== 'object') {
                        throw new NativeAnalysisError('malformed_input', 'Expected a JSON object record.');
                    }
                    for (const [key] of node.entries) {
                        this.keys.add(key);
                    }
                    if (node.entries.length > FAST_PREVIEW_MAX_COLUMNS || this.keys.size > FAST_PREVIEW_MAX_COLUMNS) {
                        throw new LimitExceededError('JSON schema exceeds the sample preview column limit.');
                    }
                    this.rows.push(node.entries);
                    this.pending = '';
                    this.phase = 'separator';
                }
            }
        }
    }

    end(): void {
        if (this.pending || (this.mode === 'array' && !this.done)) {
            throw new NativeAnalysisError('malformed_input', 'Incomplete JSON record in the sample.');
        }
    }

    result(): { metadata: Partial<FileMetadata>; rows: SampleValue[][] } {
        const metadata = buildJsonResult(this.rows, this.mode ?? 'object', null, true);
        const keys = (metadata.schema ?? []).map(([key]) => key);
        return {
            metadata,
            rows: this.rows.map((row) => {
                const fields = new Map(row);
                return keys.map((key) => jsonSafe(fields.get(key) ?? null));
            }),
        };
    }
}

class TextSample implements SampleParser {
    private readonly rows: SampleValue[][] = [];
    private pending = '';
    private skipLineFeed = false;

    constructor(private readonly limit: number) {}

    get logicalRows(): number {
        return this.rows.length;
    }

    get done(): boolean {
        return this.rows.length >= this.limit;
    }

    push(text: string): void {
        for (let index = 0; index < text.length && !this.done; index += 1) {
            const char = text[index];
            if (this.skipLineFeed) {
                this.skipLineFeed = false;
                if (char === '\n') {
                    continue;
                }
            }
            if (char === '\n' || char === '\r') {
                this.rows.push([this.pending]);
                this.pending = '';
                this.skipLineFeed = char === '\r';
            } else {
                this.pending += char;
                if (this.pending.length > FAST_PREVIEW_MAX_RECORD_CHARS) {
                    throw new LimitExceededError('A text line exceeds the sample preview limit.');
                }
            }
        }
    }

    end(): void {
        if (this.pending && !this.done) {
            this.rows.push([this.pending]);
            this.pending = '';
        }
    }

    result(): { metadata: Partial<FileMetadata>; rows: SampleValue[][] } {
        return {
            metadata: {
                schema: [['line', 'object']],
                column_count: 1,
                schema_sample_size: this.rows.length,
                nullable_columns: ['line'],
                nullability_inference: 'conservative',
                max_string_lengths: {},
            },
            rows: this.rows,
        };
    }
}

export function isTextPreviewType(fileType: FileType): boolean {
    return fileType === 'csv' || fileType === 'json' || fileType === 'text';
}

/**
 * Read once, including sniffing. None of these sample-only ceilings change the
 * existing complete analyzers or their final previews.
 */
export async function boundedTextPreview(
    reference: StorageReference,
    fileType: FileType,
    maxRows: number,
    token?: CancellationToken,
): Promise<AnalysisPreview> {
    throwIfCancelled(token);
    const rowLimit = Math.min(clampPreviewRows(maxRows), FAST_PREVIEW_MAX_ROWS);
    const sample: PreviewSample = {
        bytes_read: 0,
        logical_rows: 0,
        byte_limit: FAST_PREVIEW_MAX_BYTES,
        row_limit: rowLimit,
        record_char_limit: FAST_PREVIEW_MAX_RECORD_CHARS,
        column_limit: FAST_PREVIEW_MAX_COLUMNS,
        stopped_by: 'end',
    };
    const handle = await fs.promises.open(reference.realPath, 'r');
    let metadata: FileMetadata;
    let parser: SampleParser | undefined;
    let failure: string | undefined;
    try {
        const buffer = Buffer.allocUnsafe(ENCODING_DETECTION_BYTES);
        const first = await handle.read(buffer, 0, Math.min(buffer.length, reference.sizeBytes), 0);
        sample.bytes_read = first.bytesRead;
        throwIfCancelled(token);
        const detection = detectEncodingFromBuffer(buffer.subarray(0, first.bytesRead));
        metadata = baseMetadata(reference, fileType, detection.encoding, detection.confidence);
        const encoding = detection.encoding;
        const decoder = iconv.getDecoder(toIconvName(encoding === 'ascii' ? 'utf-8' : encoding) as iconv.Encoding);
        let text = decoder.write(buffer.subarray(0, first.bytesRead)).replace(/^\uFEFF/, '');
        try {
            parser = fileType === 'csv'
                ? new DelimitedSample(text, reference.realPath, rowLimit)
                : fileType === 'json'
                    ? new JsonSample(rowLimit, reference.realPath)
                    : new TextSample(rowLimit);
            for (;;) {
                throwIfCancelled(token);
                parser.push(text);
                if (parser.done) {
                    sample.stopped_by = parser.complete ? 'end' : 'rows';
                    break;
                }
                if (sample.bytes_read >= reference.sizeBytes) {
                    const tail = decoder.end();
                    if (tail) {
                        parser.push(tail);
                    }
                    parser.end();
                    break;
                }
                const budget = Math.min(
                    FAST_PREVIEW_CHUNK_BYTES,
                    FAST_PREVIEW_MAX_BYTES - sample.bytes_read,
                    reference.sizeBytes - sample.bytes_read,
                );
                if (budget <= 0) {
                    sample.stopped_by = 'bytes';
                    break;
                }
                const read = await handle.read(buffer, 0, budget, sample.bytes_read);
                if (read.bytesRead === 0) {
                    throw new NativeAnalysisError('file_changed', 'The file changed while reading a sample. Select it again to retry.');
                }
                sample.bytes_read += read.bytesRead;
                text = decoder.write(buffer.subarray(0, read.bytesRead));
            }
        } catch (error) {
            if (error instanceof NativeAnalysisError && (error.code === 'cancelled' || error.code === 'file_changed')) {
                throw error;
            }
            failure = error instanceof Error ? error.message : String(error);
            sample.stopped_by = error instanceof LimitExceededError ? 'record_limit' : 'error';
        }
    } finally {
        await handle.close();
    }
    throwIfCancelled(token);
    const result = parser?.result() ?? { metadata: {}, rows: [] };
    sample.logical_rows = parser?.logicalRows ?? 0;
    if (!failure && result.rows.length === 0 && sample.stopped_by !== 'end') {
        failure = 'No complete data record fit within the sample preview limits.';
    }
    Object.assign(metadata, result.metadata, {
        analysis_stage: 'provisional',
        schema_inference: 'sampled',
        row_count: null,
        row_count_lower_bound: result.rows.length,
        analysis_truncated: true,
        preview_sample: sample,
        sample_rows: result.rows.slice(0, SAMPLE_ROW_COUNT),
        warning: 'Sample preview only; schema and total row count are not verified. Full analysis is required before using generated SQL.',
        ...(failure ? { error: failure } : {}),
    });
    const columns = (result.metadata.schema ?? []).map(([name, type]) => ({
        name,
        type,
    }));
    return {
        metadata,
        preview: {
            columns,
            rows: result.rows,
            total_rows: null,
            truncated: true,
            ...(failure ? { error: failure } : {}),
        },
    };
}
