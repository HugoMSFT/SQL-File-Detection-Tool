import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MAX_ARM_PAGES,
    MAX_ARM_RESPONSE_BYTES,
    ArmClient,
    validateManagementUrl,
    type FetchLike,
} from '../../azure/armClient';
import { AzureBrowserError } from '../../azure/errors';

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
    const bytes = Buffer.from(JSON.stringify(body));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get: (name: string): string | null => headers[name.toLowerCase()] ?? null,
        },
        arrayBuffer: async (): Promise<ArrayBuffer> =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
}

test('management URLs allow only HTTPS management.azure.com', () => {
    assert.equal(
        validateManagementUrl('https://management.azure.com/tenants?api-version=1'),
        'https://management.azure.com/tenants?api-version=1',
    );
    for (const value of [
        'http://management.azure.com/tenants',
        'https://management.azure.com.evil.test/tenants',
        'https://user@management.azure.com/tenants',
        'https://management.azure.com:444/tenants',
        'https://storage.azure.com/tenants',
    ]) {
        assert.throws(() => validateManagementUrl(value), AzureBrowserError);
    }
});

test('ARM maps tenants, subscriptions, and Storage account HNS metadata', async () => {
    const fetchImpl: FetchLike = async (url) => {
        if (url.includes('/tenants')) {
            return response(200, { value: [{ tenantId: 'tenant-1', displayName: 'Tenant One' }] });
        }
        if (url.includes('/subscriptions?')) {
            return response(200, {
                value: [
                    {
                        subscriptionId: '11111111-1111-1111-1111-111111111111',
                        tenantId: 'tenant-1',
                        displayName: 'Development',
                    },
                ],
            });
        }
        return response(200, {
            value: [
                {
                    id:
                        '/subscriptions/11111111-1111-1111-1111-111111111111/' +
                        'resourceGroups/rg-data/providers/Microsoft.Storage/storageAccounts/lake001',
                    name: 'lake001',
                    location: 'westus2',
                    kind: 'StorageV2',
                    properties: { isHnsEnabled: true },
                },
            ],
        });
    };
    const client = new ArmClient(fetchImpl);
    assert.deepEqual(await client.listTenants('token'), [
        { id: 'tenant-1', label: 'Tenant One' },
    ]);
    assert.deepEqual(await client.listSubscriptions('token', 'tenant-1'), [
        {
            id: '11111111-1111-1111-1111-111111111111',
            tenantId: 'tenant-1',
            label: 'Development',
        },
    ]);
    assert.deepEqual(
        await client.listStorageAccounts('token', '11111111-1111-1111-1111-111111111111'),
        [
            {
                id:
                    '/subscriptions/11111111-1111-1111-1111-111111111111/' +
                    'resourceGroups/rg-data/providers/Microsoft.Storage/storageAccounts/lake001',
                name: 'lake001',
                resourceGroup: 'rg-data',
                location: 'westus2',
                kind: 'StorageV2',
                hns: true,
                blobHost: 'lake001.blob.core.windows.net',
                dfsHost: 'lake001.dfs.core.windows.net',
            },
        ],
    );
});

test('ARM accepts only authoritative public-cloud standard or DNS-zone endpoints', async () => {
    const account = (blob: string) => ({
        value: [
            {
                id:
                    '/subscriptions/11111111-1111-1111-1111-111111111111/' +
                    'resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/lake001',
                name: 'lake001',
                properties: {
                    isHnsEnabled: true,
                    primaryEndpoints: {
                        blob,
                        dfs: 'https://lake001.z19.dfs.storage.azure.net/',
                    },
                },
            },
        ],
    });
    const zone = new ArmClient(async () =>
        response(200, account('https://lake001.z19.blob.storage.azure.net/')),
    );
    const accounts = await zone.listStorageAccounts(
        'token',
        '11111111-1111-1111-1111-111111111111',
    );
    assert.equal(accounts[0].blobHost, 'lake001.z19.blob.storage.azure.net');
    assert.equal(accounts[0].dfsHost, 'lake001.z19.dfs.storage.azure.net');

    const hostile = new ArmClient(async () =>
        response(200, account('https://lake001.blob.core.windows.net.evil.test/')),
    );
    await assert.rejects(
        hostile.listStorageAccounts('token', '11111111-1111-1111-1111-111111111111'),
        /outside Azure public cloud/,
    );
});

test('ARM rejects hostile nextLinks, oversized responses, denied access, and page overflow', async () => {
    const hostile = new ArmClient(async () =>
        response(200, { value: [], nextLink: 'https://evil.test/steal' }),
    );
    await assert.rejects(hostile.listTenants('secret'), /outside management\.azure\.com/);

    const oversized = new ArmClient(async () =>
        response(200, { value: [] }, { 'content-length': String(MAX_ARM_RESPONSE_BYTES + 1) }),
    );
    await assert.rejects(oversized.listTenants('secret'), /larger than the safety limit/);

    const denied = new ArmClient(async () => response(403, {}));
    await assert.rejects(
        denied.listTenants('secret'),
        (error: unknown) =>
            error instanceof AzureBrowserError
            && error.kind === 'controlAccess'
            && !error.message.includes('secret'),
    );

    let page = 0;
    const tooManyPages = new ArmClient(async () => {
        page += 1;
        return response(200, {
            value: [],
            nextLink:
                `https://management.azure.com/tenants?api-version=1&page=${page}`,
        });

    });
    await assert.rejects(
        tooManyPages.listTenants('secret'),
        new RegExp(`${MAX_ARM_PAGES}-page safety limit`),
    );
});

test('ARM stops streaming a response as soon as the byte cap is crossed', async () => {
    const chunks = [new Uint8Array(MAX_ARM_RESPONSE_BYTES), new Uint8Array(1)];
    let cancelled = false;
    const client = new ArmClient(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
            cancel: async () => {
                cancelled = true;
            },
            getReader: () => ({
                read: async () =>
                    chunks.length > 0
                        ? { done: false, value: chunks.shift() }
                        : { done: true },
                cancel: async () => {
                    cancelled = true;
                },
            }),
        },
        arrayBuffer: async () => new ArrayBuffer(0),
    }));
    await assert.rejects(client.listTenants('secret'), /larger than the safety limit/);
    assert.equal(cancelled, true);
});

test('ARM aborts response bodies before rejecting early responses', async () => {
    const cases = [
        { status: 200, declared: MAX_ARM_RESPONSE_BYTES + 1, message: /larger than/ },
        { status: 403, declared: 0, message: /access was denied/ },
        { status: 500, declared: 0, message: /HTTP 500/ },
    ] as const;
    for (const item of cases) {
        let cancelled = false;
        let requestAborted = false;
        const client = new ArmClient(async (_url, init) => {
            init.signal.addEventListener('abort', () => {
                requestAborted = true;
            });
            return {
                ...response(item.status, {}, { 'content-length': String(item.declared) }),
                body: {
                    cancel: async () => {
                        cancelled = true;
                    },
                    getReader: () => ({
                        read: async () => ({ done: true }),
                        cancel: async () => undefined,
                    }),
                },
            };
        });
        await assert.rejects(client.listTenants('secret'), item.message);
        assert.equal(cancelled, true, `HTTP ${item.status} body was not cancelled`);
        assert.equal(requestAborted, true, `HTTP ${item.status} request was not aborted`);
    }
});

test('ARM preserves classified errors when response-body cancellation fails', async () => {
    const client = new ArmClient(async () => ({
        ...response(403, {}),
        body: {
            cancel: async () => {
                throw new Error('stream already errored');
            },
            getReader: () => ({
                read: async () => ({ done: true }),
                cancel: async () => undefined,
            }),
        },
    }));
    await assert.rejects(
        client.listTenants('secret'),
        (error: unknown) =>
            error instanceof AzureBrowserError
            && error.kind === 'controlAccess'
            && error.statusCode === 403,
    );
});
