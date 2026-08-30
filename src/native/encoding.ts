/**
 * Bounded encoding detection and decoding.
 *
 * Detection deliberately runs in three stages so that the common cases are
 * deterministic rather than statistical (which is what keeps the native core
 * byte-for-byte comparable with the Python `chardet` results):
 *
 *   1. Byte-order marks, which are unambiguous.
 *   2. A strict UTF-8 validation pass over the sample, distinguishing pure
 *      ASCII from UTF-8 with multi-byte sequences, exactly like `chardet`.
 *   3. `chardet` (npm) for legacy single- and multi-byte code pages.
 *
 * Only the first {@link ENCODING_DETECTION_BYTES} bytes are ever inspected.
 */

import * as fs from 'fs';

import * as chardet from 'chardet';
import * as iconv from 'iconv-lite';

import { ENCODING_DETECTION_BYTES } from './limits';

/** Result of a bounded encoding probe. */
export interface EncodingDetection {
    /** Python-`chardet`-compatible, lower-case encoding name. */
    encoding: string;
    /** Detector confidence in `[0, 1]`. */
    confidence: number;
    /** Length of the byte-order mark, if any. */
    bomLength: number;
}

/**
 * SQL Server codepage numbers, copied verbatim from
 * `FileDetector.CODEPAGE_MAP` so that generated `CODEPAGE` hints match.
 */
export const CODEPAGE_MAP: Readonly<Record<string, string>> = Object.freeze({
    'utf-8': '65001',
    'utf-8-sig': '65001',
    'ascii': '1252',
    'latin-1': '1252',
    'iso-8859-1': '1252',
    'cp1252': '1252',
    'windows-1252': '1252',
    'utf-16': '1200',
    'utf-16-le': '1200',
    'utf-16-be': '1201',
    'shift_jis': '932',
    'shift-jis': '932',
    'sjis': '932',
    'cp932': '932',
    'ms932': '932',
    'euc-jp': '20932',
    'euc_jp': '20932',
    'gbk': '936',
    'cp936': '936',
    'gb2312': '936',
    'big5': '950',
    'cp950': '950',
    'cp1251': '1251',
    'windows-1251': '1251',
});

/** Map an encoding name onto its SQL Server codepage, defaulting to `ACP`. */
export function encodingToCodepage(encoding: string): string {
    const key = encoding.toLowerCase().trim();
    return CODEPAGE_MAP[key] ?? 'ACP';
}

/**
 * Normalise the names `chardet` (npm) emits onto the names Python's `chardet`
 * emits, so both backends agree on `encoding` as well as `codepage`.
 */
const CHARDET_NAME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
    'shift_jis': 'cp932',
    'shift-jis': 'cp932',
    'sjis': 'cp932',
    'utf-16le': 'utf-16',
    'utf-16be': 'utf-16-be',
    'gb18030': 'gbk',
    'iso-8859-1': 'iso-8859-1',
    'windows-1252': 'cp1252',
    'windows-1251': 'cp1251',
    'euc-jp': 'euc-jp',
});

/** Byte-order marks, longest first so UTF-32 wins over UTF-16. */
const BOMS: ReadonlyArray<{ bytes: number[]; encoding: string; }> = [
    { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: 'utf-32-be' },
    { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: 'utf-32' },
    { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8-sig' },
    { bytes: [0xfe, 0xff], encoding: 'utf-16-be' },
    { bytes: [0xff, 0xfe], encoding: 'utf-16' },
];

/** Identify a byte-order mark at the start of `buffer`. */
export function detectBom(buffer: Buffer): { encoding: string; bomLength: number; } | null {
    for (const bom of BOMS) {
        if (buffer.length < bom.bytes.length) {
            continue;
        }
        let matches = true;
        for (let i = 0; i < bom.bytes.length; i += 1) {
            if (buffer[i] !== bom.bytes[i]) {
                matches = false;
                break;
            }
        }
        if (matches) {
            return { encoding: bom.encoding, bomLength: bom.bytes.length };
        }
    }
    return null;
}

/**
 * Strict UTF-8 validation over a sample.
 *
 * `truncatedTail` allows the final, possibly incomplete, multi-byte sequence at
 * the end of a bounded sample to be ignored instead of failing the whole probe.
 */
function classifyUtf8(buffer: Buffer): 'ascii' | 'utf-8' | 'invalid' {
    let sawMultiByte = false;
    let i = 0;
    const length = buffer.length;
    while (i < length) {
        const byte = buffer[i];
        if (byte < 0x80) {
            i += 1;
            continue;
        }
        sawMultiByte = true;
        let extra: number;
        let codePoint: number;
        if (byte >= 0xc2 && byte <= 0xdf) {
            extra = 1;
            codePoint = byte & 0x1f;
        } else if (byte >= 0xe0 && byte <= 0xef) {
            extra = 2;
            codePoint = byte & 0x0f;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
            extra = 3;
            codePoint = byte & 0x07;
        } else {
            return 'invalid';
        }
        if (i + extra >= length) {
            // Sequence straddles the sample boundary; treat the sample as clean.
            break;
        }
        for (let k = 1; k <= extra; k += 1) {
            const continuation = buffer[i + k];
            if ((continuation & 0xc0) !== 0x80) {
                return 'invalid';
            }
            codePoint = (codePoint << 6) | (continuation & 0x3f);
        }
        if (extra === 2 && (codePoint < 0x800 || (codePoint >= 0xd800 && codePoint <= 0xdfff))) {
            return 'invalid';
        }
        if (extra === 3 && (codePoint < 0x10000 || codePoint > 0x10ffff)) {
            return 'invalid';
        }
        i += extra + 1;
    }
    return sawMultiByte ? 'utf-8' : 'ascii';
}

function detectLegacy(buffer: Buffer): { encoding: string; confidence: number; } {
    try {
        const matches = chardet.analyse(buffer);
        if (matches && matches.length > 0) {
            const best = matches[0];
            const lowered = String(best.name || 'utf-8').toLowerCase();
            return {
                encoding: CHARDET_NAME_ALIASES[lowered] ?? lowered,
                // `chardet` reports 0-100; the Python contract is 0-1.
                confidence: Math.max(0, Math.min(1, (best.confidence ?? 0) / 100)),
            };
        }
    } catch {
        // Fall through to the conservative default below.
    }
    return { encoding: 'cp1252', confidence: 0.4 };
}

/**
 * Recognise UTF-16 that arrived without a byte order mark.
 *
 * Latin text encoded as UTF-16 is a run of `XX 00` pairs, so `classifyUtf8`
 * sees nothing but bytes below 0x80 and calls it ASCII. Decoding it as a
 * single byte codepage then treats the NUL padding as data and doubles the
 * apparent row count.
 *
 * The tell is where the NULs sit, not that they exist: real text has none,
 * and binary formats scatter them across both parities. Only a sample whose
 * NULs land on exactly one parity, densely enough to be structural, is
 * claimed here.
 */
function detectBomlessUtf16(buffer: Buffer): string | undefined {
    const usable = buffer.length - (buffer.length % 2);
    if (usable < 4) {
        return undefined;
    }
    let zerosEven = 0;
    let zerosOdd = 0;
    for (let i = 0; i < usable; i += 2) {
        if (buffer[i] === 0) {
            zerosEven += 1;
        }
        if (buffer[i + 1] === 0) {
            zerosOdd += 1;
        }
    }
    const pairs = usable / 2;
    const threshold = Math.max(2, Math.floor(pairs / 4));
    if (zerosEven === 0 && zerosOdd >= threshold) {
        return 'utf-16-le';
    }
    if (zerosOdd === 0 && zerosEven >= threshold) {
        return 'utf-16-be';
    }
    return undefined;
}

/** Detect the encoding of an in-memory sample. */
export function detectEncodingFromBuffer(buffer: Buffer): EncodingDetection {
    const bom = detectBom(buffer);
    if (bom) {
        return { encoding: bom.encoding, confidence: 1.0, bomLength: bom.bomLength };
    }
    if (buffer.length === 0) {
        return { encoding: 'utf-8', confidence: 1.0, bomLength: 0 };
    }
    const bomless = detectBomlessUtf16(buffer);
    if (bomless) {
        return { encoding: bomless, confidence: 0.95, bomLength: 0 };
    }
    const utf8 = classifyUtf8(buffer);
    if (utf8 === 'ascii') {
        return { encoding: 'ascii', confidence: 1.0, bomLength: 0 };
    }
    if (utf8 === 'utf-8') {
        return { encoding: 'utf-8', confidence: 0.99, bomLength: 0 };
    }
    const legacy = detectLegacy(buffer);
    return { encoding: legacy.encoding, confidence: legacy.confidence, bomLength: 0 };
}

/** Read the leading bytes of a file without loading the whole thing. */
export async function readHead(filePath: string, byteCount: number): Promise<Buffer> {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(byteCount);
        const { bytesRead } = await handle.read(buffer, 0, byteCount, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

/** Detect the encoding of a file from a bounded prefix. */
export async function detectEncoding(filePath: string): Promise<EncodingDetection> {
    const head = await readHead(filePath, ENCODING_DETECTION_BYTES);
    return detectEncodingFromBuffer(head);
}

/** Python codec name to an `iconv-lite` codec name. */
const ICONV_ALIASES: Readonly<Record<string, string>> = Object.freeze({
    'utf-8': 'utf8',
    'utf-8-sig': 'utf8',
    'utf8': 'utf8',
    'ascii': 'ascii',
    'utf-16': 'utf-16le',
    'utf-16-le': 'utf-16le',
    'utf-16-be': 'utf-16be',
    'utf-32': 'utf-32le',
    'utf-32-be': 'utf-32be',
    'latin-1': 'latin1',
    'iso-8859-1': 'latin1',
    'cp1252': 'win1252',
    'windows-1252': 'win1252',
    'cp1251': 'win1251',
    'windows-1251': 'win1251',
    'cp932': 'cp932',
    'shift_jis': 'cp932',
    'shift-jis': 'cp932',
    'sjis': 'cp932',
    'ms932': 'cp932',
    'euc-jp': 'eucjp',
    'euc_jp': 'eucjp',
    'gbk': 'gbk',
    'cp936': 'gbk',
    'gb2312': 'gbk',
    'gb18030': 'gb18030',
    'big5': 'big5',
    'cp950': 'big5',
});

/** Resolve a detected encoding name onto a decoder `iconv-lite` understands. */
export function toIconvName(encoding: string): string {
    const key = encoding.toLowerCase().trim();
    const alias = ICONV_ALIASES[key];
    if (alias) {
        return alias;
    }
    return iconv.encodingExists(key) ? key : 'utf8';
}

/**
 * Decode a buffer, stripping a leading byte-order mark.
 *
 * UTF-16 and UTF-32 BOMs are consumed by `iconv-lite`; the UTF-8 BOM is not,
 * so it is removed explicitly to match Python's `utf-8-sig` behaviour.
 */
export function decodeBuffer(buffer: Buffer, encoding: string): string {
    const codec = toIconvName(encoding);
    let text = iconv.decode(buffer, codec);
    if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
    }
    return text;
}

/** True when the encoding needs whole-code-unit alignment when chunking. */
export function bytesPerUnit(encoding: string): number {
    const codec = toIconvName(encoding);
    if (codec === 'utf-16le' || codec === 'utf-16be') {
        return 2;
    }
    if (codec === 'utf-32le' || codec === 'utf-32be') {
        return 4;
    }
    return 1;
}
