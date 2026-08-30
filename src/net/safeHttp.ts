/**
 * The extension host's only outbound HTTP path for user-supplied URLs.
 *
 * The guarantees, which the tests assert individually, are:
 *
 *   * HTTPS only. No plaintext, no `file:`, no `ftp:`, no scheme-relative URL.
 *   * No credentials in the URL (`https://user:pass@host/`) — those would be
 *     sent to a host the user may not control and would end up in logs.
 *   * The host is resolved and every resulting address must be publicly
 *     routable. Loopback, RFC 1918, CGNAT, link-local (including the cloud
 *     metadata endpoint at 169.254.169.254) and IPv4-mapped forms of all of
 *     those are rejected.
 *   * The socket connects to an address the guard checked, because the guard
 *     is installed as the connection's DNS `lookup`. That closes the DNS
 *     rebinding window that a validate-then-connect-by-name design leaves open.
 *   * Redirects are followed manually, revalidating the full policy on every
 *     hop, and are capped.
 *   * Responses are capped by declared `Content-Length` *and* by bytes actually
 *     read, so a lying or chunked server cannot exhaust memory or disk.
 *   * Every request has a timeout.
 *
 * `vscode` is not imported, and both DNS and the transport are injectable, so
 * the whole module is testable with no live network access.
 */

import * as dns from 'dns';
import * as https from 'https';
import type { LookupFunction } from 'net';

import { isIpLiteral, isPublicAddress } from './ipGuard';

export const MAX_REDIRECTS = 5;
export const REQUEST_TIMEOUT_MS = 15_000;
/** Matches the Python implementation's upload/download ceiling. */
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
/** Catalog and container-listing documents are far smaller than this. */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_URL_LENGTH = 2048;
export const USER_AGENT = 'SQLFileDetectionTool/native-public-data';

export type SafeHttpErrorCode =
    | 'invalid_request'
    | 'scheme_not_allowed'
    | 'credentials_not_allowed'
    | 'host_not_allowed'
    | 'port_not_allowed'
    | 'dns_failure'
    | 'too_many_redirects'
    | 'bad_redirect'
    | 'upstream_error'
    | 'timeout'
    | 'too_large'
    | 'cancelled'
    | 'empty_response'
    | 'unsupported_type'
    | 'unsafe_path';

/** A user-visible failure that carries no credential and no internal detail. */
export class SafeHttpError extends Error {
    constructor(
        message: string,
        readonly code: SafeHttpErrorCode = 'invalid_request',
        readonly status = 400,
    ) {
        super(message);
        this.name = 'SafeHttpError';
    }
}

function reject(
    message: string,
    code: SafeHttpErrorCode = 'invalid_request',
    status = 400,
): never {
    throw new SafeHttpError(message, code, status);
}

/** Resolves a host name to every address it maps to. */
export type HostResolver = (hostname: string) => Promise<string[]>;

/** One raw HTTP response, deliberately smaller than Node's `IncomingMessage`. */
export interface RawResponse {
    readonly statusCode: number;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly body: AsyncIterable<Buffer>;
    destroy(): void;
}

export interface RequestOptions {
    readonly headers: Record<string, string>;
    readonly timeoutMs: number;
    /** Guarded DNS lookup the transport must use when connecting. */
    readonly lookup: LookupFunction;
    /** Aborts the request when the user cancels the operation. */
    readonly signal?: AbortSignal;
}

export type RequestImpl = (url: string, options: RequestOptions) => Promise<RawResponse>;

export interface SafeHttpDeps {
    readonly resolve?: HostResolver;
    readonly request?: RequestImpl;
    readonly maxRedirects?: number;
    readonly timeoutMs?: number;
    /**
     * Cancellation for the whole operation.
     *
     * Checked between redirect hops and on every chunk, so cancelling a large
     * download stops reading rather than merely discarding the result.
     */
    readonly signal?: AbortSignal;
}

/** Throw the cancellation error when *signal* has been aborted. */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw new SafeHttpError('The request was cancelled.', 'cancelled', 499);
    }
}

const defaultResolver: HostResolver = async (hostname) => {
    const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
};

const defaultRequest: RequestImpl = (url, options) =>
    new Promise<RawResponse>((resolveRequest, rejectRequest) => {
        const request = https.request(
            url,
            {
                method: 'GET',
                headers: options.headers,
                timeout: options.timeoutMs,
                lookup: options.lookup,
                signal: options.signal,
            },
            (response) => {
                resolveRequest({
                    statusCode: response.statusCode ?? 0,
                    headers: response.headers as Record<
                        string,
                        string | string[] | undefined
                    >,
                    body: response,
                    destroy: () => response.destroy(),
                });
            },
        );
        request.on('timeout', () => {
            request.destroy(new SafeHttpError('The request timed out.', 'timeout', 504));
        });
        request.on('error', (error: NodeJS.ErrnoException) => {
            rejectRequest(
                error instanceof SafeHttpError
                    ? error
                    : new SafeHttpError(
                          `Could not reach the server (${error.code ?? 'network error'}).`,
                          'upstream_error',
                          502,
                      ),
            );
        });
        request.end();
    });

/**
 * Validate a user-supplied URL against the full policy.
 *
 * Returns the parsed URL plus the addresses the host resolved to, so the caller
 * can reuse them rather than resolving twice.
 */
export async function validatePublicHttpsUrl(
    candidate: string,
    deps: SafeHttpDeps = {},
): Promise<{ url: URL; addresses: string[] }> {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
        reject('A URL is required.');
    }
    const trimmed = candidate.trim();
    if (trimmed.length > MAX_URL_LENGTH) {
        reject('That URL is too long.');
    }

    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        reject('That URL could not be parsed.');
    }

    if (url.protocol !== 'https:') {
        reject('Only https:// URLs are supported.', 'scheme_not_allowed');
    }
    if (url.username || url.password) {
        reject('URLs must not contain credentials.', 'credentials_not_allowed');
    }

    const hostname = url.hostname;
    if (!hostname) {
        reject('That URL is missing a host name.');
    }
    const lowered = hostname.toLowerCase();
    if (
        lowered === 'localhost' ||
        lowered === 'localhost.localdomain' ||
        lowered.endsWith('.localhost') ||
        lowered.endsWith('.local') ||
        lowered.endsWith('.internal')
    ) {
        reject('Local host names are not allowed.', 'host_not_allowed');
    }

    // Public datasets are served on the default HTTPS port. Refusing every other
    // port removes the extension as a port-scanning primitive against public
    // hosts, and costs nothing a real dataset URL relies on.
    if (url.port && url.port !== '443') {
        reject('Only the default HTTPS port (443) is allowed.', 'port_not_allowed');
    }

    if (isIpLiteral(hostname)) {
        const literal = hostname.replace(/^\[/, '').replace(/\]$/, '');
        if (!isPublicAddress(literal)) {
            reject('That IP address is not publicly routable.', 'host_not_allowed');
        }
        return { url, addresses: [literal] };
    }

    let addresses: string[];
    try {
        addresses = await (deps.resolve ?? defaultResolver)(hostname);
    } catch {
        reject(`Could not resolve host "${lowered}".`, 'dns_failure');
    }
    if (!addresses || addresses.length === 0) {
        reject(`Could not resolve host "${lowered}".`, 'dns_failure');
    }
    for (const address of addresses) {
        if (!isPublicAddress(address)) {
            reject(
                `Host "${lowered}" resolves to an address that is not publicly routable.`,
                'host_not_allowed',
            );
        }
    }
    return { url, addresses };
}

/**
 * Build the DNS lookup the transport must use.
 *
 * Re-checking here (rather than trusting the earlier validation) is what makes
 * rebinding ineffective: the address the socket actually connects to is the
 * address this function returned, and it only ever returns public ones.
 */
export function guardedLookup(deps: SafeHttpDeps = {}): LookupFunction {
    const resolver = deps.resolve ?? defaultResolver;
    return ((
        hostname: string,
        options: dns.LookupOneOptions | dns.LookupAllOptions | number,
        callback: (
            err: NodeJS.ErrnoException | null,
            address: string | dns.LookupAddress[],
            family?: number,
        ) => void,
    ) => {
        const wantsAll = typeof options === 'object' && options !== null && options.all === true;
        const finish = (addresses: string[]): void => {
            const usable = addresses.filter(isPublicAddress);
            if (usable.length === 0 || usable.length !== addresses.length) {
                callback(
                    new SafeHttpError(
                        `Host "${hostname}" resolves to an address that is not publicly routable.`,
                        'host_not_allowed',
                    ),
                    '',
                );
                return;
            }
            const entries = usable.map((address) => ({
                address,
                family: address.includes(':') ? 6 : 4,
            }));
            if (wantsAll) {
                callback(null, entries);
            } else {
                callback(null, entries[0].address, entries[0].family);
            }
        };

        if (isIpLiteral(hostname)) {
            finish([hostname.replace(/^\[/, '').replace(/\]$/, '')]);
            return;
        }
        resolver(hostname).then(
            (addresses) => finish(addresses ?? []),
            () =>
                callback(
                    new SafeHttpError(
                        `Could not resolve host "${hostname}".`,
                        'dns_failure',
                    ),
                    '',
                ),
        );
    }) as LookupFunction;
}

function headerValue(
    headers: Record<string, string | string[] | undefined>,
    name: string,
): string | undefined {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
}

export interface OpenedResponse {
    readonly response: RawResponse;
    readonly finalUrl: string;
}

/**
 * Open *startUrl*, following redirects manually and revalidating each hop.
 *
 * Automatic redirect following is deliberately avoided: an allowlisted first
 * hop that 302s to `http://169.254.169.254/` is the canonical SSRF bypass, and
 * only per-hop revalidation stops it.
 */
export async function open(
    startUrl: string,
    accept: string,
    deps: SafeHttpDeps = {},
): Promise<OpenedResponse> {
    const maxRedirects = deps.maxRedirects ?? MAX_REDIRECTS;
    const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const request = deps.request ?? defaultRequest;
    const lookup = guardedLookup(deps);

    let current = startUrl;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
        throwIfCancelled(deps.signal);
        const { url } = await validatePublicHttpsUrl(current, deps);
        const response = await request(url.toString(), {
            headers: { 'User-Agent': USER_AGENT, Accept: accept },
            timeoutMs,
            lookup,
            signal: deps.signal,
        });
        const status = response.statusCode;
        if (status >= 200 && status < 300) {
            return { response, finalUrl: url.toString() };
        }
        if ([301, 302, 303, 307, 308].includes(status)) {
            const location = headerValue(response.headers, 'location');
            response.destroy();
            if (!location) {
                reject('A redirect response had no Location header.', 'bad_redirect', 502);
            }
            let next: URL;
            try {
                next = new URL(location, url);
            } catch {
                reject('A redirect pointed at an unusable URL.', 'bad_redirect', 502);
            }
            current = next.toString();
            continue;
        }
        response.destroy();
        reject(`The server returned ${status}.`, 'upstream_error', 502);
    }
    reject(`More than ${maxRedirects} redirects.`, 'too_many_redirects', 502);
}

/** Reject early when the server declares a body larger than *cap*. */
export function checkDeclaredLength(
    headers: Record<string, string | string[] | undefined>,
    cap: number,
): void {
    const raw = headerValue(headers, 'content-length');
    if (!raw) {
        return;
    }
    const declared = Number(raw);
    if (!Number.isFinite(declared)) {
        return;
    }
    if (declared > cap) {
        reject(
            `That resource is ${declared.toLocaleString('en-US')} bytes, over the ` +
                `${cap.toLocaleString('en-US')} byte limit.`,
            'too_large',
            413,
        );
    }
}

/** Read at most *cap* bytes from a response body, rejecting if it overruns. */
export async function readBounded(
    response: RawResponse,
    cap: number,
    signal?: AbortSignal,
): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        for await (const chunk of response.body) {
            throwIfCancelled(signal);
            total += chunk.length;
            if (total > cap) {
                reject(
                    `That resource is larger than the ${cap.toLocaleString('en-US')} byte limit.`,
                    'too_large',
                    413,
                );
            }
            chunks.push(chunk);
        }
    } finally {
        response.destroy();
    }
    return Buffer.concat(chunks, total);
}

/** Download a bounded amount of text. Used for catalog and listing documents. */
export async function fetchText(
    url: string,
    deps: SafeHttpDeps & { cap?: number; accept?: string } = {},
): Promise<string> {
    const cap = deps.cap ?? MAX_TEXT_BYTES;
    const { response } = await open(
        url,
        deps.accept ?? 'text/html,application/xhtml+xml,application/xml',
        deps,
    );
    checkDeclaredLength(response.headers, cap);
    const payload = await readBounded(response, cap, deps.signal);
    const contentType = headerValue(response.headers, 'content-type') ?? '';
    const match = /charset=([\w-]+)/i.exec(contentType);
    const charset = (match?.[1] ?? 'utf-8').toLowerCase();
    try {
        return new TextDecoder(charset, { fatal: false }).decode(payload);
    } catch {
        return payload.toString('utf8');
    }
}

export { headerValue };
