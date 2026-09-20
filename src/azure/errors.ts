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
        if (statusCode === 401) {
            return new AzureBrowserError(
                'storageConsent',
                'Azure Storage authorization expired or was not granted. Authorize Storage browsing again.',
                statusCode,
            );
        }
        if (statusCode === 403) {
            return new AzureBrowserError(
                'dataAccess',
                'This account is visible, but Azure Storage denied container listing. Assign Storage Blob Data Reader on this storage account or a parent scope; Owner and Contributor do not grant blob data access. If that role already exists, check the storage firewall or private endpoint. Role changes can take up to 10 minutes, then select Retry.',
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
