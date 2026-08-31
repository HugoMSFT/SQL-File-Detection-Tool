/**
 * Typed error taxonomy for the native analysis core.
 *
 * Callers (and, later, the WebviewView message layer) need to tell apart a
 * user-correctable problem such as "that path is outside the allowed root"
 * from a genuine internal failure, so every failure mode gets a stable `code`
 * rather than only a message string.
 */

/** Stable, machine-readable failure codes. */
export type NativeErrorCode =
    | 'path_outside_root'
    | 'path_not_found'
    | 'not_a_directory'
    | 'unsupported_format'
    | 'limit_exceeded'
    | 'malformed_input'
    | 'cancelled'
    | 'internal';

/** Base class for every error the native core raises deliberately. */
export class NativeAnalysisError extends Error {
    public readonly code: NativeErrorCode;
    public readonly detail?: string;

    constructor(code: NativeErrorCode, message: string, detail?: string) {
        super(message);
        this.name = 'NativeAnalysisError';
        this.code = code;
        this.detail = detail;
        // Restore the prototype chain across the TypeScript class downlevel so
        // `instanceof` keeps working for subclasses.
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** A path escaped, or resolved outside, the configured allowed root. */
export class PathContainmentError extends NativeAnalysisError {
    constructor(message: string, detail?: string) {
        super('path_outside_root', message, detail);
        this.name = 'PathContainmentError';
    }
}

/** A bounded parser refused to read further. */
export class LimitExceededError extends NativeAnalysisError {
    constructor(message: string, detail?: string) {
        super('limit_exceeded', message, detail);
        this.name = 'LimitExceededError';
    }
}

/** The caller cancelled the operation. */
export class CancellationError extends NativeAnalysisError {
    constructor(message = 'Operation cancelled') {
        super('cancelled', message);
        this.name = 'CancellationError';
    }
}

/** Return a human-readable message for any thrown value. */
export function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

/** Return the stable code for any thrown value. */
export function errorCode(error: unknown): NativeErrorCode {
    return error instanceof NativeAnalysisError ? error.code : 'internal';
}
