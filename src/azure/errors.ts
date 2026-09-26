import type { AzureBrowserErrorKind } from './types';

export class AzureBrowserError extends Error {
    constructor(
        readonly kind: AzureBrowserErrorKind,
        message: string,
        readonly statusCode?: number,
    ) {
        super(message);
        this.name = 'AzureBrowserError';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface StorageErrorContext {
    readonly operation: 'containers' | 'blobs';
    readonly access: 'authenticated' | 'public';
}

export function classifyStorageError(
    error: unknown,
    context: StorageErrorContext = { operation: 'containers', access: 'authenticated' },
): AzureBrowserError {
    const operation = context.operation === 'containers' ? 'Container listing' : 'Blob listing';
    if (error instanceof AzureBrowserError) {
        return error.kind === 'timeout'
            ? new AzureBrowserError('timeout', `${operation}: The request timed out. Check connectivity and Retry.`, error.statusCode)
            : error;
    }
    const anonymous = context.access === 'public';
    const publicGuidance =
        'Listing requires Container-level public access; Blob-level access only permits reading known blobs. No sign-in was attempted.';
    if (isRecord(error)) {
        const statusCode =
            typeof error.statusCode === 'number'
                ? error.statusCode
                : typeof error.status === 'number'
                    ? error.status
                    : undefined;
        const details = isRecord(error.details) ? error.details : undefined;
        const code = typeof details?.errorCode === 'string' ? details.errorCode : error.code;
        const cause = isRecord(error.cause) ? error.cause : undefined;
        const transportCode = cause?.code ?? error.code;
        const failure = (kind: AzureBrowserErrorKind, message: string): AzureBrowserError =>
            new AzureBrowserError(kind, `${operation}: ${message}`, statusCode);

        if (code === 'AccountIsDisabled') {
            return failure(
                'accountDisabled',
                'The storage account is disabled. Ask its administrator to check the account and subscription status; repeated sign-in will not fix this.',
            );
        }
        if (statusCode === 401) {
            return failure(
                anonymous ? 'publicAccess' : 'storageConsent',
                anonymous
                    ? `Azure requires authorization for this container. ${publicGuidance}`
                    : 'Azure Storage authorization expired or was not granted. Authorize Storage browsing again.',
            );
        }
        if (code === 'PublicAccessNotPermitted') {
            return failure(
                'publicAccess',
                'The storage account does not permit anonymous access. Use an authorized source instead; signing in is a separate choice.',
            );
        }
        if (code === 'AuthenticationFailed') {
            return failure(
                anonymous ? 'publicAccess' : 'storageAuthentication',
                anonymous
                    ? `Azure did not accept anonymous access. ${publicGuidance}`
                    : 'Azure did not accept the Microsoft Storage credential. Retry with a current session; if this persists, reconnect your Microsoft account.',
            );
        }
        if (code === 'AuthorizationPermissionMismatch') {
            return failure(
                anonymous ? 'publicAccess' : 'dataAccess',
                anonymous
                    ? `Azure denied anonymous listing. ${publicGuidance}`
                    : 'The Microsoft identity lacks permission at this scope. Check Storage Blob Data Reader '
                        + (context.operation === 'containers'
                            ? 'on the storage account or a parent scope'
                            : 'on this container, storage account, or a parent scope')
                        + '; Owner and Contributor do not grant blob data access. Allow role changes to propagate, then Retry.',
            );
        }
        if (
            code === 'AuthorizationFailure'
            || code === 'AuthorizationSourceIPMismatch'
            || code === 'NetworkSecurityPerimeterAccessDenied'
        ) {
            return failure(
                'network',
                'Azure rejected access. Check the storage firewall, public network access, network security perimeter, and private endpoint/VPN routing and DNS. '
                    + (anonymous
                        ? publicGuidance
                        : 'If network access is allowed, verify the identity and data-access policy.'),
            );
        }
        if (code === 'ContainerNotFound' || code === 'ResourceNotFound' || statusCode === 404) {
            return failure(
                'notFound',
                'The account or container was not found or is not visible. Verify the known endpoint and container name.'
                    + (anonymous ? ' A private container can hide its existence. ' + publicGuidance : ''),
            );
        }
        if (statusCode === 403) {
            return failure(
                anonymous ? 'publicAccess' : 'dataAccess',
                'Azure denied the request. This may be a permission or network policy restriction; the response does not identify which. '
                    + (anonymous
                        ? publicGuidance
                        : 'Check data-access scope and the storage firewall/private endpoint before retrying.'),
            );
        }
        if (statusCode === 429 || code === 'ServerBusy') {
            return failure('rateLimited', 'Azure is rate limiting requests or is busy. Wait briefly, then Retry.');
        }
        if (
            statusCode === 408
            || statusCode === 504
            || code === 'OperationTimedOut'
            || transportCode === 'ETIMEDOUT'
            || transportCode === 'ESOCKETTIMEDOUT'
        ) {
            return failure('timeout', 'The request timed out. Check connectivity and Retry.');
        }
        if (transportCode === 'ENOTFOUND' || transportCode === 'EAI_AGAIN') {
            return failure(
                'network',
                'The Azure Blob endpoint could not be resolved. Verify the account endpoint, DNS, and private endpoint/VPN configuration.',
            );
        }
        if (
            transportCode === 'ECONNREFUSED'
            || transportCode === 'ECONNRESET'
            || transportCode === 'EHOSTUNREACH'
            || transportCode === 'ENETUNREACH'
            || transportCode === 'REQUEST_SEND_ERROR'
        ) {
            return failure(
                'network',
                'The Azure Blob endpoint could not be reached. Check connectivity, the storage firewall, and private endpoint/VPN routing, then Retry.',
            );
        }
    }
    return new AzureBrowserError(
        'temporary',
        `${operation}: Azure Storage could not complete the request. Retry or choose another location.`,
    );
}
