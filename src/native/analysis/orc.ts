/**
 * ORC recognition.
 *
 * ## Why ORC is not natively analysed in this layer
 *
 * Reading an ORC schema means implementing the ORC protobuf footer plus its
 * stripe/stream encodings. A survey of npm found no maintained, portable
 * JavaScript or WebAssembly ORC reader:
 *
 * * `orc-tools` / `node-orc` — unpublished or abandoned (no release in years).
 * * `apache-arrow` (JS) — deliberately ships no ORC reader; ORC lives only in
 *   the C++ library, which would mean a platform-specific native binary.
 * * `parquet-wasm`-style WASM builds of Arrow C++ that include ORC are tens of
 *   megabytes, well beyond a reasonable VSIX budget, and pull in a build
 *   toolchain the extension cannot verify.
 *
 * Rather than fabricate a schema, the native core reports a typed
 * `unsupported_native` result: the file *is* recognised as ORC, its compression
 * codec is read from the real postscript, and the SQL generator still emits
 * correct ORC statements from a caller-supplied schema. The Python backend
 * (which has `pyarrow`) remains the way to get an ORC schema today.
 */

import * as fs from 'fs';

import { throwIfCancelled, type CancellationToken } from '../cancellation';
import { NativeAnalysisError } from '../errors';
import type { FileMetadata } from '../types';

/** Guidance surfaced to the user when ORC analysis is requested. */
export const ORC_UNSUPPORTED_MESSAGE =
    'ORC schema reading is not available in the native TypeScript core because ' +
    'no maintained, portable (non-native, non-WASM-bloat) ORC reader exists for ' +
    'Node. The file is recognised as ORC and SQL generation still works from a ' +
    'supplied schema; use the Python backend for automatic ORC schema detection.';

const ORC_MAGIC = 'ORC';

/**
 * ORC `CompressionKind` values, in protobuf enum order.
 *
 * `CompressionKind` is a proto2 enum whose zero value is `NONE`; ORC readers
 * surface that as `UNCOMPRESSED`.
 */
const ORC_COMPRESSION_KINDS = ['UNCOMPRESSED', 'ZLIB', 'SNAPPY', 'LZO', 'LZ4', 'ZSTD'];

function readVarint(buffer: Buffer, offset: number): { value: number; next: number; } {
    let value = 0;
    let shift = 0;
    let cursor = offset;
    while (cursor < buffer.length && shift <= 56) {
        const byte = buffer[cursor];
        cursor += 1;
        value += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) {
            return { value, next: cursor };
        }
        shift += 7;
    }
    return { value, next: cursor };
}

/**
 * Decode only the fields of the ORC postscript that are safe to report.
 *
 * The postscript is an uncompressed protobuf message at the very end of the
 * file, preceded by a single length byte, so this needs no decompression and
 * touches at most 256 bytes. Field numbers follow `orc_proto.proto`:
 * `compression` is field 2 and `magic` is field 8000.
 */
export function decodeOrcPostscript(tail: Buffer): { compression: string | null; magic: string | null; } {
    let compression: string | null = null;
    let magic: string | null = null;
    let cursor = 0;

    while (cursor < tail.length) {
        const key = readVarint(tail, cursor);
        if (key.next === cursor) {
            break;
        }
        cursor = key.next;
        const fieldNumber = Math.floor(key.value / 8);
        const wireType = key.value % 8;

        if (wireType === 0) {
            const scalar = readVarint(tail, cursor);
            if (fieldNumber === 2) {
                compression = ORC_COMPRESSION_KINDS[scalar.value] ?? null;
            }
            cursor = scalar.next;
        } else if (wireType === 2) {
            const length = readVarint(tail, cursor);
            const start = length.next;
            const end = start + length.value;
            if (end > tail.length) {
                break;
            }
            if (fieldNumber === 8000) {
                magic = tail.subarray(start, end).toString('latin1');
            }
            cursor = end;
        } else if (wireType === 5) {
            cursor += 4;
        } else if (wireType === 1) {
            cursor += 8;
        } else {
            break;
        }
    }

    return { compression, magic };
}

/**
 * Recognise an ORC file and report the explicit native limitation.
 *
 * Returns real facts only: whether the ORC magic is present and which
 * compression codec the postscript declares. No schema is invented.
 */
export async function analyzeOrc(
    filePath: string,
    token?: CancellationToken,
): Promise<Partial<FileMetadata>> {
    try {
        throwIfCancelled(token);
        const handle = await fs.promises.open(filePath, 'r');
        let compression: string | null = null;
        let looksLikeOrc = false;
        try {
            const stats = await handle.stat();
            const head = Buffer.alloc(Math.min(3, Number(stats.size)));
            if (head.length > 0) {
                await handle.read(head, 0, head.length, 0);
                looksLikeOrc = head.toString('latin1') === ORC_MAGIC;
            }
            const tailLength = Math.min(256, Number(stats.size));
            if (tailLength > 1) {
                const tail = Buffer.alloc(tailLength);
                await handle.read(tail, 0, tailLength, Number(stats.size) - tailLength);
                const postscriptLength = tail[tail.length - 1];
                if (postscriptLength > 0 && postscriptLength < tail.length) {
                    const postscript = tail.subarray(
                        tail.length - 1 - postscriptLength,
                        tail.length - 1,
                    );
                    const decoded = decodeOrcPostscript(postscript);
                    compression = decoded.compression;
                    looksLikeOrc = looksLikeOrc || decoded.magic === ORC_MAGIC;
                }
            }
        } finally {
            await handle.close();
        }

        if (!looksLikeOrc) {
            return {
                error: 'File does not carry the ORC magic marker',
                encoding: 'binary',
                native_support: 'unsupported_native',
            };
        }

        return {
            schema: null,
            row_count: null,
            column_count: null,
            // A proto2 enum that is absent carries its zero value, so a missing
            // `compression` field genuinely means the stripes are uncompressed.
            compression: compression ?? 'UNCOMPRESSED',
            nullable_columns: [],
            encoding: 'binary',
            native_support: 'unsupported_native',
            warning: ORC_UNSUPPORTED_MESSAGE,
        };
    } catch (error) {
        if (error instanceof NativeAnalysisError && error.code === 'cancelled') {
            throw error;
        }
        return {
            error: error instanceof Error ? error.message : String(error),
            encoding: 'binary',
            native_support: 'unsupported_native',
        };
    }
}

/** RCFile stays recognition-only, exactly as the Python backend documents. */
export const RC_GUIDANCE =
    'RCFile is recognised for statement generation only; schema detection is ' +
    'not available. Provide the column list, or convert the file to Parquet or ORC.';

/** Recognise an RCFile without claiming to read its schema. */
export function analyzeRc(): Partial<FileMetadata> {
    return {
        schema: null,
        row_count: null,
        column_count: null,
        nullable_columns: [],
        encoding: 'binary',
        native_support: 'recognition_only',
        warning: RC_GUIDANCE,
    };
}
