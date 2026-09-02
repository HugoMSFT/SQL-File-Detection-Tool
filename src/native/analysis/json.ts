/**
 * JSON, NDJSON and JSON-Lines analysis.
 *
 * Complete documents and NDJSON streams aggregate field evidence across every
 * row at constant schema memory. Oversized JSON arrays are sampled by decoding
 * values one at a time from a bounded prefix rather than parsing the whole
 * document.
 */

import * as path from 'path';

import { throwIfCancelled, type CancellationToken } from '../cancellation';
import { bytesPerUnit, detectEncoding } from '../encoding';
import {
    CANCELLATION_POLL_INTERVAL,
    CSV_SAMPLE_SIZE,
    JSON_FULL_PARSE_MAX_BYTES,
    JSON_SCHEMA_MAX_COLUMNS,
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
import {
    exactNumericSample,
    NumericColumnAccumulator,
} from './numeric';

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
            return exactNumericSample(node.raw);
        case 'string':
            return node.value;
        default:
            return pythonRepr(node);
    }
}

type JsonValueFamily = 'boolean' | 'numeric' | 'string' | 'object' | 'array';

interface JsonFieldEvidence {
    readonly families: Set<JsonValueFamily>;
    readonly numeric: NumericColumnAccumulator;
    first: JsonNode | null;
    maxStringLength: number | null;
    rejectedNumeric: boolean;
}

class JsonSchemaAccumulator {
    private readonly keys: string[] = [];
    private readonly fields = new Map<string, JsonFieldEvidence>();
    private rowCount = 0;
    private schemaTruncated = false;

    public add(row: ObjectRow): void {
        this.rowCount += 1;
        for (const [key, value] of row) {
            let evidence = this.fields.get(key);
            if (!evidence) {
                if (this.fields.size >= JSON_SCHEMA_MAX_COLUMNS) {
                    this.schemaTruncated = true;
                    continue;
                }
                evidence = {
                    families: new Set<JsonValueFamily>(),
                    numeric: new NumericColumnAccumulator(),
                    first: null,
                    maxStringLength: null,
                    rejectedNumeric: false,
                };
                this.fields.set(key, evidence);
                this.keys.push(key);
            }
            if (value.kind === 'null') {
                continue;
            }
            evidence.first ??= value;
            switch (value.kind) {
                case 'bool':
                    evidence.families.add('boolean');
                    break;
                case 'int':
                case 'float':
                    evidence.families.add('numeric');
                    if (!evidence.numeric.add(value.raw)) {
                        evidence.rejectedNumeric = true;
                    }
                    break;
                case 'string':
                    evidence.families.add('string');
                    evidence.maxStringLength = Math.max(
                        evidence.maxStringLength ?? 0,
                        value.value.length,
                    );
                    break;
                case 'object':
                    evidence.families.add('object');
                    break;
                case 'array':
                    evidence.families.add('array');
                    break;
                default:
                    break;
            }
        }
    }

    public build(
        jsonFormat: 'array' | 'ndjson' | 'object',
        rowCount: number | null,
        sampled: boolean,
    ): Partial<FileMetadata> {
        const schema: SchemaField[] = [];
        const nesting: Record<string, JsonNestingKind> = {};
        const sampleValues: Record<string, SampleValue> = {};
        const observed: Record<string, number> = {};
        const maxLengths: Record<string, number> = {};
        const inferenceSampled = sampled || this.schemaTruncated;
        let typedProjectionSafe = !inferenceSampled;

        for (const key of this.keys) {
            const evidence = this.fields.get(key)!;
            const families = [...evidence.families];
            if (families.length === 1 && families[0] === 'object') {
                nesting[key] = 'object';
                schema.push([key, 'dict']);
            } else if (families.length === 1 && families[0] === 'array') {
                nesting[key] = 'array';
                schema.push([key, 'list']);
            } else if (families.length === 1 && families[0] === 'boolean') {
                nesting[key] = 'scalar';
                schema.push([key, 'bool']);
            } else if (families.length === 1 && families[0] === 'numeric') {
                nesting[key] = 'scalar';
                schema.push([
                    key,
                    evidence.rejectedNumeric
                        ? 'str'
                        : evidence.numeric.detectedType() ?? 'str',
                ]);
                if (evidence.rejectedNumeric) {
                    typedProjectionSafe = false;
                }
            } else if (families.length === 1 && families[0] === 'string') {
                nesting[key] = 'scalar';
                schema.push([key, 'str']);
                if (evidence.maxStringLength !== null) {
                    observed[key] = evidence.maxStringLength;
                    if (!inferenceSampled) {
                        maxLengths[key] = sizeSampledString(evidence.maxStringLength);
                    }
                }
            } else {
                nesting[key] = 'scalar';
                schema.push([key, 'str']);
                if (families.length > 1) {
                    typedProjectionSafe = false;
                }
            }
            sampleValues[key] = jsonSafe(evidence.first);
        }

        const result: Partial<FileMetadata> = {
            schema,
            row_count: rowCount === null && !inferenceSampled ? this.rowCount : rowCount,
            column_count: schema.length,
            has_header: true,
            json_format: jsonFormat,
            json_nesting: nesting,
            json_sample_values: sampleValues,
            json_typed_projection_safe: typedProjectionSafe,
            nullable_columns: this.keys.slice(),
            nullability_inference: 'conservative',
            schema_inference: inferenceSampled ? 'sampled' : 'full',
            schema_sample_size: this.rowCount,
            observed_max_string_lengths: observed,
            max_string_lengths: maxLengths,
        };
        if (this.schemaTruncated) {
            result.analysis_truncated = true;
            result.warning =
                `JSON schema inference retained the first ${JSON_SCHEMA_MAX_COLUMNS.toLocaleString('en-US')} ` +
                'distinct keys. Additional keys were not retained; generated SQL uses ' +
                'preservation-oriented types until the source shape is normalized.';
        }
        return result;
    }
}

function appendWarning(result: Partial<FileMetadata>, warning: string): void {
    result.warning = result.warning ? `${result.warning} ${warning}` : warning;
}

/**
 * Build the metadata block shared by every JSON shape.
 */
export function buildJsonResult(
    rows: ObjectRow[],
    jsonFormat: 'array' | 'ndjson' | 'object',
    rowCount: number | null,
    sampled: boolean,
): Partial<FileMetadata> {
    const accumulator = new JsonSchemaAccumulator();
    for (const row of rows) {
        accumulator.add(row);
    }
    return accumulator.build(jsonFormat, rowCount, sampled);
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

/** Stream an NDJSON candidate, aggregating its schema at constant memory. */
async function analyzeNdjsonCandidate(
    filePath: string,
    encoding: string,
    explicitNdjson: boolean,
    token?: CancellationToken,
): Promise<Partial<FileMetadata> | null> {
    const accumulator = new JsonSchemaAccumulator();
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
        accumulator.add(row);
    }

    if (rowCount === 0) {
        return null;
    }
    if (rowCount === 1 && !explicitNdjson) {
        return accumulator.build('object', 1, false);
    }

    const result = accumulator.build('ndjson', rowCount, false);
    if (invalidLines > 0) {
        appendWarning(
            result,
            `Skipped ${invalidLines} invalid NDJSON line${invalidLines === 1 ? '' : 's'}.`,
        );
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
                appendWarning(
                    result,
                    'JSON array exceeds the full-parse limit; ' +
                    'schema was inferred from a bounded prefix.',
                );
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
        for (const item of document.items) {
            const row = asObjectRow(item);
            if (row !== null) {
                objectRows.push(row);
            }
        }
        if (objectRows.length > 0) {
            const sampled = document.items.length !== objectRows.length;
            const result = buildJsonResult(
                objectRows,
                'array',
                document.items.length,
                sampled,
            );
            if (sampled) {
                appendWarning(
                    result,
                    'The JSON array mixes object rows with other values. Generated SQL ' +
                    'uses preservation-oriented types until the shape is normalized.',
                );
            }
            return result;
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
