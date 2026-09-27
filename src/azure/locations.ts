import { isAzureBlobHost, isAzureDfsHost, urlparse } from '../native/sql/storage';
import { AzureBrowserError } from './errors';
import type { AzurePublicContainer } from './types';

export const MAX_PUBLIC_CONTAINER_URL_LENGTH = 2_048;
export const MAX_BLOB_PATH_LENGTH = 1_024;
const MAX_FOLDER_SEGMENTS = 99;

export interface PublicContainerLocation extends AzurePublicContainer {
    readonly prefix: string;
}

/** Unlike SQL-only URL parsing, network destinations must be canonical public-cloud hosts. */
export function azurePublicStorageAccountName(
    host: string,
    service: 'blob' | 'dfs',
): string | undefined {
    const recognized = service === 'blob' ? isAzureBlobHost(host) : isAzureDfsHost(host);
    if (!recognized || host.length > 253 || host.split('.').some((label) => label.length > 63)) {
        return undefined;
    }
    return new RegExp(
        `^([a-z0-9]{3,24})(?:\\.${service}\\.core\\.windows\\.net|\\.z\\d+\\.${service}\\.storage\\.azure\\.net)$`,
    ).exec(host)?.[1];
}

function invalidLocation(): AzureBrowserError {
    return new AzureBrowserError(
        'invalidResponse',
        'Use a known HTTPS Azure public-cloud Blob container URL or abs://container@account.blob.core.windows.net/. Credentials, ports, query strings (including SAS), and fragments are not accepted.',
    );
}

export function validContainerName(value: string): boolean {
    return value === '$root' || value === '$web' || (
        /^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/.test(value) && !value.includes('--')
    );
}

export function validBlobPath(value: string): boolean {
    // eslint-disable-next-line no-control-regex -- network paths must not contain control characters
    if (value.length > MAX_BLOB_PATH_LENGTH || /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
        return false;
    }
    const segments = value.replace(/\/$/, '').split('/');
    return value === '' || (
        segments.length <= MAX_FOLDER_SEGMENTS
        && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
    );
}

export function validBlobListingName(value: unknown, prefix: string, kind: 'folder' | 'file'): value is string {
    if (typeof value !== 'string' || !validBlobPath(value) || !value.startsWith(prefix)) {
        return false;
    }
    const relative = value.slice(prefix.length);
    return kind === 'folder'
        ? relative.endsWith('/') && relative.length > 1 && !relative.slice(0, -1).includes('/')
        : relative !== '' && !relative.includes('/');
}

function decodePath(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        throw invalidLocation();
    }
}

export function parsePublicContainerUrl(
    value: string,
    folderPrefix = '',
): PublicContainerLocation {
    if (
        value.length === 0
        || value.length > MAX_PUBLIC_CONTAINER_URL_LENGTH
        || folderPrefix.length > MAX_BLOB_PATH_LENGTH
        // eslint-disable-next-line no-control-regex -- check before URL parsers discard controls
        || /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
        || /[?#]/.test(value)
    ) {
        throw invalidLocation();
    }
    const raw = value.trim();
    const parsed = urlparse(raw);
    if (!/^(https|abs):\/\//i.test(raw)) {
        throw invalidLocation();
    }
    const authority = parsed.netloc.split('@');
    const isAbs = parsed.scheme === 'abs';
    if (authority.length !== (isAbs ? 2 : 1)) {
        throw invalidLocation();
    }
    const blobHost = authority[authority.length - 1].toLowerCase();
    const accountName = azurePublicStorageAccountName(blobHost, 'blob');
    const segments = parsed.path.replace(/^\//, '').split('/');
    const container = decodePath(isAbs ? authority[0] : segments.shift() ?? '');
    if (!accountName || !validContainerName(container)) {
        throw invalidLocation();
    }
    const urlPrefix = decodePath(segments.join('/'));
    const extraPrefix = decodePath(folderPrefix);
    if (!validBlobPath(urlPrefix) || !validBlobPath(extraPrefix)) {
        throw invalidLocation();
    }
    const combined = [urlPrefix, extraPrefix]
        .map((part) => part.replace(/\/$/, ''))
        .filter((part) => part !== '')
        .join('/');
    const prefix = combined ? `${combined}/` : '';
    if (!validBlobPath(prefix)) {
        throw invalidLocation();
    }
    return { accountName, blobHost, container, prefix };
}
