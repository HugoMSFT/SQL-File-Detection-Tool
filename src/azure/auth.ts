import type { AzureIdentity } from './types';

export const ARM_SCOPE = 'https://management.azure.com/user_impersonation';
export const STORAGE_SCOPE = 'https://storage.azure.com/user_impersonation';
export const TENANT_SCOPE_PREFIX = 'VSCODE_TENANT:';

export interface AuthenticationAccount {
    readonly id: string;
    readonly label: string;
}

export interface AuthenticationSession {
    readonly accessToken: string;
    readonly account: AuthenticationAccount;
}

export interface SessionOptions {
    readonly silent?: boolean;
    readonly createIfNone?: boolean | { readonly detail: string };
    readonly account?: AuthenticationAccount;
}

export type GetSession = (
    providerId: 'microsoft',
    scopes: readonly string[],
    options: SessionOptions,
) => Promise<AuthenticationSession | undefined>;

export function authenticationScopes(resourceScope: string, tenantId?: string): readonly string[] {
    return tenantId ? [resourceScope, `${TENANT_SCOPE_PREFIX}${tenantId}`] : [resourceScope];
}

export class MicrosoftAuthentication {
    constructor(private readonly getSession: GetSession) {}

    async acquire(
        resourceScope: typeof ARM_SCOPE | typeof STORAGE_SCOPE,
        tenantId: string | undefined,
        account: AuthenticationAccount | undefined,
        allowInteractive: boolean,
    ): Promise<AuthenticationSession | undefined> {
        const scopes = authenticationScopes(resourceScope, tenantId);
        const silent = await this.getSession('microsoft', scopes, {
            silent: true,
            ...(account ? { account } : {}),
        });
        if (silent || !allowInteractive) {
            return silent;
        }
        return this.getSession('microsoft', scopes, {
            createIfNone: {
                detail:
                    resourceScope === ARM_SCOPE
                        ? 'Read Azure tenants, subscriptions, and Storage account metadata.'
                        : 'Read containers and blobs you already have permission to access.',
            },
            ...(account ? { account } : {}),
        });
    }

    identity(session: AuthenticationSession): AzureIdentity {
        return { id: session.account.id, label: session.account.label };
    }
}

