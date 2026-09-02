/**
 * A JSON parser that preserves the distinctions Python's `json` module keeps.
 *
 * Two of them matter for parity:
 *
 *   * `int` versus `float` — `1` and `1.0` are indistinguishable once they
 *     become a JavaScript `number`, but Python renders them differently inside
 *     the nested-value samples the detector reports.
 *   * key insertion order — reproduced by keeping entries in an array.
 *
 * The parser is incremental in the sense that it decodes a value starting at an
 * arbitrary index and reports where it stopped, mirroring
 * `json.JSONDecoder.raw_decode`, which is what makes bounded array sampling
 * possible without reading the whole document.
 */

import { NativeAnalysisError } from '../errors';
import { exactNumericSample, MAX_NUMERIC_TOKEN_CHARS } from './numeric';

/** A parsed JSON value with its original numeric flavour retained. */
export type JsonNode =
    | { kind: 'null'; }
    | { kind: 'bool'; value: boolean; }
    | { kind: 'int'; value: number; raw: string; }
    | { kind: 'float'; value: number; raw: string; }
    | { kind: 'string'; value: string; }
    | { kind: 'array'; items: JsonNode[]; }
    | { kind: 'object'; entries: Array<[string, JsonNode]>; };

/** Thrown when the document is not valid JSON. */
export class JsonSyntaxError extends NativeAnalysisError {
    constructor(message: string, public readonly index: number) {
        super('malformed_input', message);
        this.name = 'JsonSyntaxError';
    }
}

const WHITESPACE = new Set([' ', '\t', '\r', '\n']);

function skipWhitespace(text: string, index: number): number {
    let i = index;
    while (i < text.length && WHITESPACE.has(text[i])) {
        i += 1;
    }
    return i;
}

function parseString(text: string, index: number): { value: string; next: number; } {
    // `index` points at the opening quote.
    let i = index + 1;
    let out = '';
    while (i < text.length) {
        const char = text[i];
        if (char === '"') {
            return { value: out, next: i + 1 };
        }
        if (char === '\\') {
            const escape = text[i + 1];
            switch (escape) {
                case '"': out += '"'; i += 2; break;
                case '\\': out += '\\'; i += 2; break;
                case '/': out += '/'; i += 2; break;
                case 'b': out += '\b'; i += 2; break;
                case 'f': out += '\f'; i += 2; break;
                case 'n': out += '\n'; i += 2; break;
                case 'r': out += '\r'; i += 2; break;
                case 't': out += '\t'; i += 2; break;
                case 'u': {
                    const hex = text.slice(i + 2, i + 6);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                        throw new JsonSyntaxError('Invalid \\u escape', i);
                    }
                    out += String.fromCharCode(parseInt(hex, 16));
                    i += 6;
                    break;
                }
                default:
                    throw new JsonSyntaxError('Invalid escape sequence', i);
            }
            continue;
        }
        out += char;
        i += 1;
    }
    throw new JsonSyntaxError('Unterminated string', index);
}

const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/;

/** Deepest nesting accepted, guarding against stack exhaustion. */
export const MAX_JSON_DEPTH = 200;

/** Decode one JSON value beginning at `index`. */
export function rawDecode(text: string, index = 0, depth = 0): { node: JsonNode; next: number; } {
    if (depth > MAX_JSON_DEPTH) {
        throw new JsonSyntaxError('JSON nesting is too deep', index);
    }
    const start = skipWhitespace(text, index);
    if (start >= text.length) {
        throw new JsonSyntaxError('Unexpected end of JSON input', start);
    }
    const char = text[start];

    if (char === '{') {
        const entries: Array<[string, JsonNode]> = [];
        let i = skipWhitespace(text, start + 1);
        if (text[i] === '}') {
            return { node: { kind: 'object', entries }, next: i + 1 };
        }
        for (;;) {
            i = skipWhitespace(text, i);
            if (text[i] !== '"') {
                throw new JsonSyntaxError('Expected an object key', i);
            }
            const key = parseString(text, i);
            i = skipWhitespace(text, key.next);
            if (text[i] !== ':') {
                throw new JsonSyntaxError('Expected ":" after an object key', i);
            }
            const value = rawDecode(text, i + 1, depth + 1);
            entries.push([key.value, value.node]);
            i = skipWhitespace(text, value.next);
            if (text[i] === ',') {
                i += 1;
                continue;
            }
            if (text[i] === '}') {
                return { node: { kind: 'object', entries }, next: i + 1 };
            }
            throw new JsonSyntaxError('Expected "," or "}" in object', i);
        }
    }

    if (char === '[') {
        const items: JsonNode[] = [];
        let i = skipWhitespace(text, start + 1);
        if (text[i] === ']') {
            return { node: { kind: 'array', items }, next: i + 1 };
        }
        for (;;) {
            const value = rawDecode(text, i, depth + 1);
            items.push(value.node);
            i = skipWhitespace(text, value.next);
            if (text[i] === ',') {
                i += 1;
                continue;
            }
            if (text[i] === ']') {
                return { node: { kind: 'array', items }, next: i + 1 };
            }
            throw new JsonSyntaxError('Expected "," or "]" in array', i);
        }
    }

    if (char === '"') {
        const parsed = parseString(text, start);
        return { node: { kind: 'string', value: parsed.value }, next: parsed.next };
    }

    if (text.startsWith('true', start)) {
        return { node: { kind: 'bool', value: true }, next: start + 4 };
    }
    if (text.startsWith('false', start)) {
        return { node: { kind: 'bool', value: false }, next: start + 5 };
    }
    if (text.startsWith('null', start)) {
        return { node: { kind: 'null' }, next: start + 4 };
    }

    const match = NUMBER_PATTERN.exec(text.slice(start));
    if (match) {
        const raw = match[0];
        const value = raw.length <= MAX_NUMERIC_TOKEN_CHARS ? Number(raw) : Number.NaN;
        const isFloat = Boolean(match[1] || match[2]);
        return {
            node: isFloat ? { kind: 'float', value, raw } : { kind: 'int', value, raw },
            next: start + raw.length,
        };
    }

    throw new JsonSyntaxError('Unexpected token in JSON', start);
}

/** Decode a complete JSON document, rejecting trailing content. */
export function parseJson(text: string): JsonNode {
    const { node, next } = rawDecode(text, 0);
    const end = skipWhitespace(text, next);
    if (end !== text.length) {
        throw new JsonSyntaxError('Extra data after JSON document', end);
    }
    return node;
}

/** Convert a node into a plain JavaScript value. */
export function toPlain(node: JsonNode): unknown {
    switch (node.kind) {
        case 'null':
            return null;
        case 'bool':
            return node.value;
        case 'int':
        case 'float':
            return node.value;
        case 'string':
            return node.value;
        case 'array':
            return node.items.map(toPlain);
        case 'object': {
            const out: Record<string, unknown> = {};
            for (const [key, value] of node.entries) {
                out[key] = toPlain(value);
            }
            return out;
        }
        default:
            return null;
    }
}

/** Render a float the way CPython's `repr` does. */
export function pythonFloatRepr(value: number): string {
    if (Number.isNaN(value)) {
        return 'nan';
    }
    if (!Number.isFinite(value)) {
        return value > 0 ? 'inf' : '-inf';
    }
    const magnitude = Math.abs(value);
    if (value !== 0 && (magnitude < 1e-4 || magnitude >= 1e16)) {
        let exponential = '';
        for (let precision = 0; precision <= 17; precision += 1) {
            exponential = value.toExponential(precision);
            if (Number(exponential) === value) {
                break;
            }
        }
        // CPython pads the exponent to at least two digits.
        return exponential.replace(/e([+-])(\d)$/, 'e$10$2');
    }
    const rendered = String(value);
    return rendered.includes('.') || rendered.includes('e') ? rendered : `${rendered}.0`;
}

const PYTHON_STRING_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
    '\\': '\\\\',
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
});

/** Render a string the way CPython's `repr` does. */
export function pythonStringRepr(value: string): string {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    let out = quote;
    for (const char of value) {
        const escape = PYTHON_STRING_ESCAPES[char];
        if (escape) {
            out += escape;
            continue;
        }
        if (char === quote) {
            out += `\\${char}`;
            continue;
        }
        const code = char.codePointAt(0) ?? 0;
        // Everything a client might read as a line terminator is escaped, not
        // just the C0 range CPython escapes. U+0085, U+2028 and U+2029 end a
        // line for `str.splitlines()` and for sqlcmd, so leaving them literal
        // would let a value break out of the single line its caller assumes it
        // occupies. Today every caller wraps the result in `sqlComment()`,
        // which already collapses them; escaping here means a future caller
        // that forgets cannot reintroduce the vector.
        if (code < 0x20 || code === 0x7f || code === 0x85) {
            out += `\\x${code.toString(16).padStart(2, '0')}`;
            continue;
        }
        if (code === 0x2028 || code === 0x2029) {
            out += `\\u${code.toString(16).padStart(4, '0')}`;
            continue;
        }
        out += char;
    }
    return out + quote;
}

/**
 * Render a node the way `str()` renders the equivalent Python object, which is
 * how the Python detector stores nested JSON sample values.
 */
export function pythonRepr(node: JsonNode): string {
    switch (node.kind) {
        case 'null':
            return 'None';
        case 'bool':
            return node.value ? 'True' : 'False';
        case 'int':
            return node.raw.replace(/^\+/, '');
        case 'float': {
            const exact = exactNumericSample(node.raw);
            return typeof exact === 'string' ? exact : pythonFloatRepr(exact);
        }
        case 'string':
            return pythonStringRepr(node.value);
        case 'array':
            return `[${node.items.map(pythonRepr).join(', ')}]`;
        case 'object':
            return `{${node.entries
                .map(([key, value]) => `${pythonStringRepr(key)}: ${pythonRepr(value)}`)
                .join(', ')}}`;
        default:
            return 'None';
    }
}
