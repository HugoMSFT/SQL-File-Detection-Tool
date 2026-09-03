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
                'This account is visible, but its containers are not. Account-level Storage Blob Data Reader is required for Phase 1 browsing.',
                statusCode,
            );
        }
        if (statusCode === 408 || statusCode === 429 || (statusCode !== undefined && statusCode >= 500)) {
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
