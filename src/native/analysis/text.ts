/**
 * Plain-text analysis: line counting only, matching the Python `_analyze_text`.
 */

import { throwIfCancelled, type CancellationToken } from '../cancellation';
import { NativeAnalysisError } from '../errors';
import { countLines, readLines } from '../streams';
import type { FileMetadata, SampleValue } from '../types';

/** Count the physical lines in a text file without buffering it. */
export async function analyzeText(
    filePath: string,
    encoding: string,
    token?: CancellationToken,
): Promise<Partial<FileMetadata>> {
    try {
        throwIfCancelled(token);
        const rowCount = await countLines(filePath, { encoding, token });
        return { row_count: rowCount };
    } catch (error) {
        if (error instanceof NativeAnalysisError && error.code === 'cancelled') {
            throw error;
        }
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

/** Return the first `maxRows` lines as single-column preview rows. */
export async function readTextPreview(
    filePath: string,
    encoding: string,
    maxRows: number,
    token?: CancellationToken,
): Promise<SampleValue[][]> {
    const rows: SampleValue[][] = [];
    for await (const line of readLines(filePath, { encoding, token })) {
        if (rows.length >= maxRows) {
            break;
        }
        rows.push([line]);
    }
    return rows;
}
