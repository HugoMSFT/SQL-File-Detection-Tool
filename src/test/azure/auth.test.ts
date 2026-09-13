import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ARM_SCOPE,
    MICROSOFT_PROVIDER_ID,
    STORAGE_SCOPE,
    TENANT_SCOPE_PREFIX,
    MicrosoftAuthentication,
    authenticationScopes,
    scopedAuthenticationScopes,
    type AuthenticationSession,
    type SessionOptions,
} from '../../azure/auth';

const SESSION: AuthenticationSession = {
    id: 'session-1',
    accessToken: 'secret-token-never-render',
    account: { id: 'account-1', label: 'developer@example.test' },
};

test('Microsoft authentication uses the ARM scope and optional tenant hint', () => {
    assert.deepEqual(authenticationScopes(), [ARM_SCOPE]);
    assert.deepEqual(authenticationScopes('11111111-1111-1111-1111-111111111111'), [
        ARM_SCOPE,
        `${TENANT_SCOPE_PREFIX}11111111-1111-1111-1111-111111111111`,
    ]);
    assert.deepEqual(
        scopedAuthenticationScopes(
            STORAGE_SCOPE,
            '11111111-1111-1111-1111-111111111111',
        ),
        [
            STORAGE_SCOPE,
            `${TENANT_SCOPE_PREFIX}11111111-1111-1111-1111-111111111111`,
        ],
    );
});

test('Storage authentication is silent first and interactive only on explicit retry', async () => {
    const calls: Array<{
        scopes: readonly string[];
        options: SessionOptions;
    }> = [];
    const authentication = new MicrosoftAuthentication(
        async (_provider, scopes, options) => {
            calls.push({ scopes, options });
            return options.silent ? undefined : SESSION;
        },
    );
    const tenantId = '11111111-1111-1111-1111-111111111111';

    assert.equal(
        await authentication.acquireSession(
            STORAGE_SCOPE,
            tenantId,
            SESSION.account,
            false,
        ),
        undefined,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
        scopes: [STORAGE_SCOPE, `${TENANT_SCOPE_PREFIX}${tenantId}`],
        options: { silent: true, account: SESSION.account },
    });

    assert.equal(
        await authentication.acquireSession(
            STORAGE_SCOPE,
            tenantId,
            SESSION.account,
            true,
        ),
        SESSION,
    );
    assert.equal(calls.length, 3);
    assert.equal(calls[2].options.createIfNone, true);
});

test('authentication is silent first and prompts only for an explicit connect', async () => {
    const calls: Array<{
        provider: string;
        scopes: readonly string[];
        options: SessionOptions;
    }> = [];
    const authentication = new MicrosoftAuthentication(
        async (provider, scopes, options) => {
            calls.push({ provider, scopes, options });
            return options.silent ? undefined : SESSION;
        },
        async () => [SESSION.account],
    );

    const passive = await authentication.acquire(false, SESSION.account);
    assert.deepEqual(passive, { session: undefined, source: 'none' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
        provider: MICROSOFT_PROVIDER_ID,
        scopes: [ARM_SCOPE],
        options: { silent: true, account: SESSION.account },
    });

    calls.length = 0;
    const explicit = await authentication.acquire(true);
    assert.deepEqual(explicit, { session: SESSION, source: 'interactive' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].options, { silent: true });
    assert.ok(calls[1].options.createIfNone);
    assert.equal(calls[1].options.silent, undefined);
});

test('an existing silent session prevents an interactive prompt', async () => {
    let calls = 0;
    const authentication = new MicrosoftAuthentication(
        async () => {
            calls += 1;
            return SESSION;
        },
        async () => [SESSION.account],
    );

    assert.deepEqual(await authentication.acquire(true), {
        session: SESSION,
        source: 'silent',
    });
    assert.equal(calls, 1);
    assert.deepEqual(authentication.identity(SESSION), {
        label: 'developer@example.test',
    });
});
