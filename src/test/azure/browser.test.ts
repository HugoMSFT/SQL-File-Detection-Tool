import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ARM_SCOPE,
    STORAGE_SCOPE,
    MicrosoftAuthentication,
    type AuthenticationSession,
    type SessionOptions,
} from '../../azure/auth';
import { ArmClient } from '../../azure/armClient';
import { AzureBrowser, azureStorageUrl } from '../../azure/browser';
import { AzureBrowserError, classifyStorageError } from '../../azure/errors';
import {
    StorageBrowserClient,
    type StoragePage,
} from '../../azure/storageClient';
import { AppStateStore } from '../../appState';
import { UiController } from '../../ui/controller';
import type { UiHost } from '../../ui/host';
import { knownStorageLocation } from '../../native';

const SESSION: AuthenticationSession = {
    accessToken: 'bearer-token-must-not-leak',
    account: { id: 'identity-1', label: 'developer@example.test' },
};
const SUBSCRIPTION = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID =
    `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-data/` +
    'providers/Microsoft.Storage/storageAccounts/lake001';

class FakeArm extends ArmClient {
    override async listTenants(): Promise<readonly { id: string; label: string }[]> {
        return [{ id: 'tenant-1', label: 'Tenant One' }];
    }

    override async listSubscriptions(): Promise<
        readonly { id: string; tenantId: string; label: string }[]
    > {
        return [{ id: SUBSCRIPTION, tenantId: 'tenant-1', label: 'Development' }];
    }

    override async listStorageAccounts() {
        return [
            {
                id: ACCOUNT_ID,
                name: 'lake001',
                resourceGroup: 'rg-data',
                location: 'westus2',
                kind: 'StorageV2',
                hns: true,
                blobHost: 'lake001.blob.core.windows.net',
                dfsHost: 'lake001.dfs.core.windows.net',
            },
        ];
    }
}

class FakeStorage extends StorageBrowserClient {
    override async listContainers(): Promise<StoragePage> {
        return {
            items: [{ kind: 'container', name: 'landing', modifiedAt: new Date(0) }],
            continuationToken: undefined,
        };
    }

    override async listBlobs(
        _account: string,
        _container: string,
        prefix: string,
    ): Promise<StoragePage> {
        return prefix === ''
            ? {
                  items: [{ kind: 'folder', name: 'orders', prefix: 'orders/' }],
                  continuationToken: undefined,
              }
            : {
                  items: [
                      {
                          kind: 'file',
                          name: 'daily sales.parquet',
                          blobName: 'orders/daily sales.parquet',
                          sizeBytes: 42,
                          modifiedAt: new Date(1_000),
                      },
                  ],
                  continuationToken: undefined,
              };
    }
}

function browser(storage: StorageBrowserClient = new FakeStorage()) {
    const scopes: Array<readonly string[]> = [];
    const authentication = new MicrosoftAuthentication(async (_provider, requested) => {
        scopes.push(requested);
        return SESSION;
    });
    return {
        scopes,
        value: new AzureBrowser({
            authentication,
            arm: new FakeArm(),
            storage,
        }),
    };
}

test('Blob and HNS selections produce canonical ABS and ABFSS locations', () => {
    assert.equal(
        azureStorageUrl({ name: 'blob001', hns: false }, 'raw', '2026/daily sales.csv'),
        'abs://raw@blob001.blob.core.windows.net/2026/daily%20sales.csv',
    );
    assert.equal(
        azureStorageUrl({ name: 'lake001', hns: true }, 'landing', 'orders/data.parquet'),
        'abfss://landing@lake001.dfs.core.windows.net/orders/data.parquet',
    );
    assert.equal(
        azureStorageUrl(
            {
                name: 'lake001',
                hns: true,
                blobHost: 'lake001.z19.blob.storage.azure.net',
                dfsHost: 'lake001.z19.dfs.storage.azure.net',
            },
            'landing',
            'orders/data.parquet',
        ),
        'abfss://landing@lake001.z19.dfs.storage.azure.net/orders/data.parquet',
    );
    assert.equal(
        knownStorageLocation(
            'abfss://landing@lake001.z19.dfs.storage.azure.net/orders/data.parquet',
        ).dataSourceType,
        'azure_data_lake',
    );
});

test('disconnect prevents an in-flight authentication result from reopening the browser', async () => {
    let resolveSession: ((session: AuthenticationSession | undefined) => void) | undefined;
    const pendingSession = new Promise<AuthenticationSession | undefined>((resolve) => {
        resolveSession = resolve;
    });
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async () => pendingSession),
        arm: new FakeArm(),
        storage: new FakeStorage(),
    });
    const opening = subject.open();
    subject.disconnect();
    resolveSession?.(SESSION);
    await opening;
    assert.equal(subject.snapshot.phase, 'closed');
    assert.equal(subject.snapshot.open, false);
    assert.equal(subject.snapshot.identity, null);
});

test('provider change before interactive auth resolves does not cancel its session', async () => {
    let resolveInteractive: ((session: AuthenticationSession) => void) | undefined;
    let interactiveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
        interactiveStarted = resolve;
    });
    const pendingInteractive = new Promise<AuthenticationSession>((resolve) => {
        resolveInteractive = resolve;
    });
    let signedIn = false;
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, _scopes, options) => {
            if (options.silent) {
                return signedIn ? SESSION : undefined;
            }
            interactiveStarted?.();
            const session = await pendingInteractive;
            signedIn = true;
            return session;
        }),
        arm: new FakeArm(),
        storage: new FakeStorage(),
    });

    const connecting = subject.connect();
    await started;
    const providerChange = subject.authenticationChanged();
    resolveInteractive?.(SESSION);
    const [connected] = await Promise.all([connecting, providerChange]);

    assert.equal(connected.phase, 'ready');
    assert.equal(subject.snapshot.identity?.id, SESSION.account.id);
    assert.equal(subject.snapshot.accounts[0].id, ACCOUNT_ID);
});

test('provider change just after interactive auth resolves does not discard its session', async () => {
    let resolveInteractive: ((session: AuthenticationSession) => void) | undefined;
    let signedIn = false;
    let interactiveStarted: (() => void) | undefined;
    let tenantsStarted: (() => void) | undefined;
    let releaseTenants: (() => void) | undefined;
    const authStarted = new Promise<void>((resolve) => {
        interactiveStarted = resolve;
    });
    const started = new Promise<void>((resolve) => {
        tenantsStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
        releaseTenants = resolve;
    });
    class BlockingArm extends FakeArm {
        override async listTenants(): Promise<readonly { id: string; label: string }[]> {
            tenantsStarted?.();
            await release;
            return super.listTenants();
        }
    }
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, _scopes, options) => {
            if (options.silent) {
                return signedIn ? SESSION : undefined;
            }
            interactiveStarted?.();
            return new Promise<AuthenticationSession>((resolve) => {
                resolveInteractive = (session) => {
                    signedIn = true;
                    resolve(session);
                };
            });
        }),
        arm: new BlockingArm(),
        storage: new FakeStorage(),
    });

    const connecting = subject.connect();
    await authStarted;
    resolveInteractive?.(SESSION);
    await started;
    const providerChange = await subject.authenticationChanged();
    assert.notEqual(providerChange.phase, 'signedOut');
    releaseTenants?.();
    const connected = await connecting;

    assert.equal(connected.phase, 'ready');
    assert.equal(subject.snapshot.identity?.id, SESSION.account.id);
    assert.equal(subject.snapshot.accounts[0].id, ACCOUNT_ID);
});

test('superseded unresolved authentication cannot block reconciliation after its winner', async () => {
    const interactiveResolvers: Array<(session: AuthenticationSession) => void> = [];
    let notifyInteractive: (() => void) | undefined;
    let signedIn = false;
    const interactiveStarted = (): Promise<void> =>
        new Promise((resolve) => {
            notifyInteractive = resolve;
        });
    let started = interactiveStarted();
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, _scopes, options) => {
            if (options.silent) {
                return signedIn ? SESSION : undefined;
            }
            return new Promise<AuthenticationSession>((resolve) => {
                interactiveResolvers.push((session) => {
                    signedIn = true;
                    resolve(session);
                });
                notifyInteractive?.();
            });
        }),
        arm: new FakeArm(),
        storage: new FakeStorage(),
    });

    const first = subject.connect();
    await started;
    started = interactiveStarted();
    const second = subject.connect();
    await started;
    interactiveResolvers[1](SESSION);
    await second;
    assert.equal(subject.snapshot.phase, 'ready');

    signedIn = false;
    const providerChange = await subject.authenticationChanged();
    assert.equal(providerChange.phase, 'signedOut');
    interactiveResolvers[0](SESSION);
    await first;
    assert.equal(subject.snapshot.phase, 'signedOut');
    assert.equal(subject.snapshot.identity, null);
});

test('non-interactive loading revokes unresolved interactive auth suppression', async () => {
    let resolveStorageAuth: ((session: AuthenticationSession) => void) | undefined;
    let notifyStorageAuth: (() => void) | undefined;
    const storageAuthStarted = new Promise<void>((resolve) => {
        notifyStorageAuth = resolve;
    });
    let managementSignedIn = true;
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, scopes, options) => {
            if (scopes.includes(STORAGE_SCOPE)) {
                if (options.silent) {
                    return undefined;
                }
                notifyStorageAuth?.();
                return new Promise<AuthenticationSession>((resolve) => {
                    resolveStorageAuth = resolve;
                });
            }
            return managementSignedIn ? SESSION : undefined;
        }),
        arm: new FakeArm(),
        storage: new FakeStorage(),
    });
    await subject.connect();
    const denied = await subject.selectAccount(ACCOUNT_ID);
    assert.equal(denied.phase, 'error');

    const staleRetry = subject.retry();
    await storageAuthStarted;
    const superseding = await subject.selectSubscription(SUBSCRIPTION);
    assert.equal(superseding.phase, 'ready');
    managementSignedIn = false;

    const signedOut = await subject.authenticationChanged();
    assert.equal(signedOut.phase, 'signedOut');
    assert.equal(signedOut.identity, null);
    resolveStorageAuth?.(SESSION);
    await staleRetry;
    assert.equal(subject.snapshot.phase, 'signedOut');
});

test('genuine sign-out during ARM discovery is reconciled when the flow settles', async () => {
    let releaseTenants: (() => void) | undefined;
    let notifyTenants: (() => void) | undefined;
    const tenantsStarted = new Promise<void>((resolve) => {
        notifyTenants = resolve;
    });
    const tenantsReleased = new Promise<void>((resolve) => {
        releaseTenants = resolve;
    });
    class BlockingArm extends FakeArm {
        override async listTenants(): Promise<readonly { id: string; label: string }[]> {
            notifyTenants?.();
            await tenantsReleased;
            return super.listTenants();
        }
    }
    let initialSilent = true;
    let providerChanged = false;
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, scopes, options) => {
            if (!options.silent) {
                return SESSION;
            }
            if (initialSilent && scopes.length === 1 && !options.account) {
                initialSilent = false;
                return undefined;
            }
            if (providerChanged && scopes.length === 1) {
                return undefined;
            }
            return SESSION;
        }),
        arm: new BlockingArm(),
        storage: new FakeStorage(),
    });

    const connecting = subject.connect();
    await tenantsStarted;
    providerChanged = true;
    await subject.authenticationChanged();
    releaseTenants?.();
    const reconciled = await connecting;

    assert.equal(reconciled.phase, 'signedOut');
    assert.equal(reconciled.identity, null);
    assert.deepEqual(reconciled.tenants, []);
    assert.deepEqual(reconciled.subscriptions, []);
    assert.deepEqual(reconciled.accounts, []);
});

test('failed deferred session revalidation clears authenticated resources', async () => {
    let notifyTenants: (() => void) | undefined;
    let releaseTenants: (() => void) | undefined;
    const tenantsStarted = new Promise<void>((resolve) => {
        notifyTenants = resolve;
    });
    const tenantsReleased = new Promise<void>((resolve) => {
        releaseTenants = resolve;
    });
    class BlockingArm extends FakeArm {
        override async listTenants(): Promise<readonly { id: string; label: string }[]> {
            notifyTenants?.();
            await tenantsReleased;
            return super.listTenants();
        }
    }
    let revalidationFails = false;
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, scopes, options) => {
            if (revalidationFails && options.silent && scopes.length === 1) {
                throw new Error('provider cache failure');
            }
            return SESSION;
        }),
        arm: new BlockingArm(),
        storage: new FakeStorage(),
    });

    const connecting = subject.connect();
    await tenantsStarted;
    await subject.authenticationChanged();
    revalidationFails = true;
    releaseTenants?.();
    const reconciled = await connecting;

    assert.equal(reconciled.phase, 'signedOut');
    assert.equal(reconciled.identity, null);
    assert.deepEqual(reconciled.tenants, []);
    assert.deepEqual(reconciled.accounts, []);
    assert.doesNotMatch(JSON.stringify(reconciled), /provider cache failure|bearer-token/);
});

test('cancelled authentication from an old browser lifecycle cannot suppress sign-out', async () => {
    let resolveInteractive: ((session: AuthenticationSession) => void) | undefined;
    let notifyInteractive: (() => void) | undefined;
    const interactiveStarted = new Promise<void>((resolve) => {
        notifyInteractive = resolve;
    });
    let available = false;
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, _scopes, options) => {
            if (options.silent) {
                return available ? SESSION : undefined;
            }
            return new Promise<AuthenticationSession>((resolve) => {
                resolveInteractive = resolve;
                notifyInteractive?.();
            });
        }),
        arm: new FakeArm(),
        storage: new FakeStorage(),
    });

    const staleConnect = subject.connect();
    await interactiveStarted;
    subject.close();
    available = true;
    const reopened = await subject.open();
    assert.equal(reopened.phase, 'ready');
    available = false;

    const signedOut = await subject.authenticationChanged();
    assert.equal(signedOut.phase, 'signedOut');
    assert.equal(signedOut.identity, null);
    resolveInteractive?.(SESSION);
    await staleConnect;
    assert.equal(subject.snapshot.phase, 'signedOut');
});

test('authentication revalidation is not pinned to a removed account', async () => {
    const options: SessionOptions[] = [];
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, _scopes, requested) => {
            options.push(requested);
            return SESSION;
        }),
        arm: new FakeArm(),
        storage: new FakeStorage(),
    });
    await subject.connect();
    const beforeRefresh = options.length;
    const refreshed = await subject.authenticationChanged();
    assert.equal(options[beforeRefresh].account, undefined);
    assert.equal(options[beforeRefresh].silent, true);
    assert.equal(refreshed.phase, 'ready');
    assert.equal(refreshed.identity?.id, SESSION.account.id);
});

test('later external sign-out clears stale Azure identity and resources', async () => {
    let signedIn = true;
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, _scopes, options) =>
            options.silent && signedIn ? SESSION : undefined,
        ),
        arm: new FakeArm(),
        storage: new FakeStorage(),
    });
    const connected = await subject.connect();
    assert.equal(connected.accounts[0].id, ACCOUNT_ID);
    signedIn = false;

    const signedOut = await subject.authenticationChanged();

    assert.equal(signedOut.phase, 'signedOut');
    assert.equal(signedOut.identity, null);
    assert.deepEqual(signedOut.tenants, []);
    assert.deepEqual(signedOut.subscriptions, []);
    assert.deepEqual(signedOut.accounts, []);
    assert.deepEqual(signedOut.entries, []);
    assert.ok(!JSON.stringify(signedOut).includes(SESSION.accessToken));
});

test('external sign-out clears retained resources after the browser is closed', async () => {
    let signedIn = true;
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, _scopes, options) =>
            options.silent && signedIn ? SESSION : undefined,
        ),
        arm: new FakeArm(),
        storage: new FakeStorage(),
    });
    await subject.connect();
    const closed = subject.close();
    assert.equal(closed.open, false);
    assert.equal(closed.identity?.id, SESSION.account.id);
    signedIn = false;

    const cleared = await subject.authenticationChanged();
    assert.equal(cleared.phase, 'closed');
    assert.equal(cleared.identity, null);
    assert.deepEqual(cleared.accounts, []);
});

test('retry preserves the failed folder location', async () => {
    class FlakyStorage extends FakeStorage {
        private failed = false;

        override async listBlobs(
            account: string,
            container: string,
            prefix: string,
        ): Promise<StoragePage> {
            if (prefix === 'orders/' && !this.failed) {
                this.failed = true;
                throw new AzureBrowserError('temporary', 'Temporary storage failure.');
            }
            return super.listBlobs(account, container, prefix);
        }
    }

    const subject = browser(new FlakyStorage()).value;
    await subject.connect();
    let current = await subject.selectAccount(ACCOUNT_ID);
    current = await subject.openEntry(current.entries[0].id);
    const failed = await subject.openEntry(current.entries[0].id);
    assert.equal(failed.phase, 'error');
    assert.deepEqual(failed.path, ['landing', 'orders']);
    const retried = await subject.retry();
    assert.equal(retried.phase, 'ready');
    assert.deepEqual(retried.path, ['landing', 'orders']);
    assert.equal(retried.entries[0].name, 'daily sales.parquet');
});

test('browser discovers ARM metadata, browses hierarchy, selects a URL, and disconnects', async () => {
    const subject = browser();
    const ready = await subject.value.connect();
    assert.equal(ready.phase, 'ready');
    assert.equal(ready.accounts[0].name, 'lake001');
    assert.ok(subject.scopes.some((scope) => scope.includes(ARM_SCOPE)));
    assert.ok(subject.scopes.some((scope) => scope.includes('VSCODE_TENANT:tenant-1')));

    const containers = await subject.value.selectAccount(ACCOUNT_ID);
    assert.equal(containers.entries[0].kind, 'container');
    assert.ok(subject.scopes.some((scope) => scope.includes(STORAGE_SCOPE)));

    const folders = await subject.value.openEntry(containers.entries[0].id);
    assert.deepEqual(folders.path, ['landing']);
    const files = await subject.value.openEntry(folders.entries[0].id);
    assert.deepEqual(files.path, ['landing', 'orders']);
    const selected = await subject.value.openEntry(files.entries[0].id);
    assert.equal(selected.entries[0].supported, true);
    assert.equal(
        subject.value.selectedUrl(),
        'abfss://landing@lake001.dfs.core.windows.net/orders/daily%20sales.parquet',
    );

    const serialized = JSON.stringify(subject.value.snapshot);
    assert.ok(!serialized.includes(SESSION.accessToken));
    assert.ok(!serialized.includes('Bearer'));
    assert.equal(subject.value.disconnect().phase, 'closed');
    assert.equal(subject.value.snapshot.identity, null);
});

test('storage access failures are distinct from management access failures', () => {
    const dataDenied = classifyStorageError({ statusCode: 403, code: 'AuthorizationFailure' });
    assert.equal(dataDenied.kind, 'dataAccess');
    assert.match(dataDenied.message, /Storage Blob Data Reader/);
    const controlDenied = new AzureBrowserError('controlAccess', 'Reader access is required.', 403);
    assert.equal(controlDenied.kind, 'controlAccess');
});

test('using an Azure file hands its canonical URL to existing Credential Setup', async () => {
    const subject = browser().value;
    await subject.connect();
    let snapshot = await subject.selectAccount(ACCOUNT_ID);
    snapshot = await subject.openEntry(snapshot.entries[0].id);
    snapshot = await subject.openEntry(snapshot.entries[0].id);
    await subject.openEntry(snapshot.entries[0].id);

    const store = new AppStateStore({ version: '1.0.9' });
    const host: UiHost = {
        version: '1.0.9',
        workspaceFolders: () => [],
        activeFilePath: () => undefined,
        activeFileLimitation: () => undefined,
        showOpenDialog: async () => undefined,
        copyToClipboard: async () => undefined,
        openUntitledDocument: async () => undefined,
        openExternal: async () => true,
        saveTextFile: async () => undefined,
        showInformation: () => undefined,
        showWarning: () => undefined,
        showError: () => undefined,
        log: () => undefined,
        getPreference: <T,>(_key: string, fallback: T): T => fallback,
        setPreference: async () => undefined,
        openPanel: async () => undefined,
        now: () => 0,
    };
    const controller = new UiController(host, store, { azure: subject });
    try {
        await controller.handle({ type: 'azureUseSelectedFile' });
        assert.equal(
            store.state.storageUrl,
            'abfss://landing@lake001.dfs.core.windows.net/orders/daily%20sales.parquet',
        );
        assert.equal(store.state.sourceKind, 'azure');
        assert.equal(store.state.activeTab, 'credential_setup');
        assert.equal(store.state.azure.open, false);
        assert.match(store.state.notice ?? '', /does not download or analyze remote bytes/);
    } finally {
        await controller.dispose();
    }
});
