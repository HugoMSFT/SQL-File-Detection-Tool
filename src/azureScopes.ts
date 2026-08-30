/**
 * Azure scope constants and token helpers with no `vscode` dependency.
 */

/** Delegated scope for Azure Storage data-plane access. */
export const STORAGE_SCOPES = ['https://storage.azure.com/user_impersonation'];

/** Delegated scope for Azure Resource Manager (subscription enumeration). */
export const ARM_SCOPES = ['https://management.azure.com/user_impersonation'];

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
    const parts = String(accessToken).split('.');
    if (parts.length < 2) {
        return now + ASSUMED_LIFETIME_MS;
    }
    try {
        const payload = JSON.parse(
            Buffer.from(
                parts[1].replace(/-/g, '+').replace(/_/g, '/'),
                'base64',
            ).toString('utf8'),
        ) as { exp?: number };
        if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
            return payload.exp * 1000;
        }
    } catch {
        /* fall through to the assumed lifetime */
    }
    return now + ASSUMED_LIFETIME_MS;
}

/** Delay before the next refresh, floored so we never spin. */
export function refreshDelayMs(expiresOnMs: number, now = Date.now()): number {
    return Math.max(30000, expiresOnMs - now - REFRESH_SKEW_MS);
}
