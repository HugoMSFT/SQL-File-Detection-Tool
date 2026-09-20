import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';

import {
    ARM_SCOPE,
    STORAGE_SCOPE,
    TENANT_SCOPE_PREFIX,
    MicrosoftAuthentication,
    type AuthenticationSession,
    type SessionOptions,
} from '../../azure/auth';
import { ArmClient } from '../../azure/armClient';
import {
    AZURE_BROWSER_CACHE_TTL_MS,
    AzureBrowser,
    azureStorageUrl,
} from '../../azure/browser';
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
    id: 'session-1',
    accessToken: 'bearer-token-must-not-leak',
    account: { id: 'identity-1', label: 'developer@example.test' },
};
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const SUBSCRIPTION = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID =
    `/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-data/` +
    'providers/Microsoft.Storage/storageAccounts/lake001';

class FakeArm extends ArmClient {
    override async listTenants(): Promise<readonly { id: string; label: string }[]> {
        return [{ id: TENANT_ID, label: 'Tenant One' }];
    }

    override async listSubscriptions(): Promise<
        readonly { id: string; tenantId: string; label: string }[]
    > {
        return [{ id: SUBSCRIPTION, tenantId: TENANT_ID, label: 'Development' }];
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

test('disconnect stays signed out and prevents silent reconnect on reopen', async () => {
    let resolveSession: ((session: AuthenticationSession | undefined) => void) | undefined;
    let authenticationCalls = 0;
    const pendingSession = new Promise<AuthenticationSession | undefined>((resolve) => {
        resolveSession = resolve;
    });
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async () => {
            authenticationCalls += 1;
            return pendingSession;
        }),
        arm: new FakeArm(),
        storage: new FakeStorage(),
    });
    const initial = await subject.open();
    assert.equal(initial.phase, 'signedOut');
    assert.equal(authenticationCalls, 0);

    const connecting = subject.connect();
    subject.disconnect();
    resolveSession?.(SESSION);
    await connecting;
    assert.equal(subject.snapshot.phase, 'signedOut');
    assert.equal(subject.snapshot.open, true);
    assert.equal(subject.snapshot.identity, null);
    assert.match(subject.snapshot.message ?? '', /Disconnected/);

    const reopened = await subject.open();
    assert.equal(reopened.phase, 'signedOut');
    assert.equal(reopened.identity, null);
    assert.equal(authenticationCalls, 1);

    await subject.authenticationChanged();
    assert.equal(authenticationCalls, 1);

    const reconnected = await subject.connect();
    assert.equal(reconnected.phase, 'ready');
    assert.equal(reconnected.identity?.label, SESSION.account.label);
    assert.ok(authenticationCalls > 1);
});

test('closed browser refreshes expired Azure metadata and supports manual refresh', async () => {
    let now = 0;
    let tenantCalls = 0;
    class CountingArm extends FakeArm {
        override async listTenants(): Promise<readonly { id: string; label: string }[]> {
            tenantCalls += 1;
            return super.listTenants();
        }
    }
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async () => SESSION),
        arm: new CountingArm(),
        storage: new FakeStorage(),
        now: () => now,
    });

    await subject.connect();
    assert.equal(tenantCalls, 1);
    subject.close();
    now = AZURE_BROWSER_CACHE_TTL_MS - 1;
    await subject.open();
    assert.equal(tenantCalls, 1);

    now = AZURE_BROWSER_CACHE_TTL_MS + 1;
    await subject.selectSubscription(SUBSCRIPTION);
    subject.close();
    const refreshedOnOpen = await subject.open();
    assert.equal(refreshedOnOpen.phase, 'ready');
    assert.equal(tenantCalls, 2);

    await subject.refresh();
    assert.equal(tenantCalls, 3);
});

test('failed refresh never leaves expired Azure resources usable', async () => {
    let now = 0;
    let failRefresh = false;
    class RefreshArm extends FakeArm {
        override async listTenants(): Promise<readonly { id: string; label: string }[]> {
            if (failRefresh) {
                throw new AzureBrowserError('temporary', 'Refresh failed.');
            }
            return super.listTenants();
        }
    }
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async () => SESSION),
        arm: new RefreshArm(),
        storage: new FakeStorage(),
        now: () => now,
    });
    await subject.connect();
    const containers = await subject.selectAccount(ACCOUNT_ID);
    await subject.openEntry(containers.entries[0].id);
    subject.close();

    now = AZURE_BROWSER_CACHE_TTL_MS + 1;
    failRefresh = true;
    const failed = await subject.open();

    assert.equal(failed.phase, 'error');
    assert.deepEqual(failed.tenants, []);
    assert.deepEqual(failed.subscriptions, []);
    assert.deepEqual(failed.accounts, []);
    assert.deepEqual(failed.entries, []);
    assert.equal(failed.selectedTenantId, null);
    assert.equal(failed.selectedSubscriptionId, null);
    assert.equal(failed.selectedAccountId, null);
});

test('refresh with no tenants clears the previous Azure hierarchy', async () => {
    let hasTenants = true;
    class EmptyArm extends FakeArm {
        override async listTenants(): Promise<readonly { id: string; label: string }[]> {
            return hasTenants ? super.listTenants() : [];
        }
    }
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async () => SESSION),
        arm: new EmptyArm(),
        storage: new FakeStorage(),
    });
    await subject.connect();
    const containers = await subject.selectAccount(ACCOUNT_ID);
    await subject.openEntry(containers.entries[0].id);
    hasTenants = false;

    const refreshed = await subject.refresh();

    assert.equal(refreshed.phase, 'ready');
    assert.deepEqual(refreshed.tenants, []);
    assert.deepEqual(refreshed.subscriptions, []);
    assert.deepEqual(refreshed.accounts, []);
    assert.deepEqual(refreshed.entries, []);
    assert.deepEqual(refreshed.path, []);
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
    assert.equal(subject.snapshot.identity?.label, SESSION.account.label);
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
    assert.equal(subject.snapshot.identity?.label, SESSION.account.label);
    assert.equal(subject.snapshot.accounts[0].id, ACCOUNT_ID);
});

test('tenant-specific sign-in callback does not require the replaced generic ARM session', async () => {
    let genericSignedIn = false;
    let tenantSignedIn = false;
    let tenantInteractiveStarted: (() => void) | undefined;
    let resolveTenantInteractive: ((session: AuthenticationSession) => void) | undefined;
    const tenantStarted = new Promise<void>((resolve) => {
        tenantInteractiveStarted = resolve;
    });
    const tenantSession = {
        ...SESSION,
        id: 'tenant-session',
    };
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, scopes, options) => {
            const tenantScoped = scopes.some((scope) => scope.startsWith(TENANT_SCOPE_PREFIX));
            if (!tenantScoped) {
                if (options.silent) {
                    return genericSignedIn ? SESSION : undefined;
                }
                genericSignedIn = true;
                return SESSION;
            }
            if (options.silent) {
                return tenantSignedIn ? tenantSession : undefined;
            }
            tenantInteractiveStarted?.();
            return new Promise<AuthenticationSession>((resolve) => {
                resolveTenantInteractive = (session) => {
                    tenantSignedIn = true;
                    genericSignedIn = false;
                    resolve(session);
                };
            });
        }),
        arm: new FakeArm(),
        storage: new FakeStorage(),
    });

    const connecting = subject.connect();
    await tenantStarted;
    await subject.authenticationChanged();
    resolveTenantInteractive?.(tenantSession);
    const connected = await connecting;

    assert.equal(connected.phase, 'ready');
    assert.equal(connected.identity?.label, SESSION.account.label);
    assert.equal(connected.selectedTenantId, TENANT_ID);
    assert.equal(connected.accounts[0].id, ACCOUNT_ID);
});

test('concurrent Connect requests share one authentication flow', async () => {
    let resolveInteractive: ((session: AuthenticationSession) => void) | undefined;
    let notifyInteractive: (() => void) | undefined;
    let interactiveCalls = 0;
    let signedIn = false;
    const interactiveStarted = new Promise<void>((resolve) => {
        notifyInteractive = resolve;
    });
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, _scopes, options) => {
            if (options.silent) {
                return signedIn ? SESSION : undefined;
            }
            interactiveCalls += 1;
            notifyInteractive?.();
            return new Promise<AuthenticationSession>((resolve) => {
                resolveInteractive = (session) => {
                    signedIn = true;
                    resolve(session);
                };
            });
        }),
        arm: new FakeArm(),
        storage: new FakeStorage(),
    });

    const first = subject.connect();
    await interactiveStarted;
    const second = subject.connect();
    assert.equal(second, first);
    resolveInteractive?.(SESSION);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.phase, 'ready');
    assert.equal(secondResult.phase, 'ready');
    assert.equal(interactiveCalls, 1);
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
    assert.equal(denied.errorKind, 'storageConsent');
    assert.match(denied.message ?? '', /Connected to Azure/);

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
            if (providerChanged) {
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
    let authenticationCalls = 0;
    let revalidationFails = false;
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, scopes, options) => {
            authenticationCalls += 1;
            if (revalidationFails && options.silent) {
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

    const callsAfterFailure = authenticationCalls;
    await subject.authenticationChanged();
    await subject.open();
    assert.equal(authenticationCalls, callsAfterFailure);

    revalidationFails = false;
    const reconnected = await subject.connect();
    assert.equal(reconnected.phase, 'ready');
});

function blockedDeferredReconciliation() {
    let notifyTenants: (() => void) | undefined;
    let releaseTenants: (() => void) | undefined;
    let notifyRevalidation: (() => void) | undefined;
    let resolveRevalidation: ((session: AuthenticationSession | undefined) => void) | undefined;
    const tenantsStarted = new Promise<void>((resolve) => {
        notifyTenants = resolve;
    });
    const tenantsReleased = new Promise<void>((resolve) => {
        releaseTenants = resolve;
    });
    const revalidationStarted = new Promise<void>((resolve) => {
        notifyRevalidation = resolve;
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
    const holder: { subject?: AzureBrowser } = {};
    holder.subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, scopes, options) => {
            if (!options.silent) {
                return SESSION;
            }
            if (initialSilent && scopes.length === 1 && !options.account) {
                initialSilent = false;
                return undefined;
            }
            if (providerChanged) {
                if (!options.account) {
                    return undefined;
                }
                if ((holder.subject?.snapshot.accounts.length ?? 0) === 0) {
                    return SESSION;
                }
                notifyRevalidation?.();
                return new Promise<AuthenticationSession | undefined>((resolve) => {
                    resolveRevalidation = resolve;
                });
            }
            return SESSION;
        }),
        arm: new BlockingArm(),
        storage: new FakeStorage(),
    });
    const subject = holder.subject;
    return {
        subject,
        tenantsStarted,
        revalidationStarted,
        markProviderChanged: (): void => {
            providerChanged = true;
        },
        releaseTenants: (): void => releaseTenants?.(),
        resolveRevalidation: (session?: AuthenticationSession): void =>
            resolveRevalidation?.(session),
    };
}

test('granting a scope keeps the selection instead of resetting to the root', async () => {
    // Granting the Storage scope creates a session, so VS Code fires a provider
    // change caused by this very operation. Reconciling it must not throw away
    // the account and container the user just reached.
    let storageGranted = false;
    let providerChange: Promise<unknown> | undefined;
    const holder: { subject?: AzureBrowser } = {};
    holder.subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, scopes, options) => {
            if (scopes.includes(STORAGE_SCOPE)) {
                if (!storageGranted) {
                    if (options.silent) {
                        return undefined;
                    }
                    storageGranted = true;
                    providerChange = holder.subject?.authenticationChanged();
                    return SESSION;
                }
                return SESSION;
            }
            return SESSION;
        }),
        arm: new FakeArm(),
        storage: new FakeStorage(),
    });
    const subject = holder.subject;

    await subject.connect();
    const denied = await subject.selectAccount(ACCOUNT_ID);
    assert.equal(denied.phase, 'error');
    assert.equal(denied.errorKind, 'storageConsent');

    const granted = await subject.retry();
    await providerChange;

    assert.equal(granted.phase, 'ready');
    assert.equal(granted.selectedAccountId, ACCOUNT_ID);
    assert.equal(granted.identity?.label, SESSION.account.label);
    assert.ok(granted.entries.length > 0);
});

test('a deferred provider change survives being superseded mid-proof', async () => {
    const setup = blockedDeferredReconciliation();
    const connecting = setup.subject.connect();
    await setup.tenantsStarted;
    setup.markProviderChanged();
    await setup.subject.authenticationChanged();
    setup.releaseTenants();
    await setup.revalidationStarted;

    // Supersede while the deferred change is still being proved.
    await setup.subject.selectSubscription(SUBSCRIPTION);
    setup.resolveRevalidation(undefined);
    await connecting;

    // The change must not be silently consumed: closing now still drops every
    // authenticated resource rather than retaining them for the next open.
    const closed = setup.subject.close();
    assert.equal(closed.identity, null);
    assert.deepEqual(closed.accounts, []);
    assert.deepEqual(closed.subscriptions, []);
});

test('close during blocked reconciliation clears state across reopen', async () => {
    const setup = blockedDeferredReconciliation();
    const connecting = setup.subject.connect();
    await setup.tenantsStarted;
    setup.markProviderChanged();
    await setup.subject.authenticationChanged();
    setup.releaseTenants();
    await setup.revalidationStarted;

    const closed = setup.subject.close();
    assert.equal(closed.phase, 'closed');
    assert.equal(closed.identity, null);
    assert.deepEqual(closed.accounts, []);
    const reopened = await setup.subject.open();
    assert.equal(reopened.phase, 'signedOut');
    assert.equal(reopened.identity, null);
    setup.resolveRevalidation(SESSION);
    await connecting;
    assert.equal(setup.subject.snapshot.phase, 'signedOut');
    assert.equal(setup.subject.snapshot.identity, null);
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
    assert.equal(reopened.phase, 'signedOut');
    const reconnected = await subject.connect();
    assert.equal(reconnected.phase, 'ready');
    available = false;

    const signedOut = await subject.authenticationChanged();
    assert.equal(signedOut.phase, 'signedOut');
    assert.equal(signedOut.identity, null);
    resolveInteractive?.(SESSION);
    await staleConnect;
    assert.equal(subject.snapshot.phase, 'signedOut');
});

test('authentication revalidation proves the account in use before any other', async () => {
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
    let current = await subject.selectAccount(ACCOUNT_ID);
    current = await subject.openEntry(current.entries[0].id);
    current = await subject.openEntry(current.entries[0].id);
    const beforeRefresh = options.length;
    const refreshed = await subject.authenticationChanged();
    // A stale account must never be able to displace the session in use, so the
    // retained account is proved first rather than asking for any session.
    assert.equal(options[beforeRefresh].account?.id, SESSION.account.id);
    assert.equal(options[beforeRefresh].silent, true);
    assert.equal(refreshed.phase, 'ready');
    assert.equal(refreshed.identity?.label, SESSION.account.label);
    assert.deepEqual(refreshed.path, current.path);
});

test('revalidation falls back to another account once the pinned one is removed', async () => {
    const replacement: AuthenticationSession = {
        id: 'session-2',
        accessToken: 'replacement-token',
        account: { id: 'account-2', label: 'second@example.com' },
    };
    const options: SessionOptions[] = [];
    let pinnedRemoved = false;
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, _scopes, requested) => {
            options.push(requested);
            if (!pinnedRemoved) {
                return SESSION;
            }
            return requested.account?.id === SESSION.account.id ? undefined : replacement;
        }),
        arm: new FakeArm(),
        storage: new FakeStorage(),
    });
    await subject.connect();
    pinnedRemoved = true;
    const beforeRefresh = options.length;
    const refreshed = await subject.authenticationChanged();

    assert.equal(options[beforeRefresh].account?.id, SESSION.account.id);
    assert.equal(options[beforeRefresh + 1].account, undefined);
    assert.equal(refreshed.phase, 'ready');
    assert.equal(refreshed.identity?.label, replacement.account.label);
});

test('a deferred change to a different account rebuilds every listing', async () => {
    const replacement: AuthenticationSession = {
        id: 'session-2',
        accessToken: 'replacement-token',
        account: { id: 'account-2', label: 'second@example.com' },
    };
    let releaseTenants: (() => void) | undefined;
    let notifyTenants: (() => void) | undefined;
    const tenantsStarted = new Promise<void>((resolve) => {
        notifyTenants = resolve;
    });
    const tenantsReleased = new Promise<void>((resolve) => {
        releaseTenants = resolve;
    });
    let tenantCalls = 0;
    let blockTenants = true;
    class BlockingArm extends FakeArm {
        override async listTenants(): Promise<readonly { id: string; label: string }[]> {
            tenantCalls += 1;
            if (blockTenants) {
                blockTenants = false;
                notifyTenants?.();
                await tenantsReleased;
            }
            return super.listTenants();
        }
    }
    let switched = false;
    const subject = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async (_provider, _scopes, options) =>
            switched && options.silent ? replacement : SESSION),
        arm: new BlockingArm(),
        storage: new FakeStorage(),
    });

    const connecting = subject.connect();
    await tenantsStarted;
    await subject.authenticationChanged();
    switched = true;
    releaseTenants?.();
    const reconciled = await connecting;

    // The account behind the deferred change is not the one in use, so the
    // browser must rediscover rather than keep listings it can no longer vouch
    // for on the strength of a single token.
    assert.equal(reconciled.identity?.label, replacement.account.label);
    assert.ok(tenantCalls >= 2);
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
    assert.equal(closed.identity?.label, SESSION.account.label);
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
    assert.ok(
        subject.scopes.some((scope) =>
            scope.includes(`VSCODE_TENANT:${TENANT_ID}`)),
    );

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
    assert.equal(subject.value.disconnect().phase, 'signedOut');
    assert.equal(subject.value.snapshot.open, true);
    assert.equal(subject.value.snapshot.identity, null);
});

test('storage access failures are distinct from management access failures', () => {
    const expired = classifyStorageError({ statusCode: 401, code: 'AuthenticationFailed' });
    assert.equal(expired.kind, 'storageConsent');
    assert.match(expired.message, /Authorize Storage browsing again/);
    const dataDenied = classifyStorageError({ statusCode: 403, code: 'AuthorizationFailure' });
    assert.equal(dataDenied.kind, 'dataAccess');
    assert.match(dataDenied.message, /Storage Blob Data Reader/);
    assert.match(dataDenied.message, /Owner and Contributor do not grant/);
    assert.match(dataDenied.message, /parent scope/);
    assert.match(dataDenied.message, /firewall or private endpoint/);
    const controlDenied = new AzureBrowserError('controlAccess', 'Reader access is required.', 403);
    assert.equal(controlDenied.kind, 'controlAccess');
});

test('an incompatible Azure source stays in the browser and generates no setup', async () => {
    const subject = browser().value;
    await subject.connect();
    let current = await subject.selectAccount(ACCOUNT_ID);
    current = await subject.openEntry(current.entries[0].id);
    current = await subject.openEntry(current.entries[0].id);
    await subject.openEntry(current.entries[0].id);

    const store = new AppStateStore({ version: '1.0.9', platform: 'fabric_sql_db' });
    const host: UiHost = {
        version: '1.0.9',
        workspaceFolders: () => [],
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
        await controller.handle({ type: 'azureBrowserUseSelectedFile' });
        assert.equal(store.state.azure.open, true);
        assert.equal(store.state.storageUrl, '');
        assert.equal(store.state.statements, null);
        assert.match(store.state.error ?? '', /not supported by the current SQL platform/);
    } finally {
        await controller.dispose();
    }
});

test('using an Azure file hands its canonical URL to existing Credential Setup', async () => {
    const subject = browser().value;
    await subject.connect();
    let snapshot = await subject.selectAccount(ACCOUNT_ID);
    snapshot = await subject.openEntry(snapshot.entries[0].id);
    snapshot = await subject.openEntry(snapshot.entries[0].id);
    await subject.openEntry(snapshot.entries[0].id);
    assert.equal(
        subject.currentFolderUrl(),
        'abfss://landing@lake001.dfs.core.windows.net/orders/',
    );

    const store = new AppStateStore({ version: '1.0.9' });
    let localPickerCalls = 0;
    const host: UiHost = {
        version: '1.0.9',
        workspaceFolders: () => [],
        showOpenDialog: async () => {
            localPickerCalls += 1;
            return undefined;
        },
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
        await controller.loadFiles([
            path.join(process.cwd(), 'data sample', 'csv', 'employees.csv'),
        ]);
        const retainedIds = store.state.files.map((file) => file.id);
        const retainedMetadata = store.state.metadata;
        const retainedLocation = store.state.sourceLabel;
        await controller.handle({ type: 'openAzureBrowser' });
        await controller.handle({ type: 'azureBrowserConnect' });
        await controller.handle({
            type: 'azureBrowserSelectAccount',
            accountId: ACCOUNT_ID,
        });
        await controller.handle({
            type: 'azureBrowserOpenEntry',
            entryId: store.state.azure.entries[0].id,
        });
        await controller.handle({
            type: 'azureBrowserOpenEntry',
            entryId: store.state.azure.entries[0].id,
        });
        await controller.handle({
            type: 'azureBrowserOpenEntry',
            entryId: store.state.azure.entries[0].id,
        });
        const selectedAzureFileId = store.state.azure.selectedEntryId;
        await controller.handle({ type: 'azureBrowserUseCurrentFolder' });
        assert.equal(store.state.activeTab, 'credential_setup');
        assert.equal(store.state.sourceMode, 'azure');
        assert.deepEqual(store.state.files, []);
        assert.equal(store.state.metadata, null);
        assert.equal(
            store.state.storageUrl,
            'abfss://landing@lake001.dfs.core.windows.net/orders/',
        );
        assert.equal(store.state.azureFolderPreview?.label, 'landing/orders');
        assert.deepEqual(
            store.state.azureFolderPreview?.items.map((item) => item.name),
            ['daily sales.parquet'],
        );
        assert.deepEqual(store.state.remoteSchema, {
            status: 'not_analyzed',
            formats: ['parquet'],
            selectedFormat: 'parquet',
            message:
                'The Azure folder format is known, but its columns and parser settings have not been analyzed.',
        });
        assert.match(store.state.notice ?? '', /Configure SQL credentials/);
        assert.match(
            store.state.statements?.credential_setup ?? '',
            /CREATE EXTERNAL TABLE/,
        );

        await controller.handle({ type: 'openAzureBrowser' });
        assert.equal(store.state.azure.open, true);
        assert.equal(store.state.azure.phase, 'ready');
        assert.equal(store.state.azure.selectedSubscriptionId, SUBSCRIPTION);
        assert.equal(store.state.azure.selectedAccountId, ACCOUNT_ID);
        assert.deepEqual(store.state.azure.path, ['landing', 'orders']);
        assert.equal(store.state.azure.selectedEntryId, selectedAzureFileId);

        const folderStorageUrl = store.state.storageUrl;
        await controller.handle({ type: 'azureBrowserClose' });
        assert.equal(store.state.azure.open, false);
        assert.equal(store.state.azure.identity?.label, SESSION.account.label);
        assert.equal(store.state.sourceMode, 'azure');
        assert.equal(store.state.storageUrl, folderStorageUrl);
        await controller.handle({ type: 'openAzureBrowser' });
        assert.equal(store.state.azure.phase, 'ready');

        await controller.handle({ type: 'azureBrowserUseSelectedFile' });
        assert.equal(
            store.state.storageUrl,
            'abfss://landing@lake001.dfs.core.windows.net/orders/daily%20sales.parquet',
        );
        assert.equal(store.state.sourceKind, 'azure');
        assert.equal(store.state.activeTab, 'credential_setup');
        assert.equal(store.state.azure.open, false);
        assert.equal(store.state.azureFolderPreview, null);
        assert.equal(store.state.remoteSchema?.status, 'not_analyzed');
        assert.equal(store.state.remoteSchema?.selectedFormat, 'parquet');
        assert.match(
            store.state.statements?.credential_setup ?? '',
            /LOCATION = 'adls:\/\/landing@lake001\.dfs\.core\.windows\.net'/,
        );
        assert.match(
            store.state.statements?.credential_setup ?? '',
            /CREATE EXTERNAL TABLE/,
        );
        assert.match(
            store.state.statements?.credential_setup ?? '',
            /TEMPLATE ONLY - REMOTE SCHEMA NOT ANALYZED/,
        );
        assert.match(
            store.state.statements?.credential_setup ?? '',
            /LOCATION = 'orders\/daily%20sales\.parquet'/,
        );
        assert.doesNotMatch(
            store.state.statements?.credential_setup ?? '',
            /TYPE = BLOB_STORAGE|LOCATION = 'https:\/\//,
        );
        await controller.handle({ type: 'setStorageGoal', value: 'openrowset' });
        assert.match(
            store.state.statements?.credential_setup ?? '',
            /FROM OPENROWSET\(/,
        );
        assert.match(
            store.state.statements?.credential_setup ?? '',
            /BULK 'orders\/daily%20sales\.parquet'/,
        );

        store.update({
            storageUrl:
                'abs://publiccsv@publicbronzelake.blob.core.windows.net/Holiday.csv',
            remoteSchema: {
                status: 'not_analyzed',
                formats: ['csv'],
                selectedFormat: 'csv',
                message: 'Schema not analyzed.',
            },
            azure: {
                ...store.state.azure,
                selectedEntryId: 'holiday',
                entries: [{
                    id: 'holiday',
                    kind: 'file',
                    name: 'Holiday.csv',
                    format: 'CSV',
                    supported: true,
                    sizeBytes: 1024,
                    modifiedAt: null,
                }],
            },
        });
        await controller.handle({ type: 'setStorageGoal', value: 'bulk_insert' });
        const bulkSql = store.state.statements?.credential_setup ?? '';
        assert.match(bulkSql, /TYPE = BLOB_STORAGE/);
        assert.match(bulkSql, /BULK INSERT/);
        assert.match(bulkSql, /FROM 'Holiday\.csv'/);
        assert.match(store.state.notice ?? '', /were not downloaded or analyzed/);

        await controller.handle({ type: 'openAzureBrowser' });
        assert.equal(store.state.azure.open, true);
        await controller.handle({ type: 'activateLocalSource' });
        assert.equal(store.state.azure.open, false);
        assert.equal(store.state.azure.phase, 'closed');
        assert.equal(store.state.azure.identity, null);
        assert.equal(store.state.sourceKind, 'local');
        assert.equal(store.state.sourceMode, 'local');
        assert.equal(store.state.storageUrl, '');
        assert.equal(store.state.activeTab, 'preview');
        assert.equal(localPickerCalls, 0);
        assert.deepEqual(
            (store.state.files as readonly { id: string }[]).map((file) => file.id),
            retainedIds,
        );
        assert.deepEqual(store.state.metadata, retainedMetadata);
        assert.equal(store.state.sourceLabel, retainedLocation);

        await controller.handle({ type: 'openLocalDialog' });
        assert.equal(localPickerCalls, 1);
    } finally {
        await controller.dispose();
    }
});
