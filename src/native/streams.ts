/**
 * Bounded streaming readers.
 *
 * Every reader here is incremental: it never materialises a whole file, it
 * polls a cancellation token, and it stops after an explicit byte budget. The
 * decoders are driven through `iconv-lite`'s low-level stateful decoder so a
 * multi-byte sequence that straddles a chunk boundary is handled correctly.
 */

import * as fs from 'fs';

import * as iconv from 'iconv-lite';

import { throwIfCancelled, type CancellationToken } from './cancellation';
import { toIconvName } from './encoding';
import { CANCELLATION_POLL_INTERVAL, STREAM_CHUNK_BYTES } from './limits';

/** Knobs shared by the streaming readers. */
export interface StreamOptions {
    /** Detected encoding name; defaults to UTF-8. */
    encoding?: string;
    /** Stop after reading this many bytes from disk. */
    maxBytes?: number;
    /** Bytes requested per read; defaults to {@link STREAM_CHUNK_BYTES}. */
    chunkBytes?: number;
    token?: CancellationToken;
}

/**
 * Yield successive decoded chunks of a file.
 *
 * A leading `U+FEFF` is dropped from the first chunk so callers never have to
 * think about byte-order marks again.
 */
export async function* readDecodedChunks(
    filePath: string,
    options: StreamOptions = {},
): AsyncGenerator<string, void, void> {
    const codec = toIconvName(options.encoding ?? 'utf-8');
    const chunkBytes = Math.max(4096, options.chunkBytes ?? STREAM_CHUNK_BYTES);
    const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    const decoder = iconv.getDecoder(codec as iconv.Encoding);

    const handle = await fs.promises.open(filePath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(chunkBytes);
        let consumed = 0;
        let first = true;
        for (;;) {
            throwIfCancelled(options.token);
            const budget = Math.min(chunkBytes, maxBytes - consumed);
            if (budget <= 0) {
                break;
            }
            const { bytesRead } = await handle.read(buffer, 0, budget, consumed);
            if (bytesRead <= 0) {
                break;
            }
            consumed += bytesRead;
            let text = decoder.write(Buffer.from(buffer.subarray(0, bytesRead)));
            if (first) {
                first = false;
                if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
                    text = text.slice(1);
                }
            }
            if (text.length > 0) {
                yield text;
            }
        }
        const tail = decoder.end();
        if (tail && tail.length > 0) {
            if (first && tail.charCodeAt(0) === 0xfeff) {
                yield tail.slice(1);
            } else {
                yield tail;
            }
        }
    } finally {
        await handle.close();
    }
}

/**
 * Yield successive lines of a file, without the trailing newline.
 *
 * `maxLineChars` caps a single line so a binary file misidentified as text
 * cannot produce an unbounded string.
 */
export async function* readLines(
    filePath: string,
    options: StreamOptions & { maxLineChars?: number; } = {},
): AsyncGenerator<string, void, void> {
    const maxLineChars = options.maxLineChars ?? 16 * 1024 * 1024;
    let pending = '';
    let lineIndex = 0;
    for await (const chunk of readDecodedChunks(filePath, options)) {
        pending += chunk;
        let start = 0;
        for (;;) {
            const newlineAt = pending.indexOf('\n', start);
            if (newlineAt === -1) {
                break;
            }
            let line = pending.slice(start, newlineAt);
            if (line.endsWith('\r')) {
                line = line.slice(0, -1);
            }
            start = newlineAt + 1;
            lineIndex += 1;
            if ((lineIndex % CANCELLATION_POLL_INTERVAL) === 0) {
                throwIfCancelled(options.token);
            }
            yield line;
        }
        pending = pending.slice(start);
        if (pending.length > maxLineChars) {
            // Truncate rather than throw: a single pathological line should not
            // abort an otherwise useful analysis.
            pending = pending.slice(0, maxLineChars);
        }
    }
    if (pending.length > 0) {
        yield pending.endsWith('\r') ? pending.slice(0, -1) : pending;
    }
}

/**
 * Read a bounded decoded prefix of a file.
 *
 * Used for delimiter sniffing and JSON shape detection.
 */
export async function readDecodedPrefix(
    filePath: string,
    byteCount: number,
    encoding = 'utf-8',
    token?: CancellationToken,
): Promise<string> {
    let text = '';
    for await (const chunk of readDecodedChunks(filePath, {
        encoding,
        maxBytes: byteCount,
        chunkBytes: Math.min(byteCount, STREAM_CHUNK_BYTES),
        token,
    })) {
        text += chunk;
    }
    return text;
}

/**
 * Count physical lines exactly the way Python's text-mode iteration does.
 *
 * Universal newlines apply: `\n`, `\r` and `\r\n` each terminate one line, and
 * a final line without a terminator still counts.
 */
export async function countLines(
    filePath: string,
    options: StreamOptions = {},
): Promise<number> {
    let count = 0;
    let sawTrailingContent = false;
    let pendingCarriageReturn = false;
    let checked = 0;
    for await (const chunk of readDecodedChunks(filePath, options)) {
        for (let i = 0; i < chunk.length; i += 1) {
            const code = chunk.charCodeAt(i);
            if (pendingCarriageReturn) {
                pendingCarriageReturn = false;
                if (code === 10) {
                    // `\r\n` already counted by the `\r`.
                    continue;
                }
            }
            if (code === 13) {
                pendingCarriageReturn = true;
                count += 1;
                sawTrailingContent = false;
            } else if (code === 10) {
                count += 1;
                sawTrailingContent = false;
            } else {
                sawTrailingContent = true;
            }
            checked += 1;
            if ((checked % (CANCELLATION_POLL_INTERVAL * 64)) === 0) {
                throwIfCancelled(options.token);
            }
        }
    }
    return sawTrailingContent ? count + 1 : count;
}
