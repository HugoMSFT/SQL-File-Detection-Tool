/**
 * Azure scope constants and token helpers with no `vscode` dependency.
 */

/** Delegated scope for Azure Storage data-plane access. */
export const STORAGE_SCOPES = ['https://storage.azure.com/user_impersonation'];

/** Delegated scope for Azure Resource Manager (subscription enumeration). */
export const ARM_SCOPES = ['https://management.azure.com/user_impersonation'];

/** VS Code's Microsoft provider uses this pseudo-scope to select an Entra tenant. */
export const VSCODE_TENANT_SCOPE = 'VSCODE_TENANT:';

/** Assumed lifetime when the provider does not tell us one. */
export const ASSUMED_LIFETIME_MS = 55 * 60 * 1000;

/** Refresh this long before a token actually expires. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Read the `exp` claim from a JWT without verifying it.
 *
 * The value is only used to decide when to refresh; the backend independently
 * treats an unknown or past expiry as expired.
 */
export function expiryFromJwt(accessToken: string, now = Date.now()): number {
    const payload = jwtPayload(accessToken);
    if (payload && typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
        return payload.exp * 1000;
    }
    return now + ASSUMED_LIFETIME_MS;
}

/** Read the non-secret tenant id claim so subsequent resource tokens stay in one directory. */
export function tenantIdFromJwt(accessToken: string): string | undefined {
    const payload = jwtPayload(accessToken);
    return payload && typeof payload.tid === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.tid)
        ? payload.tid.toLowerCase()
        : undefined;
}

function jwtPayload(accessToken: string): { exp?: number; tid?: string } | undefined {
    const parts = String(accessToken).split('.');
    if (parts.length < 2) {
        return undefined;
    }
    try {
        return JSON.parse(
            Buffer.from(
                parts[1].replace(/-/g, '+').replace(/_/g, '/'),
                'base64',
            ).toString('utf8'),
        ) as { exp?: number; tid?: string };
    } catch {
        return undefined;
    }
}

/** Delay before the next refresh, floored so we never spin. */
export function refreshDelayMs(expiresOnMs: number, now = Date.now()): number {
    return Math.max(30000, expiresOnMs - now - REFRESH_SKEW_MS);
}
