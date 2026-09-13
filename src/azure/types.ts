export type AzureConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'error';

export type AzureConnectionErrorKind =
    | 'signIn'
    | 'controlAccess'
    | 'rateLimited'
    | 'timeout'
    | 'cancelled'
    | 'temporary'
    | 'invalidResponse';

export interface AzureIdentity {
    readonly label: string;
}

export interface AzureTenant {
    readonly id: string;
    readonly label: string;
}

/**
 * Safe connection state shared with the webview.
 *
 * Access tokens and VS Code authentication-session identifiers deliberately
 * have no representation in this type.
 */
export interface AzureConnectionState {
    readonly phase: AzureConnectionPhase;
    readonly identity: AzureIdentity | null;
    readonly tenants: readonly AzureTenant[];
    readonly stale: boolean;
    readonly errorKind: AzureConnectionErrorKind | null;
    readonly message: string;
}

export const DISCONNECTED_AZURE_CONNECTION_STATE: AzureConnectionState = Object.freeze({
    phase: 'disconnected',
    identity: null,
    tenants: Object.freeze([]),
    stale: false,
    errorKind: null,
    message:
        'Connect with Microsoft to verify Azure access and list accessible directories (tenants).',
});

export interface AzureConnectionService {
    readonly state: AzureConnectionState;
    connect(): Promise<AzureConnectionState>;
    retry(): Promise<AzureConnectionState>;
    refresh(): Promise<AzureConnectionState>;
    disconnect(): AzureConnectionState;
    authenticationChanged(): Promise<AzureConnectionState>;
    dispose(): void;
}
