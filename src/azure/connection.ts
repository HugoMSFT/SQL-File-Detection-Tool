import {
    MicrosoftAuthentication,
    type AuthenticationSession,
} from './auth';
import { AzureConnectionError, safeAzureError } from './errors';
import { AzureTenantClient } from './tenantClient';
import {
    DISCONNECTED_AZURE_CONNECTION_STATE,
    type AzureConnectionService,
    type AzureConnectionState,
} from './types';

export const TENANT_CACHE_TTL_MS = 2 * 60 * 1_000;

interface Operation {
    readonly generation: number;
    readonly lifecycle: number;
    readonly kind: 'connect' | 'refresh' | 'reconcile';
    readonly abort: AbortController;
    interactiveSessionId?: string;
}

interface TenantCache {
    readonly accountId: string;
    readonly tenants: AzureConnectionState['tenants'];
    readonly expiresAt: number;
}

export interface AzureConnectionDependencies {
    readonly authentication: MicrosoftAuthentication;
    readonly tenants: AzureTenantClient;
    readonly publish: (state: AzureConnectionState) => void;
    readonly log: (message: string) => void;
    readonly now?: () => number;
    readonly tenantCacheTtlMs?: number;
}

/**
 * Minimal Azure connection state machine.
 *
 * Provider events are coalesced behind the active operation. A session returned
 * by this operation remains authoritative for its own change event only while
 * its account still exists in VS Code. Every later event requires a successful
 * account-pinned silent lookup.
 */
export class AzureConnection implements AzureConnectionService {
    private currentState = DISCONNECTED_AZURE_CONNECTION_STATE;
    private session: AuthenticationSession | undefined;
    private active: Operation | undefined;
    private generation = 0;
    private lifecycle = 0;
    private pendingAuthenticationChange = false;
    private preserveSessionOnce: string | undefined;
    private tenantCache: TenantCache | undefined;
    private connectPromise: Promise<AzureConnectionState> | undefined;
    private refreshPromise: Promise<AzureConnectionState> | undefined;
    private disposed = false;

    constructor(private readonly deps: AzureConnectionDependencies) {}

    get state(): AzureConnectionState {
        return this.currentState;
    }

    connect(): Promise<AzureConnectionState> {
        return this.coalescedConnect(true);
    }

    retry(): Promise<AzureConnectionState> {
        return this.coalescedConnect(false);
    }

    refresh(): Promise<AzureConnectionState> {
        if (this.connectPromise) {
            return this.connectPromise;
        }
        if (this.refreshPromise) {
            return this.refreshPromise;
        }
        const pending = this.startRefresh();
        this.refreshPromise = pending;
        void pending.then(
            () => this.clearRefreshPromise(pending),
            () => this.clearRefreshPromise(pending),
        );
        return pending;
    }

    disconnect(): AzureConnectionState {
        this.lifecycle += 1;
        this.supersede();
        this.pendingAuthenticationChange = false;
        this.preserveSessionOnce = undefined;
        this.tenantCache = undefined;
        this.connectPromise = undefined;
        this.refreshPromise = undefined;
        this.session = undefined;
        return this.transition(DISCONNECTED_AZURE_CONNECTION_STATE);
    }

    async authenticationChanged(): Promise<AzureConnectionState> {
        if (this.disposed || this.currentState.phase === 'disconnected') {
            this.pendingAuthenticationChange = false;
            return this.currentState;
        }
        this.tenantCache = undefined;
        this.pendingAuthenticationChange = true;
        this.deps.log(
            `Azure authentication change queued at lifecycle=${this.lifecycle} generation=${this.generation}.`,
        );
        if (this.active) {
            return this.currentState;
        }
        return this.reconcile();
    }

    dispose(): void {
        this.disposed = true;
        this.lifecycle += 1;
        this.supersede();
        this.pendingAuthenticationChange = false;
        this.preserveSessionOnce = undefined;
        this.tenantCache = undefined;
        this.connectPromise = undefined;
        this.refreshPromise = undefined;
        this.session = undefined;
    }

    private coalescedConnect(useCache: boolean): Promise<AzureConnectionState> {
        if (this.connectPromise) {
            this.deps.log('Azure connect joined the active request.');
            return this.connectPromise;
        }
        const pending = this.startConnect(useCache);
        this.connectPromise = pending;
        void pending.then(
            () => this.clearConnectPromise(pending),
            () => this.clearConnectPromise(pending),
        );
        return pending;
    }

    private clearConnectPromise(pending: Promise<AzureConnectionState>): void {
        if (this.connectPromise === pending) {
            this.connectPromise = undefined;
        }
    }

    private clearRefreshPromise(pending: Promise<AzureConnectionState>): void {
        if (this.refreshPromise === pending) {
            this.refreshPromise = undefined;
        }
    }

    private async startConnect(useCache: boolean): Promise<AzureConnectionState> {
        if (this.disposed) {
            return this.currentState;
        }
        const operation = this.begin('connect');
        const startedAt = this.now();
        let stage: 'authentication' | 'tenants' = 'authentication';
        this.session = undefined;
        this.preserveSessionOnce = undefined;
        this.transition({
            phase: 'connecting',
            identity: null,
            tenants: [],
            stale: false,
            errorKind: null,
            message: 'Waiting for Microsoft authentication…',
        });
        try {
            const authenticationStartedAt = this.now();
            const acquired = await this.deps.authentication.acquire(true);
            if (!this.isCurrent(operation)) {
                return this.currentState;
            }
            this.logDuration('authentication', acquired.source, authenticationStartedAt, operation);
            if (!acquired.session) {
                return this.fail(
                    operation,
                    'signIn',
                    'Microsoft sign-in was not completed. Select Retry to try again.',
                );
            }
            this.session = acquired.session;
            if (acquired.source === 'interactive') {
                operation.interactiveSessionId = acquired.session.id;
            }
            const cached = useCache ? this.cachedTenants(acquired.session.account.id) : undefined;
            if (cached) {
                this.transition({
                    phase: 'connected',
                    identity: this.deps.authentication.identity(acquired.session),
                    tenants: cached,
                    stale: false,
                    errorKind: null,
                    message:
                        `Connected. Using ${cached.length} recently verified Azure ${
                            cached.length === 1 ? 'directory' : 'directories'
                        }.`,
                });
                if (this.pendingAuthenticationChange && operation.interactiveSessionId) {
                    this.preserveSessionOnce = operation.interactiveSessionId;
                }
            } else {
                this.transition({
                    phase: 'connecting',
                    identity: this.deps.authentication.identity(acquired.session),
                    tenants: [],
                    stale: false,
                    errorKind: null,
                    message: 'Microsoft sign-in succeeded. Checking Azure directories…',
                });
                stage = 'tenants';
                const tenantsStartedAt = this.now();
                const tenants = await this.deps.tenants.listTenants(
                    acquired.session.accessToken,
                    operation.abort.signal,
                );
                this.logDuration('tenants', 'success', tenantsStartedAt, operation);
                if (!this.isCurrent(operation)) {
                    return this.currentState;
                }
                this.cacheTenants(acquired.session.account.id, tenants);
                this.transition({
                    phase: 'connected',
                    identity: this.deps.authentication.identity(acquired.session),
                    tenants,
                    stale: false,
                    errorKind: null,
                    message:
                        tenants.length === 0
                            ? 'Connected, but this account has no visible Azure directories.'
                            : `Connected. ${tenants.length} Azure ${
                                tenants.length === 1 ? 'directory is' : 'directories are'
                            } visible.`,
                });
                if (this.pendingAuthenticationChange && operation.interactiveSessionId) {
                    this.preserveSessionOnce = operation.interactiveSessionId;
                }
            }
        } catch (error) {
            if (this.isCurrent(operation)) {
                const safe =
                    stage === 'authentication'
                        ? new AzureConnectionError(
                            'signIn',
                            'Microsoft authentication is unavailable. Retry when VS Code sign-in is available.',
                        )
                        : safeAzureError(error);
                this.deps.log(
                    `Azure ${stage} completed outcome=${safe.kind} durationMs=${Math.max(
                        0,
                        this.now() - startedAt,
                    )} generation=${operation.generation}.`,
                );
                if (
                    stage === 'tenants'
                    && this.session
                    && this.useCachedFallback(operation, this.session, safe)
                ) {
                    return this.currentState;
                }
                this.fail(operation, safe.kind, safe.message);
            }
        } finally {
            if (this.isCurrent(operation)) {
                this.active = undefined;
            }
        }
        if (
            this.ownsGeneration(operation)
            && !this.active
            && this.pendingAuthenticationChange
            && this.session
        ) {
            return this.reconcile();
        }
        if (this.ownsGeneration(operation) && !this.session) {
            this.pendingAuthenticationChange = false;
        }
        return this.currentState;
    }

    private async startRefresh(): Promise<AzureConnectionState> {
        const retained = this.session;
        if (
            this.disposed
            || !retained
            || this.currentState.phase !== 'connected'
        ) {
            return this.currentState;
        }
        const operation = this.begin('refresh');
        const startedAt = this.now();
        this.transition({
            ...this.currentState,
            phase: 'connecting',
            message: 'Refreshing Microsoft session and Azure directories…',
        });
        try {
            const authenticationStartedAt = this.now();
            const acquired = await this.deps.authentication.acquire(false, retained.account);
            if (!this.isCurrent(operation)) {
                return this.currentState;
            }
            this.logDuration('authentication', acquired.source, authenticationStartedAt, operation);
            if (!acquired.session) {
                return this.clearAfterAuthenticationChange(
                    operation,
                    'The Microsoft session is no longer available. Connect again to use Azure.',
                );
            }
            this.session = acquired.session;
            const tenantsStartedAt = this.now();
            const tenants = await this.deps.tenants.listTenants(
                acquired.session.accessToken,
                operation.abort.signal,
            );
            this.logDuration('tenants', 'success', tenantsStartedAt, operation);
            if (!this.isCurrent(operation)) {
                return this.currentState;
            }
            this.cacheTenants(acquired.session.account.id, tenants);
            this.transition({
                phase: 'connected',
                identity: this.deps.authentication.identity(acquired.session),
                tenants,
                stale: false,
                errorKind: null,
                message:
                    tenants.length === 0
                        ? 'Connected, but this account has no visible Azure directories.'
                        : `Refreshed. ${tenants.length} Azure ${
                            tenants.length === 1 ? 'directory is' : 'directories are'
                        } visible.`,
            });
        } catch (error) {
            if (this.isCurrent(operation)) {
                const safe = safeAzureError(error);
                this.deps.log(
                    `Azure refresh completed outcome=${safe.kind} durationMs=${Math.max(
                        0,
                        this.now() - startedAt,
                    )} generation=${operation.generation}.`,
                );
                if (!this.useCachedFallback(operation, retained, safe)) {
                    this.fail(operation, safe.kind, safe.message);
                }
            }
        } finally {
            if (this.isCurrent(operation)) {
                this.active = undefined;
            }
        }
        if (
            this.ownsGeneration(operation)
            && !this.active
            && this.pendingAuthenticationChange
            && this.session
        ) {
            return this.reconcile();
        }
        return this.currentState;
    }

    private async reconcile(): Promise<AzureConnectionState> {
        while (
            !this.disposed
            && this.pendingAuthenticationChange
            && this.session
            && !this.active
        ) {
            const retained = this.session;
            const operation = this.begin('reconcile');
            const preserve =
                this.preserveSessionOnce !== undefined
                && this.preserveSessionOnce === retained.id;
            this.preserveSessionOnce = undefined;
            this.pendingAuthenticationChange = false;
            try {
                const accounts = await this.deps.authentication.getAccounts();
                if (!this.isCurrent(operation)) {
                    return this.transferOrReconcile(operation);
                }
                const account = accounts.find((candidate) => candidate.id === retained.account.id);
                if (!account) {
                    return this.clearAfterAuthenticationChange(
                        operation,
                        'The Microsoft account was signed out. Connect again to use Azure.',
                    );
                }
                const result = await this.deps.authentication.acquire(false, account);
                if (!this.isCurrent(operation)) {
                    return this.transferOrReconcile(operation);
                }
                if (result.session) {
                    this.session = result.session;
                    this.transition({
                        ...this.currentState,
                        phase: 'connected',
                        identity: this.deps.authentication.identity(result.session),
                        stale: this.currentState.stale,
                        errorKind: null,
                    });
                } else if (preserve) {
                    this.deps.log(
                        `Azure preserved the authoritative interactive session at lifecycle=${this.lifecycle} generation=${operation.generation}.`,
                    );
                } else {
                    return this.clearAfterAuthenticationChange(
                        operation,
                        'The Microsoft session is no longer available. Connect again to use Azure.',
                    );
                }
            } catch {
                if (!this.isCurrent(operation)) {
                    return this.transferOrReconcile(operation);
                }
                if (preserve) {
                    this.deps.log(
                        `Azure deferred one inconclusive self-session check at lifecycle=${this.lifecycle} generation=${operation.generation}.`,
                    );
                } else {
                    return this.clearAfterAuthenticationChange(
                        operation,
                        'The Microsoft session could not be revalidated. Connect again to use Azure.',
                    );
                }
            } finally {
                if (this.isCurrent(operation)) {
                    this.active = undefined;
                }
            }
        }
        return this.currentState;
    }

    private clearAfterAuthenticationChange(
        operation: Operation,
        message: string,
    ): AzureConnectionState {
        if (!this.isCurrent(operation)) {
            return this.currentState;
        }
        this.active = undefined;
        this.session = undefined;
        this.pendingAuthenticationChange = false;
        this.preserveSessionOnce = undefined;
        this.tenantCache = undefined;
        return this.transition({
            phase: 'disconnected',
            identity: null,
            tenants: [],
            stale: false,
            errorKind: null,
            message,
        });
    }

    private fail(
        operation: Operation,
        kind: AzureConnectionState['errorKind'],
        message: string,
    ): AzureConnectionState {
        if (!this.isCurrent(operation)) {
            return this.currentState;
        }
        this.session = undefined;
        this.preserveSessionOnce = undefined;
        this.tenantCache = undefined;
        return this.transition({
            phase: 'error',
            identity: null,
            tenants: [],
            stale: false,
            errorKind: kind,
            message,
        });
    }

    private begin(kind: Operation['kind']): Operation {
        this.supersede();
        const operation: Operation = {
            generation: ++this.generation,
            lifecycle: this.lifecycle,
            kind,
            abort: new AbortController(),
        };
        this.active = operation;
        this.deps.log(
            `Azure ${kind} started at lifecycle=${operation.lifecycle} generation=${operation.generation}.`,
        );
        return operation;
    }

    private supersede(): void {
        if (this.active) {
            this.active.abort.abort();
            this.active = undefined;
        }
    }

    private isCurrent(operation: Operation): boolean {
        return (
            this.ownsGeneration(operation)
            && this.active?.generation === operation.generation
        );
    }

    private ownsGeneration(operation: Operation): boolean {
        return (
            !this.disposed
            && operation.lifecycle === this.lifecycle
            && operation.generation === this.generation
        );
    }

    private transferOrReconcile(operation: Operation): Promise<AzureConnectionState> {
        if (!this.disposed && operation.lifecycle === this.lifecycle && this.session) {
            this.pendingAuthenticationChange = true;
            if (!this.active) {
                return this.reconcile();
            }
        }
        return Promise.resolve(this.currentState);
    }

    private cacheTenants(
        accountId: string,
        tenants: AzureConnectionState['tenants'],
    ): void {
        this.tenantCache = {
            accountId,
            tenants: Object.freeze([...tenants]),
            expiresAt: this.now() + (this.deps.tenantCacheTtlMs ?? TENANT_CACHE_TTL_MS),
        };
    }

    private cachedTenants(accountId: string): AzureConnectionState['tenants'] | undefined {
        const cache = this.tenantCache;
        if (!cache || cache.accountId !== accountId || cache.expiresAt <= this.now()) {
            return undefined;
        }
        return cache.tenants;
    }

    private useCachedFallback(
        operation: Operation,
        session: AuthenticationSession,
        error: AzureConnectionError,
    ): boolean {
        if (
            error.kind !== 'temporary'
            && error.kind !== 'timeout'
            && error.kind !== 'rateLimited'
        ) {
            return false;
        }
        if (
            error.kind === 'temporary'
            && error.status !== undefined
            && error.status !== 500
            && error.status !== 502
            && error.status !== 503
            && error.status !== 504
        ) {
            return false;
        }
        const cached = this.cachedTenants(session.account.id);
        if (!cached || !this.isCurrent(operation)) {
            return false;
        }
        this.session = session;
        this.transition({
            phase: 'connected',
            identity: this.deps.authentication.identity(session),
            tenants: cached,
            stale: true,
            errorKind: error.kind,
            message:
                `${error.message} Showing the last in-memory tenant list; ` +
                'select Refresh to verify it.',
        });
        return true;
    }

    private logDuration(
        stage: 'authentication' | 'tenants',
        outcome: string,
        startedAt: number,
        operation: Operation,
    ): void {
        this.deps.log(
            `Azure ${stage} completed outcome=${outcome} durationMs=${Math.max(
                0,
                this.now() - startedAt,
            )} generation=${operation.generation}.`,
        );
    }

    private now(): number {
        return (this.deps.now ?? Date.now)();
    }

    private transition(state: AzureConnectionState): AzureConnectionState {
        this.currentState = Object.freeze({
            ...state,
            tenants: Object.freeze([...state.tenants]),
        });
        this.deps.log(
            `Azure phase=${state.phase} stale=${state.stale} tenantCount=${state.tenants.length} ` +
            `lifecycle=${this.lifecycle} generation=${this.generation}.`,
        );
        this.deps.publish(this.currentState);
        return this.currentState;
    }
}
