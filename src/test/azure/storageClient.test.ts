import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MAX_PUBLIC_LIST_RESPONSE_BYTES,
    MAX_STORAGE_CONTINUATION_LENGTH,
    STORAGE_PAGE_SIZE,
    StorageBrowserClient,
    runStorageRequest,
    type PublicStorageFetch,
} from '../../azure/storageClient';
import { AzureBrowserError } from '../../azure/errors';

const BLOB_HOST = 'blob001.z19.blob.storage.azure.net';

function xml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function listing(options: { blobs?: string[]; folders?: string[]; marker?: string; length?: string; modified?: string } = {}): string {
    return '<EnumerationResults><Blobs>'
        + (options.folders ?? []).map((name) => `<BlobPrefix><Name>${xml(name)}</Name></BlobPrefix>`).join('')
        + (options.blobs ?? []).map((name) =>
            `<Blob><Name>${xml(name)}</Name><Properties>`
            + `<Last-Modified>${options.modified ?? 'Wed, 23 Sep 2026 00:00:00 GMT'}</Last-Modified>`
            + `<Content-Length>${options.length ?? '42'}</Content-Length><BlobType>BlockBlob</BlobType>`
            + '</Properties></Blob>').join('')
        + `</Blobs><NextMarker>${xml(options.marker ?? '')}</NextMarker></EnumerationResults>`;
}

function xmlResponse(body: string, status = 200, code?: string): Response {
    return new Response(body, {
        status,
        headers: { 'content-type': 'application/xml', ...(code ? { 'x-ms-error-code': code } : {}) },
    });
}

test('Storage requests abort when their wall-clock timeout expires', async () => {
    let requestSignal: AbortSignal | undefined;
    await assert.rejects(
        runStorageRequest(undefined, 5, async (signal) => {
            requestSignal = signal;
            await new Promise(() => undefined);
        }),
        /timed out/,
    );
    assert.equal(requestSignal?.aborted, true);
});

test('Storage requests combine caller cancellation with their timeout', async () => {
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const request = runStorageRequest(caller.signal, 10_000, async (signal) => {
        requestSignal = signal;
        await new Promise(() => undefined);
    });
    caller.abort();
    await assert.rejects(request, /cancelled/);
    assert.equal(requestSignal?.aborted, true);
});

test('real anonymous ContainerClient requests list only the known container with no authorization or cookies', async () => {
    const requests: Array<{ url: URL; init: Parameters<PublicStorageFetch>[1] }> = [];
    const prefix = 'sales data/caf\u00e9/';
    const marker = 'next+/=&';
    const storage = new StorageBrowserClient(1_000, async (url, init) => {
        requests.push({ url: new URL(url), init });
        return xmlResponse(listing({
            folders: [prefix + '2026/'],
            blobs: [prefix + 'daily sales.csv'],
            marker: requests.length === 1 ? marker : '',
        }));
    });
    const first = await storage.listPublicBlobs(BLOB_HOST, 'raw', prefix);
    assert.equal(first.continuationToken, marker);
    assert.deepEqual(first.items.map((item) => [item.kind, item.name]), [
        ['folder', '2026'], ['file', 'daily sales.csv'],
    ]);
    const second = await storage.listPublicBlobs(BLOB_HOST, 'raw', prefix, first.continuationToken);
    assert.equal(second.continuationToken, undefined);
    assert.equal(requests.length, 2);
    for (const { url, init } of requests) {
        assert.equal(url.origin, `https://${BLOB_HOST}`);
        assert.equal(url.pathname, '/raw');
        assert.equal(url.searchParams.get('comp'), 'list');
        assert.equal(url.searchParams.get('restype'), 'container');
        assert.equal(url.searchParams.get('delimiter'), '/');
        assert.equal(url.searchParams.get('maxresults'), String(STORAGE_PAGE_SIZE));
        assert.equal(url.searchParams.get('prefix'), prefix);
        assert.equal(url.searchParams.has('sig'), false);
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'manual');
        assert.equal(init.credentials, 'omit');
        assert.ok(Object.keys(init.headers).every((header) =>
            !['authorization', 'cookie', 'proxy-authorization'].includes(header.toLowerCase())));
    }
    assert.equal(requests[1].url.searchParams.get('marker'), marker);
});

test('reserved public containers remain container-list operations, not account enumeration', async () => {
    const paths: string[] = [];
    const storage = new StorageBrowserClient(1_000, async (url) => {
        const parsed = new URL(url);
        paths.push(decodeURIComponent(parsed.pathname));
        assert.equal(parsed.searchParams.get('restype'), 'container');
        return xmlResponse(listing());
    });
    await storage.listPublicBlobs(BLOB_HOST, '$root', '');
    await storage.listPublicBlobs(BLOB_HOST, '$web', '');
    assert.deepEqual(paths, ['/$root', '/$web']);
});

test('actual service error responses are classified without leaking raw error bodies or headers', async () => {
    for (const [status, code, kind] of [
        [401, 'NoAuthenticationInformation', 'publicAccess'],
        [403, 'AuthorizationPermissionMismatch', 'publicAccess'],
        [403, 'AuthenticationFailed', 'publicAccess'],
        [403, 'AccountIsDisabled', 'accountDisabled'],
        [403, 'AuthorizationFailure', 'network'],
        [403, 'UnknownCode', 'publicAccess'],
        [409, 'PublicAccessNotPermitted', 'publicAccess'],
        [404, 'ContainerNotFound', 'notFound'],
        [429, 'TooManyRequests', 'rateLimited'],
    ] as const) {
        let calls = 0;
        const storage = new StorageBrowserClient(1_000, async () => {
            calls += 1;
            return xmlResponse(
                `<Error><Code>${code}</Code><Message>SECRET https://private/?sig=SECRET Bearer SECRET</Message></Error>`,
                status, code,
            );
        });
        await assert.rejects(storage.listPublicBlobs(BLOB_HOST, 'raw', ''), (error: unknown) => {
            assert.ok(error instanceof AzureBrowserError);
            assert.equal(error.kind, kind);
            assert.match(error.message, /^Blob listing:/);
            assert.doesNotMatch(error.message, /SECRET|https:|Bearer|Authorize Storage/);
            return true;
        });
        assert.equal(calls, 1);
    }
});

test('public SDK redirects cannot follow another host, local service, blob download, or same-origin redirect', async () => {
    for (const location of [
        'https://attacker.test/?sig=SECRET',
        'http://169.254.169.254/metadata',
        `https://${BLOB_HOST}/raw/secret.csv`,
        `https://${BLOB_HOST}/raw?restype=container&comp=list`,
    ]) {
        let calls = 0;
        const storage = new StorageBrowserClient(1_000, async (_url, init) => {
            calls += 1;
            assert.equal(init.redirect, 'manual');
            return new Response(null, { status: 307, headers: { location } });
        });
        await assert.rejects(storage.listPublicBlobs(BLOB_HOST, 'raw', ''), /Redirects are not followed/);
        assert.equal(calls, 1);
    }
});

test('public listing bounds prefixes, markers, page metadata, and response bytes', async () => {
    let calls = 0;
    let responseBody = listing();
    const storage = new StorageBrowserClient(1_000, async () => {
        calls += 1;
        return xmlResponse(responseBody);
    });
    for (const [host, container, prefix, marker] of [
        ['127.0.0.1', 'raw', '', undefined],
        [BLOB_HOST + '.attacker.test', 'raw', '', undefined],
        [BLOB_HOST, '../raw', '', undefined],
        [BLOB_HOST, 'raw', 'a/../b/', undefined],
        [BLOB_HOST, 'raw', 'a'.repeat(1_025), undefined],
        [BLOB_HOST, 'raw', '', 'a'.repeat(MAX_STORAGE_CONTINUATION_LENGTH + 1)],
    ] as const) {
        await assert.rejects(storage.listPublicBlobs(host, container, prefix, marker), AzureBrowserError);
    }
    assert.equal(calls, 0);

    for (const body of [
        listing({ marker: 'm'.repeat(MAX_STORAGE_CONTINUATION_LENGTH + 1) }),
        listing({ blobs: ['elsewhere/data.csv'] }),
        listing({ folders: ['sales/../outside/'] }),
        listing({ folders: ['sales/'] }),
        listing({ blobs: ['sales/a.csv'], length: '-1' }),
        listing({ blobs: ['sales/a.csv'], modified: 'invalid-date' }),
        listing({ blobs: Array.from({ length: STORAGE_PAGE_SIZE + 1 }, (_, index) => `sales/${index}.csv`) }),
    ]) {
        responseBody = body;
        await assert.rejects(storage.listPublicBlobs(BLOB_HOST, 'raw', 'sales/'), (error: unknown) => {
            assert.ok(error instanceof AzureBrowserError);
            assert.equal(error.kind, 'invalidResponse');
            return true;
        });
    }
    responseBody = 'x'.repeat(MAX_PUBLIC_LIST_RESPONSE_BYTES + 1);
    await assert.rejects(storage.listPublicBlobs(BLOB_HOST, 'raw', ''), /response-size safety limit/);
});

test('public request timeout aborts the actual listing transport', async () => {
    let signal: AbortSignal | undefined;
    const storage = new StorageBrowserClient(5, async (_url, init) => {
        signal = init.signal;
        return new Promise<Response>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
    });
    await assert.rejects(storage.listPublicBlobs(BLOB_HOST, 'raw', ''), /Blob listing:.*timed out/);
    assert.equal(signal?.aborted, true);
});
