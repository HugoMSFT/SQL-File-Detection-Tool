import * as crypto from 'crypto';

import {
    ARM_SCOPE,
    STORAGE_SCOPE,
    MicrosoftAuthentication,
    type AuthenticationAccount,
    type AuthenticationSession,
} from './auth';
import { ArmClient } from './armClient';
import { AzureBrowserError } from './errors';
import {
    MAX_STORAGE_ITEMS,
    StorageBrowserClient,
    type StorageItem,
} from './storageClient';
import {
    CLOSED_AZURE_BROWSER_STATE,
    type AzureBrowserEntry,
    type AzureBrowserState,
    type AzureStorageAccount,
} from './types';

const SUPPORTED_EXTENSIONS = new Set([
    'csv',
    'tsv',
    'txt',
    'dat',
    'json',
    'jsonl',
    'ndjson',
    'parquet',
    'snappy',
    'orc',
    'rc',
]);

type RetryOperation = 'discover' | 'tenant' | 'subscription' | 'account' | 'location';

interface RegisteredEntry {
    readonly entry: AzureBrowserEntry;
    readonly target:
        | { readonly kind: 'container'; readonly container: string }
        | { readonly kind: 'folder'; readonly prefix: string }
        | { readonly kind: 'file'; readonly blobName: string };
}

export interface AzureBrowserDeps {
    readonly authentication: MicrosoftAuthentication;
    readonly arm?: ArmClient;
    readonly storage?: StorageBrowserClient;
}

export function azureStorageUrl(
    account: Pick<AzureStorageAccount, 'name' | 'hns'> &
        Partial<Pick<AzureStorageAccount, 'blobHost' | 'dfsHost'>>,
    container: string,
    blobName: string,
): string {
    const encode = (value: string): string => encodeURIComponent(value);
    const path = blobName.split('/').map(encode).join('/');
    const scheme = account.hns ? 'abfss' : 'abs';
    const host =
        (account.hns ? account.dfsHost : account.blobHost)
        ?? `${account.name}.${account.hns ? 'dfs' : 'blob'}.core.windows.net`;
    return `${scheme}://${encode(container)}@${host}/${path}`;
}

export class AzureBrowser {
    private readonly arm: ArmClient;
    private readonly storage: StorageBrowserClient;
    private state: AzureBrowserState = CLOSED_AZURE_BROWSER_STATE;
    private account: AuthenticationAccount | undefined;
    private entryRegistry = new Map<string, RegisteredEntry>();
    private continuationToken: string | undefined;
    private container: string | undefined;
    private prefix = '';
    private retryOperation: RetryOperation = 'discover';
    private abortController: AbortController | undefined;
    private generation = 0;
    private readonly interactiveOperations = new Map<number, number>();
    private interactiveOperationId = 0;
    private lifecycle = 0;

    constructor(private readonly deps: AzureBrowserDeps) {
        this.arm = deps.arm ?? new ArmClient();
        this.storage = deps.storage ?? new StorageBrowserClient();
    }

    get snapshot(): AzureBrowserState {
        return this.state;
    }

    async authenticationChanged(): Promise<AzureBrowserState> {
        // VS Code reports only the provider, not the affected session. A session
        // created by this operation is authoritative until its full discovery
        // chain settles; later provider events still revalidate normally.
        if (
            this.state.open
            && [...this.interactiveOperations.values()].some(
                (operationLifecycle) => operationLifecycle === this.lifecycle,
            )
        ) {
            return this.state;
        }
        return this.revalidateAuthentication();
    }

    private async revalidateAuthentication(): Promise<AzureBrowserState> {
        const wasOpen = this.state.open;
        this.cancel();
        this.account = undefined;
        this.entryRegistry.clear();
        this.continuationToken = undefined;
        this.container = undefined;
        this.prefix = '';
        this.retryOperation = 'discover';
        if (!wasOpen) {
            this.state = CLOSED_AZURE_BROWSER_STATE;
            return this.state;
        }
        this.state = { ...CLOSED_AZURE_BROWSER_STATE, open: true, phase: 'loading' };
        return this.discover(false);
    }

    async open(): Promise<AzureBrowserState> {
        this.disconnect();
        this.state = { ...CLOSED_AZURE_BROWSER_STATE, open: true, phase: 'loading' };
        return this.discover(false);
    }

    connect(): Promise<AzureBrowserState> {
        this.retryOperation = 'discover';
        return this.runInteractive(() => this.discover(true));
    }

    retry(): Promise<AzureBrowserState> {
        return this.runInteractive(() => this.retryInteractive());
    }

    private async retryInteractive(): Promise<AzureBrowserState> {
        switch (this.retryOperation) {
            case 'tenant':
                return this.selectTenant(this.state.selectedTenantId ?? '', true);
            case 'subscription':
                return this.selectSubscription(this.state.selectedSubscriptionId ?? '', true);
            case 'account':
                return this.selectAccount(this.state.selectedAccountId ?? '', true);
            case 'location':
                return this.loadLocation(false, true);
            case 'discover':
            default:
                return this.discover(true);
        }
    }

    async selectTenant(tenantId: string, interactive = false): Promise<AzureBrowserState> {
        if (!this.state.tenants.some((tenant) => tenant.id === tenantId)) {
            return this.fail(new AzureBrowserError('invalidResponse', 'That Azure tenant is no longer available.'));
        }
        this.retryOperation = 'tenant';
        const generation = this.loading('Loading subscriptions…', {
            selectedTenantId: tenantId,
            subscriptions: [],
            selectedSubscriptionId: null,
            accounts: [],
            selectedAccountId: null,
            path: [],
            entries: [],
        });
        try {
            const session = await this.session(ARM_SCOPE, tenantId, interactive);
            if (!this.isCurrent(generation)) {
                return this.state;
            }
            if (!session) {
                throw new AzureBrowserError(
                    'signIn',
                    'Connect or Retry to approve read-only Azure management access for this tenant.',
                );
            }
            const subscriptions = await this.arm.listSubscriptions(
                session.accessToken,
                tenantId,
                this.signal(),
            );
            if (!this.isCurrent(generation)) {
                return this.state;
            }
            const selectedSubscriptionId = subscriptions[0]?.id ?? null;
            this.state = {
                ...this.state,
                phase: 'ready',
                subscriptions,
                selectedSubscriptionId,
                message:
                    subscriptions.length === 0
                        ? 'No enabled subscriptions are visible in this tenant.'
                        : null,
            };
            return selectedSubscriptionId
                ? this.selectSubscription(selectedSubscriptionId, interactive)
                : this.state;
        } catch (error) {
            return this.fail(error, generation);
        }
    }

    async selectSubscription(
        subscriptionId: string,
        interactive = false,
    ): Promise<AzureBrowserState> {
        const subscription = this.state.subscriptions.find((item) => item.id === subscriptionId);
        if (!subscription) {
            return this.fail(
                new AzureBrowserError('invalidResponse', 'That Azure subscription is no longer available.'),
            );
        }
        this.retryOperation = 'subscription';
        const generation = this.loading('Loading Storage accounts…', {
            selectedSubscriptionId: subscriptionId,
            accounts: [],
            selectedAccountId: null,
            path: [],
            entries: [],
        });
        try {
            const session = await this.session(ARM_SCOPE, subscription.tenantId, interactive);
            if (!this.isCurrent(generation)) {
                return this.state;
            }
            if (!session) {
                throw new AzureBrowserError(
                    'signIn',
                    'Retry to approve read-only Azure management access for this tenant.',
                );
            }
            const accounts = await this.arm.listStorageAccounts(
                session.accessToken,
                subscriptionId,
                this.signal(),
            );
            if (!this.isCurrent(generation)) {
                return this.state;
            }
            this.state = {
                ...this.state,
                phase: 'ready',
                accounts,
                message:
                    accounts.length === 0
                        ? 'No Storage accounts are visible in this subscription.'
                        : null,
            };
            return this.state;
        } catch (error) {
            return this.fail(error, generation);
        }
    }

    async selectAccount(accountId: string, interactive = false): Promise<AzureBrowserState> {
        const selected = this.state.accounts.find((item) => item.id === accountId);
        const tenantId = this.state.selectedTenantId;
        if (!selected || !tenantId) {
            return this.fail(
                new AzureBrowserError('invalidResponse', 'That Storage account is no longer available.'),
            );
        }
        this.retryOperation = 'account';
        this.container = undefined;
        this.prefix = '';
        this.continuationToken = undefined;
        this.entryRegistry.clear();
        const generation = this.loading('Loading containers…', {
            selectedAccountId: accountId,
            path: [],
            entries: [],
            selectedEntryId: null,
            hasMore: false,
        });
        try {
            const session = await this.session(STORAGE_SCOPE, tenantId, interactive);
            if (!this.isCurrent(generation)) {
                return this.state;
            }
            if (!session) {
                throw new AzureBrowserError(
                    'dataAccess',
                    'Retry to approve the Azure Storage data scope. Account-level Storage Blob Data Reader is also required for Phase 1 browsing.',
                );
            }
            const page = await this.storage.listContainers(
                selected.blobHost,
                session,
                undefined,
                this.signal(),
            );
            if (!this.isCurrent(generation)) {
                return this.state;
            }
            return this.applyItems(page.items, page.continuationToken, false);
        } catch (error) {
            return this.fail(error, generation);
        }
    }

    async openEntry(entryId: string): Promise<AzureBrowserState> {
        const registered = this.entryRegistry.get(entryId);
        if (!registered) {
            return this.fail(
                new AzureBrowserError('invalidResponse', 'That Azure item is no longer available.'),
            );
        }
        if (registered.target.kind === 'file') {
            this.state = { ...this.state, selectedEntryId: entryId, message: null };
            return this.state;
        }
        if (registered.target.kind === 'container') {
            this.container = registered.target.container;
            this.prefix = '';
        } else {
            this.prefix = registered.target.prefix;
        }
        return this.loadLocation(false);
    }

    async navigate(depth: number): Promise<AzureBrowserState> {
        if (!Number.isInteger(depth) || depth < 0 || depth > this.state.path.length) {
            return this.fail(new AzureBrowserError('invalidResponse', 'That breadcrumb is invalid.'));
        }
        if (depth === 0) {
            const accountId = this.state.selectedAccountId;
            return accountId ? this.selectAccount(accountId, false) : this.state;
        }
        const segments = this.state.path.slice(0, depth);
        this.container = segments[0];
        this.prefix =
            segments.length > 1
                ? `${segments.slice(1).join('/')}/`
                : '';
        return this.loadLocation(false);
    }

    async loadMore(): Promise<AzureBrowserState> {
        if (!this.continuationToken) {
            return this.state;
        }
        return this.container ? this.loadLocation(true) : this.loadContainersMore();
    }

    selectedUrl(): string | undefined {
        const registered = this.state.selectedEntryId
            ? this.entryRegistry.get(this.state.selectedEntryId)
            : undefined;
        const account = this.selectedAccount();
        if (!registered || registered.target.kind !== 'file' || !account || !this.container) {
            return undefined;
        }
        return azureStorageUrl(account, this.container, registered.target.blobName);
    }

    close(): AzureBrowserState {
        this.lifecycle += 1;
        this.cancel();
        this.state = { ...this.state, open: false, phase: 'closed' };
        return this.state;
    }

    disconnect(): AzureBrowserState {
        this.lifecycle += 1;
        this.cancel();
        this.account = undefined;
        this.entryRegistry.clear();
        this.continuationToken = undefined;
        this.container = undefined;
        this.prefix = '';
        this.retryOperation = 'discover';
        this.state = CLOSED_AZURE_BROWSER_STATE;
        return this.state;
    }

    cancel(): void {
        this.abortController?.abort();
        this.abortController = undefined;
        this.generation += 1;
    }

    private async discover(interactive: boolean): Promise<AzureBrowserState> {
        this.retryOperation = 'discover';
        const generation = this.loading('Connecting to Azure…');
        try {
            const session = await this.deps.authentication.acquire(
                ARM_SCOPE,
                undefined,
                this.account,
                interactive,
            );
            if (!this.isCurrent(generation)) {
                return this.state;
            }
            if (!session) {
                this.state = {
                    ...CLOSED_AZURE_BROWSER_STATE,
                    open: true,
                    phase: 'signedOut',
                    message: 'Connect with Microsoft to browse Azure public cloud read-only.',
                };
                return this.state;
            }
            this.account = session.account;
            const tenants = await this.arm.listTenants(session.accessToken, this.signal());
            if (!this.isCurrent(generation)) {
                return this.state;
            }
            const selectedTenantId = tenants[0]?.id ?? null;
            this.state = {
                ...this.state,
                phase: 'ready',
                identity: this.deps.authentication.identity(session),
                tenants,
                selectedTenantId,
                errorKind: null,
                message: tenants.length === 0 ? 'No Azure tenants are visible for this account.' : null,
            };
            return selectedTenantId
                ? this.selectTenant(selectedTenantId, interactive)
                : this.state;
        } catch (error) {
            return this.fail(error, generation);
        }
    }

    private async loadLocation(
        append: boolean,
        interactive = false,
    ): Promise<AzureBrowserState> {
        const account = this.selectedAccount();
        const tenantId = this.state.selectedTenantId;
        if (!account || !tenantId || !this.container) {
            return this.fail(new AzureBrowserError('invalidResponse', 'The Azure location is incomplete.'));
        }
        this.retryOperation = 'location';
        const generation = this.loading(
            'Loading files…',
            append
                ? { path: this.locationPath() }
                : { path: this.locationPath(), entries: [], selectedEntryId: null },
        );
        try {
            const session = await this.session(STORAGE_SCOPE, tenantId, interactive);
            if (!this.isCurrent(generation)) {
                return this.state;
            }
            if (!session) {
                throw new AzureBrowserError(
                    'dataAccess',
                    'Retry to approve the Azure Storage data scope. Account-level Storage Blob Data Reader is also required for Phase 1 browsing.',
                );
            }
            const page = await this.storage.listBlobs(
                account.blobHost,
                this.container,
                this.prefix,
                session,
                append ? this.continuationToken : undefined,
                this.signal(),
            );
            if (!this.isCurrent(generation)) {
                return this.state;
            }
            return this.applyItems(page.items, page.continuationToken, append);
        } catch (error) {
            return this.fail(error, generation);
        }
    }

    private async loadContainersMore(): Promise<AzureBrowserState> {
        const account = this.selectedAccount();
        const tenantId = this.state.selectedTenantId;
        if (!account || !tenantId) {
            return this.state;
        }
        const generation = this.loading('Loading more containers…');
        try {
            const session = await this.session(STORAGE_SCOPE, tenantId, false);
            if (!this.isCurrent(generation)) {
                return this.state;
            }
            if (!session) {
                throw new AzureBrowserError('dataAccess', 'Retry to approve the Azure Storage data scope.');
            }
            const page = await this.storage.listContainers(
                account.blobHost,
                session,
                this.continuationToken,
                this.signal(),
            );
            if (!this.isCurrent(generation)) {
                return this.state;
            }
            return this.applyItems(page.items, page.continuationToken, true);
        } catch (error) {
            return this.fail(error, generation);
        }
    }

    private applyItems(
        items: readonly StorageItem[],
        continuationToken: string | undefined,
        append: boolean,
    ): AzureBrowserState {
        if (!append) {
            this.entryRegistry.clear();
        }
        const existing = append ? this.state.entries.length : 0;
        const remaining = Math.max(0, MAX_STORAGE_ITEMS - existing);
        const entries = items.slice(0, remaining).map((item) => this.register(item));
        const capped = existing + entries.length >= MAX_STORAGE_ITEMS;
        this.continuationToken = capped ? undefined : continuationToken;
        this.state = {
            ...this.state,
            phase: 'ready',
            path: this.locationPath(),
            entries: append ? [...this.state.entries, ...entries] : entries,
            hasMore: this.continuationToken !== undefined,
            errorKind: null,
            message:
                capped && continuationToken !== undefined
                    ? `Showing the first ${MAX_STORAGE_ITEMS} items in this location.`
                    : !append && entries.length === 0
                    ? 'This location contains no items.'
                    : null,
        };
        return this.state;
    }

    private register(item: StorageItem): AzureBrowserEntry {
        const id = crypto.randomBytes(12).toString('hex');
        const extension =
            item.kind === 'file' && item.name.includes('.')
                ? item.name.slice(item.name.lastIndexOf('.') + 1).toLowerCase()
                : null;
        const entry: AzureBrowserEntry = {
            id,
            kind: item.kind,
            name: item.name,
            format: extension ? extension.toUpperCase() : null,
            supported: extension !== null && SUPPORTED_EXTENSIONS.has(extension),
            sizeBytes: item.kind === 'file' ? item.sizeBytes : null,
            modifiedAt:
                item.kind === 'folder' || item.modifiedAt === null
                    ? null
                    : item.modifiedAt.toISOString(),
        };
        const target =
            item.kind === 'container'
                ? { kind: 'container' as const, container: item.name }
                : item.kind === 'folder'
                    ? { kind: 'folder' as const, prefix: item.prefix }
                    : { kind: 'file' as const, blobName: item.blobName };
        this.entryRegistry.set(id, { entry, target });
        return entry;
    }

    private locationPath(): readonly string[] {
        if (!this.container) {
            return [];
        }
        return [
            this.container,
            ...this.prefix.split('/').filter((segment) => segment.length > 0),
        ];
    }

    private selectedAccount(): AzureStorageAccount | undefined {
        return this.state.accounts.find((item) => item.id === this.state.selectedAccountId);
    }

    private session(
        scope: typeof ARM_SCOPE | typeof STORAGE_SCOPE,
        tenantId: string,
        interactive: boolean,
    ): Promise<AuthenticationSession | undefined> {
        return this.deps.authentication.acquire(scope, tenantId, this.account, interactive);
    }

    private async runInteractive(
        action: () => Promise<AzureBrowserState>,
    ): Promise<AzureBrowserState> {
        const operationId = ++this.interactiveOperationId;
        this.interactiveOperations.set(operationId, this.lifecycle);
        try {
            return await action();
        } finally {
            this.interactiveOperations.delete(operationId);
        }
    }

    private loading(
        message: string,
        patch: Partial<AzureBrowserState> = {},
    ): number {
        this.cancel();
        this.abortController = new AbortController();
        this.state = {
            ...this.state,
            ...patch,
            open: true,
            phase: 'loading',
            errorKind: null,
            message,
        };
        return this.generation;
    }

    private signal(): AbortSignal {
        if (!this.abortController) {
            this.abortController = new AbortController();
        }
        return this.abortController.signal;
    }

    private isCurrent(generation: number): boolean {
        return generation === this.generation;
    }

    private fail(error: unknown, generation?: number): AzureBrowserState {
        if (generation !== undefined && !this.isCurrent(generation)) {
            return this.state;
        }
        const safe =
            error instanceof AzureBrowserError
                ? error
                : new AzureBrowserError('temporary', 'Azure browsing failed. Retry the request.');
        this.state = {
            ...this.state,
            open: true,
            phase: 'error',
            errorKind: safe.kind,
            message: safe.message,
        };
        return this.state;
    }
}
