import { BlobServiceClient } from '@azure/storage-blob';

import type { AuthenticationSession } from './auth';
import { AzureBrowserError, classifyStorageError } from './errors';

export const STORAGE_PAGE_SIZE = 100;
export const MAX_STORAGE_ITEMS = 1_000;
export const STORAGE_TIMEOUT_MS = 15_000;

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

export async function runStorageRequest<T>(
    callerSignal: AbortSignal | undefined,
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    const controller = new AbortController();
    let rejectCancellation: ((error: AzureBrowserError) => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
    });
    const cancel = (message: string): void => {
        controller.abort();
        rejectCancellation?.(new AzureBrowserError('temporary', message));
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
        () => cancel('The Azure Storage request timed out. Retry the request.'),
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
    constructor(private readonly timeoutMs = STORAGE_TIMEOUT_MS) {}

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
                        .byPage({ continuationToken, maxPageSize: STORAGE_PAGE_SIZE });
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
                continuationToken: result.value.continuationToken,
            };
        } catch (error) {
            throw classifyStorageError(error);
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
        try {
            const result = await runStorageRequest(
                abortSignal,
                this.timeoutMs,
                async (requestSignal) => {
                    const iterator = serviceClient(blobHost, session)
                        .getContainerClient(containerName)
                        .listBlobsByHierarchy('/', { prefix, abortSignal: requestSignal })
                        .byPage({ continuationToken, maxPageSize: STORAGE_PAGE_SIZE });
                    return iterator.next();
                },
            );
            if (result.done || !result.value) {
                return { items: [], continuationToken: undefined };
            }
            const folders: StorageFolderItem[] = (result.value.segment.blobPrefixes ?? []).map(
                (folder) => ({
                    kind: 'folder',
                    name: folder.name.slice(prefix.length).replace(/\/$/, ''),
                    prefix: folder.name,
                }),
            );
            const blobs: StorageBlobItem[] = result.value.segment.blobItems.map((blob) => ({
                kind: 'file',
                name: blob.name.slice(prefix.length),
                blobName: blob.name,
                sizeBytes: blob.properties.contentLength ?? null,
                modifiedAt: blob.properties.lastModified ?? null,
            }));
            return {
                items: [...folders, ...blobs],
                continuationToken: result.value.continuationToken,
            };
        } catch (error) {
            throw classifyStorageError(error);
        }
    }
}
