/**
 * Tests for the SSRF-hardened HTTP client.
 *
 * Every test injects a fake resolver and a fake transport, so the suite never
 * touches the network and cannot be flaky. The point of these tests is the
 * policy, not the socket: which URLs are refused, which redirects are refused,
 * and where the byte ceilings bite.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';

import {
    SafeHttpError,
    checkDeclaredLength,
    fetchText,
    guardedLookup,
    open,
    readBounded,
    validatePublicHttpsUrl,
    type RawResponse,
    type RequestImpl,
    type SafeHttpDeps,
} from '../../net/safeHttp';

const PUBLIC = ['93.184.216.34'];

function resolver(map: Record<string, string[]>): SafeHttpDeps['resolve'] {
    return async (hostname) => {
        const addresses = map[hostname.toLowerCase()];
        if (!addresses) {
            throw new Error('ENOTFOUND');
        }
        return addresses;
    };
}

interface FakeHop {
    readonly status: number;
    readonly headers?: Record<string, string>;
    readonly body?: string | Buffer | Buffer[];
}

/** A transport that replays a scripted list of hops and records the URLs. */
function transport(hops: FakeHop[]): { request: RequestImpl; urls: string[]; destroyed: number } {
    const urls: string[] = [];
    const state = { destroyed: 0 };
    const request: RequestImpl = async (url) => {
        urls.push(url);
        const hop = hops[Math.min(urls.length - 1, hops.length - 1)];
        const raw = hop.body ?? '';
        const chunks = Array.isArray(raw)
            ? raw
            : [Buffer.from(typeof raw === 'string' ? raw : raw)];
        const response: RawResponse = {
            statusCode: hop.status,
            headers: hop.headers ?? {},
            body: Readable.from(chunks),
            destroy: () => {
                state.destroyed += 1;
            },
        };
        return response;
    };
    return {
        request,
        urls,
        get destroyed() {
            return state.destroyed;
        },
    };
}

async function code(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof SafeHttpError, `expected SafeHttpError, got ${String(error)}`);
        return error.code;
    }
    return assert.fail('the call was expected to reject');
}

test('only https URLs are accepted', async () => {
    const deps = { resolve: resolver({ 'example.com': PUBLIC }) };
    assert.equal(await code(validatePublicHttpsUrl('http://example.com/a.csv', deps)), 'scheme_not_allowed');
    assert.equal(await code(validatePublicHttpsUrl('ftp://example.com/a.csv', deps)), 'scheme_not_allowed');
    assert.equal(await code(validatePublicHttpsUrl('file:///c:/secret.csv', deps)), 'scheme_not_allowed');
    assert.equal(
        await code(validatePublicHttpsUrl('javascript:alert(1)', deps)),
        'scheme_not_allowed',
    );
    const ok = await validatePublicHttpsUrl('https://example.com/a.csv', deps);
    assert.equal(ok.url.hostname, 'example.com');
});

test('non-default ports are refused so the client is not a port scanner', async () => {
    const deps = { resolve: resolver({ 'example.com': PUBLIC }) };
    assert.equal(
        await code(validatePublicHttpsUrl('https://example.com:8080/a.csv', deps)),
        'port_not_allowed',
    );
    assert.equal(
        await code(validatePublicHttpsUrl('https://example.com:22/a.csv', deps)),
        'port_not_allowed',
    );
    // An explicit 443, and the implicit default, both stay allowed.
    const explicit = await validatePublicHttpsUrl('https://example.com:443/a.csv', deps);
    assert.equal(explicit.url.port, '');
    const implicit = await validatePublicHttpsUrl('https://example.com/a.csv', deps);
    assert.equal(implicit.url.port, '');
});

test('credentials embedded in the URL are refused', async () => {
    const deps = { resolve: resolver({ 'example.com': PUBLIC }) };
    assert.equal(
        await code(validatePublicHttpsUrl('https://user:secret@example.com/a.csv', deps)),
        'credentials_not_allowed',
    );
    assert.equal(
        await code(validatePublicHttpsUrl('https://user@example.com/a.csv', deps)),
        'credentials_not_allowed',
    );
});

test('local host names are refused before any resolution happens', async () => {
    let resolved = 0;
    const deps: SafeHttpDeps = {
        resolve: async () => {
            resolved += 1;
            return PUBLIC;
        },
    };
    for (const host of [
        'localhost',
        'localhost.localdomain',
        'db.localhost',
        'printer.local',
        'vault.internal',
    ]) {
        assert.equal(await code(validatePublicHttpsUrl(`https://${host}/x`, deps)), 'host_not_allowed');
    }
    assert.equal(resolved, 0, 'a local name must not even be looked up');
});

test('private IP literals are refused without resolution', async () => {
    const deps: SafeHttpDeps = {
        resolve: async () => assert.fail('an IP literal must not be resolved'),
    };
    for (const host of ['127.0.0.1', '169.254.169.254', '10.1.2.3', '192.168.0.5', '[::1]', '[fd00::1]']) {
        assert.equal(await code(validatePublicHttpsUrl(`https://${host}/x`, deps)), 'host_not_allowed');
    }
    const ok = await validatePublicHttpsUrl('https://93.184.216.34/x', deps);
    assert.deepEqual(ok.addresses, ['93.184.216.34']);
});

test('a name that resolves to any private address is refused', async () => {
    const deps = {
        resolve: resolver({
            'evil.example': ['93.184.216.34', '169.254.169.254'],
            'inner.example': ['10.0.0.7'],
        }),
    };
    assert.equal(await code(validatePublicHttpsUrl('https://evil.example/x', deps)), 'host_not_allowed');
    assert.equal(await code(validatePublicHttpsUrl('https://inner.example/x', deps)), 'host_not_allowed');
});

test('resolution failures and empty answers are reported as DNS failures', async () => {
    const deps = { resolve: resolver({}) };
    assert.equal(await code(validatePublicHttpsUrl('https://missing.example/x', deps)), 'dns_failure');
    const empty: SafeHttpDeps = { resolve: async () => [] };
    assert.equal(await code(validatePublicHttpsUrl('https://empty.example/x', empty)), 'dns_failure');
});

test('absurd and unparseable URLs are refused', async () => {
    assert.equal(await code(validatePublicHttpsUrl('')), 'invalid_request');
    assert.equal(await code(validatePublicHttpsUrl('   ')), 'invalid_request');
    assert.equal(await code(validatePublicHttpsUrl('not a url')), 'invalid_request');
    assert.equal(await code(validatePublicHttpsUrl(`https://example.com/${'a'.repeat(9000)}`)), 'invalid_request');
});

test('the guarded lookup only ever yields public addresses', async () => {
    const lookup = guardedLookup({ resolve: resolver({ 'good.example': PUBLIC, 'bad.example': ['10.0.0.1'] }) });
    const good = await new Promise<unknown>((resolve) => {
        lookup('good.example', {}, (error, address, family) => resolve({ error, address, family }));
    });
    assert.deepEqual(good, { error: null, address: '93.184.216.34', family: 4 });

    const bad = await new Promise<{ error: Error | null }>((resolve) => {
        lookup('bad.example', {}, (error) => resolve({ error: error as Error | null }));
    });
    assert.ok(bad.error, 'a private answer must surface as a lookup error');
    assert.ok(!/10\.0\.0\.1/.test(String(bad.error?.message ?? '')));
});

test('a redirect to a private address is refused mid-chain', async () => {
    const deps: SafeHttpDeps = {
        resolve: resolver({ 'example.com': PUBLIC }),
        ...transport([
            { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } },
        ]),
    };
    assert.equal(await code(open('https://example.com/start', 'text/html', deps)), 'scheme_not_allowed');
});

test('an https redirect to a private host is also refused', async () => {
    const deps: SafeHttpDeps = {
        resolve: resolver({ 'example.com': PUBLIC, 'inner.example': ['10.1.1.1'] }),
        ...transport([
            { status: 302, headers: { location: 'https://inner.example/secrets' } },
        ]),
    };
    assert.equal(await code(open('https://example.com/start', 'text/html', deps)), 'host_not_allowed');
});

test('redirects are followed, revalidated and capped', async () => {
    const hops = transport([
        { status: 302, headers: { location: '/two' } },
        { status: 302, headers: { location: 'https://example.org/three' } },
        { status: 200, body: 'done' },
    ]);
    const deps: SafeHttpDeps = {
        resolve: resolver({ 'example.com': PUBLIC, 'example.org': PUBLIC }),
        request: hops.request,
    };
    const opened = await open('https://example.com/one', 'text/html', deps);
    assert.equal(opened.finalUrl, 'https://example.org/three');
    assert.deepEqual(hops.urls, [
        'https://example.com/one',
        'https://example.com/two',
        'https://example.org/three',
    ]);

    const loop = transport([{ status: 302, headers: { location: 'https://example.com/loop' } }]);
    assert.equal(
        await code(
            open('https://example.com/loop', 'text/html', {
                resolve: resolver({ 'example.com': PUBLIC }),
                request: loop.request,
                maxRedirects: 3,
            }),
        ),
        'too_many_redirects',
    );
    assert.equal(loop.urls.length, 4, 'the initial request plus three redirects');
});

test('a redirect without a usable Location is refused', async () => {
    const deps: SafeHttpDeps = {
        resolve: resolver({ 'example.com': PUBLIC }),
        ...transport([{ status: 302 }]),
    };
    assert.equal(await code(open('https://example.com/x', 'text/html', deps)), 'bad_redirect');
});

test('non-success statuses are surfaced without leaking the body', async () => {
    const deps: SafeHttpDeps = {
        resolve: resolver({ 'example.com': PUBLIC }),
        ...transport([{ status: 403, body: 'AccountKey=super-secret' }]),
    };
    try {
        await open('https://example.com/x', 'text/html', deps);
        assert.fail('expected a rejection');
    } catch (error) {
        assert.ok(error instanceof SafeHttpError);
        assert.equal(error.code, 'upstream_error');
        assert.ok(!/super-secret/.test(error.message));
    }
});

test('a declared content length over the cap is refused before reading', () => {
    assert.throws(
        () => checkDeclaredLength({ 'content-length': '100000' }, 1000),
        (error: unknown) => error instanceof SafeHttpError && error.code === 'too_large',
    );
    checkDeclaredLength({ 'content-length': '999' }, 1000);
    checkDeclaredLength({}, 1000);
    checkDeclaredLength({ 'content-length': 'not-a-number' }, 1000);
});

test('a body that overruns the cap is refused mid-stream', async () => {
    const chunks = [Buffer.alloc(600, 1), Buffer.alloc(600, 2), Buffer.alloc(600, 3)];
    let destroyed = 0;
    const response: RawResponse = {
        statusCode: 200,
        headers: {},
        body: Readable.from(chunks),
        destroy: () => {
            destroyed += 1;
        },
    };
    await assert.rejects(readBounded(response, 1000), (error: unknown) => {
        return error instanceof SafeHttpError && error.code === 'too_large';
    });
    assert.equal(destroyed, 1, 'the stream must be torn down when the cap is hit');
});

test('a body inside the cap is returned intact', async () => {
    const response: RawResponse = {
        statusCode: 200,
        headers: {},
        body: Readable.from([Buffer.from('hello '), Buffer.from('world')]),
        destroy: () => undefined,
    };
    assert.equal((await readBounded(response, 1000)).toString('utf8'), 'hello world');
});

test('fetchText honours the declared charset and the text cap', async () => {
    const deps: SafeHttpDeps = {
        resolve: resolver({ 'example.com': PUBLIC }),
        ...transport([
            {
                status: 200,
                headers: { 'content-type': 'text/html; charset=utf-8' },
                body: 'café — ok',
            },
        ]),
    };
    assert.equal(await fetchText('https://example.com/a', deps), 'café — ok');

    const big: SafeHttpDeps = {
        resolve: resolver({ 'example.com': PUBLIC }),
        ...transport([
            { status: 200, headers: { 'content-length': '10000' }, body: 'x' },
        ]),
    };
    assert.equal(await code(fetchText('https://example.com/a', { ...big, cap: 10 })), 'too_large');
});

test('the request never carries a cookie, authorization or referer header', async () => {
    let seen: Record<string, string> = {};
    const deps: SafeHttpDeps = {
        resolve: resolver({ 'example.com': PUBLIC }),
        request: async (_url, options) => {
            seen = options.headers;
            return {
                statusCode: 200,
                headers: {},
                body: Readable.from([Buffer.from('ok')]),
                destroy: () => undefined,
            };
        },
    };
    await open('https://example.com/x', 'text/csv', deps);
    assert.deepEqual(Object.keys(seen).sort(), ['Accept', 'User-Agent']);
    assert.equal(seen.Accept, 'text/csv');
});
