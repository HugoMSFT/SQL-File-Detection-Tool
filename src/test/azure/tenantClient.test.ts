import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ARM_TENANTS_API_VERSION,
    MAX_ARM_ITEMS,
    MAX_ARM_PAGES,
    MAX_ARM_RESPONSE_BYTES,
    AzureTenantClient,
    validateTenantManagementUrl,
    type FetchLike,
} from '../../azure/tenantClient';
import { AzureConnectionError } from '../../azure/errors';

function response(
    status: number,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
) {
    const bytes = Buffer.from(JSON.stringify(body));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get: (name: string): string | null => headers[name.toLowerCase()] ?? null,
        },
        body: null,
        arrayBuffer: async (): Promise<ArrayBuffer> =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
}

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

test('tenant management URLs are HTTPS, host/path fixed, and query allowlisted', () => {
    assert.equal(
        validateTenantManagementUrl(
            `https://management.azure.com/tenants?api-version=${ARM_TENANTS_API_VERSION}&$skiptoken=next`,
        ),
        `https://management.azure.com/tenants?api-version=${ARM_TENANTS_API_VERSION}&$skiptoken=next`,
    );
    for (const value of [
        `http://management.azure.com/tenants?api-version=${ARM_TENANTS_API_VERSION}`,
        `https://management.azure.com.evil.test/tenants?api-version=${ARM_TENANTS_API_VERSION}`,
        `https://user@management.azure.com/tenants?api-version=${ARM_TENANTS_API_VERSION}`,
        `https://management.azure.com:444/tenants?api-version=${ARM_TENANTS_API_VERSION}`,
        `https://management.azure.com/subscriptions?api-version=${ARM_TENANTS_API_VERSION}`,
        'https://management.azure.com/tenants?api-version=old',
        `https://management.azure.com/tenants?api-version=${ARM_TENANTS_API_VERSION}&redirect=evil`,
    ]) {
        assert.throws(() => validateTenantManagementUrl(value), AzureConnectionError);
    }
});

test('tenant discovery maps bounded public-cloud ARM pages', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
        calls.push(url);
        assert.equal(init.method, 'GET');
        assert.equal(init.headers.Authorization, 'Bearer never-log-this-token');
        if (calls.length === 1) {
            return response(200, {
                value: [{ tenantId: TENANT_ID, displayName: 'Engineering' }],
                nextLink:
                    `https://management.azure.com/tenants?api-version=${ARM_TENANTS_API_VERSION}` +
                    '&$skiptoken=next',
            });
        }
        return response(200, {
            value: [
                {
                    tenantId: '22222222-2222-2222-2222-222222222222',
                    defaultDomain: 'example.test',
                },
            ],
        });
    };
    const tenants = await new AzureTenantClient(fetchImpl).listTenants(
        'never-log-this-token',
    );
    assert.deepEqual(tenants, [
        { id: TENANT_ID, label: 'Engineering' },
        {
            id: '22222222-2222-2222-2222-222222222222',
            label: 'example.test',
        },
    ]);
    assert.equal(calls.length, 2);
});

test('tenant discovery rejects hostile next links and malformed entries', async () => {
    const hostile = new AzureTenantClient(async () =>
        response(200, { value: [], nextLink: 'https://evil.test/steal' }),
    );
    await assert.rejects(hostile.listTenants('secret'), /allowed management endpoint/);

    const malformed = new AzureTenantClient(async () =>
        response(200, { value: [{ tenantId: 'not-a-tenant' }] }),
    );
    await assert.rejects(malformed.listTenants('secret'), /invalid tenant identifier/);
});

test('tenant discovery enforces item and page caps', async () => {
    const tooManyItems = new AzureTenantClient(async () =>
        response(200, {
            value: Array.from({ length: MAX_ARM_ITEMS + 1 }, (_, index) => ({
                tenantId: `11111111-1111-1111-1111-${String(index).padStart(12, '0')}`,
            })),
        }),
    );
    await assert.rejects(
        tooManyItems.listTenants('secret'),
        new RegExp(`${MAX_ARM_ITEMS}-tenant safety limit`),
    );

    const tooManyPages = new AzureTenantClient(async () =>
        response(200, {
            value: [],
            nextLink:
                `https://management.azure.com/tenants?api-version=${ARM_TENANTS_API_VERSION}` +
                '&$skiptoken=next',
        }),
    );
    await assert.rejects(
        tooManyPages.listTenants('secret'),
        new RegExp(`${MAX_ARM_PAGES}-page safety limit`),
    );
});

test('tenant discovery stops streaming and cancels oversized responses', async () => {
    const chunks = [new Uint8Array(MAX_ARM_RESPONSE_BYTES), new Uint8Array(1)];
    let cancelled = false;
    let aborted = false;
    const client = new AzureTenantClient(async (_url, init) => {
        init.signal.addEventListener('abort', () => {
            aborted = true;
        });
        return {
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
        };
    });
    await assert.rejects(client.listTenants('secret'), /larger than the safety limit/);
    assert.equal(cancelled, true);
    assert.equal(aborted, true);
});

test('tenant discovery cancels denied and failed response bodies', async () => {
    for (const status of [401, 403, 500]) {
        let cancelled = false;
        let aborted = false;
        const client = new AzureTenantClient(async (_url, init) => {
            init.signal.addEventListener('abort', () => {
                aborted = true;
            });
            return {
                ...response(status, {}),
                body: {
                    cancel: async () => {
                        cancelled = true;
                    },
                    getReader: () => {
                        throw new Error('body must not be read');
                    },
                },
            };
        });
        await assert.rejects(client.listTenants('secret'), AzureConnectionError);
        assert.equal(cancelled, true, `body was not cancelled for HTTP ${status}`);
        assert.equal(aborted, true, `request was not aborted for HTTP ${status}`);
    }
});

test('tenant discovery has a real request timeout and honors caller cancellation', async () => {
    for (const callerCancellation of [false, true]) {
        const parent = new AbortController();
        let requestSignal: AbortSignal | undefined;
        const client = new AzureTenantClient(
            async (_url, init) => {
                requestSignal = init.signal;
                return new Promise((_resolve, reject) => {
                    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
                });
            },
            5,
        );
        const pending = client.listTenants('secret', parent.signal);
        if (callerCancellation) {
            parent.abort();
        }
        await assert.rejects(
            pending,
            callerCancellation ? /was cancelled/ : /timed out/,
        );
        assert.equal(requestSignal?.aborted, true);
    }
});

test('tenant errors never disclose bearer tokens or response bodies', async () => {
    const secret = 'extremely-secret-bearer-token';
    const client = new AzureTenantClient(async () => {
        throw new Error(`network failed with ${secret}`);
    });
    await assert.rejects(client.listTenants(secret), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(secret));
        return true;
    });
});
