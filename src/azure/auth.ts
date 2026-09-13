import type { AzureIdentity } from './types';

export const MICROSOFT_PROVIDER_ID = 'microsoft';
export const ARM_SCOPE = 'https://management.azure.com/user_impersonation';
export const STORAGE_SCOPE = 'https://storage.azure.com/user_impersonation';
export const TENANT_SCOPE_PREFIX = 'VSCODE_TENANT:';

export interface AuthenticationAccount {
    readonly id: string;
    readonly label: string;
}

export interface AuthenticationSession {
    readonly id: string;
    readonly accessToken: string;
    readonly account: AuthenticationAccount;
}

export interface SessionOptions {
    readonly silent?: boolean;
    readonly createIfNone?: boolean;
    readonly account?: AuthenticationAccount;
}

export type GetSession = (
    providerId: typeof MICROSOFT_PROVIDER_ID,
    scopes: readonly string[],
    options: SessionOptions,
) => Promise<AuthenticationSession | undefined>;

export type GetAccounts = (
    providerId: typeof MICROSOFT_PROVIDER_ID,
) => Promise<readonly AuthenticationAccount[]>;

export interface AuthenticationResult {
    readonly session: AuthenticationSession | undefined;
    readonly source: 'silent' | 'interactive' | 'none';
}

export function authenticationScopes(tenantId?: string): readonly string[] {
    return tenantId ? [ARM_SCOPE, `${TENANT_SCOPE_PREFIX}${tenantId}`] : [ARM_SCOPE];
}

export function scopedAuthenticationScopes(
    resourceScope: typeof ARM_SCOPE | typeof STORAGE_SCOPE,
    tenantId?: string,
): readonly string[] {
    return tenantId ? [resourceScope, `${TENANT_SCOPE_PREFIX}${tenantId}`] : [resourceScope];
}

/**
 * Thin adapter over VS Code's built-in Microsoft provider.
 *
 * It cannot persist tokens because it has no storage dependency. Interactive
 * creation is reachable only when the caller explicitly permits it.
 */
export class MicrosoftAuthentication {
    constructor(
        private readonly getSession: GetSession,
        private readonly getAccountsImpl: GetAccounts = async () => [],
    ) {}

    async acquire(
        allowInteractive: boolean,
        account?: AuthenticationAccount,
        tenantId?: string,
    ): Promise<AuthenticationResult> {
        return this.acquireResource(ARM_SCOPE, allowInteractive, account, tenantId);
    }

    async acquireSession(
        resourceScope: typeof ARM_SCOPE | typeof STORAGE_SCOPE,
        tenantId: string | undefined,
        account: AuthenticationAccount | undefined,
        allowInteractive: boolean,
    ): Promise<AuthenticationSession | undefined> {
        return (
            await this.acquireResource(resourceScope, allowInteractive, account, tenantId)
        ).session;
    }

    private async acquireResource(
        resourceScope: typeof ARM_SCOPE | typeof STORAGE_SCOPE,
        allowInteractive: boolean,
        account?: AuthenticationAccount,
        tenantId?: string,
    ): Promise<AuthenticationResult> {
        const scopes = scopedAuthenticationScopes(resourceScope, tenantId);
        const silent = await this.getSession(MICROSOFT_PROVIDER_ID, scopes, {
            silent: true,
            ...(account ? { account } : {}),
        });
        if (silent) {
            return { session: silent, source: 'silent' };
        }
        if (!allowInteractive) {
            return { session: undefined, source: 'none' };
        }
        const interactive = await this.getSession(MICROSOFT_PROVIDER_ID, scopes, {
            createIfNone: true,
            ...(account ? { account } : {}),
        });
        return {
            session: interactive,
            source: interactive ? 'interactive' : 'none',
        };
    }

    getAccounts(): Promise<readonly AuthenticationAccount[]> {
        return this.getAccountsImpl(MICROSOFT_PROVIDER_ID);
    }

    identity(session: AuthenticationSession): AzureIdentity {
        return { label: session.account.label };
    }
}
