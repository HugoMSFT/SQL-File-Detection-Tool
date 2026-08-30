/**
 * Native Azure Blob browsing, running in the extension host.
 *
 * This is what replaces the Flask `/api/azure/*` endpoints. It exposes a small
 * {@link BlobBrowser} interface so the UI controller can be tested against a
 * fake, and one implementation on top of `@azure/storage-blob`.
 *
 * Security notes that the tests pin:
 *
 *   * Credentials are supplied once, when the browser is constructed, and are
 *     never returned by any method. The browser has no accessor that hands a
 *     token, key or SAS back out.
 *   * Listing is paged and bounded. The webview supplies an opaque
 *     continuation token it received from a previous page; it can never ask for
 *     an unbounded enumeration.
 *   * Downloads are written to a caller-owned directory under a sanitised name
 *     and are capped both by the service-reported content length and by bytes
 *     actually received.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
    AnonymousCredential,
    BlobServiceClient,
    StorageSharedKeyCredential,
} from '@azure/storage-blob';
import type { TokenCredential } from '@azure/core-auth';

import { safeFileName } from '../net/publicData';
import {
    AzureInputError,
    isSafeBlobName,
    isValidContainerName,
    redactAzure,
} from './storageUrl';

/** Hard ceiling on any single page the UI can request. */
export const MAX_PAGE_SIZE = 200;
/** Hard ceiling on a blob the extension will download for analysis. */
export const MAX_BLOB_DOWNLOAD_BYTES = 200 * 1024 * 1024;

export interface ContainerPage {
    readonly names: string[];
    readonly continuation: string | null;
}

export interface BlobEntry {
    readonly name: string;
    readonly sizeBytes: number | null;
    /** True for a virtual folder produced by hierarchical listing. */
    readonly isPrefix: boolean;
}

export interface BlobPage {
    readonly entries: BlobEntry[];
    readonly continuation: string | null;
}

export interface BlobBrowser {
    readonly account: string;
    listContainers(options?: {
        continuation?: string | null;
        pageSize?: number;
        signal?: AbortSignal;
    }): Promise<ContainerPage>;
    listBlobs(
        container: string,
        options?: {
            prefix?: string;
            continuation?: string | null;
            pageSize?: number;
            signal?: AbortSignal;
        },
    ): Promise<BlobPage>;
    downloadBlob(
        container: string,
        blob: string,
        destinationDir: string,
        options?: { maxBytes?: number; signal?: AbortSignal },
    ): Promise<{ path: string; bytes: number }>;
    /** The https URL of a blob, for use inside generated SQL. Never signed. */
    blobUrl(container: string, blob: string): string;
}

/** How a {@link AzureBlobBrowser} authenticates. */
export type BlobCredential =
    | { readonly kind: 'token'; readonly getToken: () => Promise<{ token: string; expiresOnMs: number }> }
    | { readonly kind: 'sas'; readonly sasToken: string }
    | { readonly kind: 'accountKey'; readonly accountKey: string }
    | { readonly kind: 'anonymous' };

function clampPageSize(requested: number | undefined): number {
    if (!requested || !Number.isFinite(requested)) {
        return 50;
    }
    return Math.max(1, Math.min(Math.trunc(requested), MAX_PAGE_SIZE));
}

function assertContainer(container: string): string {
    if (!isValidContainerName(container)) {
        throw new AzureInputError('That is not a valid container name.');
    }
    return container;
}

function assertBlob(blob: string): string {
    if (!isSafeBlobName(blob)) {
        throw new AzureInputError('That is not a blob name the extension can open.');
    }
    return blob;
}

/**
 * A prefix the caller may list under.
 *
 * A prefix is a filter, not a path, so it cannot escape anything — but a `..`
 * segment in one still ends up in display labels and in temp file names, so it
 * is rejected for the same reason a blob name is.
 */
function assertPrefix(prefix: string): string {
    const candidate = prefix ?? '';
    if (candidate.length > 1024 || candidate.includes('\0') || candidate.includes('\\')) {
        throw new AzureInputError('That is not a usable blob prefix.');
    }
    if (candidate.split('/').some((segment) => segment === '..')) {
        throw new AzureInputError('That is not a usable blob prefix.');
    }
    return candidate;
}

/** The concrete browser, backed by `@azure/storage-blob`. */
export class AzureBlobBrowser implements BlobBrowser {
    private readonly client: BlobServiceClient;
    private readonly baseUrl: string;

    constructor(
        readonly account: string,
        serviceUrl: string,
        credential: BlobCredential,
    ) {
        this.baseUrl = serviceUrl.replace(/\/+$/, '');
        this.client = AzureBlobBrowser.createClient(this.baseUrl, credential);
    }

    private static createClient(
        serviceUrl: string,
        credential: BlobCredential,
    ): BlobServiceClient {
        switch (credential.kind) {
            case 'token': {
                const tokenCredential: TokenCredential = {
                    getToken: async () => {
                        const { token, expiresOnMs } = await credential.getToken();
                        return { token, expiresOnTimestamp: expiresOnMs };
                    },
                };
                return new BlobServiceClient(serviceUrl, tokenCredential);
            }
            case 'sas':
                return new BlobServiceClient(
                    `${serviceUrl}?${credential.sasToken.replace(/^\?/, '')}`,
                );
            case 'accountKey': {
                const account = new URL(serviceUrl).hostname.split('.')[0];
                return new BlobServiceClient(
                    serviceUrl,
                    new StorageSharedKeyCredential(account, credential.accountKey),
                );
            }
            case 'anonymous':
            default:
                return new BlobServiceClient(serviceUrl, new AnonymousCredential());
        }
    }

    blobUrl(container: string, blob: string): string {
        assertContainer(container);
        assertBlob(blob);
        const encoded = blob.split('/').map(encodeURIComponent).join('/');
        return `${this.baseUrl}/${encodeURIComponent(container)}/${encoded}`;
    }

    async listContainers(
        options: { continuation?: string | null; pageSize?: number; signal?: AbortSignal } = {},
    ): Promise<ContainerPage> {
        const pageSize = clampPageSize(options.pageSize);
        const iterator = this.client
            .listContainers({ abortSignal: options.signal })
            .byPage({
                maxPageSize: pageSize,
                continuationToken: options.continuation ?? undefined,
            });
        const page = await iterator.next();
        if (page.done || !page.value) {
            return { names: [], continuation: null };
        }
        return {
            names: (page.value.containerItems ?? []).map((item) => item.name),
            continuation: page.value.continuationToken || null,
        };
    }

    async listBlobs(
        container: string,
        options: {
            prefix?: string;
            continuation?: string | null;
            pageSize?: number;
            signal?: AbortSignal;
        } = {},
    ): Promise<BlobPage> {
        const name = assertContainer(container);
        const prefix = assertPrefix(options.prefix ?? '');
        const pageSize = clampPageSize(options.pageSize);
        const iterator = this.client
            .getContainerClient(name)
            .listBlobsByHierarchy('/', { prefix, abortSignal: options.signal })
            .byPage({
                maxPageSize: pageSize,
                continuationToken: options.continuation ?? undefined,
            });
        const page = await iterator.next();
        if (page.done || !page.value) {
            return { entries: [], continuation: null };
        }
        const segment = page.value.segment;
        const entries: BlobEntry[] = [];
        for (const item of segment.blobPrefixes ?? []) {
            entries.push({ name: item.name, sizeBytes: null, isPrefix: true });
        }
        for (const item of segment.blobItems ?? []) {
            entries.push({
                name: item.name,
                sizeBytes: item.properties?.contentLength ?? null,
                isPrefix: false,
            });
        }
        return { entries, continuation: page.value.continuationToken || null };
    }

    async downloadBlob(
        container: string,
        blob: string,
        destinationDir: string,
        options: { maxBytes?: number; signal?: AbortSignal } = {},
    ): Promise<{ path: string; bytes: number }> {
        const containerName = assertContainer(container);
        const blobName = assertBlob(blob);
        const maxBytes = options.maxBytes ?? MAX_BLOB_DOWNLOAD_BYTES;
        const root = await fs.promises.realpath(destinationDir);
        const fileName = safeFileName(blobName.split('/').pop() ?? 'blob', 'blob');
        const target = path.join(root, fileName);
        if (path.dirname(path.resolve(target)) !== root) {
            throw new AzureInputError('Refusing to write outside the download directory.');
        }

        const client = this.client.getContainerClient(containerName).getBlobClient(blobName);
        const properties = await client.getProperties({ abortSignal: options.signal });
        if ((properties.contentLength ?? 0) > maxBytes) {
            throw new AzureInputError(
                `That blob is ${(properties.contentLength ?? 0).toLocaleString('en-US')} bytes, ` +
                    `over the ${maxBytes.toLocaleString('en-US')} byte limit for analysis.`,
            );
        }

        const response = await client.download(0, undefined, {
            abortSignal: options.signal,
        });
        const body = response.readableStreamBody;
        if (!body) {
            throw new AzureInputError('The service returned an empty response body.');
        }

        let written = 0;
        const handle = await fs.promises.open(target, 'w');
        try {
            for await (const chunk of body) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                written += buffer.length;
                if (written > maxBytes) {
                    throw new AzureInputError(
                        `That blob exceeded the ${maxBytes.toLocaleString('en-US')} byte limit.`,
                    );
                }
                await handle.write(buffer);
            }
        } catch (error) {
            await handle.close();
            await fs.promises.rm(target, { force: true });
            throw new Error(redactAzure(error instanceof Error ? error.message : error));
        }
        await handle.close();
        return { path: target, bytes: written };
    }
}
