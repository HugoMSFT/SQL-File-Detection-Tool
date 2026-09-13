import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MicrosoftAuthentication,
    type AuthenticationAccount,
    type AuthenticationSession,
    type SessionOptions,
} from '../../azure/auth';
import { AzureConnection } from '../../azure/connection';
import { AzureTenantClient, type FetchLike } from '../../azure/tenantClient';
import type { AzureConnectionState } from '../../azure/types';

const ACCOUNT: AuthenticationAccount = {
    id: 'account-1',
    label: 'developer@example.test',
};
const SESSION: AuthenticationSession = {
    id: 'session-1',
    accessToken: 'secret-token-never-render',
    account: ACCOUNT,
};
const TENANT = {
    id: '11111111-1111-1111-1111-111111111111',
    label: 'Engineering',
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function response(body: unknown) {
    const bytes = Buffer.from(JSON.stringify(body));
    return {
        ok: true,
        status: 200,
        headers: { get: (): null => null },
        body: null,
        arrayBuffer: async (): Promise<ArrayBuffer> =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
}

async function settle(): Promise<void> {
    for (let index = 0; index < 8; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

function fixture(options: {
    getSession: (
        options: SessionOptions,
        call: number,
    ) => Promise<AuthenticationSession | undefined>;
    getAccounts?: () => Promise<readonly AuthenticationAccount[]>;
    fetch?: FetchLike;
}) {
    let sessionCalls = 0;
    const states: AzureConnectionState[] = [];
    const logs: string[] = [];
    const authentication = new MicrosoftAuthentication(
        async (_provider, _scopes, sessionOptions) => {
            sessionCalls += 1;
            return options.getSession(sessionOptions, sessionCalls);
        },
        async () => options.getAccounts?.() ?? [ACCOUNT],
    );
    const connection = new AzureConnection({
        authentication,
        tenants: new AzureTenantClient(
            options.fetch ?? (async () => response({
                value: [{ tenantId: TENANT.id, displayName: TENANT.label }],
            })),
        ),
        publish: (state) => states.push(state),
        log: (message) => logs.push(message),
    });
    return { connection, states, logs, sessionCalls: () => sessionCalls };
}

test('a provider event before interactive resolution preserves the returned session', async () => {
    const interactive = deferred<AuthenticationSession | undefined>();
    const item = fixture({
        getSession: async (options, call) => {
            if (call === 1) {
                return undefined;
            }
            if (call === 2) {
                return interactive.promise;
            }
            assert.equal(options.silent, true);
            assert.deepEqual(options.account, ACCOUNT);
            return undefined;
        },
    });

    const connecting = item.connection.connect();
    await settle();
    const changed = item.connection.authenticationChanged();
    interactive.resolve(SESSION);
    await Promise.all([connecting, changed]);

    assert.equal(item.connection.state.phase, 'connected');
    assert.deepEqual(item.connection.state.tenants, [TENANT]);
    assert.equal(item.connection.state.identity?.label, ACCOUNT.label);
});

test('a provider event just after interactive resolution is reconciled after discovery', async () => {
    const interactive = deferred<AuthenticationSession | undefined>();
    const arm = deferred<ReturnType<typeof response>>();
    const item = fixture({
        getSession: async (_options, call) => {
            if (call === 1 || call === 3) {
                return undefined;
            }
            return interactive.promise;
        },
        fetch: async () => arm.promise,
    });

    const connecting = item.connection.connect();
    await settle();
    interactive.resolve(SESSION);
    await settle();
    const changed = item.connection.authenticationChanged();
    arm.resolve(response({
        value: [{ tenantId: TENANT.id, displayName: TENANT.label }],
    }));
    await Promise.all([connecting, changed]);

    assert.equal(item.connection.state.phase, 'connected');
    assert.equal(item.sessionCalls(), 3, 'silent, interactive, then pinned reconciliation');
});

test('a genuine sign-out during discovery clears identity and tenants', async () => {
    const arm = deferred<ReturnType<typeof response>>();
    const item = fixture({
        getSession: async (options) => options.silent ? undefined : SESSION,
        getAccounts: async () => [],
        fetch: async () => arm.promise,
    });

    const connecting = item.connection.connect();
    await settle();
    const changed = item.connection.authenticationChanged();
    arm.resolve(response({
        value: [{ tenantId: TENANT.id, displayName: TENANT.label }],
    }));
    await Promise.all([connecting, changed]);

    assert.equal(item.connection.state.phase, 'disconnected');
    assert.equal(item.connection.state.identity, null);
    assert.deepEqual(item.connection.state.tenants, []);
    assert.match(item.connection.state.message, /signed out/i);
});

test('an obsolete unresolved connect cannot overwrite a newer successful connect', async () => {
    const oldInteractive = deferred<AuthenticationSession | undefined>();
    const arm = deferred<ReturnType<typeof response>>();
    const newer: AuthenticationSession = {
        ...SESSION,
        id: 'session-2',
    };
    const item = fixture({
        getSession: async (options, call) => {
            if (call === 1 || call === 3 || call === 5) {
                return undefined;
            }
            if (call === 2) {
                return oldInteractive.promise;
            }
            return newer;
        },
        fetch: async () => arm.promise,
    });

    const old = item.connection.connect();
    await settle();
    const winner = item.connection.connect();
    await settle();
    const changed = item.connection.authenticationChanged();
    arm.resolve(response({
        value: [{ tenantId: TENANT.id, displayName: TENANT.label }],
    }));
    await Promise.all([winner, changed]);
    assert.equal(item.connection.state.phase, 'connected');

    oldInteractive.resolve(SESSION);
    await old;
    assert.equal(item.connection.state.phase, 'connected');
    assert.deepEqual(item.connection.state.tenants, [TENANT]);
});

test('disconnect cancels an unresolved interactive operation and retains no state', async () => {
    const interactive = deferred<AuthenticationSession | undefined>();
    const item = fixture({
        getSession: async (_options, call) =>
            call === 1 ? undefined : interactive.promise,
    });

    const pending = item.connection.connect();
    await settle();
    item.connection.disconnect();
    await item.connection.authenticationChanged();
    interactive.resolve(SESSION);
    await pending;

    assert.equal(item.connection.state.phase, 'disconnected');
    assert.equal(item.connection.state.identity, null);
    assert.deepEqual(item.connection.state.tenants, []);
});

test('a later provider event requires silent validation and clears stale state', async () => {
    let connected = false;
    const item = fixture({
        getSession: async (options) => {
            if (!connected && options.silent) {
                return undefined;
            }
            if (!connected) {
                connected = true;
                return SESSION;
            }
            return undefined;
        },
    });
    await item.connection.connect();
    assert.equal(item.connection.state.phase, 'connected');

    await item.connection.authenticationChanged();
    assert.equal(item.connection.state.phase, 'disconnected');
    assert.equal(item.connection.state.identity, null);
    assert.deepEqual(item.connection.state.tenants, []);
});

test('a superseded blocked reconciliation transfers the pending sign-out', async () => {
    const accounts = deferred<readonly AuthenticationAccount[]>();
    let accountCalls = 0;
    const newer: AuthenticationSession = { ...SESSION, id: 'session-2' };
    let sessionCalls = 0;
    const item = fixture({
        getSession: async () => {
            sessionCalls += 1;
            return sessionCalls === 1 ? SESSION : newer;
        },
        getAccounts: async () => {
            accountCalls += 1;
            return accountCalls === 1 ? accounts.promise : [];
        },
    });
    await item.connection.connect();
    assert.equal(item.connection.state.phase, 'connected');

    const changed = item.connection.authenticationChanged();
    await settle();
    await item.connection.connect();
    assert.equal(item.connection.state.phase, 'connected');

    accounts.resolve([]);
    await changed;
    assert.equal(item.connection.state.phase, 'disconnected');
    assert.equal(item.connection.state.identity, null);
    assert.deepEqual(item.connection.state.tenants, []);
});

test('disconnect during blocked revalidation cannot retain identity on later reconnect', async () => {
    const accounts = deferred<readonly AuthenticationAccount[]>();
    let accountCalls = 0;
    const item = fixture({
        getSession: async () => SESSION,
        getAccounts: async () => {
            accountCalls += 1;
            return accountCalls === 1 ? accounts.promise : [ACCOUNT];
        },
    });
    await item.connection.connect();
    const changed = item.connection.authenticationChanged();
    await settle();
    item.connection.disconnect();
    accounts.resolve([ACCOUNT]);
    await changed;

    assert.equal(item.connection.state.phase, 'disconnected');
    assert.equal(item.connection.state.identity, null);
    assert.deepEqual(item.connection.state.tenants, []);

    await item.connection.connect();
    assert.equal(item.connection.state.phase, 'connected');
    assert.deepEqual(item.connection.state.identity, { label: ACCOUNT.label });
});

test('state and diagnostics never disclose tokens or provider error text', async () => {
    const secret = SESSION.accessToken;
    const item = fixture({
        getSession: async () => {
            throw new Error(`provider included ${secret}`);
        },
    });
    await item.connection.connect();
    const serialised = JSON.stringify({ state: item.connection.state, logs: item.logs });
    assert.ok(!serialised.includes(secret));
    assert.ok(!serialised.includes('provider included'));
    assert.equal(item.connection.state.phase, 'error');
});
