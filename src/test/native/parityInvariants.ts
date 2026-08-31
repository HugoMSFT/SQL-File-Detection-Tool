/**
 * Shared helpers for the Python↔TypeScript parity suite.
 *
 * `scripts/generate_parity_baselines.py` records what the current Python
 * implementation produces for the committed `demo/` fixtures. To compare
 * against it we have to reduce native output using *exactly* the same
 * normalisation, including the marker keys, which embed the original Python
 * regular-expression source text.
 *
 * The regexes below are therefore kept as (python source, JavaScript regex)
 * pairs: the source string only ever builds the marker key, and the compiled
 * JavaScript regex does the matching.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Repository root, derived from this file's compiled location in `out/`. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Absolute path to the committed Python baseline. */
export const BASELINE_PATH = path.join(
    REPO_ROOT,
    'tests',
    'native_parity',
    'python_baseline.json',
);

/** A single statement reduced to comparable structural facts. */
export interface StatementInvariants {
    markers: string[];
    columns: string[][];
    go_batches: number;
    has_sql: boolean;
}

/** Shape of the committed baseline document. */
export interface ParityBaseline {
    version: number;
    description: string;
    default_target_platform: string;
    platforms: string[];
    storage_urls: Record<string, string | null>;
    metadata: Record<string, Record<string, unknown>>;
    statements: Record<string, Record<string, StatementInvariants>>;
}

let cachedBaseline: ParityBaseline | null = null;

/** Load (and memoise) the committed Python baseline. */
export function loadBaseline(): ParityBaseline {
    if (cachedBaseline === null) {
        cachedBaseline = JSON.parse(
            fs.readFileSync(BASELINE_PATH, 'utf-8'),
        ) as ParityBaseline;
    }
    return cachedBaseline;
}

/** Resolve a repository-relative fixture path recorded in the baseline. */
export function fixturePath(relative: string): string {
    return path.join(REPO_ROOT, ...relative.split('/'));
}

interface InvariantPattern {
    /** The original Python pattern source; used verbatim in marker keys. */
    readonly source: string;
    /** The equivalent JavaScript regex, always global. */
    readonly regex: RegExp;
}

function pattern(source: string, flags: string): InvariantPattern {
    return { source, regex: new RegExp(source.replace(/\\'/g, "'"), `g${flags}`) };
}

/**
 * Mirror of `_INVARIANT_PATTERNS` in `scripts/generate_parity_baselines.py`.
 *
 * The Python sources escape single quotes (`\'`) because they are written
 * inside single-quoted raw strings. `\'` is not a valid JavaScript regex escape
 * in unicode mode, so {@link pattern} strips it for matching while the marker
 * key keeps the original text.
 */
const INVARIANT_PATTERNS: readonly InvariantPattern[] = [
    pattern(String.raw`\bCREATE\s+TABLE\s+(\[[^\]]*\]\.\[[^\]]*\])`, 'i'),
    pattern(String.raw`\bCREATE\s+EXTERNAL\s+TABLE\s+(\[[^\]]*\]\.\[[^\]]*\])`, 'i'),
    pattern(String.raw`\bCREATE\s+EXTERNAL\s+FILE\s+FORMAT\s+(\[[^\]]*\])`, 'i'),
    pattern(String.raw`\bCREATE\s+EXTERNAL\s+DATA\s+SOURCE\s+(\[[^\]]*\])`, 'i'),
    pattern(String.raw`\bCREATE\s+DATABASE\s+SCOPED\s+CREDENTIAL\s+(\[[^\]]*\])`, 'i'),
    pattern(String.raw`\bBULK\s+INSERT\s+(\[[^\]]*\]\.\[[^\]]*\])`, 'i'),
    pattern(String.raw`\bFORMAT_TYPE\s*=\s*(\w+)`, 'i'),
    pattern(String.raw`\bFORMAT\s*=\s*\'([^\']*)\'`, 'i'),
    pattern(String.raw`\bDATA_SOURCE\s*=\s*\'([^\']*)\'`, 'i'),
    pattern(String.raw`\bDATA_SOURCE\s*=\s*(\[[^\]]*\])`, 'i'),
    pattern(String.raw`\bLOCATION\s*=\s*\'([^\']*)\'`, 'i'),
    pattern(String.raw`\bBULK\s+N?\'([^\']*)\'`, 'i'),
    pattern(String.raw`\bTYPE\s*=\s*(HADOOP|BLOB_STORAGE)\b`, 'i'),
    pattern(String.raw`\bCODEPAGE\s*=\s*\'([^\']*)\'`, 'i'),
    pattern(String.raw`\bFIELDTERMINATOR\s*=\s*\'([^\']*)\'`, 'i'),
    pattern(String.raw`\bFIELD_TERMINATOR\s*=\s*\'([^\']*)\'`, 'i'),
    pattern(String.raw`\bFIRSTROW\s*=\s*(\d+)`, 'i'),
    pattern(String.raw`\bFIRST_ROW\s*=\s*(\d+)`, 'i'),
    pattern(String.raw`\bROWTERMINATOR\s*=\s*\'([^\']*)\'`, 'i'),
    pattern(String.raw`\bROW_TERMINATOR\s*=\s*\'([^\']*)\'`, 'i'),
    // USE_TYPE_DEFAULT decides whether an empty CSV field arrives as NULL or as
    // a zero, which is a semantic difference the live matrix asserts on. It is
    // exactly the kind of option a port can drop without any test noticing.
    pattern(String.raw`\bUSE_TYPE_DEFAULT\s*=\s*(TRUE|FALSE)\b`, 'i'),
    pattern(String.raw`\bSTRING_DELIMITER\s*=\s*\'([^\']*)\'`, 'i'),
    pattern(String.raw`\bFIELDQUOTE\s*=\s*\'([^\']*)\'`, 'i'),
    pattern(String.raw`\bENCODING\s*=\s*\'([^\']*)\'`, 'i'),
    pattern(String.raw`\bDATAFILETYPE\s*=\s*\'([^\']*)\'`, 'i'),
    // The credential shape is a security property: identity-based methods store
    // no secret, while SAS and S3 access-key methods require one.
    pattern(String.raw`\bIDENTITY\s*=\s*\'(MANAGED\s+IDENTITY|USER\s+IDENTITY|SHARED\s+ACCESS\s+SIGNATURE|S3\s+ACCESS\s+KEY)\'`, 'i'),
    // A live TRUNCATE in a generated document empties a table the user already
    // had. Anchored so the commented guidance form does not count as a live one.
    pattern(String.raw`^\s*TRUNCATE\s+TABLE\s+(\[[^\]]*\]\.\[[^\]]*\])`, 'im'),
    pattern(String.raw`\bREJECT_TYPE\s*=\s*(\w+)`, 'i'),
    pattern(String.raw`\bSERDE_METHOD\s*=\s*\'([^\']*)\'`, 'i'),
    pattern(String.raw`\bDATA_COMPRESSION\s*=\s*\'([^\']*)\'`, 'i'),
    pattern(String.raw`\b(SINGLE_CLOB|SINGLE_NCLOB|SINGLE_BLOB)\b`, 'i'),
    pattern(String.raw`\bNOT\s+AVAILABLE\s+on\s+(.+)$`, 'im'),
];

const COLUMN_PATTERN =
    /^\s*(\[[^\]]*\])\s+([A-Za-z][A-Za-z0-9_]*(?:\s*\([^)]*\))?)/gm;

/**
 * Python's `str.strip()` whitespace set.
 *
 * JavaScript's `String.prototype.trim` also removes U+FEFF and U+00A0, which
 * Python keeps, so a captured value containing them must not be trimmed away.
 */
const PYTHON_WHITESPACE = ' \t\n\r\v\f\u001c\u001d\u001e\u001f\u0085';

function pythonStrip(value: string): string {
    let start = 0;
    let end = value.length;
    while (start < end && PYTHON_WHITESPACE.includes(value[start])) {
        start += 1;
    }
    while (end > start && PYTHON_WHITESPACE.includes(value[end - 1])) {
        end -= 1;
    }
    return value.slice(start, end);
}

/**
 * Reduce generated T-SQL to the same structural facts the Python baseline
 * records. Mirror of `_statement_invariants`.
 */
export function statementInvariants(sql: string): StatementInvariants {
    const lines = sql.split('\n');
    const codeLines = lines.filter((line) => {
        const stripped = pythonStrip(line);
        return stripped.length > 0 && !stripped.startsWith('--');
    });
    const code = codeLines.join('\n');

    const markers: string[] = [];
    for (const { source, regex } of INVARIANT_PATTERNS) {
        regex.lastIndex = 0;
        let match = regex.exec(sql);
        while (match !== null) {
            const captured = match.length > 1 ? match[1] ?? '' : match[0];
            markers.push(`${source}=>${pythonStrip(captured)}`);
            if (match[0].length === 0) {
                regex.lastIndex += 1;
            }
            match = regex.exec(sql);
        }
    }

    const columns: string[][] = [];
    COLUMN_PATTERN.lastIndex = 0;
    let columnMatch = COLUMN_PATTERN.exec(code);
    while (columnMatch !== null) {
        columns.push([columnMatch[1], columnMatch[2].split(/\s+/).join(' ')]);
        columnMatch = COLUMN_PATTERN.exec(code);
    }

    return {
        markers,
        columns,
        go_batches: lines.filter((line) => pythonStrip(line).toUpperCase() === 'GO')
            .length,
        has_sql: codeLines.length > 0,
    };
}

/** Metadata keys the baseline deliberately omits. */
export const VOLATILE_METADATA_KEYS: ReadonlySet<string> = new Set([
    'file_path',
    'encoding_confidence',
    'encoding_warning',
]);

const VOLATILE_PARQUET_KEYS: ReadonlySet<string> = new Set(['serialized_size']);
const VOLATILE_DELTA_KEYS: ReadonlySet<string> = new Set(['created_time']);

function sortedRecord(value: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
        out[key] = value[key];
    }
    return out;
}

/**
 * Apply the baseline's metadata normalisation to a native metadata object.
 * Mirror of `_normalise_metadata`.
 */
export function normaliseMetadata(
    metadata: Record<string, unknown>,
): Record<string, unknown> {
    const normalised: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
        if (VOLATILE_METADATA_KEYS.has(key)) {
            continue;
        }
        if (key === 'schema' && Array.isArray(value) && value.length > 0) {
            normalised[key] = (value as unknown[][]).map((pair) => [
                String(pair[0]),
                String(pair[1]),
            ]);
            continue;
        }
        if (key === 'parquet_metadata' && value !== null && typeof value === 'object') {
            normalised[key] = sortedRecord(
                Object.fromEntries(
                    Object.entries(value as Record<string, unknown>).filter(
                        ([inner]) => !VOLATILE_PARQUET_KEYS.has(inner),
                    ),
                ),
            );
            continue;
        }
        if (key === 'delta_metadata' && value !== null && typeof value === 'object') {
            normalised[key] = sortedRecord(
                Object.fromEntries(
                    Object.entries(value as Record<string, unknown>).filter(
                        ([inner]) => !VOLATILE_DELTA_KEYS.has(inner),
                    ),
                ),
            );
            continue;
        }
        normalised[key] = value;
    }
    return sortedRecord(normalised);
}

/**
 * Compare two values the way the baseline needs.
 *
 * Python's JSON writer emits `12.0` where JavaScript emits `12`, so numbers are
 * compared numerically rather than structurally. Everything else falls back to
 * a deep structural comparison.
 */
export function parityEqual(actual: unknown, expected: unknown): boolean {
    if (typeof actual === 'number' && typeof expected === 'number') {
        return actual === expected || (Number.isNaN(actual) && Number.isNaN(expected));
    }
    if (Array.isArray(actual) && Array.isArray(expected)) {
        return (
            actual.length === expected.length &&
            actual.every((item, index) => parityEqual(item, expected[index]))
        );
    }
    if (
        actual !== null &&
        expected !== null &&
        typeof actual === 'object' &&
        typeof expected === 'object'
    ) {
        const left = actual as Record<string, unknown>;
        const right = expected as Record<string, unknown>;
        const leftKeys = Object.keys(left).sort();
        const rightKeys = Object.keys(right).sort();
        return (
            leftKeys.length === rightKeys.length &&
            leftKeys.every((key, index) => key === rightKeys[index]) &&
            leftKeys.every((key) => parityEqual(left[key], right[key]))
        );
    }
    return actual === expected;
}
