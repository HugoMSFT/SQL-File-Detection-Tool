/**
 * Public dataset / direct HTTPS support, running entirely in the extension
 * host.
 *
 * This replaces the Flask `public_data.py` endpoints. Every outbound request
 * goes through {@link ../net/safeHttp}, so the SSRF policy is identical for the
 * catalog fetch, the container listing and the file download.
 *
 * Two product rules live here as well:
 *
 *   * A downloaded file is written only inside a caller-owned directory, under
 *     a flattened, sanitised name. A `Content-Disposition` header cannot walk
 *     out of that directory or plant a dotfile.
 *   * The generated SQL only claims a URL is directly queryable when it is an
 *     Azure Blob / ADLS endpoint. An arbitrary public web server cannot be read
 *     by SQL Server, Azure SQL or Fabric, so for those the caller is told to
 *     stage the file instead of being handed a script that cannot run.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
    MAX_DOWNLOAD_BYTES,
    MAX_TEXT_BYTES,
    SafeHttpError,
    type SafeHttpDeps,
    checkDeclaredLength,
    fetchText,
    headerValue,
    open,
    throwIfCancelled,
} from './safeHttp';

/** Extensions the native core can actually analyse from a downloaded file. */
export const SUPPORTED_DATA_EXTENSIONS = [
    '.csv',
    '.tsv',
    '.dat',
    '.json',
    '.jsonl',
    '.ndjson',
    '.parquet',
    '.snappy',
    '.orc',
    '.rc',
    '.txt',
] as const;

/** Storage schemes SQL Server / Azure SQL can virtualise directly. */
export const VIRTUALISABLE_SCHEMES = ['abs:', 'adls:', 'abfss:', 'wasbs:', 'azure:'];

export const LEARN_HOST = 'learn.microsoft.com';
export const LEARN_PATH_MARKER = '/azure/open-datasets/';

export const MAX_BLOB_LIST_RESULTS = 200;

const AZURE_BLOB_HOST = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.(blob|dfs)\.core\.windows\.net$/i;

/** The supported data extension of a URL or name, or `null`. */
export function dataExtension(urlOrName: string): string | null {
    let candidate = String(urlOrName ?? '');
    if (candidate.includes('://')) {
        try {
            candidate = new URL(candidate).pathname;
        } catch {
            // Fall through and treat the whole string as a name.
        }
    }
    const lowered = candidate.toLowerCase();
    for (const extension of SUPPORTED_DATA_EXTENSIONS) {
        if (lowered.endsWith(extension)) {
            return extension;
        }
    }
    return null;
}

/**
 * Reduce an arbitrary candidate to a flat, safe file name.
 *
 * Separators are removed before sanitisation rather than after, so neither
 * `../../etc/passwd` nor a percent-encoded form of it can survive.
 */
export function safeFileName(candidate: string, fallback = 'dataset'): string {
    let name = String(candidate ?? '').replace(/\\/g, '/').trim();
    name = name.slice(name.lastIndexOf('/') + 1);
    try {
        name = decodeURIComponent(name);
    } catch {
        // A malformed escape stays as-is; the character filter below handles it.
    }
    name = name.replace(/\\/g, '/');
    name = name.slice(name.lastIndexOf('/') + 1);
    name = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '');
    if (!name || name === '.' || name === '..') {
        name = fallback;
    }
    return name.slice(0, 120);
}

/** Extract a sanitised file name from a `Content-Disposition` header. */
export function nameFromContentDisposition(header: string | undefined): string | null {
    if (!header) {
        return null;
    }
    const extended = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
    const plain = /filename="?([^";]+)"?/i.exec(header);
    const raw = (extended?.[1] ?? plain?.[1] ?? '').trim();
    if (!raw) {
        return null;
    }
    const sanitised = safeFileName(raw, '');
    return sanitised || null;
}

/** True when *url* is inside the allowlisted Learn Open Datasets doc path. */
export function isLearnOpenDatasetsUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return (
            parsed.protocol === 'https:' &&
            parsed.hostname.toLowerCase() === LEARN_HOST &&
            parsed.pathname.toLowerCase().includes(LEARN_PATH_MARKER)
        );
    } catch {
        return false;
    }
}

/**
 * The URL SQL can read directly, or `null` when the data must be staged first.
 *
 * Reporting a generic web server here would produce an `OPENROWSET` that never
 * runs, so the honest answer is `null` and the UI says "download and stage".
 */
export function storageUrlFor(url: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    // The query string is dropped deliberately. A user may paste a SAS-signed
    // URL, and this value is echoed into the state envelope and into generated
    // T-SQL that people save and commit. The signature must never travel with
    // it; SQL reads a signed URL through a DATABASE SCOPED CREDENTIAL instead.
    // `abfss://container@account/...` keeps its user-info, because there the
    // user-info is the container name rather than a credential.
    parsed.search = '';
    parsed.hash = '';
    if (parsed.protocol === 'https:') {
        parsed.username = '';
        parsed.password = '';
    }
    const unsigned = parsed.toString();
    if (VIRTUALISABLE_SCHEMES.includes(parsed.protocol)) {
        return unsigned;
    }
    if (parsed.protocol === 's3:') {
        return unsigned;
    }
    if (parsed.protocol !== 'https:') {
        return null;
    }
    return AZURE_BLOB_HOST.test(parsed.hostname) ? unsigned : null;
}

/** True when *url* points at an Azure Blob / ADLS endpoint. */
export function isAzureStorageUrl(url: string): boolean {
    try {
        return AZURE_BLOB_HOST.test(new URL(url).hostname);
    } catch {
        return false;
    }
}

export interface AzureUrlParts {
    readonly serviceUrl: string;
    readonly account: string;
    readonly container: string;
    readonly prefix: string;
}

/** Split an Azure storage URL into service root, container and prefix. */
export function azureBlobParts(url: string): AzureUrlParts | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    const host = parsed.hostname;
    if (!AZURE_BLOB_HOST.test(host)) {
        return null;
    }
    const withoutLeadingSlash = parsed.pathname.replace(/^\/+/, '');
    let container: string;
    let prefix: string;
    if (parsed.protocol === 'https:') {
        const slash = withoutLeadingSlash.indexOf('/');
        container = slash < 0 ? withoutLeadingSlash : withoutLeadingSlash.slice(0, slash);
        prefix = slash < 0 ? '' : withoutLeadingSlash.slice(slash + 1);
    } else if (VIRTUALISABLE_SCHEMES.includes(parsed.protocol)) {
        container = decodeURIComponent(parsed.username || '');
        prefix = withoutLeadingSlash;
        if (!container) {
            const slash = withoutLeadingSlash.indexOf('/');
            container = slash < 0 ? withoutLeadingSlash : withoutLeadingSlash.slice(0, slash);
            prefix = slash < 0 ? '' : withoutLeadingSlash.slice(slash + 1);
        }
    } else {
        return null;
    }
    if (!container) {
        return null;
    }
    const account = host.split('.')[0];
    return {
        serviceUrl: `https://${account}.blob.core.windows.net`,
        account,
        container,
        prefix,
    };
}

/** Trim a wildcard suffix down to a literal listing prefix. */
export function listablePrefix(prefix: string): string {
    const wildcard = prefix.search(/[*?[]/);
    if (wildcard < 0) {
        return prefix;
    }
    const head = prefix.slice(0, wildcard);
    const slash = head.lastIndexOf('/');
    return slash < 0 ? '' : head.slice(0, slash + 1);
}

export interface PublicBlob {
    readonly name: string;
    readonly sizeBytes: number | null;
    readonly url: string;
    readonly extension: string | null;
}

/** Pull the text of the first `<Tag>` inside *xml* starting at *from*. */
function firstTag(xml: string, tag: string): string | null {
    const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
    return match ? match[1] : null;
}

function decodeXmlEntities(value: string): string {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * List a bounded page of blobs under a public (anonymous) container.
 *
 * Only used to find one representative file for metadata analysis; the
 * documented dataset URL is what ends up in the generated SQL.
 */
export async function listPublicBlobs(
    url: string,
    deps: SafeHttpDeps & { maxResults?: number } = {},
): Promise<PublicBlob[]> {
    const parts = azureBlobParts(url);
    if (!parts) {
        throw new SafeHttpError(
            'That location is not an Azure Blob or ADLS URL.',
            'invalid_request',
        );
    }
    const maxResults = Math.max(
        1,
        Math.min(deps.maxResults ?? MAX_BLOB_LIST_RESULTS, MAX_BLOB_LIST_RESULTS),
    );
    const query = new URLSearchParams({
        restype: 'container',
        comp: 'list',
        prefix: listablePrefix(parts.prefix),
        maxresults: String(maxResults),
    });
    const listingUrl = `${parts.serviceUrl}/${encodeURIComponent(parts.container)}?${query}`;
    const xml = await fetchText(listingUrl, {
        ...deps,
        cap: MAX_TEXT_BYTES,
        accept: 'application/xml',
    });

    const blobs: PublicBlob[] = [];
    const blobPattern = /<Blob>([\s\S]*?)<\/Blob>/g;
    let match = blobPattern.exec(xml);
    while (match && blobs.length < maxResults) {
        const body = match[1];
        const rawName = firstTag(body, 'Name');
        if (rawName) {
            const name = decodeXmlEntities(rawName);
            const rawSize = firstTag(body, 'Content-Length');
            const size = rawSize !== null && rawSize.trim() !== '' ? Number(rawSize) : NaN;
            blobs.push({
                name,
                sizeBytes: Number.isFinite(size) ? size : null,
                url: `${parts.serviceUrl}/${encodeURIComponent(parts.container)}/${name
                    .split('/')
                    .map(encodeURIComponent)
                    .join('/')}`,
                extension: dataExtension(name),
            });
        }
        match = blobPattern.exec(xml);
    }
    return blobs;
}

/** The first publicly listed, supported, small-enough blob, or `null`. */
export async function firstSupportedBlob(
    url: string,
    deps: SafeHttpDeps & { maxResults?: number; maxBytes?: number } = {},
): Promise<PublicBlob | null> {
    const maxBytes = deps.maxBytes ?? MAX_DOWNLOAD_BYTES;
    for (const blob of await listPublicBlobs(url, deps)) {
        if (!blob.extension) {
            continue;
        }
        if (blob.sizeBytes !== null && (blob.sizeBytes === 0 || blob.sizeBytes > maxBytes)) {
            continue;
        }
        return blob;
    }
    return null;
}

export interface DownloadResult {
    readonly path: string;
    readonly fileName: string;
    readonly bytes: number;
    readonly sourceUrl: string;
    readonly finalUrl: string;
}

/**
 * Stream a supported data file from *url* into *destinationDir*.
 *
 * The caller owns `destinationDir` and must have created it inside a trusted
 * root; nothing here ever writes outside it.
 */
export async function downloadDataFile(
    url: string,
    destinationDir: string,
    deps: SafeHttpDeps & { maxBytes?: number } = {},
): Promise<DownloadResult> {
    const maxBytes = deps.maxBytes ?? MAX_DOWNLOAD_BYTES;
    const root = await fs.promises.realpath(destinationDir);
    if (!(await fs.promises.stat(root)).isDirectory()) {
        throw new SafeHttpError('The download directory does not exist.', 'unsafe_path', 500);
    }

    const extension = dataExtension(url);
    if (!extension) {
        throw new SafeHttpError(
            'That URL does not point at a supported data file. Supported extensions: ' +
                `${SUPPORTED_DATA_EXTENSIONS.join(', ')}.`,
            'unsupported_type',
        );
    }

    const { response, finalUrl } = await open(url, 'application/octet-stream', deps);
    checkDeclaredLength(response.headers, maxBytes);

    let name =
        nameFromContentDisposition(headerValue(response.headers, 'content-disposition')) ??
        safeFileName(new URL(url).pathname);
    if (!dataExtension(name)) {
        name = `${name}${extension}`;
    }

    const target = path.join(root, name);
    // `name` is already flattened, but proving containment costs nothing and
    // means a future change to the sanitiser cannot silently open an escape.
    if (path.dirname(path.resolve(target)) !== root) {
        response.destroy();
        throw new SafeHttpError(
            'Refusing to write outside the download directory.',
            'unsafe_path',
            500,
        );
    }

    let written = 0;
    const handle = await fs.promises.open(target, 'w');
    try {
        for await (const chunk of response.body) {
            throwIfCancelled(deps.signal);
            written += chunk.length;
            if (written > maxBytes) {
                throw new SafeHttpError(
                    `The download exceeded the ${maxBytes.toLocaleString('en-US')} byte limit.`,
                    'too_large',
                    413,
                );
            }
            await handle.write(chunk);
        }
    } catch (error) {
        await handle.close();
        await fs.promises.rm(target, { force: true });
        response.destroy();
        throw error;
    }
    await handle.close();
    response.destroy();

    if (written === 0) {
        await fs.promises.rm(target, { force: true });
        throw new SafeHttpError('The server returned an empty file.', 'empty_response', 502);
    }

    return { path: target, fileName: name, bytes: written, sourceUrl: url, finalUrl };
}
