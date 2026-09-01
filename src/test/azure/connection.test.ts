/**
 * Tests for the native Azure connection.
 *
 * Every editor capability is injected, so all four authentication modes run
 * here with no editor, no network and no clock. The assertions concentrate on
 * the rules that keep credentials contained: nothing observable carries a
 * secret, remembering is opt-in and defaults to no, and disconnecting or losing
 * a session clears everything.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    NativeAzureBridge,
    SECRET_KEY,
    type AuthEnvironment,
    type AuthSessionRequest,
    type AuthToken,
    type PromptOptions,
} from '../../azure/connection';
import type { BlobBrowser, BlobCredential } from '../../azure/blobBrowser';
import { AzureInputError } from '../../azure/storageUrl';
import { ARM_SCOPES, STORAGE_SCOPES, VSCODE_TENANT_SCOPE } from '../../azureScopes';

interface Harness {
    readonly secrets: Map<string, string>;
    readonly logs: string[];
    readonly prompts: PromptOptions[];
    readonly sessionRequests: { scopes: string[]; request: AuthSessionRequest }[];
    readonly credentials: BlobCredential[];
    answer: string | undefined;
    confirmAnswer: boolean;
    session: AuthToken | undefined;
    armSession: AuthToken | undefined;
    clock: number;
    timers: { callback: () => void; delayMs: number; cancelled: boolean }[];
    fireTimer(): void;
    env: AuthEnvironment;
}

function harness(overrides: Partial<Harness> = {}): Harness {
    const secrets = new Map<string, string>();
    const state: Harness = {
        secrets,
        logs: [],
        prompts: [],
        sessionRequests: [],
        credentials: [],
        answer: undefined,
        confirmAnswer: false,
        session: {
            accessToken: 'storage-token',
            expiresOnMs: 3_600_000,
            tenantId: '11111111-1111-1111-1111-111111111111',
            account: { id: 'account-1', label: 'user@example.com' },
        },
        armSession: {
            accessToken: 'arm-token',
            expiresOnMs: 3_600_000,
            account: { id: 'account-1', label: 'user@example.com' },
        },
        clock: 0,
        timers: [],
        fireTimer(): void {
            const pending = state.timers.filter((timer) => !timer.cancelled);
            assert.ok(pending.length > 0, 'no timer was scheduled');
            pending[pending.length - 1].callback();
        },
        env: undefined as unknown as AuthEnvironment,
        ...overrides,
    };
    const environment: AuthEnvironment = {
        getSession: async (scopes, request) => {
            state.sessionRequests.push({ scopes, request });
            return scopes === ARM_SCOPES || scopes[0].includes('management')
                ? state.armSession
                : state.session;
        },
        prompt: async (options) => {
            state.prompts.push(options);
            return state.answer;
        },
        confirm: async () => state.confirmAnswer,
        secrets: {
            get: async (key) => secrets.get(key),
            store: async (key, value) => void secrets.set(key, value),
            delete: async (key) => void secrets.delete(key),
        },
        log: (message) => state.logs.push(message),
        now: () => state.clock,
        setTimer: (callback, delayMs) => {
            const timer = { callback, delayMs, cancelled: false };
            state.timers.push(timer);
            return {
                cancel: () => {
                    timer.cancelled = true;
                },
            };
        },
        createBrowser: (account, serviceUrl, credential): BlobBrowser => {
            state.credentials.push(credential);
            return {
                account,
                listContainers: async () => ({ names: [], continuation: null }),
                listBlobs: async () => ({ entries: [], continuation: null }),
                downloadBlob: async () => ({ path: '', bytes: 0 }),
                blobUrl: (container: string, blob: string) =>
                    `${serviceUrl}/${container}/${blob}`,
            };
        },
    };
    state.env = environment;
    return state;
}

const SAS_URL =
    'https://myaccount.blob.core.windows.net/data?sv=2021-08-06&ss=b&sig=SIGNATURE-VALUE';
const CONNECTION_STRING =
    'DefaultEndpointsProtocol=https;AccountName=myaccount;AccountKey=U0VDUkVUS0VZ==;EndpointSuffix=core.windows.net';

test('the VS Code account mode uses a delegated token and never a stored secret', async () => {
    const h = harness();
    const bridge = new NativeAzureBridge(h.env);
    const info = await bridge.connect('vscode');

    assert.equal(info.connected, true);
    assert.equal(info.mode, 'vscode');
    assert.equal(info.identity, 'user@example.com');
    assert.equal(info.canListSubscriptions, true);
    assert.deepEqual(h.sessionRequests[0], {
        scopes: [...STORAGE_SCOPES, `${VSCODE_TENANT_SCOPE}organizations`],
        request: { interactive: true, clearSessionPreference: true },
    });
    assert.deepEqual(h.sessionRequests[1], {
        scopes: [...ARM_SCOPES, `${VSCODE_TENANT_SCOPE}organizations`],
        request: {
            interactive: false,
            account: { id: 'account-1', label: 'user@example.com' },
        },
    });
    assert.equal(info.tenantId, '11111111-1111-1111-1111-111111111111');
    assert.equal(h.secrets.size, 0, 'a delegated token is never persisted');
    assert.equal(h.prompts.length, 0, 'no free-text prompt is used for the account mode');
    assert.equal(await bridge.armToken(), 'arm-token');
});

test('a cancelled sign-in leaves the bridge disconnected', async () => {
    const h = harness({ session: undefined });
    const bridge = new NativeAzureBridge(h.env);
    await assert.rejects(bridge.connect('vscode'), AzureInputError);
    assert.equal(bridge.info.connected, false);
    assert.equal(bridge.browser(), undefined);
});

test('a failed replacement keeps the working connection and remembered credential', async () => {
    const h = harness({ answer: SAS_URL, confirmAnswer: true });
    const bridge = new NativeAzureBridge(h.env);
    await bridge.connect('sas');
    const previousInfo = bridge.info;
    const previousBrowser = bridge.browser();
    const previousSecret = h.secrets.get(SECRET_KEY);

    h.session = undefined;
    await assert.rejects(bridge.connect('vscode'), AzureInputError);

    assert.deepEqual(bridge.info, previousInfo);
    assert.equal(bridge.browser(), previousBrowser);
    assert.equal(h.secrets.get(SECRET_KEY), previousSecret);
});

test('an explicit tenant is applied to sign-in, refresh, and ARM discovery', async () => {
    const h = harness();
    const bridge = new NativeAzureBridge(h.env);
    const tenant = '22222222-2222-2222-2222-222222222222';
    const info = await bridge.connect('vscode', tenant);

    assert.equal(info.tenantId, tenant);
    assert.deepEqual(h.sessionRequests[0].scopes, [
        ...STORAGE_SCOPES,
        `${VSCODE_TENANT_SCOPE}${tenant}`,
    ]);
    assert.deepEqual(h.sessionRequests[1].scopes, [
        ...ARM_SCOPES,
        `${VSCODE_TENANT_SCOPE}${tenant}`,
    ]);
});

test('tenant mismatches become actionable and invalid tenant ids never open sign-in', async () => {
    const h = harness();
    const bridge = new NativeAzureBridge({
        ...h.env,
        getSession: async () => {
            throw new Error(
                "AADSTS50020: Selected user account does not exist in tenant 'Microsoft Services'.",
            );
        },
    });
    await assert.rejects(
        bridge.connect('vscode'),
        /Directory \(tenant\) ID that owns the storage account/i,
    );

    const invalid = harness();
    const second = new NativeAzureBridge(invalid.env);
    await assert.rejects(second.connect('vscode', 'not-a-guid'), /must be a GUID/i);
    assert.equal(invalid.sessionRequests.length, 0);
});

test('the delegated token is refreshed before it expires', async () => {
    const h = harness();
    const bridge = new NativeAzureBridge(h.env);
    await bridge.connect('vscode');

    const scheduled = h.timers.at(-1);
    assert.ok(scheduled);
    assert.ok(scheduled.delayMs > 0 && scheduled.delayMs < 3_600_000, 'refresh runs before expiry');

    h.clock = 3_000_000;
    h.session = {
        accessToken: 'fresh',
        expiresOnMs: 7_200_000,
        account: { id: 'account-1', label: 'user@example.com' },
    };
    h.fireTimer();
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(
        h.sessionRequests.some((request) => !request.request.interactive),
        'the refresh must be silent',
    );
    assert.equal(bridge.info.connected, true);
});

test('losing the session disconnects rather than leaving a stale connection', async () => {
    const h = harness();
    const bridge = new NativeAzureBridge(h.env);
    await bridge.connect('vscode');

    h.session = undefined;
    h.fireTimer();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(bridge.info.connected, false);
    assert.equal(bridge.info.mode, null);
    assert.equal(bridge.browser(), undefined);
});

test('the SAS mode masks the input and keeps the signature out of the state', async () => {
    const h = harness({ answer: SAS_URL });
    const bridge = new NativeAzureBridge(h.env);
    const info = await bridge.connect('sas');

    assert.equal(h.prompts[0].password, true, 'a SAS URL is a credential and must be masked');
    assert.equal(info.mode, 'sas');
    assert.equal(info.account, 'myaccount');
    assert.equal(info.identity, 'Shared access signature');
    assert.equal(info.container, 'data');
    assert.equal(info.prefix, '');
    assert.equal(info.canListSubscriptions, false);
    assert.ok(!JSON.stringify(info).includes('SIGNATURE-VALUE'));
    assert.ok(!h.logs.join('\n').includes('SIGNATURE-VALUE'));
    assert.deepEqual(h.credentials.at(-1), {
        kind: 'sas',
        sasToken: 'sv=2021-08-06&ss=b&sig=SIGNATURE-VALUE',
    });
    assert.equal(h.secrets.size, 0, 'remembering defaults to no');
});

test('a credential is only stored when the user explicitly opts in', async () => {
    const h = harness({ answer: SAS_URL, confirmAnswer: true });
    const bridge = new NativeAzureBridge(h.env);
    await bridge.connect('sas');
    assert.equal(h.secrets.size, 1);
    const stored = JSON.parse(h.secrets.get(SECRET_KEY) as string);
    assert.equal(stored.mode, 'sas');
    assert.equal(stored.account, 'myaccount');
    assert.equal(stored.container, 'data');
});

test('the connection string mode is masked and stores nothing by default', async () => {
    const h = harness({ answer: CONNECTION_STRING });
    const bridge = new NativeAzureBridge(h.env);
    const info = await bridge.connect('connectionString');

    assert.equal(h.prompts[0].password, true);
    assert.equal(info.mode, 'connectionString');
    assert.equal(info.account, 'myaccount');
    assert.deepEqual(h.credentials.at(-1), { kind: 'accountKey', accountKey: 'U0VDUkVUS0VZ==' });
    assert.ok(!JSON.stringify(info).includes('U0VDUkVUS0VZ'));
    assert.ok(!h.logs.join('\n').includes('U0VDUkVUS0VZ'));
    assert.equal(h.secrets.size, 0);
});

test('anonymous mode takes a public container URL and holds no credential', async () => {
    const h = harness({
        answer: 'https://azureopendatastorage.blob.core.windows.net/nyctlc/yellow',
    });
    const bridge = new NativeAzureBridge(h.env);
    const info = await bridge.connect('anonymous');

    assert.equal(h.prompts[0].password, false, 'a public container URL is not a secret');
    assert.equal(info.mode, 'anonymous');
    assert.equal(info.account, 'azureopendatastorage');
    assert.equal(info.container, 'nyctlc');
    assert.equal(info.prefix, 'yellow');
    assert.deepEqual(h.credentials.at(-1), { kind: 'anonymous' });
    assert.equal(h.secrets.size, 0);
});

test('invalid input in each prompted mode is refused', async () => {
    for (const [mode, answer] of [
        ['sas', 'https://evil.example/data?sig=x'],
        ['connectionString', 'AccountName=myaccount'],
        ['anonymous', 'https://evil.example/data'],
    ] as const) {
        const h = harness({ answer });
        const bridge = new NativeAzureBridge(h.env);
        await assert.rejects(bridge.connect(mode), AzureInputError, mode);
        assert.equal(bridge.info.connected, false);
    }
});

test('cancelling a prompt is refused rather than half-connecting', async () => {
    for (const mode of ['sas', 'connectionString', 'anonymous'] as const) {
        const h = harness({ answer: undefined });
        const bridge = new NativeAzureBridge(h.env);
        await assert.rejects(bridge.connect(mode), AzureInputError, mode);
        assert.equal(bridge.info.connected, false);
    }
});

test('an unknown mode is refused', async () => {
    const h = harness();
    const bridge = new NativeAzureBridge(h.env);
    await assert.rejects(
        bridge.connect('managedIdentity' as never),
        AzureInputError,
        'managed identity is not a desktop mode',
    );
});

test('disconnecting clears memory and the secret store', async () => {
    const h = harness({ answer: SAS_URL, confirmAnswer: true });
    const bridge = new NativeAzureBridge(h.env);
    await bridge.connect('sas');
    assert.equal(h.secrets.size, 1);

    await bridge.disconnect();
    assert.equal(bridge.info.connected, false);
    assert.equal(bridge.info.mode, null);
    assert.equal(bridge.info.account, null);
    assert.equal(bridge.browser(), undefined);
    assert.equal(h.secrets.size, 0, 'disconnect must not leave the key behind');
    assert.equal(await bridge.armToken(), undefined);
});

test('disposal clears the credential and cancels the refresh timer', async () => {
    const h = harness();
    const bridge = new NativeAzureBridge(h.env);
    await bridge.connect('vscode');
    bridge.dispose();
    assert.equal(bridge.info.connected, false);
    assert.equal(bridge.browser(), undefined);
    assert.ok(h.timers.every((timer) => timer.cancelled), 'no timer may outlive the bridge');
});

test('a remembered credential is restored, and an unusable one is deleted', async () => {
    const h = harness();
    h.secrets.set(
        SECRET_KEY,
        JSON.stringify({
            mode: 'sas',
            account: 'myaccount',
            serviceUrl: 'https://myaccount.blob.core.windows.net',
            sasToken: 'sv=2021-08-06&sig=SIGNATURE-VALUE',
        }),
    );
    const bridge = new NativeAzureBridge(h.env);
    const info = await bridge.restore();
    assert.equal(info.connected, true);
    assert.equal(info.mode, 'sas');
    assert.equal(info.account, 'myaccount');
    assert.ok(bridge.browser());
    assert.ok(!JSON.stringify(info).includes('SIGNATURE-VALUE'));

    const broken = harness();
    broken.secrets.set(SECRET_KEY, '{not json');
    const second = new NativeAzureBridge(broken.env);
    assert.equal((await second.restore()).connected, false);
    assert.equal(broken.secrets.size, 0);

    const unusable = harness();
    unusable.secrets.set(SECRET_KEY, JSON.stringify({ mode: 'vscode', account: 'myaccount' }));
    const third = new NativeAzureBridge(unusable.env);
    assert.equal((await third.restore()).connected, false);
    assert.equal(unusable.secrets.size, 0, 'a token mode cannot be restored from a secret');
});

test('restore never throws when the secret store is unavailable', async () => {
    const h = harness();
    const env: AuthEnvironment = {
        ...h.env,
        secrets: {
            get: async () => {
                throw new Error('locked');
            },
            store: async () => undefined,
            delete: async () => undefined,
        },
    };
    const bridge = new NativeAzureBridge(env);
    assert.equal((await bridge.restore()).connected, false);
});

test('switching accounts is allowed for a token and refused for a scoped credential', async () => {
    const token = harness();
    const withToken = new NativeAzureBridge(token.env);
    await withToken.connect('vscode');
    const info = await withToken.useAccount('otheraccount');
    assert.equal(info.account, 'otheraccount');
    assert.equal(token.credentials.at(-1)?.kind, 'token');

    const sas = harness({ answer: SAS_URL });
    const withSas = new NativeAzureBridge(sas.env);
    await withSas.connect('sas');
    await assert.rejects(withSas.useAccount('otheraccount'), AzureInputError);
    assert.equal((await withSas.useAccount('myaccount')).account, 'myaccount');

    await assert.rejects(withToken.useAccount('BAD NAME'), AzureInputError);
    const fresh = new NativeAzureBridge(harness().env);
    await assert.rejects(fresh.useAccount('myaccount'), AzureInputError);
});

test('an ARM token is only offered for the delegated mode and is cached until expiry', async () => {
    const sas = harness({ answer: SAS_URL });
    const withSas = new NativeAzureBridge(sas.env);
    await withSas.connect('sas');
    assert.equal(await withSas.armToken(), undefined);

    const h = harness();
    const bridge = new NativeAzureBridge(h.env);
    await bridge.connect('vscode');
    const before = h.sessionRequests.length;
    assert.equal(await bridge.armToken(), 'arm-token');
    assert.equal(h.sessionRequests.length, before, 'a valid ARM token is reused');

    h.clock = 3_600_000;
    h.armSession = {
        accessToken: 'arm-token-2',
        expiresOnMs: 7_200_000,
        account: { id: 'account-1', label: 'user@example.com' },
    };
    assert.equal(await bridge.armToken(true), 'arm-token-2');
    assert.equal(h.sessionRequests.at(-1)?.request.interactive, true);
});

test('subscription listing is simply unavailable when ARM consent is missing', async () => {
    const h = harness({ armSession: undefined });
    const bridge = new NativeAzureBridge(h.env);
    const info = await bridge.connect('vscode');
    assert.equal(info.connected, true);
    assert.equal(info.canListSubscriptions, false);
    assert.equal(await bridge.armToken(), undefined);
});

test('no observable surface of the bridge exposes a credential', async () => {
    const h = harness({ answer: CONNECTION_STRING, confirmAnswer: false });
    const bridge = new NativeAzureBridge(h.env);
    await bridge.connect('connectionString');
    const visible = JSON.stringify({ info: bridge.info, logs: h.logs });
    for (const secret of ['U0VDUkVUS0VZ', 'AccountKey', 'sig=']) {
        assert.ok(!visible.includes(secret), `${secret} leaked into observable state`);
    }
});
