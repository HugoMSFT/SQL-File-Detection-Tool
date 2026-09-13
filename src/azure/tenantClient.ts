import { AzureConnectionError } from './errors';
import type { AzureTenant } from './types';

export const ARM_HOST = 'management.azure.com';
export const ARM_TENANTS_API_VERSION = '2022-12-01';
export const MAX_ARM_PAGES = 10;
export const MAX_ARM_ITEMS = 200;
export const MAX_ARM_RESPONSE_BYTES = 1024 * 1024;
export const ARM_TIMEOUT_MS = 15_000;
export const MAX_ARM_RETRIES = 2;
export const MAX_ARM_RETRY_DELAY_MS = 5_000;
export const ARM_RETRY_BASE_DELAY_MS = 250;

interface FetchResponse {
    readonly ok: boolean;
    readonly status: number;
    readonly headers: { get(name: string): string | null };
    readonly body?: {
        cancel(): Promise<unknown>;
        getReader(): {
            read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
            cancel(): Promise<unknown>;
        };
    } | null;
    arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (
    input: string,
    init: {
        readonly method: 'GET';
        readonly redirect: 'error';
        readonly headers: Readonly<Record<string, string>>;
        readonly signal: AbortSignal;
    },
) => Promise<FetchResponse>;

export interface RetryOptions {
    readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    readonly random?: () => number;
    readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tenantId(value: unknown): string {
    if (
        typeof value !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ) {
        throw new AzureConnectionError(
            'invalidResponse',
            'Azure returned an invalid tenant identifier.',
        );
    }
    return value;
}

function tenantLabel(item: Record<string, unknown>, id: string): string {
    for (const candidate of [item.displayName, item.defaultDomain]) {
        if (
            typeof candidate === 'string'
            && candidate.length > 0
            && candidate.length <= 256
            // eslint-disable-next-line no-control-regex -- labels must not carry terminal controls
            && !/[\u0000-\u001f\u007f]/.test(candidate)
        ) {
            return candidate;
        }
    }
    return id;
}

export function validateTenantManagementUrl(value: string): string {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new AzureConnectionError(
            'invalidResponse',
            'Azure returned an invalid management continuation URL.',
        );
    }
    const allowedParameters = new Set(['api-version', '$skiptoken']);
    if (
        parsed.protocol !== 'https:'
        || parsed.hostname !== ARM_HOST
        || parsed.port !== ''
        || parsed.username !== ''
        || parsed.password !== ''
        || parsed.hash !== ''
        || parsed.pathname !== '/tenants'
        || parsed.searchParams.get('api-version') !== ARM_TENANTS_API_VERSION
        || [...parsed.searchParams.keys()].some((key) => !allowedParameters.has(key))
    ) {
        throw new AzureConnectionError(
            'invalidResponse',
            'Azure returned a tenant continuation URL outside the allowed management endpoint.',
        );
    }
    return parsed.toString();
}

export class AzureTenantClient {
    private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    private readonly random: () => number;
    private readonly now: () => number;

    constructor(
        private readonly fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
        private readonly timeoutMs = ARM_TIMEOUT_MS,
        retryOptions: RetryOptions = {},
    ) {
        this.sleep = retryOptions.sleep ?? cancellableDelay;
        this.random = retryOptions.random ?? Math.random;
        this.now = retryOptions.now ?? Date.now;
    }

    async listTenants(
        accessToken: string,
        parentSignal?: AbortSignal,
    ): Promise<readonly AzureTenant[]> {
        const tenants: AzureTenant[] = [];
        let next: string | undefined = validateTenantManagementUrl(
            `https://${ARM_HOST}/tenants?api-version=${ARM_TENANTS_API_VERSION}`,
        );
        for (let page = 0; next && page < MAX_ARM_PAGES; page += 1) {
            const body = await this.requestWithRetry(next, accessToken, parentSignal);
            if (!Array.isArray(body.value)) {
                throw new AzureConnectionError(
                    'invalidResponse',
                    'Azure returned an invalid tenant list.',
                );
            }
            for (const item of body.value) {
                if (!isRecord(item)) {
                    throw new AzureConnectionError(
                        'invalidResponse',
                        'Azure returned an invalid tenant entry.',
                    );
                }
                if (tenants.length >= MAX_ARM_ITEMS) {
                    throw new AzureConnectionError(
                        'invalidResponse',
                        `Azure returned more than the ${MAX_ARM_ITEMS}-tenant safety limit.`,
                    );
                }
                const id = tenantId(item.tenantId);
                tenants.push({ id, label: tenantLabel(item, id) });
            }
            if (body.nextLink !== undefined && typeof body.nextLink !== 'string') {
                throw new AzureConnectionError(
                    'invalidResponse',
                    'Azure returned an invalid management continuation URL.',
                );
            }
            next = body.nextLink
                ? validateTenantManagementUrl(body.nextLink)
                : undefined;
        }
        if (next) {
            throw new AzureConnectionError(
                'invalidResponse',
                `Azure exceeded the ${MAX_ARM_PAGES}-page safety limit.`,
            );
        }
        return tenants;
    }

    private async requestWithRetry(
        url: string,
        accessToken: string,
        parentSignal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await this.request(url, accessToken, parentSignal);
            } catch (error) {
                if (
                    !(error instanceof AzureConnectionError)
                    || !this.retryable(error, parentSignal)
                    || attempt >= MAX_ARM_RETRIES
                ) {
                    throw error;
                }
                const exponential = ARM_RETRY_BASE_DELAY_MS * (2 ** attempt);
                const jittered = Math.round(exponential * (0.8 + this.random() * 0.4));
                const delay = Math.min(
                    MAX_ARM_RETRY_DELAY_MS,
                    error.retryAfterMs ?? jittered,
                );
                await this.sleep(delay, parentSignal);
            }
        }
    }

    private async request(
        url: string,
        accessToken: string,
        parentSignal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
        const controller = new AbortController();
        const cancel = (): void => controller.abort();
        parentSignal?.addEventListener('abort', cancel, { once: true });
        if (parentSignal?.aborted) {
            controller.abort();
        }
        const timer = setTimeout(cancel, this.timeoutMs);
        try {
            const response = await this.fetchImpl(validateTenantManagementUrl(url), {
                method: 'GET',
                redirect: 'error',
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${accessToken}`,
                },
                signal: controller.signal,
            });
            const declared = Number(response.headers.get('content-length'));
            if (Number.isFinite(declared) && declared > MAX_ARM_RESPONSE_BYTES) {
                await this.cancelResponse(response, controller);
                throw new AzureConnectionError(
                    'invalidResponse',
                    'Azure returned a management response larger than the safety limit.',
                );
            }
            if (response.status === 401) {
                await this.cancelResponse(response, controller);
                throw new AzureConnectionError(
                    'signIn',
                    'The Microsoft session is no longer authorized. Connect again.',
                    response.status,
                );
            }
            if (response.status === 403) {
                await this.cancelResponse(response, controller);
                throw new AzureConnectionError(
                    'controlAccess',
                    'Azure management access was denied for this account.',
                    response.status,
                );
            }
            if (response.status === 408) {
                await this.cancelResponse(response, controller);
                throw new AzureConnectionError(
                    'timeout',
                    'Azure management timed out. Retry the request.',
                    response.status,
                    retryAfterMilliseconds(response.headers, this.now()),
                );
            }
            if (response.status === 429) {
                await this.cancelResponse(response, controller);
                throw new AzureConnectionError(
                    'rateLimited',
                    'Azure management is rate limiting requests. Retry shortly.',
                    response.status,
                    retryAfterMilliseconds(response.headers, this.now()),
                );
            }
            if (!response.ok) {
                await this.cancelResponse(response, controller);
                const retryable = response.status >= 500 && response.status <= 599;
                throw new AzureConnectionError(
                    retryable ? 'temporary' : 'invalidResponse',
                    retryable
                        ? `Azure management returned HTTP ${response.status}. Retry the request.`
                        : `Azure management rejected the request with HTTP ${response.status}.`,
                    response.status,
                    retryable
                        ? retryAfterMilliseconds(response.headers, this.now())
                        : undefined,
                );
            }
            const bytes = await this.readBoundedBody(response, controller);
            let parsed: unknown;
            try {
                parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            } catch {
                throw new AzureConnectionError(
                    'invalidResponse',
                    'Azure returned malformed management JSON.',
                );
            }
            if (!isRecord(parsed)) {
                throw new AzureConnectionError(
                    'invalidResponse',
                    'Azure returned an invalid management response.',
                );
            }
            return parsed;
        } catch (error) {
            if (error instanceof AzureConnectionError) {
                throw error;
            }
            if (controller.signal.aborted) {
                throw new AzureConnectionError(
                    parentSignal?.aborted ? 'cancelled' : 'timeout',
                    parentSignal?.aborted
                        ? 'The Azure management request was cancelled.'
                        : 'The Azure management request timed out.',
                );
            }
            throw new AzureConnectionError(
                'temporary',
                'Azure management could not be reached. Retry the request.',
            );
        } finally {
            clearTimeout(timer);
            parentSignal?.removeEventListener('abort', cancel);
        }
    }

    private retryable(
        error: AzureConnectionError,
        parentSignal?: AbortSignal,
    ): boolean {
        if (parentSignal?.aborted || error.kind === 'cancelled') {
            return false;
        }
        if (error.kind === 'rateLimited' || error.kind === 'timeout') {
            return true;
        }
        return (
            error.kind === 'temporary'
            && (
                error.status === undefined
                || error.status === 500
                || error.status === 502
                || error.status === 503
                || error.status === 504
            )
        );
    }

    private async readBoundedBody(
        response: FetchResponse,
        controller: AbortController,
    ): Promise<Uint8Array> {
        if (!response.body) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength > MAX_ARM_RESPONSE_BYTES) {
                controller.abort();
                throw new AzureConnectionError(
                    'invalidResponse',
                    'Azure returned a management response larger than the safety limit.',
                );
            }
            return bytes;
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
            for (;;) {
                const result = await reader.read();
                if (result.done) {
                    break;
                }
                const chunk = result.value;
                if (!chunk) {
                    continue;
                }
                total += chunk.byteLength;
                if (total > MAX_ARM_RESPONSE_BYTES) {
                    controller.abort();
                    try {
                        await reader.cancel();
                    } catch {
                        // The request is already aborted; cancellation is best effort.
                    }
                    throw new AzureConnectionError(
                        'invalidResponse',
                        'Azure returned a management response larger than the safety limit.',
                    );
                }
                chunks.push(chunk);
            }
        } catch (error) {
            if (error instanceof AzureConnectionError) {
                throw error;
            }
            throw error;
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes;
    }

    private async cancelResponse(
        response: FetchResponse,
        controller: AbortController,
    ): Promise<void> {
        controller.abort();
        try {
            await response.body?.cancel();
        } catch {
            // The request is already aborted; body cancellation is best effort.
        }
    }

}

function retryAfterMilliseconds(
    headers: { get(name: string): string | null },
    now: number,
): number | undefined {
    const value = headers.get('retry-after');
    if (!value) {
        return undefined;
    }
    if (/^\d{1,5}$/.test(value)) {
        return Math.min(MAX_ARM_RETRY_DELAY_MS, Number(value) * 1_000);
    }
    const date = Date.parse(value);
    if (!Number.isFinite(date)) {
        return undefined;
    }
    return Math.min(MAX_ARM_RETRY_DELAY_MS, Math.max(0, date - now));
}

function cancellableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new AzureConnectionError('cancelled', 'The Azure request was cancelled.'));
            return;
        }
        const timer = setTimeout(done, milliseconds);
        const cancel = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
            reject(new AzureConnectionError('cancelled', 'The Azure request was cancelled.'));
        };
        function done(): void {
            signal?.removeEventListener('abort', cancel);
            resolve();
        }
        signal?.addEventListener('abort', cancel, { once: true });
    });
}
