/**
 * Streaming delimited-text parsing and pandas-compatible column inference.
 *
 * The row parser follows CPython's `csv` module state machine (QUOTE_MINIMAL,
 * `doublequote=True`, non-strict) so that row counts and field splitting agree
 * with the Python backend, including embedded delimiters, embedded newlines,
 * doubled quotes and blank lines.
 *
 * The type inference follows pandas' C parser: a column becomes `int64` only
 * when every value parses as an integer and nothing is missing, `float64` when
 * numeric values are mixed with missing values or decimals, `bool` when every
 * value is a recognised boolean with nothing missing, and `object` otherwise.
 */

import { LimitExceededError } from '../errors';
import { MAX_COLUMNS, MAX_FIELD_CHARS } from '../limits';
import type { SampleValue } from '../types';

/** Cell values as pandas would materialise them. */
export type ParsedCell = string | number | boolean | null;

/** pandas' default set of strings treated as missing. */
export const PANDAS_NA_VALUES: ReadonlySet<string> = new Set([
    '',
    '#N/A',
    '#N/A N/A',
    '#NA',
    '-1.#IND',
    '-1.#QNAN',
    '-NaN',
    '-nan',
    '1.#IND',
    '1.#QNAN',
    '<NA>',
    'N/A',
    'NA',
    'NULL',
    'NaN',
    'None',
    'n/a',
    'nan',
    'null',
]);

const TRUE_LITERALS: ReadonlySet<string> = new Set(['True', 'TRUE', 'true']);
const FALSE_LITERALS: ReadonlySet<string> = new Set(['False', 'FALSE', 'false']);

const INTEGER_PATTERN = /^[+-]?\d+$/;
const FLOAT_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Incremental RFC 4180 / CPython-`csv` row parser. */
export class DelimitedRowParser {
    private field = '';
    private row: string[] = [];
    private inQuotes = false;
    private quotePending = false;
    private started = false;
    private skipLineFeed = false;

    constructor(
        private readonly delimiter: string,
        private readonly quoteChar: string = '"',
    ) {
        if (delimiter.length !== 1) {
            throw new Error('Delimiter must be a single character');
        }
    }

    /** Feed a decoded chunk and return every complete row it produced. */
    public push(chunk: string): string[][] {
        const rows: string[][] = [];
        for (let i = 0; i < chunk.length; i += 1) {
            const char = chunk[i];
            if (this.skipLineFeed) {
                this.skipLineFeed = false;
                if (char === '\n') {
                    continue;
                }
            }
            if (this.inQuotes) {
                if (this.quotePending) {
                    this.quotePending = false;
                    if (char === this.quoteChar) {
                        this.appendChar(char);
                        continue;
                    }
                    // Closing quote: fall through with the quoted state cleared.
                    this.inQuotes = false;
                    if (char === this.delimiter) {
                        this.endField();
                        continue;
                    }
                    if (char === '\n' || char === '\r') {
                        this.endRow(rows, char);
                        continue;
                    }
                    // Non-strict mode keeps a stray character literally.
                    this.appendChar(char);
                    continue;
                }
                if (char === this.quoteChar) {
                    this.quotePending = true;
                    continue;
                }
                this.appendChar(char);
                continue;
            }
            if (char === this.quoteChar && this.field.length === 0) {
                this.inQuotes = true;
                this.started = true;
                continue;
            }
            if (char === this.delimiter) {
                this.endField();
                continue;
            }
            if (char === '\n' || char === '\r') {
                this.endRow(rows, char);
                continue;
            }
            this.appendChar(char);
        }
        return rows;
    }

    /** Flush any partial row at end of input. */
    public end(): string[][] {
        const rows: string[][] = [];
        if (this.started || this.field.length > 0 || this.row.length > 0) {
            this.row.push(this.field);
            rows.push(this.row);
        }
        this.field = '';
        this.row = [];
        this.started = false;
        this.inQuotes = false;
        this.quotePending = false;
        return rows;
    }

    private appendChar(char: string): void {
        if (this.field.length >= MAX_FIELD_CHARS) {
            throw new LimitExceededError(
                'A delimited field exceeded the maximum supported size',
            );
        }
        this.field += char;
        this.started = true;
    }

    private endField(): void {
        if (this.row.length >= MAX_COLUMNS) {
            throw new LimitExceededError('Row exceeded the maximum supported column count');
        }
        this.row.push(this.field);
        this.field = '';
        this.started = true;
    }

    private endRow(rows: string[][], terminator: string): void {
        if (terminator === '\r') {
            this.skipLineFeed = true;
        }
        if (!this.started && this.row.length === 0 && this.field.length === 0) {
            // A completely blank physical line; CPython yields an empty row.
            rows.push([]);
            return;
        }
        this.row.push(this.field);
        rows.push(this.row);
        this.field = '';
        this.row = [];
        this.started = false;
    }
}

/** Parse a complete in-memory sample into rows. */
export function parseDelimited(text: string, delimiter: string, quoteChar = '"'): string[][] {
    const parser = new DelimitedRowParser(delimiter, quoteChar);
    const rows = parser.push(text);
    return rows.concat(parser.end());
}

/** Delimiters the sniffer will consider, in CPython's preference order. */
const CANDIDATE_DELIMITERS = [',', '\t', ';', '|', ':'];

/** Outcome of sniffing a bounded sample. */
export interface DialectGuess {
    delimiter: string;
    hasHeader: boolean;
}

function scoreDelimiter(sample: string, delimiter: string): { score: number; columns: number; } {
    const rows = parseDelimited(sample, delimiter).filter((row) => row.length > 0);
    // Drop the final row: a bounded sample usually truncates it mid-line.
    const usable = rows.length > 2 ? rows.slice(0, -1) : rows;
    if (usable.length < 2) {
        return { score: 0, columns: 0 };
    }
    const width = usable[0].length;
    if (width < 2) {
        return { score: 0, columns: 0 };
    }
    let consistent = 0;
    for (const row of usable) {
        if (row.length === width) {
            consistent += 1;
        }
    }
    if (consistent !== usable.length) {
        return { score: 0, columns: 0 };
    }
    return { score: consistent * width, columns: width };
}

function looksNumeric(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return false;
    }
    return INTEGER_PATTERN.test(trimmed) || FLOAT_PATTERN.test(trimmed);
}

function looksBoolean(value: string): boolean {
    return TRUE_LITERALS.has(value) || FALSE_LITERALS.has(value);
}

/**
 * Decide whether the first row is a header.
 *
 * The heuristic mirrors the intent of `csv.Sniffer.has_header`: a header row is
 * a row of distinct, non-empty, non-numeric labels that sits above at least one
 * column whose data values are consistently typed differently.
 */
export function guessHasHeader(rows: string[][]): boolean {
    const usable = rows.filter((row) => row.length > 0);
    if (usable.length === 0) {
        return false;
    }
    const header = usable[0];
    if (header.length === 0) {
        return false;
    }
    const seen = new Set<string>();
    for (const cell of header) {
        const key = cell.trim().toLowerCase();
        if (key.length === 0 || seen.has(key)) {
            return false;
        }
        if (looksNumeric(cell) || looksBoolean(cell)) {
            return false;
        }
        seen.add(key);
    }
    const body = usable.slice(1, usable.length > 3 ? usable.length - 1 : usable.length);
    if (body.length === 0) {
        // Only a header-shaped row was available; treat it as a header, which
        // is what the Python backend defaults to when sniffing fails.
        return true;
    }
    for (let column = 0; column < header.length; column += 1) {
        let typed = 0;
        let present = 0;
        for (const row of body) {
            const cell = row[column];
            if (cell === undefined || PANDAS_NA_VALUES.has(cell)) {
                continue;
            }
            present += 1;
            if (looksNumeric(cell) || looksBoolean(cell)) {
                typed += 1;
            }
        }
        if (present > 0 && typed === present) {
            return true;
        }
    }
    // No column is unambiguously typed; distinct textual labels are still the
    // most likely explanation for the first row.
    return true;
}

/** Sniff the delimiter and header of a bounded sample. */
export function sniffDialect(sample: string, filePath: string): DialectGuess {
    let best = ',';
    let bestScore = 0;
    let bestColumns = 0;
    for (const candidate of CANDIDATE_DELIMITERS) {
        const { score, columns } = scoreDelimiter(sample, candidate);
        if (score > bestScore || (score === bestScore && score > 0 && columns > bestColumns)) {
            best = candidate;
            bestScore = score;
            bestColumns = columns;
        }
    }
    if (bestScore === 0) {
        best = filePath.toLowerCase().includes('.tsv') ? '\t' : ',';
    }
    const rows = parseDelimited(sample, best);
    return { delimiter: best, hasHeader: guessHasHeader(rows) };
}

/** pandas dtype names the inference can produce. */
export type PandasDtype = 'int64' | 'float64' | 'bool' | 'object';

/** Result of inferring one column. */
export interface ColumnInference {
    dtype: PandasDtype;
    values: ParsedCell[];
    /** Longest `str(value)` across non-missing values, for string columns. */
    observedMaxLength: number | null;
}

function pythonStr(value: ParsedCell): string {
    if (value === null) {
        return '';
    }
    if (typeof value === 'boolean') {
        return value ? 'True' : 'False';
    }
    return String(value);
}

/**
 * Infer one column the way pandas' C parser would.
 *
 * `raw` holds the textual cells; missing cells are represented by `null`.
 */
export function inferColumn(raw: Array<string | null>): ColumnInference {
    let hasMissing = false;
    let allInteger = true;
    let allNumeric = true;
    let allBoolean = true;
    let sawValue = false;

    for (const cell of raw) {
        if (cell === null || PANDAS_NA_VALUES.has(cell)) {
            hasMissing = true;
            continue;
        }
        sawValue = true;
        const trimmed = cell.trim();
        if (!looksBoolean(cell)) {
            allBoolean = false;
        }
        if (!INTEGER_PATTERN.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
            allInteger = false;
        }
        if (!FLOAT_PATTERN.test(trimmed)) {
            allNumeric = false;
        }
    }

    if (!sawValue) {
        // An all-missing column becomes float64 (all NaN) in pandas.
        return {
            dtype: 'float64',
            values: raw.map(() => null),
            observedMaxLength: null,
        };
    }

    if (allBoolean) {
        const values = raw.map<ParsedCell>((cell) =>
            cell === null || PANDAS_NA_VALUES.has(cell) ? null : TRUE_LITERALS.has(cell),
        );
        if (!hasMissing) {
            return { dtype: 'bool', values, observedMaxLength: null };
        }
        // Booleans plus missing values degrade to an object column holding
        // Python bools, whose `str()` length is 4 or 5.
        let maxLength = 0;
        for (const value of values) {
            if (value !== null) {
                maxLength = Math.max(maxLength, pythonStr(value).length);
            }
        }
        return { dtype: 'object', values, observedMaxLength: maxLength };
    }

    if (allInteger && !hasMissing) {
        return {
            dtype: 'int64',
            values: raw.map((cell) => Number((cell as string).trim())),
            observedMaxLength: null,
        };
    }

    if (allNumeric) {
        return {
            dtype: 'float64',
            values: raw.map<ParsedCell>((cell) =>
                cell === null || PANDAS_NA_VALUES.has(cell) ? null : Number(cell.trim()),
            ),
            observedMaxLength: null,
        };
    }

    let maxLength = 0;
    const values = raw.map<ParsedCell>((cell) => {
        if (cell === null || PANDAS_NA_VALUES.has(cell)) {
            return null;
        }
        maxLength = Math.max(maxLength, cell.length);
        return cell;
    });
    return { dtype: 'object', values, observedMaxLength: maxLength };
}

/** Convert an inferred cell into a JSON-safe sample value. */
export function toSampleValue(value: ParsedCell): SampleValue {
    if (typeof value === 'number' && !Number.isFinite(value)) {
        return null;
    }
    return value;
}
