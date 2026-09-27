import { AnonymousCredential, BlobServiceClient, ContainerClient } from '@azure/storage-blob';

import type { AuthenticationSession } from './auth';
import { AzureBrowserError, classifyStorageError } from './errors';
import {
    azurePublicStorageAccountName,
    validBlobListingName,
    validBlobPath,
    validContainerName,
} from './locations';

export const STORAGE_PAGE_SIZE = 100;
export const MAX_STORAGE_ITEMS = 1_000;
export const STORAGE_TIMEOUT_MS = 15_000;
export const MAX_PUBLIC_LIST_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_STORAGE_CONTINUATION_LENGTH = 8_192;

export type PublicStorageFetch = (
    url: string,
    init: {
        readonly method: 'GET';
        readonly headers: Readonly<Record<string, string>>;
        readonly redirect: 'manual';
        readonly credentials: 'omit';
        readonly signal: AbortSignal;
    },
) => Promise<Response>;

export interface StorageContainerItem {
    readonly kind: 'container';
    readonly name: string;
    readonly modifiedAt: Date | null;
}

export interface StorageFolderItem {
    readonly kind: 'folder';
    readonly name: string;
    readonly prefix: string;
}

export interface StorageBlobItem {
    readonly kind: 'file';
    readonly name: string;
    readonly blobName: string;
    readonly sizeBytes: number | null;
    readonly modifiedAt: Date | null;
}

export type StorageItem = StorageContainerItem | StorageFolderItem | StorageBlobItem;

export interface StoragePage {
    readonly items: readonly StorageItem[];
    readonly continuationToken: string | undefined;
}

function boundedContinuation(value: unknown): string | undefined {
    if (value === undefined || value === '') {
        return undefined;
    }
    if (
        typeof value !== 'string'
        || value.length > MAX_STORAGE_CONTINUATION_LENGTH
        // eslint-disable-next-line no-control-regex -- opaque markers must be safe bounded query values
        || /[\u0000-\u001f\u007f-\u009f]/.test(value)
    ) {
        throw new AzureBrowserError('invalidResponse', 'Azure returned an invalid or oversized continuation marker.');
    }
    return value;
}

function serviceClient(blobHost: string, session: AuthenticationSession): BlobServiceClient {
    const credential = {
        getToken: async (): Promise<{ token: string; expiresOnTimestamp: number }> => ({
            token: session.accessToken,
            expiresOnTimestamp: Date.now() + 4 * 60 * 1000,
        }),
    };
    return new BlobServiceClient(
        `https://${blobHost}`,
        credential,
        {
            retryOptions: { maxTries: 2, tryTimeoutInMs: 10_000 },
            userAgentOptions: { userAgentPrefix: 'sql-file-detection-tool' },
        },
    );
}

function publicContainerClient(
    blobHost: string,
    container: string,
    fetchImpl: PublicStorageFetch,
): ContainerClient {
    if (!azurePublicStorageAccountName(blobHost, 'blob') || !validContainerName(container)) {
        throw new AzureBrowserError('invalidResponse', 'The public container endpoint is invalid.');
    }
    const endpoint = new URL(`https://${blobHost}/${encodeURIComponent(container)}`);
    return new ContainerClient(endpoint.href, new AnonymousCredential(), {
        retryOptions: { maxTries: 2, tryTimeoutInMs: 10_000 },
        userAgentOptions: { userAgentPrefix: 'sql-file-detection-tool' },
        httpClient: {
            async sendRequest(request) {
                const target = new URL(request.url);
                const parameters = new Set(['restype', 'comp', 'prefix', 'delimiter', 'marker', 'maxresults', 'timeout']);
                if (
                    target.origin !== endpoint.origin
                    || target.pathname !== endpoint.pathname
                    || target.username !== ''
                    || target.password !== ''
                    || target.hash !== ''
                    || request.method !== 'GET'
                    || request.headers.contains('authorization')
                    || request.headers.contains('proxy-authorization')
                    || request.headers.contains('cookie')
                    || target.searchParams.get('restype') !== 'container'
                    || target.searchParams.get('comp') !== 'list'
                    || target.searchParams.get('delimiter') !== '/'
                    || target.searchParams.get('maxresults') !== String(STORAGE_PAGE_SIZE)
                    || !validBlobPath(target.searchParams.get('prefix') ?? '')
                    || (target.searchParams.get('marker') ?? '').length > MAX_STORAGE_CONTINUATION_LENGTH
                    || [...target.searchParams.keys()].some((key) => !parameters.has(key))
                ) {
                    throw new AzureBrowserError('invalidResponse', 'Only anonymous listing of the selected public container is allowed.');
                }
                const controller = new AbortController();
                const abort = (): void => controller.abort();
                request.abortSignal?.addEventListener('abort', abort);
                if (request.abortSignal?.aborted) {
                    abort();
                }
                const timeout = setTimeout(abort, request.timeout || STORAGE_TIMEOUT_MS);
                try {
                    // A transport-level guard also covers redirects issued inside SDK policies.
                    const response = await fetchImpl(target.href, {
                        method: 'GET',
                        headers: request.headers.toJson(),
                        redirect: 'manual',
                        credentials: 'omit',
                        signal: controller.signal,
                    });
                    if (response.status >= 300 && response.status < 400) {
                        controller.abort();
                        throw new AzureBrowserError(
                            'invalidResponse',
                            'Azure Storage redirected the listing request. Redirects are not followed; verify the original container endpoint.',
                        );
                    }
                    const declared = Number(response.headers.get('content-length'));
                    if (declared > MAX_PUBLIC_LIST_RESPONSE_BYTES) {
                        controller.abort();
                        throw new AzureBrowserError('invalidResponse', 'The public container listing exceeds the response-size safety limit.');
                    }
                    const chunks: Uint8Array[] = [];
                    let length = 0;
                    if (response.body) {
                        const reader = response.body.getReader();
                        try {
                            for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
                                length += chunk.value.byteLength;
                                if (length > MAX_PUBLIC_LIST_RESPONSE_BYTES) {
                                    controller.abort();
                                    throw new AzureBrowserError('invalidResponse', 'The public container listing exceeds the response-size safety limit.');
                                }
                                chunks.push(chunk.value);
                            }
                        } catch (error) {
                            if (controller.signal.aborted && !request.abortSignal?.aborted && !(error instanceof AzureBrowserError)) {
                                throw new AzureBrowserError('timeout', 'The Azure Storage request timed out.');
                            }
                            throw error;
                        } finally {
                            reader.releaseLock();
                        }
                    }
                    const headers = request.headers.clone();
                    for (const name of headers.headerNames()) {
                        headers.remove(name);
                    }
                    response.headers.forEach((value, name) => headers.set(name, value));
                    return {
                        request,
                        status: response.status,
                        headers,
                        bodyAsText: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
                    };
                } finally {
                    clearTimeout(timeout);
                    request.abortSignal?.removeEventListener('abort', abort);
                }
            },
        },
    });
}

export async function runStorageRequest<T>(
    callerSignal: AbortSignal | undefined,
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    if (callerSignal?.aborted) {
        throw new AzureBrowserError('temporary', 'The Azure Storage request was cancelled.');
    }
    const controller = new AbortController();
    let rejectCancellation: ((error: AzureBrowserError) => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
    });
    const cancel = (message: string, kind: 'temporary' | 'timeout' = 'temporary'): void => {
        controller.abort();
        rejectCancellation?.(new AzureBrowserError(kind, message));
    };
    const cancelFromCaller = (): void => {
        cancel('The Azure Storage request was cancelled.');
    };
    if (callerSignal?.aborted) {
        cancelFromCaller();
    } else {
        callerSignal?.addEventListener('abort', cancelFromCaller, { once: true });
    }
    const timer = setTimeout(
        () => cancel('The Azure Storage request timed out. Retry the request.', 'timeout'),
        timeoutMs,
    );
    try {
        return await Promise.race([operation(controller.signal), cancellation]);
    } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', cancelFromCaller);
    }
}

export class StorageBrowserClient {
    constructor(
        private readonly timeoutMs = STORAGE_TIMEOUT_MS,
        private readonly publicFetch: PublicStorageFetch = (url, init) => globalThis.fetch(url, init),
    ) {}

    async listContainers(
        blobHost: string,
        session: AuthenticationSession,
        continuationToken?: string,
        abortSignal?: AbortSignal,
    ): Promise<StoragePage> {
        try {
            const result = await runStorageRequest(
                abortSignal,
                this.timeoutMs,
                async (requestSignal) => {
                    const iterator = serviceClient(blobHost, session)
                        .listContainers({ abortSignal: requestSignal })
                        .byPage({ continuationToken: boundedContinuation(continuationToken), maxPageSize: STORAGE_PAGE_SIZE });
                    return iterator.next();
                },
            );
            if (result.done || !result.value) {
                return { items: [], continuationToken: undefined };
            }
            return {
                items: result.value.containerItems.map((container) => ({
                    kind: 'container' as const,
                    name: container.name,
                    modifiedAt: container.properties.lastModified ?? null,
                })),
                continuationToken: boundedContinuation(result.value.continuationToken),
            };
        } catch (error) {
            throw classifyStorageError(error, { operation: 'containers', access: 'authenticated' });
        }
    }

    async listBlobs(
        blobHost: string,
        containerName: string,
        prefix: string,
        session: AuthenticationSession,
        continuationToken?: string,
        abortSignal?: AbortSignal,
    ): Promise<StoragePage> {
        return this.listBlobPage(
            () => serviceClient(blobHost, session).getContainerClient(containerName),
            prefix,
            'authenticated',
            continuationToken,
            abortSignal,
        );
    }

    async listPublicBlobs(
        blobHost: string,
        containerName: string,
        prefix: string,
        continuationToken?: string,
        abortSignal?: AbortSignal,
    ): Promise<StoragePage> {
        if (!validBlobPath(prefix)) {
            throw new AzureBrowserError('invalidResponse', 'The public folder prefix is invalid.');
        }
        return this.listBlobPage(
            () => publicContainerClient(blobHost, containerName, this.publicFetch),
            prefix,
            'public',
            continuationToken,
            abortSignal,
        );
    }

    private async listBlobPage(
        client: () => ContainerClient,
        prefix: string,
        access: 'authenticated' | 'public',
        continuationToken?: string,
        abortSignal?: AbortSignal,
    ): Promise<StoragePage> {
        try {
            const result = await runStorageRequest(
                abortSignal,
                this.timeoutMs,
                async (requestSignal) => {
                    const iterator = client()
                        .listBlobsByHierarchy('/', { prefix, abortSignal: requestSignal })
                        .byPage({ continuationToken: boundedContinuation(continuationToken), maxPageSize: STORAGE_PAGE_SIZE });
                    return iterator.next();
                },
            );
            if (result.done || !result.value) {
                return { items: [], continuationToken: undefined };
            }
            const segment = result.value.segment;
            if (
                !segment || !Array.isArray(segment.blobItems)
                || (segment.blobPrefixes !== undefined && !Array.isArray(segment.blobPrefixes))
            ) {
                throw new AzureBrowserError('invalidResponse', 'Azure returned an invalid blob listing.');
            }
            if (access === 'public') {
                const invalidFolder = (segment.blobPrefixes ?? []).some((item) =>
                    !validBlobListingName(item.name, prefix, 'folder'));
                const invalidBlob = segment.blobItems.some((item) => {
                    const size = item.properties?.contentLength;
                    const modified = item.properties?.lastModified;
                    return !validBlobListingName(item.name, prefix, 'file')
                        || !item.properties
                        || (size !== undefined && (!Number.isFinite(size) || size < 0))
                        || (modified !== undefined && (!(modified instanceof Date) || !Number.isFinite(modified.getTime())));
                });
                if (
                    invalidFolder || invalidBlob
                    || (segment.blobPrefixes?.length ?? 0) + segment.blobItems.length > STORAGE_PAGE_SIZE
                ) {
                    throw new AzureBrowserError('invalidResponse', 'Azure returned invalid public container listing metadata.');
                }
            }
            const folders: StorageFolderItem[] = (segment.blobPrefixes ?? []).map(
                (folder) => ({
                    kind: 'folder',
                    name: folder.name.slice(prefix.length).replace(/\/$/, ''),
                    prefix: folder.name,
                }),
            );
            const blobs: StorageBlobItem[] = segment.blobItems.map((blob) => ({
                kind: 'file',
                name: blob.name.slice(prefix.length),
                blobName: blob.name,
                sizeBytes: blob.properties.contentLength ?? null,
                modifiedAt: blob.properties.lastModified ?? null,
            }));
            return {
                items: [...folders, ...blobs],
                continuationToken: boundedContinuation(result.value.continuationToken),
            };
        } catch (error) {
            throw classifyStorageError(error, { operation: 'blobs', access });
        }
    }
}
