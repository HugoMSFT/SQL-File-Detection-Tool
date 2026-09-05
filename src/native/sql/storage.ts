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

const S3_SCHEMES: ReadonlySet<string> = new Set(['s3']);

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

const AZURE_BLOB_SUFFIXES = [
    'blob.core.windows.net',
    'blob.core.usgovcloudapi.net',
    'blob.core.chinacloudapi.cn',
    'blob.core.cloudapi.de',
] as const;

const AZURE_DFS_SUFFIXES = [
    'dfs.core.windows.net',
    'dfs.core.usgovcloudapi.net',
    'dfs.core.chinacloudapi.cn',
    'dfs.core.cloudapi.de',
] as const;

/** Host name from a URL authority that may contain user info or a port. */
export function authorityHostname(authority: string): string {
    const withoutUser = authority.slice(authority.lastIndexOf('@') + 1);
    if (withoutUser.startsWith('[')) {
        const end = withoutUser.indexOf(']');
        return (end >= 0 ? withoutUser.slice(1, end) : withoutUser).toLowerCase();
    }
    return withoutUser.split(':')[0].toLowerCase();
}

function hasDnsSuffix(host: string, suffixes: readonly string[]): boolean {
    const normalized = host.toLowerCase().replace(/\.$/, '');
    return suffixes.some((suffix) => normalized.endsWith(`.${suffix}`));
}

/** Documented Azure Blob endpoint, including sovereign and private-link forms. */
export function isAzureBlobHost(host: string): boolean {
    return hasDnsSuffix(host, AZURE_BLOB_SUFFIXES);
}

/** Documented Azure Data Lake endpoint, including sovereign and private-link forms. */
export function isAzureDfsHost(host: string): boolean {
    return hasDnsSuffix(host, AZURE_DFS_SUFFIXES);
}

/**
 * OneLake DFS endpoints supported by ABFS:
 * global, regional, and workspace-private FQDNs.
 */
export function isOneLakeDfsHost(host: string): boolean {
    const normalized = host.toLowerCase().replace(/\.$/, '');
    return (
        /^(?:[a-z0-9-]+-)?onelake\.dfs\.fabric\.microsoft\.com$/.test(normalized)
        || isOneLakePrivateDfsHost(normalized)
    );
}

/** Workspace-private OneLake DFS endpoint. */
export function isOneLakePrivateDfsHost(host: string): boolean {
    return /^([0-9a-f]{2})(?:[0-9a-f]{30}|[0-9a-f]{6}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.z\1\.dfs\.fabric\.microsoft\.com$/.test(
        host.toLowerCase().replace(/\.$/, ''),
    );
}

const CLOUD_URL_SCHEMES: ReadonlySet<string> = new Set([
    'abs',
    'wasb',
    'wasbs',
    'adls',
    'abfs',
    'abfss',
    'azure',
    's3',
    'gs',
    'http',
    'https',
    'onelake',
]);

const AZURE_PLACEHOLDER_ACCOUNT = '<storage_account>.dfs.core.windows.net';

/** Default OneLake external data source location. */
export const FABRIC_DEFAULT_SOURCE_LOCATION =
    'abfss://<workspace_id>@onelake.dfs.fabric.microsoft.com/<item_id>/Files';

/** Classify a storage URL, so a platform's reachability can be checked. */
export function storageUrlKind(storageUrl: string | null | undefined): StorageKind {
    if (storageUrl === null || storageUrl === undefined || storageUrl === '') {
        return 'local';
    }

    const normalized = String(storageUrl).trim().replace(/\\/g, '/');
    const parsed = urlparse(normalized);
    const scheme = parsed.scheme;
    const host = authorityHostname(parsed.netloc);
    if (
        (scheme === 'http' || scheme === 'https' || scheme === 's3')
        && parsed.netloc.includes('@')
    ) {
        return 'other';
    }

    if (S3_SCHEMES.has(scheme)) {
        return host && parsed.path.split('/').filter(Boolean).length > 0
            ? 's3'
            : 'other';
    }
    if (
        ['abfs', 'abfss', 'http', 'https'].includes(scheme)
        && isOneLakeDfsHost(host)
    ) {
        return 'onelake';
    }
    if (scheme === 'azure') {
        return 'azure';
    }
    if (
        ['abs', 'wasb', 'wasbs'].includes(scheme)
        && isAzureBlobHost(host)
    ) {
        return 'azure';
    }
    if (
        ['adls', 'abfs', 'abfss'].includes(scheme)
        && isAzureDfsHost(host)
    ) {
        return 'azure';
    }
    if (
        (scheme === 'http' || scheme === 'https') &&
        (isAzureBlobHost(host) || isAzureDfsHost(host))
    ) {
        return 'azure';
    }
    if (
        CLOUD_URL_SCHEMES.has(scheme)
        || scheme === 'ftp'
        || (scheme.length > 1)
    ) {
        return 'other';
    }
    return 'local';
}

/** Whether a real storage URL is supported by the selected SQL platform. */
export function storageUrlSupportedByPlatform(
    storageUrl: string | null | undefined,
    platform: TargetPlatform,
): boolean {
    const kind = storageUrlKind(storageUrl);
    if (kind === 'local') {
        return true;
    }
    if (platform === 'fabric_sql_db') {
        return kind === 'onelake';
    }
    if (platform === 'azure_sql_db' || platform === 'azure_sql_mi') {
        return kind === 'azure';
    }
    if (platform === 'sql_server_2022' || platform === 'sql_server_2025') {
        return kind === 'azure' || kind === 's3';
    }
    if (platform !== 'sql_server_2019' || kind !== 'azure') {
        return false;
    }
    const parsed = urlparse(String(storageUrl).trim().replace(/\\/g, '/'));
    return isAzureBlobHost(authorityHostname(parsed.netloc)) || parsed.scheme === 'azure';
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

    const hostname = authorityHostname(host);
    const validSchemeHost =
        (['abs', 'wasb', 'wasbs'].includes(scheme) && isAzureBlobHost(hostname))
        || (['adls', 'abfs', 'abfss'].includes(scheme) && isAzureDfsHost(hostname));
    if (scheme in schemeMap && host !== '' && validSchemeHost) {
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
        if (isAzureDfsHost(authorityHostname(lowerHost))) {
            targetScheme = is2019 ? 'abfss' : 'adls';
        } else if (isAzureBlobHost(authorityHostname(lowerHost))) {
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
        // `s3://bucket/key` is the standard AWS SDK spelling, but SQL Server
        // needs an endpoint plus bucket. Convert an unambiguous short bucket
        // name to the documented path-style AWS endpoint form.
        if (
            !authorityHostname(host).includes('.') &&
            !host.includes(':') &&
            !(host.startsWith('<') && host.endsWith('>'))
        ) {
            return [`s3://s3.amazonaws.com/${host}`, path || fallback];
        }
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

    const hostname = authorityHostname(host);
    const validSchemeHost =
        (['abs', 'wasb', 'wasbs'].includes(scheme) && isAzureBlobHost(hostname))
        || (['adls', 'abfs', 'abfss'].includes(scheme) && isAzureDfsHost(hostname));
    if (AZURE_STORAGE_SCHEMES.has(scheme) && host !== '' && validSchemeHost) {
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
        (isAzureBlobHost(authorityHostname(lowerHost)) ||
            isAzureDfsHost(authorityHostname(lowerHost)))
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
    const blobHost = account.replace(/\.dfs\.(core\.[^.]+\.[^.]+)$/i, '.blob.$1');
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
        isAzureDfsHost(authorityHostname(lowerAccount))
        || isOneLakeDfsHost(authorityHostname(lowerAccount))
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

    if (
        (scheme === 'abfs' || scheme === 'abfss')
        && host !== ''
        && isOneLakeDfsHost(authorityHostname(host))
    ) {
        const [root, separator, remainder] = splitOnFilesSegment(path);
        if (!separator) {
            return fallbackPair;
        }
        return [`abfss://${host}/${root}`, remainder || fallback];
    }

    if (
        (scheme === 'http' || scheme === 'https') &&
        host !== '' &&
        isOneLakeDfsHost(authorityHostname(host))
    ) {
        const privateHost = isOneLakePrivateDfsHost(authorityHostname(host));
        const [pathWorkspace, separator, remainder] = partition(path, '/');
        const workspace = privateHost
            ? authorityHostname(host).split('.')[0]
            : pathWorkspace;
        const itemPath = privateHost ? path : remainder;
        if (!privateHost && !separator) {
            return fallbackPair;
        }
        const [root, filesSeparator, tail] = splitOnFilesSegment(itemPath);
        if (!filesSeparator) {
            return fallbackPair;
        }
        return [`abfss://${workspace}@${host}/${root}`, tail || fallback];
    }

    return fallbackPair;
}
