/**
 * Parsing and validation for Azure Storage identifiers.
 *
 * Everything here is pure, so the rules that decide what counts as a usable
 * account, SAS URL or connection string can be tested exhaustively without a
 * network or an `@azure/storage-blob` client.
 *
 * The functions deliberately return the *secret-bearing* parts separately from
 * the *displayable* parts. Callers put the former into memory or
 * `SecretStorage` and the latter into the webview state, which is how the
 * "no credential ever reaches the renderer" rule is kept mechanical rather
 * than a matter of remembering.
 */

/** Storage account names are 3-24 characters of lowercase letters and digits. */
const ACCOUNT_NAME = /^[a-z0-9]{3,24}$/;

const BLOB_HOST = /^([a-z0-9]{3,24})\.(blob|dfs)\.core\.(windows\.net|chinacloudapi\.cn|cloudapi\.de)$/i;
const GOV_BLOB_HOST = /^([a-z0-9]{3,24})\.(blob|dfs)\.core\.usgovcloudapi\.net$/i;

/** Container names are 3-63 characters, lowercase, no leading/trailing dash. */
const CONTAINER_NAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,61}[a-z0-9]$/;

export class AzureInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AzureInputError';
    }
}

/** True when *name* is a syntactically valid storage account name. */
export function isValidAccountName(name: string): boolean {
    return ACCOUNT_NAME.test(String(name ?? '').trim());
}

/** True when *name* is a syntactically valid container name. */
export function isValidContainerName(name: string): boolean {
    const candidate = String(name ?? '').trim();
    return candidate.length >= 3 && candidate.length <= 63 && CONTAINER_NAME.test(candidate);
}

/**
 * True when *name* is a blob name the extension is willing to address.
 *
 * Azure permits a lot inside a blob name, but a name containing `..` segments
 * or a backslash is never needed here and is exactly the shape that turns into
 * a path traversal once the blob is written to a temp directory.
 */
export function isSafeBlobName(name: string): boolean {
    const candidate = String(name ?? '');
    if (candidate.length === 0 || candidate.length > 1024) {
        return false;
    }
    if (candidate.includes('\\') || candidate.includes('\0')) {
        return false;
    }
    if (candidate.startsWith('/')) {
        return false;
    }
    return !candidate.split('/').some((segment) => segment === '..' || segment === '.');
}

/** The blob service endpoint for *account*. */
export function serviceUrlFor(account: string, suffix = 'core.windows.net'): string {
    if (!isValidAccountName(account)) {
        throw new AzureInputError('That is not a valid storage account name.');
    }
    if (!/^[a-z0-9.]{4,64}$/i.test(suffix)) {
        throw new AzureInputError('That is not a valid storage endpoint suffix.');
    }
    return `https://${account}.blob.${suffix}`;
}

/** The account name embedded in an Azure blob endpoint host, or `null`. */
export function accountFromHost(hostname: string): string | null {
    const match = BLOB_HOST.exec(hostname) ?? GOV_BLOB_HOST.exec(hostname);
    return match ? match[1].toLowerCase() : null;
}

export interface ParsedSasUrl {
    readonly account: string;
    /** Service endpoint with no query string. Safe to display. */
    readonly serviceUrl: string;
    /** Container the SAS is scoped to, when it is a container or blob SAS. */
    readonly container: string | null;
    readonly prefix: string;
    /** The raw `?sv=...&sig=...` query. Secret: never send this to a webview. */
    readonly sasToken: string;
}

/**
 * Parse a user-supplied SAS URL.
 *
 * A SAS URL is a credential, so the parse is strict: HTTPS, a recognised Azure
 * blob endpoint, and an actual signature. Accepting a lookalike host would send
 * the user's signature somewhere it does not belong.
 */
export function parseSasUrl(candidate: string): ParsedSasUrl {
    const trimmed = String(candidate ?? '').trim();
    if (!trimmed) {
        throw new AzureInputError('A SAS URL is required.');
    }
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        throw new AzureInputError('That SAS URL could not be parsed.');
    }
    if (url.protocol !== 'https:') {
        throw new AzureInputError('A SAS URL must use https://.');
    }
    const account = accountFromHost(url.hostname);
    if (!account) {
        throw new AzureInputError(
            'That host is not an Azure Blob Storage endpoint (account.blob.core.windows.net).',
        );
    }
    if (!url.searchParams.get('sig')) {
        throw new AzureInputError(
            'That URL has no SAS signature. Copy the full URL including the "?sv=..." query.',
        );
    }
    const segments = url.pathname.replace(/^\/+/, '').split('/');
    const container = segments[0] ? segments[0] : null;
    if (container && !isValidContainerName(container)) {
        throw new AzureInputError('That SAS URL contains an invalid container name.');
    }
    return {
        account,
        serviceUrl: `${url.protocol}//${url.host}`,
        container,
        prefix: segments.slice(1).join('/'),
        sasToken: url.search.replace(/^\?/, ''),
    };
}

export interface ParsedConnectionString {
    readonly account: string;
    readonly serviceUrl: string;
    /** Present for an account-key connection string. Secret. */
    readonly accountKey: string | null;
    /** Present for a SAS connection string. Secret. */
    readonly sasToken: string | null;
}

/**
 * Parse an account connection string.
 *
 * Only the fields the extension actually needs are read; anything else in the
 * string is ignored rather than forwarded, so a stray `DefaultEndpointsProtocol`
 * or table/queue endpoint cannot redirect a blob request.
 */
export function parseConnectionString(candidate: string): ParsedConnectionString {
    const trimmed = String(candidate ?? '').trim();
    if (!trimmed) {
        throw new AzureInputError('A connection string is required.');
    }
    const fields = new Map<string, string>();
    for (const pair of trimmed.split(';')) {
        const separator = pair.indexOf('=');
        if (separator <= 0) {
            continue;
        }
        const key = pair.slice(0, separator).trim().toLowerCase();
        const value = pair.slice(separator + 1).trim();
        if (key && value && !fields.has(key)) {
            fields.set(key, value);
        }
    }

    const account = (fields.get('accountname') ?? '').toLowerCase();
    if (!isValidAccountName(account)) {
        throw new AzureInputError(
            'That connection string has no usable AccountName.',
        );
    }
    const suffix = fields.get('endpointsuffix') ?? 'core.windows.net';
    const explicitEndpoint = fields.get('blobendpoint');
    let serviceUrl: string;
    if (explicitEndpoint) {
        let endpoint: URL;
        try {
            endpoint = new URL(explicitEndpoint);
        } catch {
            throw new AzureInputError('That connection string has an unusable BlobEndpoint.');
        }
        if (endpoint.protocol !== 'https:' || !accountFromHost(endpoint.hostname)) {
            throw new AzureInputError(
                'BlobEndpoint must be an https:// Azure Blob Storage endpoint.',
            );
        }
        serviceUrl = `${endpoint.protocol}//${endpoint.host}`;
    } else {
        serviceUrl = serviceUrlFor(account, suffix);
    }

    const accountKey = fields.get('accountkey') ?? null;
    const sasToken = (fields.get('sharedaccesssignature') ?? null)?.replace(/^\?/, '') ?? null;
    if (!accountKey && !sasToken) {
        throw new AzureInputError(
            'That connection string has neither an AccountKey nor a SharedAccessSignature.',
        );
    }
    return { account, serviceUrl, accountKey, sasToken };
}

/**
 * Strip anything credential-shaped out of text bound for a log, a notification
 * or the webview.
 *
 * The extension's own code paths never put a secret in an error, but an SDK or
 * a service can echo a signed URL back inside a message, so this runs on every
 * Azure error before it is shown or written.
 */
export function redactAzure(text: unknown): string {
    let value = String(text ?? '');
    value = value.replace(/([?&](?:sig|skoid|sktid|sks|si|se|st|sp|spr|srt|ss)=)[^&\s"']+/gi, '$1<redacted>');
    value = value.replace(
        /(AccountKey|SharedAccessSignature|SharedAccessKey)=[^;\s"']+/gi,
        '$1=<redacted>',
    );
    value = value.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer <redacted>');
    value = value.replace(/\beyJ[A-Za-z0-9._-]{10,}/g, '<redacted-token>');
    return value;
}

/** A short, non-secret label describing how the extension is authenticated. */
export function describeAuthMode(mode: string): string {
    switch (mode) {
        case 'vscode':
            return 'VS Code Microsoft account';
        case 'sas':
            return 'Shared access signature';
        case 'connectionString':
            return 'Connection string';
        case 'anonymous':
            return 'Anonymous public access';
        default:
            return 'Not connected';
    }
}
