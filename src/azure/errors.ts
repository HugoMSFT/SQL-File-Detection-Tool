import type { AzureConnectionErrorKind } from './types';

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
