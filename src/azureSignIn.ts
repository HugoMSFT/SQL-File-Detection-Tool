/**
 * Azure sign-in bridge.
 *
 * Tokens are obtained from VS Code's built-in Microsoft authentication
 * provider, held only in memory, and handed to the loopback backend through a
 * control endpoint authenticated with the per-process control token. They are
 * never written to settings, files, logs, URLs or command arguments.
 */

import * as vscode from 'vscode';

import { ARM_SCOPES, STORAGE_SCOPES, expiryFromJwt, refreshDelayMs } from './azureScopes';
import { BackendManager } from './backend';
import { redact } from './util';

const PROVIDER = 'microsoft';

interface ParsedToken {
    accessToken: string;
    expiresOnMs: number;
    account?: string;
}

export class AzureSignIn implements vscode.Disposable {
    private timer: NodeJS.Timeout | undefined;
    private signedIn = false;

    constructor(
        private readonly backend: BackendManager,
        private readonly output: vscode.OutputChannel,
    ) {}

    get isSignedIn(): boolean {
        return this.signedIn;
    }

    /** Sign in interactively and push the resulting tokens to the backend. */
    async signIn(): Promise<void> {
        const storage = await this.getSession(STORAGE_SCOPES, true);
        if (!storage) {
            throw new Error('Azure sign-in was cancelled.');
        }
        // ARM is optional: without it the subscription picker is hidden, but
        // browsing a known account by name still works.
        const arm = await this.getSession(ARM_SCOPES, false).catch(() => undefined);
        await this.push(storage, arm);
        this.signedIn = true;
        this.scheduleRefresh(storage, arm);
        this.output.appendLine(
            `Signed in to Azure as ${storage.account ?? 'the current Microsoft account'}.`,
        );
    }

    /** Clear the tokens held by the backend. */
    async signOut(): Promise<void> {
        this.cancelRefresh();
        const wasSignedIn = this.signedIn;
        this.signedIn = false;
        if (!this.backend.running) {
            return;
        }
        try {
            await this.backend.control('azure/signout', {});
            if (wasSignedIn) {
                this.output.appendLine('Azure tokens cleared from the backend.');
            }
        } catch (err) {
            this.output.appendLine(
                `Could not clear Azure tokens: ${redact(
                    err instanceof Error ? err.message : err,
                )}`,
            );
        }
    }

    private async getSession(
        scopes: string[],
        interactive: boolean,
    ): Promise<ParsedToken | undefined> {
        const session = await vscode.authentication.getSession(
            PROVIDER,
            scopes,
            interactive ? { createIfNone: true } : { silent: true },
        );
        if (!session) {
            return undefined;
        }
        return {
            accessToken: session.accessToken,
            expiresOnMs: expiryFromJwt(session.accessToken),
            account: session.account?.label,
        };
    }

    private async push(storage: ParsedToken, arm?: ParsedToken): Promise<void> {
        await this.backend.control('azure/token', {
            storage_token: storage.accessToken,
            storage_expires_on: Math.floor(storage.expiresOnMs / 1000),
            arm_token: arm?.accessToken,
            arm_expires_on: arm ? Math.floor(arm.expiresOnMs / 1000) : undefined,
            identity: storage.account,
        });
    }

    private cancelRefresh(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    /** Re-acquire and re-send tokens shortly before the current ones expire. */
    private scheduleRefresh(storage: ParsedToken, arm?: ParsedToken): void {
        this.cancelRefresh();
        const soonest = Math.min(
            storage.expiresOnMs,
            arm ? arm.expiresOnMs : Number.POSITIVE_INFINITY,
        );
        this.timer = setTimeout(() => {
            void this.refresh();
        }, refreshDelayMs(soonest));
        this.timer.unref?.();
    }

    private async refresh(): Promise<void> {
        if (!this.signedIn || !this.backend.running) {
            return;
        }
        try {
            const storage = await this.getSession(STORAGE_SCOPES, false);
            if (!storage) {
                this.output.appendLine('The Azure session is gone; signing out.');
                await this.signOut();
                return;
            }
            const arm = await this.getSession(ARM_SCOPES, false).catch(() => undefined);
            await this.push(storage, arm);
            this.scheduleRefresh(storage, arm);
            this.output.appendLine('Refreshed the Azure access token.');
        } catch (err) {
            this.output.appendLine(
                `Azure token refresh failed: ${redact(
                    err instanceof Error ? err.message : err,
                )}`,
            );
        }
    }

    dispose(): void {
        this.cancelRefresh();
        this.signedIn = false;
    }
}
