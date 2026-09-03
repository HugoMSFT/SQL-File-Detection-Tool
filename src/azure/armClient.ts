import { AzureBrowserError } from './errors';
import type { AzureStorageAccount, AzureSubscription, AzureTenant } from './types';

export const ARM_HOST = 'management.azure.com';
export const MAX_ARM_PAGES = 20;
export const MAX_ARM_ITEMS = 2_000;
export const MAX_ARM_RESPONSE_BYTES = 2 * 1024 * 1024;
export const ARM_TIMEOUT_MS = 15_000;

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
        readonly headers: Readonly<Record<string, string>>;
        readonly signal: AbortSignal;
    },
) => Promise<FetchResponse>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
        throw new AzureBrowserError('invalidResponse', `Azure returned an invalid ${label}.`);
    }
    return value;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 && value.length <= 2_048
        ? value
        : undefined;
}

function storageEndpointHost(
    value: unknown,
    accountName: string,
    service: 'blob' | 'dfs',
): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    const raw = requiredString(value, `${service} endpoint`);
    let endpoint: URL;
    try {
        endpoint = new URL(raw);
    } catch {
        throw new AzureBrowserError('invalidResponse', `Azure returned an invalid ${service} endpoint.`);
    }
    const escapedName = accountName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hostPattern = new RegExp(
        `^${escapedName}(?:\\.${service}\\.core\\.windows\\.net|\\.z\\d+\\.${service}\\.storage\\.azure\\.net)$`,
    );
    if (
        endpoint.protocol !== 'https:'
        || endpoint.port !== ''
        || endpoint.username !== ''
        || endpoint.password !== ''
        || endpoint.pathname !== '/'
        || endpoint.search !== ''
        || endpoint.hash !== ''
        || !hostPattern.test(endpoint.hostname)
    ) {
        throw new AzureBrowserError(
            'invalidResponse',
            `Azure returned a ${service} endpoint outside Azure public cloud.`,
        );
    }
    return endpoint.hostname;
}

export function validateManagementUrl(value: string): string {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new AzureBrowserError('invalidResponse', 'Azure returned an invalid management URL.');
    }
    if (
        parsed.protocol !== 'https:'
        || parsed.hostname !== ARM_HOST
        || parsed.port !== ''
        || parsed.username !== ''
        || parsed.password !== ''
    ) {
        throw new AzureBrowserError(
            'invalidResponse',
            'Azure returned a management continuation URL outside management.azure.com.',
        );
    }
    return parsed.toString();
}

export class ArmClient {
    constructor(
        private readonly fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
        private readonly timeoutMs = ARM_TIMEOUT_MS,
    ) {}

    listTenants(accessToken: string, signal?: AbortSignal): Promise<readonly AzureTenant[]> {
        return this.listPaged(
            'https://management.azure.com/tenants?api-version=2022-12-01',
            accessToken,
            (item) => {
                const id = requiredString(item.tenantId, 'tenant identifier');
                return { id, label: optionalString(item.displayName) ?? id };
            },
            signal,
        );
    }

    listSubscriptions(
        accessToken: string,
        tenantId: string,
        signal?: AbortSignal,
    ): Promise<readonly AzureSubscription[]> {
        return this.listPaged(
            'https://management.azure.com/subscriptions?api-version=2022-12-01',
            accessToken,
            (item) => {
                const id = requiredString(item.subscriptionId, 'subscription identifier');
                const itemTenant = requiredString(item.tenantId, 'subscription tenant');
                return {
                    id,
                    tenantId: itemTenant,
                    label: optionalString(item.displayName) ?? id,
                };
            },
            signal,
        ).then((items) => items.filter((item) => item.tenantId === tenantId));
    }

    listStorageAccounts(
        accessToken: string,
        subscriptionId: string,
        signal?: AbortSignal,
    ): Promise<readonly AzureStorageAccount[]> {
        if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(subscriptionId)) {
            throw new AzureBrowserError('invalidResponse', 'The selected subscription identifier is invalid.');
        }
        const url =
            `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}` +
            '/providers/Microsoft.Storage/storageAccounts?api-version=2023-05-01';
        return this.listPaged(
            url,
            accessToken,
            (item) => {
                const id = requiredString(item.id, 'Storage account identifier');
                const name = requiredString(item.name, 'Storage account name');
                if (!/^[a-z0-9]{3,24}$/.test(name)) {
                    throw new AzureBrowserError(
                        'invalidResponse',
                        'Azure returned an invalid Storage account name.',
                    );
                }
                const properties = isRecord(item.properties) ? item.properties : {};
                const primaryEndpoints = isRecord(properties.primaryEndpoints)
                    ? properties.primaryEndpoints
                    : {};
                const kind = optionalString(item.kind) ?? 'Storage account';
                if (
                    kind === 'FileStorage'
                    && (primaryEndpoints.blob === undefined || primaryEndpoints.blob === null)
                ) {
                    return undefined;
                }
                const blobHost = storageEndpointHost(primaryEndpoints.blob, name, 'blob');
                if (!blobHost) {
                    throw new AzureBrowserError(
                        'invalidResponse',
                        'Azure returned a Blob-capable Storage account without a Blob endpoint.',
                    );
                }
                const resourceGroupMatch = /\/resourceGroups\/([^/]+)\//i.exec(id);
                if (!resourceGroupMatch) {
                    throw new AzureBrowserError(
                        'invalidResponse',
                        'Azure returned an invalid Storage account resource identifier.',
                    );
                }
                const hns = properties.isHnsEnabled;
                if (hns !== undefined && hns !== null && typeof hns !== 'boolean') {
                    throw new AzureBrowserError(
                        'invalidResponse',
                        'Azure returned an invalid hierarchical namespace value.',
                    );
                }
                const isHnsEnabled = hns === true;
                const dfsHost = isHnsEnabled
                    ? storageEndpointHost(primaryEndpoints.dfs, name, 'dfs')
                    : undefined;
                if (isHnsEnabled && !dfsHost) {
                    throw new AzureBrowserError(
                        'invalidResponse',
                        'Azure returned an HNS-enabled Storage account without a DFS endpoint.',
                    );
                }
                return {
                    id,
                    name,
                    resourceGroup: decodeURIComponent(resourceGroupMatch[1]),
                    location: optionalString(item.location) ?? 'Unknown region',
                    kind,
                    hns: isHnsEnabled,
                    blobHost,
                    dfsHost: dfsHost ?? null,
                };
            },
            signal,
        );
    }

    private async listPaged<T>(
        initialUrl: string,
        accessToken: string,
        mapItem: (item: Record<string, unknown>) => T | undefined,
        signal?: AbortSignal,
    ): Promise<readonly T[]> {
        const items: T[] = [];
        let rawItemCount = 0;
        let next: string | undefined = validateManagementUrl(initialUrl);
        for (let page = 0; next && page < MAX_ARM_PAGES; page += 1) {
            const body = await this.request(next, accessToken, signal);
            if (!Array.isArray(body.value)) {
                throw new AzureBrowserError('invalidResponse', 'Azure returned an invalid list response.');
            }
            for (const raw of body.value) {
                if (!isRecord(raw)) {
                    throw new AzureBrowserError('invalidResponse', 'Azure returned an invalid list item.');
                }
                if (rawItemCount >= MAX_ARM_ITEMS) {
                    throw new AzureBrowserError(
                        'invalidResponse',
                        `Azure returned more than the ${MAX_ARM_ITEMS}-item safety limit.`,
                    );
                }
                rawItemCount += 1;
                const mapped = mapItem(raw);
                if (mapped !== undefined) {
                    items.push(mapped);
                }
            }
            const rawNext = body.nextLink;
            if (rawNext !== undefined && typeof rawNext !== 'string') {
                throw new AzureBrowserError(
                    'invalidResponse',
                    'Azure returned an invalid management continuation URL.',
                );
            }
            next = rawNext ? validateManagementUrl(rawNext) : undefined;
        }
        if (next) {
            throw new AzureBrowserError(
                'invalidResponse',
                `Azure exceeded the ${MAX_ARM_PAGES}-page safety limit.`,
            );
        }
        return items;
    }

    private async request(
        url: string,
        accessToken: string,
        parentSignal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
        const controller = new AbortController();
        const cancel = (): void => controller.abort();
        parentSignal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(cancel, this.timeoutMs);
        try {
            const response = await this.fetchImpl(validateManagementUrl(url), {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${accessToken}`,
                },
                signal: controller.signal,
            });
            const declared = Number(response.headers.get('content-length'));
            if (Number.isFinite(declared) && declared > MAX_ARM_RESPONSE_BYTES) {
                return this.rejectResponse(
                    response,
                    controller,
                    new AzureBrowserError(
                        'invalidResponse',
                        'Azure returned a management response larger than the safety limit.',
                    ),
                );
            }
            if (response.status === 401 || response.status === 403) {
                return this.rejectResponse(
                    response,
                    controller,
                    new AzureBrowserError(
                        'controlAccess',
                        'Azure management access was denied. Reader access is required to list subscriptions and Storage accounts.',
                        response.status,
                    ),
                );
            }
            if (!response.ok) {
                return this.rejectResponse(
                    response,
                    controller,
                    new AzureBrowserError(
                        'temporary',
                        `Azure management returned HTTP ${response.status}. Retry the request.`,
                        response.status,
                    ),
                );
            }
            const bytes = await this.readBoundedBody(response, controller);
            let parsed: unknown;
            try {
                parsed = JSON.parse(new TextDecoder().decode(bytes));
            } catch {
                throw new AzureBrowserError(
                    'invalidResponse',
                    'Azure returned malformed management JSON.',
                );
            }
            if (!isRecord(parsed)) {
                throw new AzureBrowserError('invalidResponse', 'Azure returned an invalid response.');
            }
            return parsed;
        } catch (error) {
            if (error instanceof AzureBrowserError) {
                throw error;
            }
            if (controller.signal.aborted) {
                throw new AzureBrowserError('temporary', 'The Azure management request timed out or was cancelled.');
            }
            throw new AzureBrowserError('temporary', 'Azure management could not be reached. Retry the request.');
        } finally {
            clearTimeout(timer);
            parentSignal?.removeEventListener('abort', cancel);
        }
    }

    private async rejectResponse(
        response: FetchResponse,
        controller: AbortController,
        error: AzureBrowserError,
    ): Promise<never> {
        if (response.body) {
            try {
                await response.body.cancel();
            } catch {
                // Cleanup failures must not replace the classified service error.
            }
        }
        controller.abort();
        throw error;
    }

    private async readBoundedBody(
        response: FetchResponse,
        controller: AbortController,
    ): Promise<Uint8Array> {
        if (!response.body) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength > MAX_ARM_RESPONSE_BYTES) {
                throw new AzureBrowserError(
                    'invalidResponse',
                    'Azure returned a management response larger than the safety limit.',
                );
            }
            return bytes;
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        let chunk = await reader.read();
        while (!chunk.done) {
            if (!chunk.value) {
                chunk = await reader.read();
                continue;
            }
            total += chunk.value.byteLength;
            if (total > MAX_ARM_RESPONSE_BYTES) {
                try {
                    await reader.cancel();
                } catch {
                    // Cleanup failures must not replace the response-size error.
                }
                controller.abort();
                throw new AzureBrowserError(
                    'invalidResponse',
                    'Azure returned a management response larger than the safety limit.',
                );
            }
            chunks.push(chunk.value);
            chunk = await reader.read();
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes;
    }
}
