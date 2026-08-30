/**
 * Escaping, quoting and formatting helpers for the native SQL generator.
 *
 * Every function here is a direct port of the module-level helpers in
 * `external_file_detection/sql_generator.py`. The security invariants are the
 * point of this module, so each helper keeps the Python behaviour verbatim:
 *
 *   * `escapeIdentifier` doubles `]` so a value can never terminate a
 *     bracket-quoted identifier early.
 *   * `quoteLiteral` doubles `'` so a value can never terminate a string
 *     literal early.
 *   * `sqlComment` collapses control characters (plus U+2028/U+2029) so a value
 *     can never break out of a `--` comment onto a new line.
 *   * `safeSqlType` allowlists the shape of a caller-supplied SQL type.
 *
 * Two deliberate hardenings relative to Python are documented inline: JavaScript
 * `\d` is ASCII-only, and JavaScript `$` does not match before a trailing
 * newline. Both make the allowlists strictly narrower than Python's, never
 * wider.
 */

import type { SampleValue, SchemaField } from '../types';
import { pythonFloatRepr } from '../analysis/jsonValue';

/** Characters Python's `str.strip()` treats as whitespace. */
const PY_WHITESPACE = new Set([
    '\t', '\n', '\v', '\f', '\r', ' ',
    '\x1c', '\x1d', '\x1e', '\x1f', '\x85', '\u00a0', '\u1680',
    '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006',
    '\u2007', '\u2008', '\u2009', '\u200a',
    '\u2028', '\u2029', '\u202f', '\u205f', '\u3000',
]);

/** `str.strip()` with Python's whitespace set (JS `trim()` also strips U+FEFF). */
export function pythonStrip(value: string): string {
    let start = 0;
    let end = value.length;
    while (start < end && PY_WHITESPACE.has(value[start]!)) {
        start += 1;
    }
    while (end > start && PY_WHITESPACE.has(value[end - 1]!)) {
        end -= 1;
    }
    return value.slice(start, end);
}

/**
 * Render a value the way Python's `str()` would.
 *
 * Sample values crossing the analysis boundary are JSON scalars, so only the
 * `bool`/`None`/float spellings actually differ between the two languages.
 */
export function pyStr(value: unknown): string {
    if (value === null || value === undefined) {
        return 'None';
    }
    if (typeof value === 'boolean') {
        return value ? 'True' : 'False';
    }
    if (typeof value === 'number') {
        return Number.isInteger(value) ? String(value) : pythonFloatRepr(value);
    }
    return String(value);
}

/** Truncate by Unicode code point, matching Python's `str` slicing. */
export function truncateCodePoints(value: string, limit: number): string {
    const points = Array.from(value);
    return points.length <= limit ? value : points.slice(0, limit).join('');
}

/** Length in Unicode code points, matching Python's `len()`. */
export function codePointLength(value: string): number {
    return Array.from(value).length;
}

/** Clean a name so it is a valid SQL identifier. */
export function cleanIdentifier(name: unknown): string {
    let clean = String(name).replace(/[^A-Za-z0-9_]/g, '_');
    if (clean.length > 0 && clean[0]! >= '0' && clean[0]! <= '9') {
        clean = `col_${clean}`;
    }
    return clean || 'column_1';
}

/**
 * Collapse the characters that can never appear safely in generated SQL.
 *
 * Line terminators are the important ones. `GO` is not a T-SQL keyword: it is a
 * *client-side* batch separator, so every tool that runs a script (sqlcmd, SSMS,
 * Azure Data Studio, and {@link splitGoBatches} below) splits on a line whose
 * only content is `GO`. A newline smuggled into a bracketed identifier or a
 * quoted literal would therefore cut the statement in half and let whatever
 * follows run as its own batch, even though the server-side parser accepts the
 * identifier perfectly happily.
 *
 * No legitimate identifier, path, URL, or delimiter contains a control
 * character — delimiters are rendered through {@link displayDelimiter} before
 * they reach {@link quoteLiteral} — so collapsing them to a space is lossless in
 * practice and closes the batch-injection vector at its source.
 *
 * U+0085 (NEL), U+2028 and U+2029 are included even though they are outside the
 * C0/C1 control ranges a naive filter would use: all three are line terminators
 * to some readers (Python's `str.splitlines()` among them), and a defence that
 * depends on which reader splits the script is not a defence.
 */
function collapseControlCharacters(value: string): string {
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\x00-\x1f\x7f\x85\u2028\u2029]+/g, ' ');
}

/**
 * Escape a value for safe use inside a T-SQL bracket-quoted `[identifier]`.
 *
 * Unlike {@link cleanIdentifier} the printable characters are preserved, so
 * caller-supplied names keep their intended form while remaining injection-safe.
 */
export function escapeIdentifier(name: unknown): string {
    return collapseControlCharacters(String(name)).split(']').join(']]');
}

/** Escape a value for safe use inside a T-SQL single-quoted `'string'` literal. */
export function quoteLiteral(value: unknown): string {
    return collapseControlCharacters(String(value)).split("'").join("''");
}

/** Collapse untrusted text to one line before placing it in a SQL comment. */
export function sqlComment(value: unknown): string {
    return pythonStrip(collapseControlCharacters(String(value)));
}

/** Render control delimiters visibly in generated SQL guidance. */
export function displayDelimiter(value: string): string {
    const controls: Record<string, string> = { '\t': '\\t', '\r': '\\r', '\n': '\\n' };
    let out = '';
    for (const character of value) {
        out += controls[character] ?? character;
    }
    return out;
}

/** Return the folder portion of a data-source relative path, with a slash. */
export function folderOf(relativePath: string): string {
    const normalized = String(relativePath).split('\\').join('/');
    if (!normalized.includes('/')) {
        return '';
    }
    const folder = normalized.slice(0, normalized.lastIndexOf('/'));
    return folder ? `${folder}/` : '';
}

/**
 * Split a T-SQL script on its `GO` batch separators.
 *
 * Only a line whose sole content is `GO` separates batches, and a `GO` that
 * falls inside a `'literal'`, a `[identifier]`, or a block comment is not a
 * separator at all. {@link escapeIdentifier} and {@link quoteLiteral} already
 * make it impossible to smuggle a line break into either region, so this scan is
 * defence in depth: it keeps the splitter correct even for a script this module
 * did not generate.
 */
export function splitGoBatches(script: string): string[] {
    const text = String(script);
    const batches: string[] = [];
    let current: string[] = [];
    let lineStart = 0;
    // Regions that a line break may legally sit inside, tracked across lines.
    let inLiteral = false;
    let inBracket = false;
    let blockCommentDepth = 0;

    const flush = (): void => {
        batches.push(pythonStrip(current.join('\n')));
        current = [];
    };

    const advance = (line: string): void => {
        for (let index = 0; index < line.length; index += 1) {
            const character = line[index]!;
            const next = line[index + 1];
            if (inLiteral) {
                if (character === "'") {
                    if (next === "'") {
                        index += 1;
                    } else {
                        inLiteral = false;
                    }
                }
            } else if (inBracket) {
                if (character === ']') {
                    if (next === ']') {
                        index += 1;
                    } else {
                        inBracket = false;
                    }
                }
            } else if (blockCommentDepth > 0) {
                if (character === '*' && next === '/') {
                    blockCommentDepth -= 1;
                    index += 1;
                } else if (character === '/' && next === '*') {
                    blockCommentDepth += 1;
                    index += 1;
                }
            } else if (character === '-' && next === '-') {
                return;
            } else if (character === '/' && next === '*') {
                blockCommentDepth += 1;
                index += 1;
            } else if (character === "'") {
                inLiteral = true;
            } else if (character === '[') {
                inBracket = true;
            }
        }
    };

    while (lineStart <= text.length) {
        const match = /\r\n|\r|\n/.exec(text.slice(lineStart));
        const lineEnd = match ? lineStart + match.index : text.length;
        const line = text.slice(lineStart, lineEnd);
        const separable = !inLiteral && !inBracket && blockCommentDepth === 0;
        if (separable && pythonStrip(line).toUpperCase() === 'GO') {
            flush();
        } else {
            advance(line);
            current.push(line);
        }
        if (!match) {
            break;
        }
        lineStart = lineEnd + match[0].length;
    }

    const tail = pythonStrip(current.join('\n'));
    if (tail) {
        batches.push(tail);
    }
    return batches.filter((batch) => batch.length > 0);
}

/**
 * Return the Delta table folder for a detector-resolved relative path.
 *
 * A Delta table is detected as a directory, so the resolved relative path *is*
 * the table folder and only a trailing slash has to be added. Taking the parent
 * folder would point `OPENROWSET` at sibling tables, and an empty result would
 * produce an invalid `BULK ''`.
 */
export function deltaTableFolder(relativePath: string): string {
    const normalized = stripSlashes(String(relativePath).split('\\').join('/'));
    return normalized ? `${normalized}/` : '<delta_table_folder>/';
}

function stripSlashes(value: string): string {
    let start = 0;
    let end = value.length;
    while (start < end && value[start] === '/') {
        start += 1;
    }
    while (end > start && value[end - 1] === '/') {
        end -= 1;
    }
    return value.slice(start, end);
}

/**
 * Return `[identifier, literal, credentialIdentifier]` for a bulk data source.
 *
 * The raw `<data_source>_Bulk` name is escaped once per context: bracket
 * escaping for `[identifier]` and quote doubling for `'literal'`. Escaping first
 * and reusing the result would corrupt names containing `]` or `'`.
 */
export function bulkDataSourceNames(dataSource: string): [string, string, string] {
    const raw = `${dataSource}_Bulk`;
    return [escapeIdentifier(raw), quoteLiteral(raw), escapeIdentifier(`cred_${raw}`)];
}

/** Raised when a schema contains two columns that collide under SQL collation. */
export class DuplicateColumnError extends Error {
    constructor(name: string) {
        super(`Duplicate column name: ${name}`);
        this.name = 'DuplicateColumnError';
    }
}

/** Reject duplicate column names under typical case-insensitive SQL collation. */
export function validateUniqueColumnNames(schema: readonly SchemaField[]): void {
    const seen = new Set<string>();
    for (const column of schema) {
        const name = String(column[0]);
        // `toLowerCase()` is JavaScript's closest equivalent to `str.casefold()`
        // for the identifiers SQL Server can actually store.
        const key = name.toLowerCase();
        if (seen.has(key)) {
            throw new DuplicateColumnError(name);
        }
        seen.add(key);
    }
}

const SIMPLE_JSON_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Build a safe T-SQL JSON path (`$.<key>`) for *name*.
 *
 * Simple identifiers become `$.key`. Anything else is wrapped in double quotes
 * (`$."weird key"`) as SQL Server requires, then escaped so the result is safe
 * inside a single-quoted SQL string literal.
 */
export function quoteJsonPath(name: unknown): string {
    const value = String(name);
    let path: string;
    if (SIMPLE_JSON_KEY.test(value)) {
        path = `$.${value}`;
    } else {
        const escaped = value.split('\\').join('\\\\').split('"').join('\\"');
        path = `$."${escaped}"`;
    }
    return quoteLiteral(path);
}

/**
 * Allowed shape for a SQL data type: a type name optionally followed by a
 * parenthesised length/precision such as `NVARCHAR(255)`, `DECIMAL(18,4)` or
 * `VARBINARY(MAX)`. Anything else (for example a value smuggled in through the
 * schema editor) is rejected and replaced with a safe default.
 *
 * The internal whitespace is `[ \t]`, never `\s`. The accepted candidate is
 * interpolated into DDL verbatim, so this is the one generator path that does
 * not run through {@link collapseControlCharacters}; `\s` would admit `\n`,
 * `\r`, `\v`, `\f` — and in JavaScript also U+00A0, U+2028, U+2029 and U+FEFF —
 * putting a real line break inside `CREATE TABLE`. Restricting it to space and
 * tab keeps the allowlist fail-closed and keeps it identical to the Python
 * mirror in `external_file_detection/sql_generator.py`, whose `re.ASCII` flag
 * narrows `\s` differently. Anchored with `^`/`$` and no `m` flag.
 */
const VALID_SQL_TYPE = /^[A-Za-z][A-Za-z0-9_]*[ \t]*(\([ \t]*(\d+|MAX)[ \t]*(,[ \t]*\d+[ \t]*)?\))?$/i;

/** Return *sqlType* only if it matches the allowed pattern, else *fallback*. */
export function safeSqlType(sqlType: unknown, fallback = 'NVARCHAR(MAX)'): string {
    const candidate = pythonStrip(String(sqlType));
    return VALID_SQL_TYPE.test(candidate) ? candidate : fallback;
}

/** Map a detected file type to the OPENROWSET `FORMAT` keyword. */
export function formatKeyword(fileType: string): string {
    switch (fileType) {
        case 'parquet': return 'PARQUET';
        case 'delta': return 'DELTA';
        case 'json': return 'CSV';
        case 'orc': return 'ORC';
        default: return 'CSV';
    }
}

/**
 * Format a byte count as `N.N MB` using Python's round-half-to-even.
 *
 * `toFixed` rounds ties away from zero, so a file of exactly 262 144 bytes
 * would render as `0.3 MB` in JavaScript and `0.2 MB` in Python. The exact
 * integer path below removes that class of difference entirely.
 */
export function formatMegabytes(sizeBytes: number): string {
    if (!Number.isFinite(sizeBytes)) {
        return `${sizeBytes} MB`;
    }
    if (Number.isSafeInteger(sizeBytes) && Number.isSafeInteger(sizeBytes * 10)) {
        const scaled = sizeBytes * 10;
        const divisor = 1024 * 1024;
        let quotient = Math.floor(scaled / divisor);
        const remainder = scaled - quotient * divisor;
        const half = divisor / 2;
        if (remainder > half || (remainder === half && quotient % 2 !== 0)) {
            quotient += 1;
        }
        const whole = Math.floor(quotient / 10);
        const tenth = quotient - whole * 10;
        return `${whole}.${tenth} MB`;
    }
    return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Left-align *value* in a field of *width*, matching Python's `{:<width}`. */
export function padRight(value: string, width: number): string {
    const length = codePointLength(value);
    return length >= width ? value : value + ' '.repeat(width - length);
}

/** Render a sample cell for a comment block, mirroring Python's `str()`. */
export function sampleCell(value: SampleValue | undefined): string {
    return value === null || value === undefined ? 'NULL' : pyStr(value);
}
