import assert from 'node:assert/strict';
import test from 'node:test';

import { AppStateStore } from '../../appState';
import { ArmClient } from '../../azure/armClient';
import { MicrosoftAuthentication, type AuthenticationSession, type SessionOptions } from '../../azure/auth';
import { AZURE_BROWSER_CACHE_TTL_MS, AzureBrowser } from '../../azure/browser';
import { classifyStorageError } from '../../azure/errors';
import { MAX_STORAGE_ITEMS, StorageBrowserClient, type StoragePage } from '../../azure/storageClient';
import type { AzureBrowserState } from '../../azure/types';
import { UiController } from '../../ui/controller';
import type { UiHost } from '../../ui/host';

const HOST = 'blob001.blob.core.windows.net';
const URL = `https://${HOST}/raw/`;
const SESSION: AuthenticationSession = {
    id: 'session', accessToken: 'SECRET', account: { id: 'account', label: 'Microsoft account' },
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accept) => { resolve = accept; });
    return { promise, resolve };
}

function page(prefix = ''): StoragePage {
    return {
        items: [
            { kind: 'folder', name: 'child folder', prefix: prefix + 'child folder/' },
            {
                kind: 'file', name: 'daily sales.csv', blobName: prefix + 'daily sales.csv',
                sizeBytes: 42, modifiedAt: new Date(0),
            },
        ],
        continuationToken: undefined,
    };
}

class PublicStorage extends StorageBrowserClient {
    readonly calls: Array<{ host: string; container: string; prefix: string; marker?: string; signal?: AbortSignal }> = [];
    list = async (prefix: string, _marker?: string): Promise<StoragePage> => page(prefix);

    override async listPublicBlobs(host: string, container: string, prefix: string, marker?: string, signal?: AbortSignal) {
        this.calls.push({ host, container, prefix, marker, signal });
        return this.list(prefix, marker);
    }

    override async listContainers(): Promise<StoragePage> {
        assert.fail('public browsing must never enumerate containers');
    }

    override async listBlobs(): Promise<StoragePage> {
        assert.fail('public browsing must never use an authenticated Storage client');
    }
}

function fixture(options: { storage?: PublicStorage; now?: () => number } = {}) {
    const authenticationCalls: SessionOptions[] = [];
    let armCalls = 0;
    class EmptyArm extends ArmClient {
        override async listTenants() {
            armCalls += 1;
            return [];
        }
    }
    const storage = options.storage ?? new PublicStorage();
    const browser = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, _scopes, settings) => {
            authenticationCalls.push(settings);
            return SESSION;
        }),
        arm: new EmptyArm(),
        storage,
        now: options.now,
    });
    return { browser, storage, authenticationCalls, armCalls: () => armCalls };
}

function assertPublic(state: AzureBrowserState): void {
    assert.equal(state.mode, 'public');
    assert.equal(state.identity, null);
    assert.deepEqual(state.tenants, []);
    assert.deepEqual(state.subscriptions, []);
    assert.deepEqual(state.accounts, []);
    assert.equal(state.selectedTenantId, null);
    assert.equal(state.selectedSubscriptionId, null);
    assert.equal(state.selectedAccountId, null);
    assert.doesNotMatch(JSON.stringify(state), /SECRET|accessToken/);
}

test('public mode is explicit, has no auth resources, and navigates canonical folder and file locations', async () => {
    const subject = fixture();
    await subject.browser.open();
    assert.equal(subject.authenticationCalls.length, 0);
    assert.equal(subject.storage.calls.length, 0);
    let state = await subject.browser.openPublicContainer(URL, 'sales%20data/caf%C3%A9');
    assertPublic(state);
    assert.equal(state.phase, 'ready');
    assert.deepEqual(state.path, ['raw', 'sales data', 'caf\u00e9']);
    assert.deepEqual(subject.browser.currentFolderLocation(), {
        url: `abs://raw@${HOST}/sales%20data/caf%C3%A9/`,
        access: 'public',
    });
    const staleId = state.entries[1].id;
    state = await subject.browser.openEntry(state.entries[0].id);
    assert.deepEqual(state.path, ['raw', 'sales data', 'caf\u00e9', 'child folder']);
    await subject.browser.openEntry(staleId);
    assert.equal(subject.browser.snapshot.errorKind, 'invalidResponse');
    state = await subject.browser.retry();
    await subject.browser.openEntry(state.entries[1].id);
    assert.deepEqual(subject.browser.selectedLocation(), {
        url: `abs://raw@${HOST}/sales%20data/caf%C3%A9/child%20folder/daily%20sales.csv`,
        access: 'public',
    });
    state = await subject.browser.navigate(1);
    assert.deepEqual(state.path, ['raw']);
    assert.equal(subject.storage.calls.at(-1)?.prefix, '');
    const calls = subject.storage.calls.length;
    await subject.browser.navigate(0);
    await subject.browser.selectTenant('forged-tenant');
    await subject.browser.selectSubscription('forged-subscription');
    await subject.browser.selectAccount('forged-account');
    assertPublic(subject.browser.snapshot);
    assert.equal(subject.storage.calls.length, calls);
    assert.equal(subject.authenticationCalls.length, 0);
    assert.equal(subject.armCalls(), 0);
});

test('public paging preserves prefixes, hides continuation tokens, and stops at 1000 entries', async () => {
    const subject = fixture();
    let pageNumber = 0;
    subject.storage.list = async (prefix, marker) => {
        assert.equal(marker, pageNumber === 0 ? undefined : `private-marker-${pageNumber}`);
        pageNumber += 1;
        return {
            items: Array.from({ length: 100 }, (_, index) => ({
                kind: 'file' as const,
                name: `${pageNumber}-${index}.csv`,
                blobName: `${prefix}${pageNumber}-${index}.csv`,
                sizeBytes: 1,
                modifiedAt: null,
            })),
            continuationToken: `private-marker-${pageNumber}`,
        };
    };
    await subject.browser.openPublicContainer(URL, 'folder');
    while (subject.browser.snapshot.hasMore) {
        await subject.browser.loadMore();
    }
    assert.equal(subject.browser.snapshot.entries.length, MAX_STORAGE_ITEMS);
    assert.equal(subject.storage.calls.length, 10);
    assert.ok(subject.storage.calls.every((call) => call.prefix === 'folder/'));
    assert.match(subject.browser.snapshot.message ?? '', /first 1000 items/);
    assert.doesNotMatch(JSON.stringify(subject.browser.snapshot), /private-marker/);
    await subject.browser.loadMore();
    assert.equal(subject.storage.calls.length, 10);
    assert.equal(subject.authenticationCalls.length, 0);
});

test('public cache, refresh, close, and provider changes never silently reconnect Microsoft', async () => {
    let now = 0;
    const subject = fixture({ now: () => now });
    await subject.browser.openPublicContainer(URL, 'folder');
    const ready = subject.browser.snapshot;
    assert.strictEqual(await subject.browser.authenticationChanged(), ready);
    subject.browser.close();
    await subject.browser.authenticationChanged();
    assert.equal(subject.browser.snapshot.phase, 'closed');
    assertPublic(await subject.browser.open());
    assert.equal(subject.storage.calls.length, 1);
    now = AZURE_BROWSER_CACHE_TTL_MS + 1;
    subject.browser.close();
    assertPublic(await subject.browser.open());
    assert.equal(subject.storage.calls.length, 2);
    const delayed = deferred<StoragePage>();
    subject.storage.list = async () => delayed.promise;
    const refresh = subject.browser.refresh();
    assert.strictEqual(subject.browser.refresh(), refresh);
    delayed.resolve(page('folder/'));
    await refresh;
    assert.equal(subject.storage.calls.length, 3);
    subject.browser.disconnect();
    assert.equal(subject.browser.snapshot.publicContainer, null);
    assert.equal((await subject.browser.open()).phase, 'signedOut');
    await subject.browser.authenticationChanged();
    assert.equal(subject.authenticationCalls.length, 0);
});

test('invalid input and denied public listings stay public and retries never request OAuth', async () => {
    const subject = fixture();
    const invalid = await subject.browser.openPublicContainer(URL + '?sig=SECRET');
    assertPublic(invalid);
    assert.equal(invalid.publicContainer, null);
    assert.equal(invalid.errorKind, 'invalidResponse');
    await subject.browser.retry();
    assert.equal(subject.storage.calls.length, 0);
    for (const code of ['AuthorizationPermissionMismatch', 'AccountIsDisabled', 'PublicAccessNotPermitted', 'ContainerNotFound']) {
        subject.storage.list = async () => {
            throw classifyStorageError({ statusCode: 403, code }, { operation: 'blobs', access: 'public' });
        };
        await subject.browser.openPublicContainer(URL);
        assertPublic(await subject.browser.retry());
        assert.equal(subject.browser.snapshot.phase, 'error');
        assert.equal(subject.browser.currentFolderLocation(), undefined);
        subject.browser.close();
        assertPublic(await subject.browser.open());
        assert.equal(subject.browser.snapshot.phase, 'error');
    }
    assert.equal(subject.authenticationCalls.length, 0);
    assert.equal(subject.armCalls(), 0);
});

test('switching public containers aborts and invalidates stale listing results immediately', async () => {
    const subject = fixture();
    const oldPage = deferred<StoragePage>();
    subject.storage.list = async (prefix) => prefix === 'old/' ? oldPage.promise : page(prefix);
    const oldRequest = subject.browser.openPublicContainer(URL, 'old');
    const signal = subject.storage.calls[0].signal;
    await subject.browser.openPublicContainer(`https://${HOST}/other/`, 'new');
    assert.equal(signal?.aborted, true);
    const current = subject.browser.snapshot;
    oldPage.resolve(page('old/'));
    await oldRequest;
    assert.strictEqual(subject.browser.snapshot, current);
    assert.deepEqual(current.path, ['other', 'new']);
    assert.equal(subject.authenticationCalls.length, 0);
});

test('close, disconnect, and Connect cancel public requests without stale results reopening them', async (context) => {
    for (const action of ['close', 'disconnect', 'connect'] as const) {
        await context.test(action, async () => {
            const subject = fixture();
            const response = deferred<StoragePage>();
            subject.storage.list = async () => response.promise;
            const loading = subject.browser.openPublicContainer(URL);
            await subject.browser.authenticationChanged();
            assert.equal(subject.authenticationCalls.length, 0);
            await subject.browser[action]();
            const afterAction = subject.browser.snapshot;
            assert.equal(subject.storage.calls[0].signal?.aborted, true);
            response.resolve(page());
            await loading;
            assert.strictEqual(subject.browser.snapshot, afterAction);
            assert.equal(subject.authenticationCalls.length, action === 'connect' ? 1 : 0);
            assert.equal(afterAction.mode, action === 'close' ? 'public' : 'authenticated');
        });
    }
});

test('switching to public cancels a pending silent lookup before any delayed consent prompt', async () => {
    const silent = deferred<AuthenticationSession | undefined>();
    const settings: SessionOptions[] = [];
    const storage = new PublicStorage();
    const browser = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, _scopes, options) => {
            settings.push(options);
            return silent.promise;
        }),
        storage,
    });
    const connecting = browser.connect();
    await browser.openPublicContainer(URL);
    const ready = browser.snapshot;
    silent.resolve(undefined);
    await connecting;
    assert.deepEqual(settings, [{ silent: true }]);
    assert.strictEqual(browser.snapshot, ready);
    await browser.authenticationChanged();
    assertPublic(browser.snapshot);
    assert.equal(settings.length, 1);
});

test('a deferred provider event and ARM result cannot replace a newly selected public container', async () => {
    const tenants = deferred<readonly { id: string; label: string }[]>();
    let armStarted!: () => void;
    const started = new Promise<void>((resolve) => { armStarted = resolve; });
    let authenticationCalls = 0;
    class DeferredArm extends ArmClient {
        override async listTenants() {
            armStarted();
            return tenants.promise;
        }
    }
    const browser = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async () => {
            authenticationCalls += 1;
            return SESSION;
        }),
        arm: new DeferredArm(),
        storage: new PublicStorage(),
    });
    const connecting = browser.connect();
    await started;
    await browser.authenticationChanged();
    await browser.openPublicContainer(URL);
    const ready = browser.snapshot;
    tenants.resolve([]);
    await connecting;
    assert.strictEqual(browser.snapshot, ready);
    assert.equal(authenticationCalls, 1);
    assertPublic(browser.snapshot);
});

test('controller hands off host-owned public access, not renderer claims or stale SQL managed identity', async () => {
    const subject = fixture();
    const store = new AppStateStore({ version: '1.1.16' });
    const preferences = new Map<string, unknown>();
    const host: UiHost = {
        version: '1.1.16', workspaceFolders: () => [],
        showOpenDialog: async () => undefined,
        copyToClipboard: async () => undefined,
        openUntitledDocument: async () => undefined,
        openExternal: async () => true,
        saveTextFile: async () => undefined,
        showInformation: () => undefined, showWarning: () => undefined, showError: () => undefined,
        log: () => undefined,
        getPreference: <T,>(_key: string, fallback: T): T => fallback,
        setPreference: async (key, value) => { preferences.set(key, value); },
        openPanel: async () => undefined, now: () => 0,
    };
    const controller = new UiController(host, store, { azure: subject.browser });
    try {
        await controller.handle({ type: 'ready' });
        await controller.handle({ type: 'openAzureBrowser' });
        assert.equal(subject.authenticationCalls.length, 0);
        assert.equal(subject.storage.calls.length, 0);
        await controller.handle({ type: 'setAuthMethod', value: 'managed_identity' });
        assert.equal(store.state.authMethod, 'managed_identity');
        await controller.handle({
            type: 'azureBrowserOpenPublicContainer', url: URL, prefix: 'sales%20data/',
            access: 'authenticated', accessToken: 'FORGED SECRET',
        });
        assertPublic(store.state.azure);
        await controller.handle({ type: 'azureBrowserUseCurrentFolder', access: 'authenticated' });
        assert.equal(store.state.authMethod, 'public');
        assert.equal(store.state.credentialSetup.authMethod, 'public');
        assert.equal(store.state.storageUrl, `abs://raw@${HOST}/sales%20data/`);
        assert.equal(store.state.activeTab, 'credential_setup');
        assert.equal(store.state.azureFolderPreview?.items.length, 2);
        assert.equal(store.state.metadata, null);
        assert.equal(store.state.preview, null);
        assert.match(store.state.statements?.credential_setup ?? '', /TEMPLATE ONLY - REMOTE SCHEMA NOT ANALYZED/);
        assert.doesNotMatch(store.state.statements?.credential_setup ?? '', /IDENTITY =|SECRET =|^CREATE DATABASE SCOPED CREDENTIAL/m);

        await controller.handle({ type: 'openAzureBrowser' });
        await controller.handle({
            type: 'azureBrowserOpenEntry',
            entryId: store.state.azure.entries.find((entry) => entry.kind === 'file')!.id,
        });
        await controller.handle({ type: 'setAuthMethod', value: 'managed_identity' });
        await controller.handle({ type: 'azureBrowserUseSelectedFile', access: 'authenticated' });
        assert.equal(store.state.authMethod, 'public');
        assert.equal(store.state.storageUrl, `abs://raw@${HOST}/sales%20data/daily%20sales.csv`);
        assert.equal(store.state.remoteSchema?.status, 'not_analyzed');
        assert.equal(store.state.azureFolderPreview, null);
        assert.equal(subject.authenticationCalls.length, 0);
        assert.equal(subject.armCalls(), 0);
        assert.doesNotMatch(JSON.stringify([...preferences]), /blob\.core|SECRET|accessToken/);
    } finally {
        await controller.dispose();
    }
});
