import type { AzureBrowserErrorKind, AzureConnectionErrorKind } from './types';

export class AzureConnectionError extends Error {
    constructor(
        readonly kind: AzureConnectionErrorKind,
        message: string,
        readonly status?: number,
        readonly retryAfterMs?: number,
    ) {
        super(message);
        this.name = 'AzureConnectionError';
    }
}

export function safeAzureError(error: unknown): AzureConnectionError {
    if (error instanceof AzureConnectionError) {
        return error;
    }
    return new AzureConnectionError(
        'temporary',
        'Azure could not be reached. Check your connection and retry.',
    );
}

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

export function classifyStorageError(error: unknown): AzureBrowserError {
    if (error instanceof AzureBrowserError) {
        return error;
    }
    if (isRecord(error)) {
        const statusCode =
            typeof error.statusCode === 'number'
                ? error.statusCode
                : typeof error.status === 'number'
                    ? error.status
                    : undefined;
        if (statusCode === 401 || statusCode === 403) {
            return new AzureBrowserError(
                'dataAccess',
                'This account is visible, but its containers are not. Account-level Storage Blob Data Reader is required for read-only browsing.',
                statusCode,
            );
        }
        if (
            statusCode === 408
            || statusCode === 429
            || (statusCode !== undefined && statusCode >= 500)
        ) {
            return new AzureBrowserError(
                'temporary',
                'Azure Storage temporarily could not list this location. Retry the request.',
                statusCode,
            );
        }
    }
    return new AzureBrowserError(
        'temporary',
        'Azure Storage could not list this location. Retry or choose another account.',
    );
}
