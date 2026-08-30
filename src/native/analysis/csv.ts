/**
 * Delimited-file analysis (CSV / TSV / pipe / any single-character delimiter).
 *
 * A single streaming pass provides the schema sample, the sample rows and the
 * exact logical row count, so a large file is never held in memory. Files above
 * {@link LARGE_FILE_THRESHOLD} skip the exact count and estimate it from a
 * bounded prefix, exactly like the Python backend.
 */

import * as fs from 'fs';

import { throwIfCancelled, type CancellationToken } from '../cancellation';
import { bytesPerUnit, detectEncoding } from '../encoding';
import {
    CANCELLATION_POLL_INTERVAL,
    CSV_SAMPLE_SIZE,
    CSV_SCHEMA_SAMPLE_ROWS,
    LARGE_FILE_THRESHOLD,
    SAMPLE_ROW_COUNT,
} from '../limits';
import { readDecodedChunks, readDecodedPrefix } from '../streams';
import type { FileMetadata, SampleValue, SchemaField } from '../types';
import {
    DelimitedRowParser,
    inferColumn,
    sniffDialect,
    toSampleValue,
    type ParsedCell,
} from './delimited';

/** Add headroom so a sampled maximum is not treated as a hard limit. */
export function sizeSampledString(observedLength: number): number {
    if (observedLength <= 0) {
        return 0;
    }
    return Math.ceil(observedLength * 1.25);
}

/** Reproduce pandas' header de-duplication and blank-name handling. */
export function normaliseHeader(cells: string[]): string[] {
    const names: string[] = [];
    const counts = new Map<string, number>();
    cells.forEach((cell, index) => {
        const base = cell.length === 0 ? `Unnamed: ${index}` : cell;
        const seen = counts.get(base) ?? 0;
        counts.set(base, seen + 1);
        names.push(seen === 0 ? base : `${base}.${seen}`);
    });
    return names;
}

/** Options accepted by {@link analyzeDelimited}. */
export interface DelimitedAnalysisOptions {
    encoding?: string;
    token?: CancellationToken;
}

interface StreamedSample {
    header: string[] | null;
    columns: Array<Array<string | null>>;
    sampledRows: number;
    logicalRows: number;
    countedExactly: boolean;
}

async function streamSample(
    filePath: string,
    delimiter: string,
    hasHeader: boolean,
    encoding: string,
    countRows: boolean,
    token?: CancellationToken,
): Promise<StreamedSample> {
    const parser = new DelimitedRowParser(delimiter);
    let header: string[] | null = null;
    let width = 0;
    const columns: Array<Array<string | null>> = [];
    let sampledRows = 0;
    let logicalRows = 0;
    let processed = 0;

    const consume = (rows: string[][]): boolean => {
        for (const row of rows) {
            logicalRows += 1;
            processed += 1;
            if ((processed % CANCELLATION_POLL_INTERVAL) === 0) {
                throwIfCancelled(token);
            }
            if (row.length === 0) {
                // pandas skips blank lines when building the frame, but
                // `csv.reader` still counts them.
                continue;
            }
            if (header === null) {
                header = hasHeader
                    ? normaliseHeader(row)
                    : row.map((_, index) => `column_${index + 1}`);
                width = header.length;
                for (let i = 0; i < width; i += 1) {
                    columns.push([]);
                }
                if (hasHeader) {
                    continue;
                }
            }
            if (sampledRows >= CSV_SCHEMA_SAMPLE_ROWS) {
                if (!countRows) {
                    return true;
                }
                continue;
            }
            if (row.length > width) {
                // `on_bad_lines='warn'` drops rows with too many fields.
                continue;
            }
            for (let i = 0; i < width; i += 1) {
                const cell = i < row.length ? row[i] : null;
                columns[i].push(cell);
            }
            sampledRows += 1;
        }
        return false;
    };

    let stopped = false;
    for await (const chunk of readDecodedChunks(filePath, { encoding, token })) {
        if (consume(parser.push(chunk))) {
            stopped = true;
            break;
        }
    }
    if (!stopped) {
        consume(parser.end());
    }

    return {
        header,
        columns,
        sampledRows,
        logicalRows,
        countedExactly: countRows && !stopped,
    };
}

/** Estimate a row count from a bounded binary prefix, mirroring Python. */
async function estimateRowCount(
    filePath: string,
    fileSize: number,
    hasHeader: boolean,
): Promise<number> {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const probeBytes = Math.min(fileSize, 4 * 1024 * 1024);
        const buffer = Buffer.allocUnsafe(probeBytes);
        const { bytesRead } = await handle.read(buffer, 0, probeBytes, 0);
        const view = buffer.subarray(0, bytesRead);
        const lineLengths: number[] = [];
        let start = 0;
        for (let i = 0; i < view.length && lineLengths.length < 500; i += 1) {
            if (view[i] === 0x0a) {
                lineLengths.push(i - start + 1);
                start = i + 1;
            }
        }
        if (lineLengths.length === 0 && view.length > 0) {
            lineLengths.push(view.length);
        }
        const total = lineLengths.reduce((sum, value) => sum + value, 0);
        const average = total / Math.max(lineLengths.length, 1);
        const estimate = Math.trunc(fileSize / Math.max(average, 1)) - (hasHeader ? 1 : 0);
        return Math.max(estimate, 0);
    } finally {
        await handle.close();
    }
}

/**
 * Analyse a delimited file, returning the same metadata keys as the Python
 * `_analyze_csv` implementation.
 */
export async function analyzeDelimited(
    filePath: string,
    fileSize: number,
    options: DelimitedAnalysisOptions = {},
): Promise<Partial<FileMetadata>> {
    const encoding = options.encoding ?? (await detectEncoding(filePath)).encoding;
    const unit = bytesPerUnit(encoding);
    const sample = await readDecodedPrefix(
        filePath,
        CSV_SAMPLE_SIZE * unit,
        encoding,
        options.token,
    );
    const dialect = sniffDialect(sample, filePath);

    const result: Partial<FileMetadata> = {
        delimiter: dialect.delimiter,
        has_header: dialect.hasHeader,
    };

    const isLarge = fileSize > LARGE_FILE_THRESHOLD;
    const streamed = await streamSample(
        filePath,
        dialect.delimiter,
        dialect.hasHeader,
        encoding,
        !isLarge,
        options.token,
    );

    const header = streamed.header ?? [];
    const schema: SchemaField[] = [];
    const observed: Record<string, number> = {};
    const maxLengths: Record<string, number> = {};
    const inferredColumns: ParsedCell[][] = [];

    header.forEach((name, index) => {
        const inference = inferColumn(streamed.columns[index] ?? []);
        schema.push([name, inference.dtype]);
        inferredColumns.push(inference.values);
        if (inference.observedMaxLength !== null) {
            observed[name] = inference.observedMaxLength;
            maxLengths[name] = sizeSampledString(inference.observedMaxLength);
        }
    });

    result.schema = schema;
    result.column_count = header.length;
    result.schema_inference = 'sampled';
    result.schema_sample_size = streamed.sampledRows;
    result.nullability_inference = 'conservative';
    result.observed_max_string_lengths = observed;
    result.max_string_lengths = maxLengths;
    result.nullable_columns = header.slice();

    const sampleRows: SampleValue[][] = [];
    const rowsToEcho = Math.min(SAMPLE_ROW_COUNT, streamed.sampledRows);
    for (let rowIndex = 0; rowIndex < rowsToEcho; rowIndex += 1) {
        sampleRows.push(inferredColumns.map((values) => toSampleValue(values[rowIndex] ?? null)));
    }
    result.sample_rows = sampleRows;

    if (isLarge) {
        result.row_count = await estimateRowCount(filePath, fileSize, dialect.hasHeader);
        result.row_count_estimated = true;
    } else {
        result.row_count = Math.max(
            streamed.logicalRows - (dialect.hasHeader ? 1 : 0),
            0,
        );
        result.row_count_estimated = false;
    }

    return result;
}
