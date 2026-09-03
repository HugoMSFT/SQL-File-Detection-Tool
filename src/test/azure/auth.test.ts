import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ARM_SCOPE,
    STORAGE_SCOPE,
    TENANT_SCOPE_PREFIX,
    MicrosoftAuthentication,
    authenticationScopes,
    type AuthenticationSession,
    type SessionOptions,
} from '../../azure/auth';

const SESSION: AuthenticationSession = {
    accessToken: 'test-token-never-render',
    account: { id: 'account-1', label: 'dev@example.test' },
};

test('Azure authentication uses the required resource and tenant scopes', () => {
    assert.deepEqual(authenticationScopes(ARM_SCOPE), [ARM_SCOPE]);
    assert.deepEqual(authenticationScopes(STORAGE_SCOPE, 'tenant-1'), [
        STORAGE_SCOPE,
        `${TENANT_SCOPE_PREFIX}tenant-1`,
    ]);
});

test('authentication always tries silent lookup before explicit interactive creation', async () => {
    const calls: Array<{ scopes: readonly string[]; options: SessionOptions }> = [];
    const auth = new MicrosoftAuthentication(async (_provider, scopes, options) => {
        calls.push({ scopes, options });
        return options.silent ? undefined : SESSION;
    });

    assert.equal(await auth.acquire(ARM_SCOPE, undefined, undefined, false), undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options, { silent: true });

    calls.length = 0;
    const session = await auth.acquire(STORAGE_SCOPE, 'tenant-1', SESSION.account, true);
    assert.equal(session, SESSION);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], {
        scopes: [STORAGE_SCOPE, 'VSCODE_TENANT:tenant-1'],
        options: { silent: true, account: SESSION.account },
    });
    assert.ok(calls[1].options.createIfNone);
    assert.equal(calls[1].options.silent, undefined);
});

test('an existing silent session never opens an interactive prompt', async () => {
    let calls = 0;
    const auth = new MicrosoftAuthentication(async () => {
        calls += 1;
        return SESSION;
    });
    assert.equal(await auth.acquire(ARM_SCOPE, 'tenant-1', SESSION.account, true), SESSION);
    assert.equal(calls, 1);
});

