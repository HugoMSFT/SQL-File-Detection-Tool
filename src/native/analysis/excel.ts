/**
 * Bounded XLSX reading.
 *
 * XLSX is a ZIP of XML parts, so the only external dependency needed is an
 * inflater (`fflate`). Reading the parts directly keeps the dependency surface
 * to one small MIT package with no native code, and lets every entry be size
 * checked before it is inflated, which is the practical defence against a
 * "zip bomb" spreadsheet.
 *
 * Only the first worksheet is read, and only its first
 * {@link EXCEL_SAMPLE_ROWS} rows, matching `pandas.read_excel(nrows=200)`.
 */

import * as fs from 'fs';

import { unzipSync } from 'fflate';

import { throwIfCancelled, type CancellationToken } from '../cancellation';
import { LimitExceededError, NativeAnalysisError } from '../errors';
import {
    MAX_IN_MEMORY_BYTES,
    MAX_ZIP_ENTRY_BYTES,
    MAX_ZIP_RATIO,
    MAX_ZIP_TOTAL_BYTES,
    SAMPLE_ROW_COUNT,
} from '../limits';
import type { FileMetadata, SampleValue, SchemaField } from '../types';
import { sizeSampledString, normaliseHeader } from './csv';

/** Rows read from the first worksheet, matching `pandas.read_excel`. */
export const EXCEL_SAMPLE_ROWS = 200;

/** A cell value as `openpyxl` would materialise it. */
export type ExcelCell = string | number | boolean | Date | null;

const XML_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
});

function decodeXmlText(value: string): string {
    return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
        if (entity.startsWith('#x') || entity.startsWith('#X')) {
            return String.fromCodePoint(parseInt(entity.slice(2), 16));
        }
        if (entity.startsWith('#')) {
            return String.fromCodePoint(parseInt(entity.slice(1), 10));
        }
        return XML_ENTITIES[entity] ?? match;
    });
}

/** Read a ZIP archive with per-entry and total inflation limits. */
function unzipBounded(archive: Uint8Array, wanted: (name: string) => boolean): Record<string, Uint8Array> {
    let total = 0;
    return unzipSync(archive, {
        filter(file) {
            if (!wanted(file.name)) {
                return false;
            }
            if (file.originalSize !== undefined) {
                if (file.originalSize > MAX_ZIP_ENTRY_BYTES) {
                    throw new LimitExceededError(
                        `Workbook entry "${file.name}" is too large to read safely`,
                    );
                }
                if (file.size > 0 && file.originalSize / file.size > MAX_ZIP_RATIO) {
                    throw new LimitExceededError(
                        `Workbook entry "${file.name}" has an implausible compression ratio`,
                    );
                }
                total += file.originalSize;
                if (total > MAX_ZIP_TOTAL_BYTES) {
                    throw new LimitExceededError(
                        'Workbook exceeds the maximum total inflated size',
                    );
                }
            }
            return true;
        },
    });
}

function decodePart(parts: Record<string, Uint8Array>, name: string): string | null {
    const bytes = parts[name];
    return bytes ? Buffer.from(bytes).toString('utf8') : null;
}

/** Extract the shared-string table, preserving rich-text run concatenation. */
export function parseSharedStrings(xml: string | null): string[] {
    if (xml === null) {
        return [];
    }
    const strings: string[] = [];
    const itemPattern = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
    let match: RegExpExecArray | null;
    while ((match = itemPattern.exec(xml)) !== null) {
        const body = match[1] ?? '';
        let text = '';
        const textPattern = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
        let textMatch: RegExpExecArray | null;
        while ((textMatch = textPattern.exec(body)) !== null) {
            text += decodeXmlText(textMatch[1] ?? '');
        }
        strings.push(text);
    }
    return strings;
}

/** Built-in number-format identifiers that render as a date or time. */
const BUILTIN_DATE_FORMATS = new Set([
    14, 15, 16, 17, 18, 19, 20, 21, 22,
    27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
    45, 46, 47,
    50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

function formatCodeIsDate(code: string): boolean {
    // Strip quoted literals and colour/condition sections before looking for
    // date tokens, so a currency format such as `"y"#,##0` is not misread.
    const stripped = code
        .replace(/"[^"]*"/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\\./g, '');
    return /[ymdhs]/i.test(stripped);
}

/** Map style index to "is a date format". */
export function parseDateStyles(stylesXml: string | null): boolean[] {
    if (stylesXml === null) {
        return [];
    }
    const customDateFormats = new Set<number>();
    const numFmtPattern = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/?>/g;
    let match: RegExpExecArray | null;
    while ((match = numFmtPattern.exec(stylesXml)) !== null) {
        if (formatCodeIsDate(decodeXmlText(match[2]))) {
            customDateFormats.add(Number(match[1]));
        }
    }

    const cellXfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
    if (cellXfsBlock === null) {
        return [];
    }
    const styles: boolean[] = [];
    const xfPattern = /<xf\b[^>]*?\/>|<xf\b[^>]*?>[\s\S]*?<\/xf>/g;
    let xfMatch: RegExpExecArray | null;
    while ((xfMatch = xfPattern.exec(cellXfsBlock[1])) !== null) {
        const idMatch = /numFmtId="(\d+)"/.exec(xfMatch[0]);
        const numFmtId = idMatch ? Number(idMatch[1]) : 0;
        styles.push(BUILTIN_DATE_FORMATS.has(numFmtId) || customDateFormats.has(numFmtId));
    }
    return styles;
}

/** Convert an `A1`-style reference into a zero-based column index. */
export function columnIndexFromRef(reference: string): number {
    let index = 0;
    for (const char of reference) {
        const code = char.charCodeAt(0);
        if (code >= 65 && code <= 90) {
            index = index * 26 + (code - 64);
        } else if (code >= 97 && code <= 122) {
            index = index * 26 + (code - 96);
        } else {
            break;
        }
    }
    return index - 1;
}

/** Convert an Excel serial number into a `Date`. */
export function excelSerialToDate(serial: number, date1904: boolean): Date {
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const milliseconds = Math.round(serial * 86400000);
    return new Date(epoch + milliseconds);
}

/** Render a `Date` the way `str(pandas.Timestamp)` does. */
export function formatExcelTimestamp(value: Date): string {
    const pad = (input: number, width = 2): string => String(input).padStart(width, '0');
    return (
        `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ` +
        `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`
    );
}

interface SheetScan {
    rows: ExcelCell[][];
    width: number;
}

/** Scan the worksheet XML, stopping once `maxRows` rows have been collected. */
function scanSheet(
    xml: string,
    sharedStrings: string[],
    dateStyles: boolean[],
    date1904: boolean,
    maxRows: number,
    token?: CancellationToken,
): SheetScan {
    const rows: ExcelCell[][] = [];
    let width = 0;
    const rowPattern = /<row\b([^>]*)(?:\/>|>([\s\S]*?)<\/row>)/g;
    let rowMatch: RegExpExecArray | null;

    while (rows.length < maxRows && (rowMatch = rowPattern.exec(xml)) !== null) {
        throwIfCancelled(token);
        const body = rowMatch[2] ?? '';
        const cells: ExcelCell[] = [];
        const cellPattern = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
        let cellMatch: RegExpExecArray | null;
        while ((cellMatch = cellPattern.exec(body)) !== null) {
            const attributes = cellMatch[1] ?? '';
            const content = cellMatch[2] ?? '';
            const refMatch = /r="([A-Za-z]+)\d+"/.exec(attributes);
            const columnIndex = refMatch ? columnIndexFromRef(refMatch[1]) : cells.length;
            while (cells.length < columnIndex) {
                cells.push(null);
            }
            cells.push(readCell(attributes, content, sharedStrings, dateStyles, date1904));
        }
        // A completely empty row is preserved so row indices stay aligned.
        rows.push(cells);
        width = Math.max(width, cells.length);
    }

    for (const row of rows) {
        while (row.length < width) {
            row.push(null);
        }
    }
    return { rows, width };
}

function readCell(
    attributes: string,
    content: string,
    sharedStrings: string[],
    dateStyles: boolean[],
    date1904: boolean,
): ExcelCell {
    const typeMatch = /\bt="([^"]+)"/.exec(attributes);
    const type = typeMatch ? typeMatch[1] : 'n';

    if (type === 'inlineStr') {
        let text = '';
        const textPattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let match: RegExpExecArray | null;
        while ((match = textPattern.exec(content)) !== null) {
            text += decodeXmlText(match[1]);
        }
        return text;
    }

    const valueMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(content);
    const raw = valueMatch ? decodeXmlText(valueMatch[1]) : null;
    if (raw === null || raw.length === 0) {
        return type === 's' || type === 'str' ? null : null;
    }

    if (type === 's') {
        const index = Number(raw);
        return Number.isInteger(index) && index >= 0 && index < sharedStrings.length
            ? sharedStrings[index]
            : '';
    }
    if (type === 'b') {
        return raw === '1' || raw.toLowerCase() === 'true';
    }
    if (type === 'str' || type === 'e') {
        return raw;
    }

    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) {
        return raw;
    }
    const styleMatch = /\bs="(\d+)"/.exec(attributes);
    const styleIndex = styleMatch ? Number(styleMatch[1]) : -1;
    if (styleIndex >= 0 && dateStyles[styleIndex]) {
        return excelSerialToDate(numeric, date1904);
    }
    return numeric;
}

/**
 * Find the `Target` of the relationship with the given `Id`.
 *
 * Every pattern here is a literal. The caller's id is matched with `===`
 * against a captured attribute rather than being compiled into a pattern, so a
 * hostile workbook can choose which relationship is selected but never how the
 * search is performed.
 */
function relationshipTarget(relsXml: string, wantedId: string): string | null {
    const elements = relsXml.match(/<Relationship\b[^>]*>/g);
    if (!elements) {
        return null;
    }
    for (const element of elements) {
        const id = /\bId="([^"]*)"/.exec(element);
        if (!id || id[1] !== wantedId) {
            continue;
        }
        const target = /\bTarget="([^"]*)"/.exec(element);
        if (target && target[1] !== '') {
            return target[1];
        }
    }
    return null;
}

/** Locate the first worksheet part named by the workbook. */
function firstSheetPath(
    workbookXml: string | null,
    relsXml: string | null,
    parts: Record<string, Uint8Array>,
): string | null {
    if (workbookXml !== null && relsXml !== null) {
        const sheetMatch = /<sheet\b[^>]*?\br:id="([^"]+)"[^>]*\/?>/.exec(workbookXml);
        if (sheetMatch) {
            // The relationship id comes out of an untrusted workbook, so it is
            // compared, never compiled. Interpolating it into a `new RegExp`
            // would hand the file's author control of the pattern as well as
            // the subject: `Id="(a+)+X"` is catastrophic backtracking on the
            // extension-host thread, and `Id="\"` is a SyntaxError thrown from
            // a path that only expects a parse miss.
            const wanted = sheetMatch[1];
            const target = relationshipTarget(relsXml, wanted);
            if (target !== null) {
                const relative = target.replace(/^\/?xl\//, '').replace(/^\//, '');
                const candidate = `xl/${relative}`;
                if (parts[candidate]) {
                    return candidate;
                }
            }
        }
    }
    const fallback = Object.keys(parts)
        .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))
        .sort();
    return fallback.length > 0 ? fallback[0] : null;
}

/** pandas dtypes an Excel column can take. */
type ExcelDtype = 'int64' | 'float64' | 'bool' | 'datetime64[ns]' | 'object';

interface ExcelColumnInference {
    dtype: ExcelDtype;
    values: SampleValue[];
    observedMaxLength: number | null;
}

function inferExcelColumn(values: ExcelCell[]): ExcelColumnInference {
    let present = 0;
    let integers = 0;
    let numbers = 0;
    let booleans = 0;
    let dates = 0;
    for (const value of values) {
        if (value === null) {
            continue;
        }
        present += 1;
        if (typeof value === 'boolean') {
            booleans += 1;
        } else if (value instanceof Date) {
            dates += 1;
        } else if (typeof value === 'number') {
            numbers += 1;
            if (Number.isInteger(value)) {
                integers += 1;
            }
        }
    }

    const hasMissing = present < values.length;
    const render = (value: ExcelCell): SampleValue => {
        if (value === null) {
            return null;
        }
        if (value instanceof Date) {
            return formatExcelTimestamp(value);
        }
        return value;
    };

    if (present > 0 && dates === present) {
        return { dtype: 'datetime64[ns]', values: values.map(render), observedMaxLength: null };
    }
    if (present > 0 && booleans === present && !hasMissing) {
        return { dtype: 'bool', values: values.map(render), observedMaxLength: null };
    }
    if (present > 0 && numbers === present) {
        const dtype: ExcelDtype = integers === present && !hasMissing ? 'int64' : 'float64';
        return { dtype, values: values.map(render), observedMaxLength: null };
    }
    if (present === 0) {
        return { dtype: 'float64', values: values.map(() => null), observedMaxLength: null };
    }

    let maxLength = 0;
    for (const value of values) {
        if (value === null) {
            continue;
        }
        const text =
            typeof value === 'boolean'
                ? (value ? 'True' : 'False')
                : value instanceof Date
                    ? formatExcelTimestamp(value)
                    : String(value);
        maxLength = Math.max(maxLength, text.length);
    }
    return { dtype: 'object', values: values.map(render), observedMaxLength: maxLength };
}

/** Analyse an XLSX workbook, mirroring the Python `_analyze_excel` keys. */
export async function analyzeExcel(
    filePath: string,
    token?: CancellationToken,
): Promise<Partial<FileMetadata>> {
    try {
        const stats = await fs.promises.stat(filePath);
        if (stats.size > MAX_IN_MEMORY_BYTES) {
            throw new LimitExceededError('Workbook is too large to read safely');
        }
        const archive = new Uint8Array(await fs.promises.readFile(filePath));
        throwIfCancelled(token);

        const wanted = (name: string): boolean =>
            name === 'xl/workbook.xml' ||
            name === 'xl/_rels/workbook.xml.rels' ||
            name === 'xl/sharedStrings.xml' ||
            name === 'xl/styles.xml' ||
            /^xl\/worksheets\/[^/]+\.xml$/.test(name);

        const parts = unzipBounded(archive, wanted);
        const workbookXml = decodePart(parts, 'xl/workbook.xml');
        const relsXml = decodePart(parts, 'xl/_rels/workbook.xml.rels');
        const sheetPath = firstSheetPath(workbookXml, relsXml, parts);
        if (sheetPath === null) {
            throw new NativeAnalysisError('malformed_input', 'Workbook contains no worksheets');
        }

        const sharedStrings = parseSharedStrings(decodePart(parts, 'xl/sharedStrings.xml'));
        const dateStyles = parseDateStyles(decodePart(parts, 'xl/styles.xml'));
        const date1904 = workbookXml !== null && /date1904="(1|true)"/i.test(workbookXml);
        const sheetXml = decodePart(parts, sheetPath) ?? '';

        const scan = scanSheet(
            sheetXml,
            sharedStrings,
            dateStyles,
            date1904,
            EXCEL_SAMPLE_ROWS + 1,
            token,
        );
        if (scan.rows.length === 0) {
            return {
                schema: [],
                nullable_columns: [],
                nullability_inference: 'conservative',
                observed_max_string_lengths: {},
                max_string_lengths: {},
                row_count: 0,
                row_count_lower_bound: null,
                column_count: 0,
                has_header: true,
                schema_inference: 'sampled',
                schema_sample_size: 0,
                sample_rows: [],
            };
        }

        const headerCells = scan.rows[0].map((cell) =>
            cell === null
                ? ''
                : cell instanceof Date
                    ? formatExcelTimestamp(cell)
                    : String(cell),
        );
        const header = normaliseHeader(headerCells);
        const dataRows = scan.rows.slice(1, EXCEL_SAMPLE_ROWS + 1);

        const schema: SchemaField[] = [];
        const observed: Record<string, number> = {};
        const maxLengths: Record<string, number> = {};
        const columnValues: SampleValue[][] = [];

        header.forEach((name, index) => {
            const inference = inferExcelColumn(dataRows.map((row) => row[index] ?? null));
            schema.push([name, inference.dtype]);
            columnValues.push(inference.values);
            if (inference.observedMaxLength !== null && inference.observedMaxLength > 0) {
                observed[name] = inference.observedMaxLength;
                maxLengths[name] = sizeSampledString(inference.observedMaxLength);
            }
        });

        const sampleRows: SampleValue[][] = [];
        const echo = Math.min(SAMPLE_ROW_COUNT, dataRows.length);
        for (let rowIndex = 0; rowIndex < echo; rowIndex += 1) {
            sampleRows.push(columnValues.map((values) => values[rowIndex] ?? null));
        }

        return {
            schema,
            nullable_columns: header.slice(),
            nullability_inference: 'conservative',
            observed_max_string_lengths: observed,
            max_string_lengths: maxLengths,
            row_count: dataRows.length < EXCEL_SAMPLE_ROWS ? dataRows.length : null,
            row_count_lower_bound: dataRows.length === EXCEL_SAMPLE_ROWS ? EXCEL_SAMPLE_ROWS : null,
            column_count: schema.length,
            has_header: true,
            schema_inference: 'sampled',
            schema_sample_size: dataRows.length,
            sample_rows: sampleRows,
        };
    } catch (error) {
        if (error instanceof NativeAnalysisError && error.code === 'cancelled') {
            throw error;
        }
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

/** Bounded row extraction for the preview surface. */
export async function readExcelPreview(
    filePath: string,
    maxRows: number,
    token?: CancellationToken,
): Promise<{ columns: SchemaField[]; rows: SampleValue[][]; }> {
    const metadata = await analyzeExcel(filePath, token);
    const schema = (metadata.schema ?? []) as SchemaField[];
    if (schema.length === 0) {
        return { columns: [], rows: [] };
    }

    const stats = await fs.promises.stat(filePath);
    if (stats.size > MAX_IN_MEMORY_BYTES) {
        throw new LimitExceededError('Workbook is too large to read safely');
    }
    const archive = new Uint8Array(await fs.promises.readFile(filePath));
    const parts = unzipBounded(
        archive,
        (name) =>
            name === 'xl/workbook.xml' ||
            name === 'xl/_rels/workbook.xml.rels' ||
            name === 'xl/sharedStrings.xml' ||
            name === 'xl/styles.xml' ||
            /^xl\/worksheets\/[^/]+\.xml$/.test(name),
    );
    const workbookXml = decodePart(parts, 'xl/workbook.xml');
    const relsXml = decodePart(parts, 'xl/_rels/workbook.xml.rels');
    const sheetPath = firstSheetPath(workbookXml, relsXml, parts);
    if (sheetPath === null) {
        return { columns: schema, rows: [] };
    }
    const scan = scanSheet(
        decodePart(parts, sheetPath) ?? '',
        parseSharedStrings(decodePart(parts, 'xl/sharedStrings.xml')),
        parseDateStyles(decodePart(parts, 'xl/styles.xml')),
        workbookXml !== null && /date1904="(1|true)"/i.test(workbookXml),
        maxRows + 1,
        token,
    );
    const rows = scan.rows.slice(1).map((row) =>
        schema.map((_field, index) => {
            const value = row[index] ?? null;
            if (value === null) {
                return null;
            }
            return value instanceof Date ? formatExcelTimestamp(value) : value;
        }),
    );
    return { columns: schema, rows };
}
