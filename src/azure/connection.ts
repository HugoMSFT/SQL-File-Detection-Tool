import {
    MicrosoftAuthentication,
    type AuthenticationSession,
} from './auth';
import { safeAzureError } from './errors';
import { AzureTenantClient } from './tenantClient';
import {
    DISCONNECTED_AZURE_CONNECTION_STATE,
    type AzureConnectionService,
    type AzureConnectionState,
} from './types';

interface Operation {
    readonly generation: number;
    readonly lifecycle: number;
    readonly kind: 'connect' | 'reconcile';
    readonly abort: AbortController;
    interactiveSessionId?: string;
}

export interface AzureConnectionDependencies {
    readonly authentication: MicrosoftAuthentication;
    readonly tenants: AzureTenantClient;
    readonly publish: (state: AzureConnectionState) => void;
    readonly log: (message: string) => void;
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
    private disposed = false;

    constructor(private readonly deps: AzureConnectionDependencies) {}

    get state(): AzureConnectionState {
        return this.currentState;
    }

    connect(): Promise<AzureConnectionState> {
        return this.startConnect();
    }

    retry(): Promise<AzureConnectionState> {
        return this.startConnect();
    }

    disconnect(): AzureConnectionState {
        this.lifecycle += 1;
        this.supersede();
        this.pendingAuthenticationChange = false;
        this.preserveSessionOnce = undefined;
        this.session = undefined;
        return this.transition(DISCONNECTED_AZURE_CONNECTION_STATE);
    }

    async authenticationChanged(): Promise<AzureConnectionState> {
        if (this.disposed || this.currentState.phase === 'disconnected') {
            this.pendingAuthenticationChange = false;
            return this.currentState;
        }
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
        this.session = undefined;
    }

    private async startConnect(): Promise<AzureConnectionState> {
        if (this.disposed) {
            return this.currentState;
        }
        const operation = this.begin('connect');
        this.session = undefined;
        this.preserveSessionOnce = undefined;
        this.transition({
            phase: 'connecting',
            identity: null,
            tenants: [],
            errorKind: null,
            message: 'Waiting for Microsoft authentication…',
        });
        try {
            const acquired = await this.deps.authentication.acquire(true);
            if (!this.isCurrent(operation)) {
                return this.currentState;
            }
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
            this.transition({
                phase: 'connecting',
                identity: this.deps.authentication.identity(acquired.session),
                tenants: [],
                errorKind: null,
                message: 'Microsoft sign-in succeeded. Checking Azure directories…',
            });
            const tenants = await this.deps.tenants.listTenants(
                acquired.session.accessToken,
                operation.abort.signal,
            );
            if (!this.isCurrent(operation)) {
                return this.currentState;
            }
            this.transition({
                phase: 'connected',
                identity: this.deps.authentication.identity(acquired.session),
                tenants,
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
        } catch (error) {
            if (this.isCurrent(operation)) {
                const safe = safeAzureError(error);
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
        return this.transition({
            phase: 'disconnected',
            identity: null,
            tenants: [],
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
        return this.transition({
            phase: 'error',
            identity: null,
            tenants: [],
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

    private transition(state: AzureConnectionState): AzureConnectionState {
        this.currentState = Object.freeze({
            ...state,
            tenants: Object.freeze([...state.tenants]),
        });
        const account = this.session?.account.id ?? 'none';
        this.deps.log(
            `Azure phase=${state.phase} lifecycle=${this.lifecycle} generation=${this.generation} account=${account}.`,
        );
        this.deps.publish(this.currentState);
        return this.currentState;
    }
}
