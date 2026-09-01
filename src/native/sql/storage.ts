/**
 * Storage-location parsing for the SQL generator.
 *
 * Generated SQL must never embed a local path where a container-relative path
 * belongs, and must never leak an absolute URL into a `BULK`/`LOCATION` clause.
 * These helpers are a direct port of the Python module-level functions and keep
 * the same placeholder behaviour when part of a URL cannot be derived.
 */

import type { StorageKind, TargetPlatform } from '../types';

/** Result of Python's `urllib.parse.urlparse`, limited to what we consume. */
export interface ParsedUrl {
    scheme: string;
    netloc: string;
    path: string;
}

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*$/;

/**
 * A faithful subset of Python's `urlparse`.
 *
 * Node's `URL` rejects the relative and Windows-style values this generator
 * routinely sees, and normalises paths in ways Python does not, so the parsing
 * rules are reproduced directly instead.
 */
export function urlparse(value: string): ParsedUrl {
    let rest = value;
    let scheme = '';

    const colon = rest.indexOf(':');
    if (colon > 0 && SCHEME_PATTERN.test(rest.slice(0, colon))) {
        scheme = rest.slice(0, colon).toLowerCase();
        rest = rest.slice(colon + 1);
    }

    let netloc = '';
    if (rest.startsWith('//')) {
        const remainder = rest.slice(2);
        const delimiters = [remainder.indexOf('/'), remainder.indexOf('?'), remainder.indexOf('#')]
            .filter((index) => index >= 0);
        const end = delimiters.length > 0 ? Math.min(...delimiters) : remainder.length;
        netloc = remainder.slice(0, end);
        rest = remainder.slice(end);
    }

    const withoutFragment = rest.split('#')[0];
    const path = withoutFragment.split('?')[0];
    return { scheme, netloc, path };
}

/** `os.path.basename` over a slash-normalised path. */
export function baseName(value: string): string {
    const normalised = String(value).replace(/\\/g, '/');
    const segments = normalised.split('/');
    return segments[segments.length - 1];
}

function fallbackFileName(fileName: string): string {
    return baseName(fileName) || '<file>';
}

const S3_SCHEMES: ReadonlySet<string> = new Set(['s3', 's3a', 's3n']);

/** Platforms whose bulk readers can reach S3-compatible object storage. */
export const S3_BULK_PLATFORMS: ReadonlySet<TargetPlatform> = new Set([
    'sql_server_2022',
    'sql_server_2025',
]);

const AZURE_STORAGE_SCHEMES: ReadonlySet<string> = new Set([
    'abs',
    'wasb',
    'wasbs',
    'adls',
    'abfs',
    'abfss',
]);

const CLOUD_URL_SCHEMES: ReadonlySet<string> = new Set([
    'abs',
    'wasb',
    'wasbs',
    'adls',
    'abfs',
    'abfss',
    'azure',
    's3',
    's3a',
    's3n',
    'gs',
    'http',
    'https',
    'onelake',
]);

const AZURE_PLACEHOLDER_ACCOUNT = '<storage_account>.dfs.core.windows.net';

/** Default OneLake external data source location. */
export const FABRIC_DEFAULT_SOURCE_LOCATION =
    'abfss://<workspace_id>@<tenant>.dfs.fabric.microsoft.com/<lakehouse_id>/Files';

/** Classify a storage URL, so a platform's reachability can be checked. */
export function storageUrlKind(storageUrl: string | null | undefined): StorageKind {
    if (storageUrl === null || storageUrl === undefined || storageUrl === '') {
        return 'local';
    }
    const normalized = String(storageUrl).trim().replace(/\\/g, '/');
    const parsed = urlparse(normalized);
    const scheme = parsed.scheme;
    const host = parsed.netloc.toLowerCase();

    if (S3_SCHEMES.has(scheme)) {
        return 's3';
    }
    if (host.includes('fabric.microsoft.com') || host.startsWith('onelake.')) {
        return 'onelake';
    }
    if (AZURE_STORAGE_SCHEMES.has(scheme) || scheme === 'azure') {
        return 'azure';
    }
    if (
        (scheme === 'http' || scheme === 'https') &&
        (host.endsWith('.blob.core.windows.net') || host.endsWith('.dfs.core.windows.net'))
    ) {
        return 'azure';
    }
    if (scheme === 'http' || scheme === 'https' || scheme === 'gs' || scheme === 'ftp') {
        return 'other';
    }
    return 'local';
}

/** True when the value points at remote object storage. */
export function looksLikeCloudUrl(storageUrl: string | null | undefined): boolean {
    if (storageUrl === null || storageUrl === undefined || storageUrl === '') {
        return false;
    }
    const scheme = urlparse(String(storageUrl).trim().replace(/\\/g, '/')).scheme;
    return CLOUD_URL_SCHEMES.has(scheme);
}

function partition(value: string, separator: string): [string, boolean, string] {
    const index = value.indexOf(separator);
    if (index < 0) {
        return [value, false, ''];
    }
    return [value.slice(0, index), true, value.slice(index + separator.length)];
}

/** Return a SQL Server external data source location and relative file path. */
export function sqlServerStorageParts(
    storageUrl: string | null | undefined,
    fileName: string,
    targetPlatform: TargetPlatform,
): [string, string] {
    const fallback = fallbackFileName(fileName);
    const is2019 = targetPlatform === 'sql_server_2019';
    const defaultLocation = is2019
        ? 'wasbs://<container>@<storage_account>.blob.core.windows.net'
        : 'adls://<container>@<storage_account>.dfs.core.windows.net';
    const defaultPath = `<path>/${fallback}`;

    if (storageUrl === null || storageUrl === undefined || storageUrl === '') {
        return [defaultLocation, defaultPath];
    }

    const normalized = String(storageUrl).trim().replace(/\\/g, '/');
    const parsed = urlparse(normalized);
    const scheme = parsed.scheme;
    let host = parsed.netloc;
    const path = parsed.path.replace(/^\/+|\/+$/g, '');

    const schemeMap: Record<string, string> = {
        abs: is2019 ? 'wasbs' : 'abs',
        wasb: is2019 ? 'wasbs' : 'abs',
        wasbs: is2019 ? 'wasbs' : 'abs',
        adls: is2019 ? 'abfss' : 'adls',
        abfs: is2019 ? 'abfss' : 'adls',
        abfss: is2019 ? 'abfss' : 'adls',
    };

    if (scheme in schemeMap && host !== '') {
        const targetScheme = schemeMap[scheme];
        let relativePath = path;
        if (!host.includes('@') && path !== '') {
            const [container, separator, remainder] = partition(path, '/');
            host = `${container}@${host}`;
            relativePath = separator ? remainder : '';
        }
        return [`${targetScheme}://${host}`, relativePath || fallback];
    }

    if (scheme === 'https' && host !== '') {
        const [container, separator, remainder] = partition(path, '/');
        const lowerHost = host.toLowerCase();
        let targetScheme: string;
        if (lowerHost.endsWith('.dfs.core.windows.net')) {
            targetScheme = is2019 ? 'abfss' : 'adls';
        } else if (lowerHost.endsWith('.blob.core.windows.net')) {
            targetScheme = is2019 ? 'wasbs' : 'abs';
        } else {
            return [defaultLocation, path || fallback];
        }
        const sourceHost = container !== '' ? `${container}@${host}` : host;
        return [
            `${targetScheme}://${sourceHost}`,
            separator && remainder !== '' ? remainder : fallback,
        ];
    }

    if (scheme === 's3' && host !== '' && !is2019) {
        return [`s3://${host}`, path || fallback];
    }

    if (scheme === 'azure' && host !== '') {
        // Internal `azure://<container>/<path>` URL from the Azure storage
        // handler: the account is unknown, so emit a placeholder root.
        const targetScheme = is2019 ? 'wasbs' : 'abs';
        return [
            `${targetScheme}://${host}@<storage_account>.blob.core.windows.net`,
            path || fallback,
        ];
    }

    if (scheme === 'http' || scheme === 'https' || scheme === 's3' || scheme === 'gs') {
        // Unknown remote endpoint: never leak an absolute URL.
        return [defaultLocation, path || fallback];
    }

    return [defaultLocation, normalized.replace(/^\/+/, '') || fallback];
}

/** Split an Azure storage URL into `[accountHost, container, relativePath]`. */
export function parseAzureStorageUrl(
    storageUrl: string | null | undefined,
    fileName: string,
): [string, string, string] {
    const fallback = fallbackFileName(fileName);
    const fallbackTriple: [string, string, string] = [
        AZURE_PLACEHOLDER_ACCOUNT,
        '<container>',
        `<path>/${fallback}`,
    ];
    if (storageUrl === null || storageUrl === undefined || storageUrl === '') {
        return fallbackTriple;
    }

    const normalized = String(storageUrl).trim().replace(/\\/g, '/');
    const parsed = urlparse(normalized);
    const scheme = parsed.scheme;
    const host = parsed.netloc;
    const path = parsed.path.replace(/^\/+|\/+$/g, '');

    if (AZURE_STORAGE_SCHEMES.has(scheme) && host !== '') {
        if (host.includes('@')) {
            const [container, , account] = partition(host, '@');
            return [
                account || AZURE_PLACEHOLDER_ACCOUNT,
                container || '<container>',
                path || fallback,
            ];
        }
        const [container, separator, remainder] = partition(path, '/');
        return [host, container || '<container>', (separator ? remainder : '') || fallback];
    }

    const lowerHost = host.toLowerCase();
    if (
        (scheme === 'http' || scheme === 'https') &&
        (lowerHost.endsWith('.blob.core.windows.net') ||
            lowerHost.endsWith('.dfs.core.windows.net'))
    ) {
        const [container, separator, remainder] = partition(path, '/');
        return [host, container || '<container>', (separator ? remainder : '') || fallback];
    }

    if (scheme === 'azure' && host !== '') {
        return [AZURE_PLACEHOLDER_ACCOUNT, host, path || fallback];
    }

    return fallbackTriple;
}

/**
 * Return an HTTPS blob container root and container-relative path.
 *
 * Bulk access to Azure Blob Storage needs a `DATA_SOURCE` of
 * `TYPE = BLOB_STORAGE` whose `LOCATION` is an `https://` blob endpoint;
 * `abs://` and `adls://` locations are not accepted there.
 */
export function azureBulkStorageParts(
    storageUrl: string | null | undefined,
    fileName: string,
): [string, string] {
    const [account, container, relativePath] = parseAzureStorageUrl(storageUrl, fileName);
    const blobHost = account.replace(/\.dfs\.core\.windows\.net$/i, '.blob.core.windows.net');
    return [`https://${blobHost}/${container}`, relativePath];
}

/** Return an `abs://` / `adls://` data source location and relative path. */
export function azureVirtualizationParts(
    storageUrl: string | null | undefined,
    fileName: string,
): [string, string] {
    const [account, container, relativePath] = parseAzureStorageUrl(storageUrl, fileName);
    const lowerAccount = account.toLowerCase();
    const prefix =
        lowerAccount.endsWith('.dfs.core.windows.net')
        || lowerAccount.endsWith('.dfs.fabric.microsoft.com')
            ? 'adls'
            : 'abs';
    return [`${prefix}://${container}@${account}`, relativePath];
}

/** Split a path on its first `Files` segment, inclusive. */
export function splitOnFilesSegment(path: string): [string, boolean, string] {
    const segments = path.split('/');
    for (let index = 0; index < segments.length; index += 1) {
        if (segments[index].toLowerCase() === 'files') {
            return [
                segments.slice(0, index + 1).join('/'),
                true,
                segments.slice(index + 1).join('/'),
            ];
        }
    }
    return [path, false, ''];
}

/** Split a OneLake path into a `.../Files` source root and relative path. */
export function fabricOnelakeParts(
    storageUrl: string | null | undefined,
    fileName: string,
): [string, string] {
    const fallback = fallbackFileName(fileName);
    const fallbackPair: [string, string] = [
        FABRIC_DEFAULT_SOURCE_LOCATION,
        `<path>/${fallback}`,
    ];
    if (storageUrl === null || storageUrl === undefined || storageUrl === '') {
        return fallbackPair;
    }

    const normalized = String(storageUrl).trim().replace(/\\/g, '/');
    const parsed = urlparse(normalized);
    const scheme = parsed.scheme;
    const host = parsed.netloc;
    const path = parsed.path.replace(/^\/+|\/+$/g, '');

    if ((scheme === 'abfs' || scheme === 'abfss') && host !== '') {
        const [root, separator, remainder] = splitOnFilesSegment(path);
        if (!separator) {
            return fallbackPair;
        }
        return [`abfss://${host}/${root}`, remainder || fallback];
    }

    if (
        (scheme === 'http' || scheme === 'https') &&
        host !== '' &&
        host.toLowerCase().includes('fabric.microsoft.com')
    ) {
        const [workspace, separator, remainder] = partition(path, '/');
        if (!separator) {
            return fallbackPair;
        }
        const [root, filesSeparator, tail] = splitOnFilesSegment(remainder);
        if (!filesSeparator) {
            return fallbackPair;
        }
        return [`abfss://${workspace}@${host}/${root}`, tail || fallback];
    }

    return fallbackPair;
}
