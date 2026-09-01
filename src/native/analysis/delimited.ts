/**
 * Streaming delimited-text parsing and pandas-compatible column inference.
 *
 * The row parser follows CPython's `csv` module state machine (QUOTE_MINIMAL,
 * `doublequote=True`, non-strict) so that row counts and field splitting agree
 * with the Python backend, including embedded delimiters, embedded newlines,
 * doubled quotes and blank lines.
 *
 * Type inference stays lexical so integer boundaries and exact decimal tokens
 * never pass through JavaScript Number before their SQL type is selected.
 */

import { LimitExceededError } from '../errors';
import { MAX_COLUMNS, MAX_FIELD_CHARS } from '../limits';
import type { SampleValue } from '../types';
import {
    exactNumericSample,
    NumericColumnAccumulator,
    type ExactNumericType,
} from './numeric';

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
    return parseBooleanToken(value) !== null;
}

/** Parse a supported boolean token, or return null rather than fabricating false. */
export function parseBooleanToken(value: string): boolean | null {
    if (TRUE_LITERALS.has(value)) {
        return true;
    }
    if (FALSE_LITERALS.has(value)) {
        return false;
    }
    return null;
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

/** Detected scalar types produced by lexical delimited-column inference. */
export type InferredDtype = ExactNumericType | 'bool' | 'object';

/** Result of inferring one column. */
export interface ColumnInference {
    dtype: InferredDtype;
    values: ParsedCell[];
    /** Longest source token across non-missing values, for text fallbacks. */
    observedMaxLength: number | null;
}

function isMissing(cell: string | null): boolean {
    return cell === null || PANDAS_NA_VALUES.has(cell);
}

/**
 * Constant-memory evidence for one delimited column.
 */
export class DelimitedColumnAccumulator {
    private sawValue = false;
    private allBoolean = true;
    private allNumeric = true;
    private maxRawLength = 0;
    private readonly numeric = new NumericColumnAccumulator();

    public add(cell: string | null): void {
        if (isMissing(cell)) {
            return;
        }
        const value = cell as string;
        this.sawValue = true;
        this.maxRawLength = Math.max(this.maxRawLength, value.length);
        if (!looksBoolean(value)) {
            this.allBoolean = false;
        }
        if (!this.numeric.add(value.trim())) {
            this.allNumeric = false;
        }
    }

    public finish(sample: Array<string | null>): ColumnInference {
        if (!this.sawValue) {
            return {
                dtype: 'object',
                values: sample.map(() => null),
                observedMaxLength: null,
            };
        }

        if (this.allBoolean) {
            return {
                dtype: 'bool',
                values: sample.map<ParsedCell>((cell) =>
                    isMissing(cell) ? null : TRUE_LITERALS.has(cell as string),
                ),
                observedMaxLength: null,
            };
        }

        if (this.allNumeric) {
            const dtype = this.numeric.detectedType();
            if (dtype !== null) {
                return {
                    dtype,
                    values: sample.map<ParsedCell>((cell) =>
                        isMissing(cell)
                            ? null
                            : exactNumericSample((cell as string).trim()),
                    ),
                    observedMaxLength: null,
                };
            }
        }

        return {
            dtype: 'object',
            values: sample.map<ParsedCell>((cell) => (isMissing(cell) ? null : cell)),
            observedMaxLength: this.maxRawLength,
        };
    }
}

/**
 * Infer one column from a bounded in-memory token list.
 *
 * Streaming callers should add every row to {@link DelimitedColumnAccumulator}
 * and retain only the small preview sample passed to `finish`.
 */
export function inferColumn(raw: Array<string | null>): ColumnInference {
    const accumulator = new DelimitedColumnAccumulator();
    for (const cell of raw) {
        accumulator.add(cell);
    }
    return accumulator.finish(raw);
}

/** Convert an inferred cell into a JSON-safe sample value. */
export function toSampleValue(value: ParsedCell): SampleValue {
    if (typeof value === 'number' && !Number.isFinite(value)) {
        return null;
    }
    return value;
}
