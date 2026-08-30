/**
 * JSON, NDJSON and JSON-Lines analysis.
 *
 * The shape of a document is decided from a bounded prefix, NDJSON is streamed
 * line by line so only the schema sample is retained, and an oversized JSON
 * array is sampled by decoding values one at a time from a bounded prefix
 * rather than parsing the whole document.
 */

import * as path from 'path';

import { throwIfCancelled, type CancellationToken } from '../cancellation';
import { bytesPerUnit, detectEncoding } from '../encoding';
import {
    CANCELLATION_POLL_INTERVAL,
    CSV_SAMPLE_SIZE,
    JSON_FULL_PARSE_MAX_BYTES,
    JSON_SAMPLE_MAX_CHARS,
    JSON_SCHEMA_SAMPLE_ROWS,
    MAX_NDJSON_LINE_BYTES,
} from '../limits';
import { readDecodedPrefix, readLines } from '../streams';
import type { FileMetadata, JsonNestingKind, SampleValue, SchemaField } from '../types';
import { sizeSampledString } from './csv';
import {
    parseJson,
    pythonRepr,
    rawDecode,
    type JsonNode,
} from './jsonValue';

/** An object row: the entries of a JSON object, in document order. */
type ObjectRow = Array<[string, JsonNode]>;

function asObjectRow(node: JsonNode): ObjectRow | null {
    return node.kind === 'object' ? node.entries : null;
}

function lookup(row: ObjectRow, key: string): JsonNode | undefined {
    for (const [candidate, value] of row) {
        if (candidate === key) {
            return value;
        }
    }
    return undefined;
}

/** Python `type(...).__name__` for a scalar JSON value. */
function scalarTypeName(node: JsonNode | null): string {
    if (node === null) {
        return 'str';
    }
    switch (node.kind) {
        case 'bool':
            return 'bool';
        case 'int':
            return 'int';
        case 'float':
            return 'float';
        case 'string':
            return 'str';
        default:
            return 'str';
    }
}

/** `_json_safe` applied to a node: containers collapse to their Python `str()`. */
function jsonSafe(node: JsonNode | null): SampleValue {
    if (node === null || node.kind === 'null') {
        return null;
    }
    switch (node.kind) {
        case 'bool':
            return node.value;
        case 'int':
        case 'float':
            return Number.isFinite(node.value) ? node.value : null;
        case 'string':
            return node.value;
        default:
            return pythonRepr(node);
    }
}

/**
 * Build the metadata block shared by every JSON shape, mirroring the Python
 * `_build_json_result` helper one level deep.
 */
export function buildJsonResult(
    rows: ObjectRow[],
    jsonFormat: 'array' | 'ndjson' | 'object',
    rowCount: number | null,
    sampled: boolean,
): Partial<FileMetadata> {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        for (const [key] of row) {
            if (!seen.has(key)) {
                seen.add(key);
                keys.push(key);
            }
        }
    }

    const schema: SchemaField[] = [];
    const nesting: Record<string, JsonNestingKind> = {};
    const sampleValues: Record<string, SampleValue> = {};
    const observed: Record<string, number> = {};

    for (const key of keys) {
        let effective: JsonNode | null = null;
        for (const row of rows) {
            const value = lookup(row, key);
            if (value !== undefined && value.kind !== 'null' && effective === null) {
                effective = value;
            }
        }

        if (effective !== null && effective.kind === 'object') {
            nesting[key] = 'object';
            schema.push([key, 'dict']);
        } else if (effective !== null && effective.kind === 'array') {
            nesting[key] = 'array';
            schema.push([key, 'list']);
        } else {
            nesting[key] = 'scalar';
            schema.push([key, scalarTypeName(effective)]);
            let maxLength: number | null = null;
            for (const row of rows) {
                const value = lookup(row, key);
                if (value !== undefined && value.kind === 'string') {
                    maxLength = Math.max(maxLength ?? 0, value.value.length);
                }
            }
            if (maxLength !== null) {
                observed[key] = maxLength;
            }
        }

        sampleValues[key] = jsonSafe(effective);
    }

    const maxLengths: Record<string, number> = {};
    for (const [key, length] of Object.entries(observed)) {
        maxLengths[key] = sizeSampledString(length);
    }

    return {
        schema,
        row_count: rowCount === null && !sampled ? rows.length : rowCount,
        column_count: schema.length,
        has_header: true,
        json_format: jsonFormat,
        json_nesting: nesting,
        json_sample_values: sampleValues,
        nullable_columns: keys,
        nullability_inference: 'conservative',
        schema_inference: sampled ? 'sampled' : 'full',
        schema_sample_size: rows.length,
        observed_max_string_lengths: observed,
        max_string_lengths: maxLengths,
    };
}

/** Read the first non-whitespace character from a bounded prefix. */
async function firstJsonCharacter(
    filePath: string,
    encoding: string,
    token?: CancellationToken,
): Promise<string> {
    const prefix = await readDecodedPrefix(
        filePath,
        CSV_SAMPLE_SIZE * bytesPerUnit(encoding),
        encoding,
        token,
    );
    const stripped = prefix.replace(/^[\uFEFF \t\r\n]+/, '');
    return stripped.length > 0 ? stripped[0] : '';
}

/** Stream an NDJSON candidate, keeping only a bounded schema sample. */
async function analyzeNdjsonCandidate(
    filePath: string,
    encoding: string,
    explicitNdjson: boolean,
    token?: CancellationToken,
): Promise<Partial<FileMetadata> | null> {
    const rows: ObjectRow[] = [];
    let rowCount = 0;
    let invalidLines = 0;
    let processed = 0;

    for await (const rawLine of readLines(filePath, {
        encoding,
        token,
        maxLineChars: MAX_NDJSON_LINE_BYTES,
    })) {
        processed += 1;
        if ((processed % CANCELLATION_POLL_INTERVAL) === 0) {
            throwIfCancelled(token);
        }
        const line = rawLine.trim();
        if (line.length === 0) {
            continue;
        }
        let node: JsonNode;
        try {
            node = parseJson(line);
        } catch {
            invalidLines += 1;
            if (!explicitNdjson) {
                return null;
            }
            continue;
        }
        const row = asObjectRow(node);
        if (row === null) {
            return null;
        }
        rowCount += 1;
        if (rows.length < JSON_SCHEMA_SAMPLE_ROWS) {
            rows.push(row);
        }
    }

    if (rows.length === 0) {
        return null;
    }
    if (rowCount === 1 && !explicitNdjson) {
        return buildJsonResult(rows, 'object', 1, false);
    }

    const result = buildJsonResult(rows, 'ndjson', rowCount, rowCount > rows.length);
    if (invalidLines > 0) {
        result.warning =
            `Skipped ${invalidLines} invalid NDJSON line${invalidLines === 1 ? '' : 's'}.`;
    }
    return result;
}

/** Decode a bounded prefix of a JSON array without reading the whole file. */
async function readJsonArraySample(
    filePath: string,
    encoding: string,
    maxRows: number,
    token?: CancellationToken,
): Promise<ObjectRow[]> {
    const text = (
        await readDecodedPrefix(
            filePath,
            JSON_SAMPLE_MAX_CHARS * bytesPerUnit(encoding),
            encoding,
            token,
        )
    ).replace(/^[\uFEFF \t\r\n]+/, '');
    if (!text.startsWith('[')) {
        return [];
    }
    const rows: ObjectRow[] = [];
    let index = 1;
    while (rows.length < maxRows) {
        throwIfCancelled(token);
        while (index < text.length && ' \t\r\n,'.includes(text[index])) {
            index += 1;
        }
        if (index >= text.length || text[index] === ']') {
            break;
        }
        let decoded: { node: JsonNode; next: number; };
        try {
            decoded = rawDecode(text, index);
        } catch {
            break;
        }
        const row = asObjectRow(decoded.node);
        if (row === null) {
            return [];
        }
        rows.push(row);
        index = decoded.next;
    }
    return rows;
}

/** Options accepted by {@link analyzeJson}. */
export interface JsonAnalysisOptions {
    encoding?: string;
    token?: CancellationToken;
}

/** Analyse a JSON, JSONL or NDJSON document. */
export async function analyzeJson(
    filePath: string,
    fileSize: number,
    options: JsonAnalysisOptions = {},
): Promise<Partial<FileMetadata>> {
    const encoding = options.encoding ?? (await detectEncoding(filePath)).encoding;
    const token = options.token;

    const firstChar = await firstJsonCharacter(filePath, encoding, token);
    const suffix = path.extname(filePath).toLowerCase();
    const explicitNdjson = suffix === '.jsonl' || suffix === '.ndjson';

    if (firstChar === '{' || explicitNdjson) {
        const ndjson = await analyzeNdjsonCandidate(filePath, encoding, explicitNdjson, token);
        if (ndjson !== null) {
            return ndjson;
        }
    }

    if (fileSize > JSON_FULL_PARSE_MAX_BYTES) {
        if (firstChar === '[') {
            const rows = await readJsonArraySample(
                filePath,
                encoding,
                JSON_SCHEMA_SAMPLE_ROWS,
                token,
            );
            if (rows.length > 0) {
                const result = buildJsonResult(rows, 'array', null, true);
                result.analysis_truncated = true;
                result.warning =
                    'JSON array exceeds the full-parse limit; ' +
                    'schema was inferred from a bounded prefix.';
                return result;
            }
        }
        return {
            error:
                'JSON document exceeds the ' +
                `${JSON_FULL_PARSE_MAX_BYTES}-byte full-parse limit`,
            analysis_truncated: true,
        };
    }

    const text = await readDecodedPrefix(
        filePath,
        JSON_FULL_PARSE_MAX_BYTES,
        encoding,
        token,
    );
    let document: JsonNode;
    try {
        document = parseJson(text);
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }

    if (document.kind === 'array') {
        const objectRows: ObjectRow[] = [];
        for (const item of document.items.slice(0, JSON_SCHEMA_SAMPLE_ROWS)) {
            const row = asObjectRow(item);
            if (row !== null) {
                objectRows.push(row);
            }
        }
        if (objectRows.length > 0) {
            return buildJsonResult(
                objectRows,
                'array',
                document.items.length,
                document.items.length > objectRows.length,
            );
        }
        return {};
    }

    if (document.kind === 'object') {
        return buildJsonResult([document.entries], 'object', 1, false);
    }

    return {};
}

/** Bounded row extraction for the preview surface. */
export async function previewJsonRows(
    filePath: string,
    fileSize: number,
    maxRows: number,
    encoding: string,
    token?: CancellationToken,
): Promise<{ columns: string[]; rows: SampleValue[][]; }> {
    const suffix = path.extname(filePath).toLowerCase();
    const explicitNdjson = suffix === '.jsonl' || suffix === '.ndjson';
    const firstChar = await firstJsonCharacter(filePath, encoding, token);
    const rows: ObjectRow[] = [];

    if (firstChar === '{' || explicitNdjson) {
        for await (const rawLine of readLines(filePath, {
            encoding,
            token,
            maxLineChars: MAX_NDJSON_LINE_BYTES,
        })) {
            if (rows.length >= maxRows) {
                break;
            }
            const line = rawLine.trim();
            if (line.length === 0) {
                continue;
            }
            try {
                const row = asObjectRow(parseJson(line));
                if (row !== null) {
                    rows.push(row);
                }
            } catch {
                continue;
            }
        }
    }

    if (rows.length === 0) {
        if (fileSize > JSON_FULL_PARSE_MAX_BYTES) {
            rows.push(...(await readJsonArraySample(filePath, encoding, maxRows, token)));
        } else {
            const text = await readDecodedPrefix(
                filePath,
                JSON_FULL_PARSE_MAX_BYTES,
                encoding,
                token,
            );
            const document = parseJson(text);
            if (document.kind === 'array') {
                for (const item of document.items.slice(0, maxRows)) {
                    const row = asObjectRow(item);
                    if (row !== null) {
                        rows.push(row);
                    }
                }
            } else if (document.kind === 'object') {
                rows.push(document.entries);
            }
        }
    }

    const columns: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        for (const [key] of row) {
            if (!seen.has(key)) {
                seen.add(key);
                columns.push(key);
            }
        }
    }

    const tabular = rows.map((row) =>
        columns.map((column) => jsonSafe(lookup(row, column) ?? null)),
    );
    return { columns, rows: tabular };
}
