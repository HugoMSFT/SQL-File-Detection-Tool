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

export const AZURE_BROWSER_CACHE_TTL_MS = 2 * 60 * 1_000;

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
    readonly now?: () => number;
    readonly cacheTtlMs?: number;
}

interface InteractiveOperation {
    readonly id: number;
    readonly lifecycle: number;
    ownerGeneration: number;
    providerChangePending: boolean;
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
    private interactiveOperation: InteractiveOperation | undefined;
    private pendingAuthenticationChangeLifecycle: number | undefined;
    private reconcilingLifecycle: number | undefined;
    private interactiveOperationId = 0;
    private lifecycle = 0;
    private reconnectRequiresUserAction = true;
    private lastRefreshAt: number | undefined;
    private connectPromise: Promise<AzureBrowserState> | undefined;
    private refreshPromise: Promise<AzureBrowserState> | undefined;

    constructor(private readonly deps: AzureBrowserDeps) {
        this.arm = deps.arm ?? new ArmClient();
        this.storage = deps.storage ?? new StorageBrowserClient();
    }

    get snapshot(): AzureBrowserState {
        return this.state;
    }

    async authenticationChanged(): Promise<AzureBrowserState> {
        if (this.reconnectRequiresUserAction) {
            return this.state;
        }
        // VS Code reports only the provider, not the affected session. A session
        // created by this operation is authoritative until its full discovery
        // chain settles; later provider events still revalidate normally.
        const interactive = this.interactiveOperation;
        if (
            this.state.open
            && interactive?.lifecycle === this.lifecycle
            && interactive.ownerGeneration === this.generation
        ) {
            interactive.providerChangePending = true;
            return this.state;
        }
        this.pendingAuthenticationChangeLifecycle = undefined;
        return this.state.open
            ? this.reconcileDeferredAuthentication(this.lifecycle)
            : this.revalidateAuthentication();
    }

    /**
     * Re-establish authentication after a provider change.
     *
     * The account in use is captured before state is dropped so rediscovery can
     * prove that account is still usable before any other signed-in account is
     * considered. Clearing is synchronous and every listing is refetched through
     * live scoped calls, so a superseding operation can only interrupt the
     * optional recovery - never leave authenticated resources on screen.
     */
    private async revalidateAuthentication(): Promise<AzureBrowserState> {
        const wasOpen = this.state.open;
        const pinned = this.account;
        this.clearAuthenticationState();
        if (!wasOpen) {
            this.reconnectRequiresUserAction = true;
            this.state = CLOSED_AZURE_BROWSER_STATE;
            return this.state;
        }
        this.state = { ...CLOSED_AZURE_BROWSER_STATE, open: true, phase: 'loading' };
        return this.discover(false, pinned);
    }

    async open(): Promise<AzureBrowserState> {
        if (this.reconnectRequiresUserAction) {
            return this.signedOut(
                this.state.phase === 'signedOut' && this.state.message
                    ? this.state.message
                    : 'Connect to Azure to browse Azure public cloud read-only.',
            );
        }
        if (this.account && this.state.identity && this.lastRefreshAt !== undefined) {
            if (!this.cacheIsFresh()) {
                return this.refresh();
            }
            this.state = {
                ...this.state,
                open: true,
                phase: 'ready',
                errorKind: null,
                message: null,
            };
            return this.state;
        }
        this.reconnectRequiresUserAction = true;
        return this.signedOut('Connect to Azure to browse Azure public cloud read-only.');
    }

    connect(): Promise<AzureBrowserState> {
        if (this.connectPromise) {
            return this.connectPromise;
        }
        this.reconnectRequiresUserAction = false;
        this.retryOperation = 'discover';
        const pending = this.runInteractive(() => this.discover(true));
        this.connectPromise = pending;
        void pending.then(
            () => this.clearConnectPromise(pending),
            () => this.clearConnectPromise(pending),
        );
        return pending;
    }

    refresh(): Promise<AzureBrowserState> {
        if (this.connectPromise) {
            return this.connectPromise;
        }
        if (this.refreshPromise) {
            return this.refreshPromise;
        }
        if (this.reconnectRequiresUserAction || !this.account) {
            this.reconnectRequiresUserAction = true;
            return Promise.resolve(
                this.signedOut('Connect to Azure before refreshing Azure resources.'),
            );
        }
        const identity = this.state.identity;
        const pinned = this.account;
        this.dropResourceState();
        this.state = {
            ...CLOSED_AZURE_BROWSER_STATE,
            open: true,
            phase: 'loading',
            identity,
            message: 'Refreshing Azure resources…',
        };
        this.retryOperation = 'discover';
        const pending = this.discover(false, pinned);
        this.refreshPromise = pending;
        void pending.then(
            () => this.clearRefreshPromise(pending),
            () => this.clearRefreshPromise(pending),
        );
        return pending;
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
        const generation = this.loading(
            'Loading subscriptions…',
            {
                selectedTenantId: tenantId,
                subscriptions: [],
                selectedSubscriptionId: null,
                accounts: [],
                selectedAccountId: null,
                path: [],
                entries: [],
            },
            this.interactiveOwner(interactive),
        );
        const supersededAuthentication = this.reconcileSupersededAuthentication();
        if (supersededAuthentication) {
            return supersededAuthentication;
        }
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
            if (selectedSubscriptionId) {
                return this.selectSubscription(selectedSubscriptionId, interactive);
            }
            return this.state;
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
        const generation = this.loading(
            'Loading Storage accounts…',
            {
                selectedSubscriptionId: subscriptionId,
                accounts: [],
                selectedAccountId: null,
                path: [],
                entries: [],
            },
            this.interactiveOwner(interactive),
        );
        const supersededAuthentication = this.reconcileSupersededAuthentication();
        if (supersededAuthentication) {
            return supersededAuthentication;
        }
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
        const generation = this.loading(
            'Loading containers…',
            {
                selectedAccountId: accountId,
                path: [],
                entries: [],
                selectedEntryId: null,
                hasMore: false,
            },
            this.interactiveOwner(interactive),
        );
        const supersededAuthentication = this.reconcileSupersededAuthentication();
        if (supersededAuthentication) {
            return supersededAuthentication;
        }
        try {
            const session = await this.session(STORAGE_SCOPE, tenantId, interactive);
            if (!this.isCurrent(generation)) {
                return this.state;
            }
            if (!session) {
                throw new AzureBrowserError(
                    'storageConsent',
                    'Connected to Azure. Authorize read-only Storage access for this tenant to list containers. Your Azure role must also include Storage Blob Data Reader.',
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

    currentFolderUrl(): string | undefined {
        const account = this.selectedAccount();
        if (!account || !this.container) {
            return undefined;
        }
        return azureStorageUrl(account, this.container, this.prefix);
    }

    close(): AzureBrowserState {
        const authenticationPending =
            this.pendingAuthenticationChangeLifecycle === this.lifecycle
            || this.reconcilingLifecycle === this.lifecycle
            || (
                this.interactiveOperation?.lifecycle === this.lifecycle
                && this.interactiveOperation.providerChangePending
            );
        this.lifecycle += 1;
        this.interactiveOperation = undefined;
        this.pendingAuthenticationChangeLifecycle = undefined;
        this.reconcilingLifecycle = undefined;
        this.connectPromise = undefined;
        this.refreshPromise = undefined;
        this.cancel();
        if (authenticationPending) {
            this.dropAuthenticationState();
            this.reconnectRequiresUserAction = true;
            this.state = CLOSED_AZURE_BROWSER_STATE;
            return this.state;
        }
        this.state = { ...this.state, open: false, phase: 'closed' };
        return this.state;
    }

    disconnect(): AzureBrowserState {
        this.lifecycle += 1;
        this.reconnectRequiresUserAction = true;
        this.interactiveOperation = undefined;
        this.pendingAuthenticationChangeLifecycle = undefined;
        this.reconcilingLifecycle = undefined;
        this.connectPromise = undefined;
        this.refreshPromise = undefined;
        this.cancel();
        return this.signedOut('Disconnected. Select Connect to browse Azure again.');
    }

    cancel(preserveInteractiveOperationId?: number): void {
        const interactive = this.interactiveOperation;
        if (interactive && interactive.id !== preserveInteractiveOperationId) {
            this.interactiveOperation = undefined;
            if (
                interactive.providerChangePending
                && interactive.lifecycle === this.lifecycle
                && this.state.open
            ) {
                this.pendingAuthenticationChangeLifecycle = this.lifecycle;
            }
        }
        this.abortController?.abort();
        this.abortController = undefined;
        this.generation += 1;
    }

    private async discover(
        interactive: boolean,
        pinned: AuthenticationAccount | undefined = this.account,
    ): Promise<AzureBrowserState> {
        this.retryOperation = 'discover';
        const generation = this.loading(
            'Connecting to Azure…',
            {},
            this.interactiveOwner(interactive),
        );
        const supersededAuthentication = this.reconcileSupersededAuthentication();
        if (supersededAuthentication) {
            return supersededAuthentication;
        }
        try {
            const session = await this.acquireDiscoverySession(pinned, interactive);
            if (!this.isCurrent(generation)) {
                return this.state;
            }
            if (!session) {
                return this.signedOut(
                    'Connect to Azure to browse Azure public cloud read-only.',
                );
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
                subscriptions: [],
                selectedSubscriptionId: null,
                accounts: [],
                selectedAccountId: null,
                path: [],
                entries: [],
                selectedEntryId: null,
                hasMore: false,
                errorKind: null,
                message: tenants.length === 0 ? 'No Azure tenants are visible for this account.' : null,
            };
            if (selectedTenantId) {
                const discovered = await this.selectTenant(selectedTenantId, interactive);
                if (discovered.phase === 'ready') {
                    this.markRefreshed();
                }
                return discovered;
            }
            this.markRefreshed();
            return this.state;
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
            this.interactiveOwner(interactive),
        );
        const supersededAuthentication = this.reconcileSupersededAuthentication();
        if (supersededAuthentication) {
            return supersededAuthentication;
        }
        try {
            const session = await this.session(STORAGE_SCOPE, tenantId, interactive);
            if (!this.isCurrent(generation)) {
                return this.state;
            }
            if (!session) {
                throw new AzureBrowserError(
                    'storageConsent',
                    'Authorize read-only Storage access for this tenant to continue browsing.',
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
        const supersededAuthentication = this.reconcileSupersededAuthentication();
        if (supersededAuthentication) {
            return supersededAuthentication;
        }
        try {
            const session = await this.session(STORAGE_SCOPE, tenantId, false);
            if (!this.isCurrent(generation)) {
                return this.state;
            }
            if (!session) {
                throw new AzureBrowserError(
                    'storageConsent',
                    'Authorize read-only Storage access for this tenant to load more containers.',
                );
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
        return this.deps.authentication.acquireSession(
            scope,
            tenantId,
            this.account,
            interactive,
        );
    }

    /**
     * Acquire the discovery session, preferring the account already in use.
     *
     * VS Code reports only that the Microsoft provider changed, never which
     * account. An account-agnostic silent lookup can therefore return a
     * different, stale account and discard the session the user just
     * established - the failure this browser originally shipped with. Proving
     * the retained account first makes that impossible, and the fallback still
     * recovers when that account was genuinely removed. An interactive request
     * keeps its existing prompt rather than silently adopting another account.
     */
    private async acquireDiscoverySession(
        pinned: AuthenticationAccount | undefined,
        interactive: boolean,
    ): Promise<AuthenticationSession | undefined> {
        if (!pinned) {
            return this.deps.authentication.acquireSession(
                ARM_SCOPE,
                undefined,
                undefined,
                interactive,
            );
        }
        if (interactive) {
            return this.deps.authentication.acquireSession(
                ARM_SCOPE,
                undefined,
                pinned,
                true,
            );
        }
        const retained = await this.deps.authentication.acquireSession(
            ARM_SCOPE,
            undefined,
            pinned,
            false,
        );
        if (retained) {
            return retained;
        }
        // Only a resolved "no session" proves the account is gone. A provider
        // failure propagates instead, because it must never license adopting a
        // different - possibly stale - account.
        return this.deps.authentication.acquireSession(
            ARM_SCOPE,
            undefined,
            undefined,
            false,
        );
    }

    private async runInteractive(
        action: () => Promise<AzureBrowserState>,
    ): Promise<AzureBrowserState> {
        const previous = this.interactiveOperation;
        const operation: InteractiveOperation = {
            id: ++this.interactiveOperationId,
            lifecycle: this.lifecycle,
            ownerGeneration: this.generation,
            providerChangePending:
                (
                    previous?.lifecycle === this.lifecycle
                    && previous.providerChangePending
                )
                || this.pendingAuthenticationChangeLifecycle === this.lifecycle,
        };
        this.pendingAuthenticationChangeLifecycle = undefined;
        this.interactiveOperation = operation;
        try {
            let result = await action();
            if (this.interactiveOperation?.id === operation.id) {
                this.interactiveOperation = undefined;
                if (operation.providerChangePending && operation.lifecycle === this.lifecycle) {
                    result = await this.reconcileDeferredAuthentication(operation.lifecycle);
                }
            }
            return result;
        } finally {
            if (this.interactiveOperation?.id === operation.id) {
                this.interactiveOperation = undefined;
            }
        }
    }

    /**
     * Apply a provider change that was deferred while an interactive operation
     * owned the browser.
     *
     * Granting a scope creates a session, so the common deferred change is the
     * operation's own sign-in. When the account in use is still the same account
     * that is a no-op for the user's position, and resetting them to the root -
     * losing the container, folder and file they just chose - would be a bug.
     * Anything else (a different account, or one that is gone) is a real
     * identity change and rebuilds every listing from live scoped calls.
     */
    private async reconcileDeferredAuthentication(
        operationLifecycle: number,
    ): Promise<AzureBrowserState> {
        if (!this.state.open || operationLifecycle !== this.lifecycle) {
            return this.state;
        }
        const account = this.account;
        if (!account) {
            return this.revalidateAuthentication();
        }
        const tenantId = this.state.selectedTenantId ?? undefined;
        const generation = this.generation;
        const reconcilingLifecycle = operationLifecycle;
        this.reconcilingLifecycle = reconcilingLifecycle;
        let session: AuthenticationSession | undefined;
        try {
            session = await this.deps.authentication.acquireSession(
                ARM_SCOPE,
                tenantId,
                account,
                false,
            );
        } catch {
            if (this.reconcilingLifecycle === reconcilingLifecycle) {
                this.reconcilingLifecycle = undefined;
            }
            if (
                generation !== this.generation
                || operationLifecycle !== this.lifecycle
                || !this.state.open
            ) {
                if (this.state.open && operationLifecycle === this.lifecycle) {
                    // A newer operation already owns the browser. Defer rather
                    // than overwrite a result that was proved after this one.
                    this.pendingAuthenticationChangeLifecycle = this.lifecycle;
                }
                return this.state;
            }
            this.clearAuthenticationState();
            return this.signedOut(
                'The Microsoft session could not be revalidated. Connect again.',
            );
        }
        if (this.reconcilingLifecycle === reconcilingLifecycle) {
            this.reconcilingLifecycle = undefined;
        }
        if (
            generation !== this.generation
            || operationLifecycle !== this.lifecycle
            || !this.state.open
        ) {
            if (this.state.open && operationLifecycle === this.lifecycle) {
                // Superseded before this could be applied. Leave it pending so
                // the next operation reconciles it instead of dropping it.
                this.pendingAuthenticationChangeLifecycle = this.lifecycle;
            }
            return this.state;
        }
        if (session && session.account.id === account.id) {
            this.account = session.account;
            this.state = {
                ...this.state,
                identity: this.deps.authentication.identity(session),
            };
            return this.state;
        }
        this.clearAuthenticationState();
        this.state = { ...CLOSED_AZURE_BROWSER_STATE, open: true, phase: 'loading' };
        return this.discover(false);
    }

    private clearAuthenticationState(): void {
        this.cancel();
        this.dropAuthenticationState();
    }

    private dropAuthenticationState(): void {
        this.account = undefined;
        this.dropResourceState();
    }

    private dropResourceState(): void {
        this.lastRefreshAt = undefined;
        this.entryRegistry.clear();
        this.continuationToken = undefined;
        this.container = undefined;
        this.prefix = '';
        this.retryOperation = 'discover';
    }

    private signedOut(message: string): AzureBrowserState {
        this.reconnectRequiresUserAction = true;
        this.dropAuthenticationState();
        this.state = {
            ...CLOSED_AZURE_BROWSER_STATE,
            open: true,
            phase: 'signedOut',
            message,
        };
        return this.state;
    }

    private markRefreshed(): void {
        this.lastRefreshAt = this.now();
    }

    private cacheIsFresh(): boolean {
        return (
            this.lastRefreshAt !== undefined
            && this.now() - this.lastRefreshAt < (
                this.deps.cacheTtlMs ?? AZURE_BROWSER_CACHE_TTL_MS
            )
        );
    }

    private now(): number {
        return (this.deps.now ?? Date.now)();
    }

    private clearConnectPromise(pending: Promise<AzureBrowserState>): void {
        if (this.connectPromise === pending) {
            this.connectPromise = undefined;
        }
    }

    private clearRefreshPromise(pending: Promise<AzureBrowserState>): void {
        if (this.refreshPromise === pending) {
            this.refreshPromise = undefined;
        }
    }

    private loading(
        message: string,
        patch: Partial<AzureBrowserState> = {},
        interactiveOperationId?: number,
    ): number {
        this.cancel(interactiveOperationId);
        this.abortController = new AbortController();
        this.state = {
            ...this.state,
            ...patch,
            open: true,
            phase: 'loading',
            errorKind: null,
            message,
        };
        const interactive = this.interactiveOperation;
        if (interactive && interactive.id === interactiveOperationId) {
            interactive.ownerGeneration = this.generation;
        }
        return this.generation;
    }

    private interactiveOwner(interactive: boolean): number | undefined {
        return interactive ? this.interactiveOperation?.id : undefined;
    }

    private reconcileSupersededAuthentication(): Promise<AzureBrowserState> | undefined {
        if (
            this.pendingAuthenticationChangeLifecycle !== this.lifecycle
            || !this.state.open
            || this.interactiveOperation
        ) {
            return undefined;
        }
        this.pendingAuthenticationChangeLifecycle = undefined;
        return this.revalidateAuthentication();
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
