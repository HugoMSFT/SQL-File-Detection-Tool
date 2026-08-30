/**
 * Cancellation and progress plumbing.
 *
 * The shapes are intentionally structurally compatible with
 * `vscode.CancellationToken` and `vscode.Progress`, so callers inside the
 * extension host can pass VS Code objects straight through while unit tests
 * (and the CLI-ish parity harness) use the tiny implementations below. The
 * native core never imports `vscode` itself.
 */

import { CancellationError } from './errors';

/** Structural subset of `vscode.CancellationToken`. */
export interface CancellationToken {
    readonly isCancellationRequested: boolean;
}

/** A progress report emitted while a long analysis runs. */
export interface ProgressReport {
    message?: string;
    /** Fraction complete in `[0, 1]` when it can be estimated. */
    increment?: number;
}

/** Structural subset of `vscode.Progress<T>`. */
export interface ProgressReporter {
    report(value: ProgressReport): void;
}

/** A token that is never cancelled. */
export const NEVER_CANCELLED: CancellationToken = { isCancellationRequested: false };

/** Throw `CancellationError` when the caller has cancelled. */
export function throwIfCancelled(token?: CancellationToken): void {
    if (token?.isCancellationRequested) {
        throw new CancellationError();
    }
}

/**
 * A trivially controllable token source for tests and for callers that do not
 * already have a `vscode.CancellationTokenSource`.
 */
export class SimpleCancellationTokenSource {
    private cancelled = false;

    public readonly token: CancellationToken;

    constructor() {
        // The getter must observe this instance's mutable state, so it closes
        // over a reader function rather than capturing a snapshot.
        const isCancelled = (): boolean => this.cancelled;
        this.token = {
            get isCancellationRequested(): boolean {
                return isCancelled();
            },
        };
    }

    public cancel(): void {
        this.cancelled = true;
    }
}
