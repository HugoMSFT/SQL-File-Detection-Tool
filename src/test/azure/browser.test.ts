import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ARM_SCOPE,
    STORAGE_SCOPE,
    MicrosoftAuthentication,
    type AuthenticationSession,
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
