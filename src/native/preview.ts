/**
 * Bounded tabular previews.
 *
 * Every path here reads at most the requested number of rows, so previewing a
 * multi-gigabyte file costs the same as previewing a small one. The shape of
 * the result matches the Python `get_preview_data` contract.
 */

import { throwIfCancelled, type CancellationToken } from './cancellation';
import { NativeAnalysisError } from './errors';
import { PREVIEW_MAX_ROWS, STREAM_CHUNK_BYTES } from './limits';
import { readDecodedChunks } from './streams';
import type {
    FileMetadata,
    PreviewColumn,
    PreviewResult,
    SampleValue,
    StorageReference,
} from './types';
import {
    DelimitedRowParser,
    PANDAS_NA_VALUES,
    parseBooleanToken,
    toSampleValue,
    type ParsedCell,
} from './analysis/delimited';
import { firstParquetFile } from './analysis/delta';
import { readExcelPreview } from './analysis/excel';
import { previewJsonRows } from './analysis/json';
import { readParquetPreview } from './analysis/parquet';
import { readTextPreview } from './analysis/text';
import { normaliseHeader } from './analysis/csv';
import { exactNumericSample, parseNumericToken } from './analysis/numeric';
import { ORC_UNSUPPORTED_MESSAGE, RC_GUIDANCE } from './analysis/orc';

/** Clamp a caller-supplied row budget to the supported range. */
export function clampPreviewRows(maxRows: number): number {
    if (!Number.isFinite(maxRows)) {
        return 1;
    }
    return Math.max(1, Math.min(Math.trunc(maxRows), PREVIEW_MAX_ROWS));
}

function columnsFrom(metadata: FileMetadata, names: string[]): PreviewColumn[] {
    const types = new Map<string, string>(metadata.schema ?? []);
    return names.map((name) => ({ name, type: types.get(name) ?? 'object' }));
}

/** Stream at most `maxRows` data rows out of a delimited file. */
async function previewDelimited(
    filePath: string,
    delimiter: string,
    hasHeader: boolean,
    encoding: string,
    maxRows: number,
    detectedTypes: ReadonlyMap<string, string>,
    token?: CancellationToken,
): Promise<{ header: string[]; rows: SampleValue[][]; }> {
    const parser = new DelimitedRowParser(delimiter);
    let header: string[] | null = null;
    const rows: SampleValue[][] = [];

    const consume = (parsed: string[][]): boolean => {
        for (const row of parsed) {
            if (row.length === 0) {
                continue;
            }
            if (header === null) {
                header = hasHeader
                    ? normaliseHeader(row)
                    : row.map((_cell, index) => `column_${index + 1}`);
                if (hasHeader) {
                    continue;
                }
            }
            rows.push(row.map((cell, index) =>
                coerceCell(cell, detectedTypes.get(header?.[index] ?? '') ?? 'object')
            ));
            if (rows.length >= maxRows) {
                return true;
            }
        }
        return false;
    };

    for await (const chunk of readDecodedChunks(filePath, {
        encoding,
        token,
        chunkBytes: STREAM_CHUNK_BYTES,
    })) {
        if (consume(parser.push(chunk))) {
            return { header: header ?? [], rows };
        }
    }
    consume(parser.end());
    return { header: header ?? [], rows };
}

/** Convert a raw delimited cell without losing exact numeric text. */
function coerceCell(cell: string, detectedType: string): SampleValue {
    const trimmed = cell.trim();
    if (PANDAS_NA_VALUES.has(cell)) {
        return null;
    }
    if (detectedType === 'bool') {
        const parsed = parseBooleanToken(cell);
        if (parsed !== null) {
            return parsed;
        }
    }
    if (
        (
            detectedType === 'int32' ||
            detectedType === 'int64' ||
            detectedType.startsWith('decimal(')
        ) &&
        parseNumericToken(trimmed)
    ) {
        return exactNumericSample(trimmed);
    }
    return toSampleValue(cell as ParsedCell);
}

/**
 * Produce a bounded preview for any recognised reference.
 *
 * `metadata` must be the result of analysing the same reference; it supplies
 * the delimiter, encoding and declared column types.
 */
export async function getPreviewData(
    reference: StorageReference,
    metadata: FileMetadata,
    maxRows: number,
    token?: CancellationToken,
): Promise<PreviewResult> {
    const limit = clampPreviewRows(maxRows);
    const encoding = metadata.encoding === 'binary' || metadata.encoding.length === 0
        ? 'utf-8'
        : metadata.encoding;

    try {
        throwIfCancelled(token);
        switch (metadata.file_type) {
            case 'csv': {
                const preview = await previewDelimited(
                    reference.realPath,
                    metadata.delimiter ?? ',',
                    metadata.has_header,
                    encoding,
                    limit,
                    new Map(metadata.schema ?? []),
                    token,
                );
                return finish(metadata, columnsFrom(metadata, preview.header), preview.rows, limit);
            }
            case 'parquet': {
                const preview = await readParquetPreview(reference.realPath, limit, token);
                const columns = preview.columns.map(([name, type]) => ({ name, type }));
                return finish(metadata, columns, preview.rows, limit);
            }
            case 'excel': {
                const preview = await readExcelPreview(reference.realPath, limit, token);
                const columns = preview.columns.map(([name, type]) => ({ name, type }));
                return finish(metadata, columns, preview.rows.slice(0, limit), limit);
            }
            case 'json': {
                const preview = await previewJsonRows(
                    reference.realPath,
                    metadata.file_size,
                    limit,
                    encoding,
                    token,
                );
                return finish(
                    metadata,
                    columnsFrom(metadata, preview.columns),
                    preview.rows,
                    limit,
                );
            }
            case 'delta':
            case 'iceberg': {
                const dataFile = await firstParquetFile(reference.realPath);
                if (dataFile === null) {
                    return {
                        columns: [],
                        rows: [],
                        total_rows: null,
                        truncated: false,
                        error: 'No underlying Parquet data file found',
                    };
                }
                const preview = await readParquetPreview(dataFile, limit, token);
                const columns = preview.columns.map(([name, type]) => ({ name, type }));
                return finish(metadata, columns, preview.rows, limit);
            }
            case 'orc':
                return {
                    columns: [],
                    rows: [],
                    total_rows: null,
                    truncated: false,
                    error: ORC_UNSUPPORTED_MESSAGE,
                };
            case 'rc':
                return {
                    columns: [],
                    rows: [],
                    total_rows: null,
                    truncated: false,
                    error: RC_GUIDANCE,
                };
            default: {
                const rows = await readTextPreview(reference.realPath, encoding, limit, token);
                return finish(metadata, [{ name: 'line', type: 'object' }], rows, limit);
            }
        }
    } catch (error) {
        if (error instanceof NativeAnalysisError && error.code === 'cancelled') {
            throw error;
        }
        return {
            columns: [],
            rows: [],
            total_rows: null,
            truncated: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function finish(
    metadata: FileMetadata,
    columns: PreviewColumn[],
    rows: SampleValue[][],
    limit: number,
): PreviewResult {
    return {
        columns,
        rows,
        total_rows: metadata.row_count,
        truncated:
            metadata.analysis_truncated === true || (metadata.row_count ?? 0) > limit,
    };
}
