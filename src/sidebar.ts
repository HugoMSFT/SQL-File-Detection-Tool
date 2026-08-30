/**
 * Activity Bar sidebar for the SQL File Detection Tool.
 *
 * The sidebar is deliberately small: it reports backend state and offers the
 * handful of actions that make sense outside the full interface. Revealing the
 * container is what starts the backend and opens the tool — the extension never
 * launches a process just because VS Code started.
 */

import * as vscode from 'vscode';

import { BackendManager, BackendState } from './backend';
import {
    SIDEBAR_COMMAND_MAP,
    SidebarModel,
    buildSidebarHtml,
    createNonce,
    parseSidebarMessage,
    shouldAutoOpen,
} from './webviewHtml';
import { redact } from './util';

export const SIDEBAR_VIEW_ID = 'sqlFileDetectionTool.sidebar';

export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private view: vscode.WebviewView | undefined;
    private detail = 'Select Open Tool to start the local backend.';
    private readonly disposables: vscode.Disposable[] = [];
    private viewSubscriptions: vscode.Disposable[] = [];
    private autoOpenPending = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly backend: BackendManager,
        private readonly openTool: () => Promise<void>,
        private readonly output: vscode.OutputChannel,
        /**
         * Milliseconds since the *window* opened, not since this extension
         * activated. Activation is triggered by the reveal itself, so an
         * activation-relative clock would read ~0 for a genuine first click and
         * suppress it. The extension host process starts with the window, so
         * its uptime distinguishes a restored layout from a deliberate click.
         */
        private readonly windowUptimeMs: () => number = () => process.uptime() * 1000,
        /** Lets auto-open skip a backend whose interface is already open. */
        private readonly isUiOpen: (host: string, port: number) => boolean = () => false,
    ) {
        this.disposables.push(this.backend.onDidChangeState((state) => this.onState(state)));
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            // The sidebar loads no local resources; keeping the roots empty
            // means a stray URL cannot reach into the extension directory.
            localResourceRoots: [],
        };
        this.render();

        // VS Code re-resolves the view whenever it recreates it (the container
        // is hidden, collapsed or moved). Per-view subscriptions therefore live
        // in their own list that is torn down with the view they belong to,
        // instead of growing without bound for the extension's lifetime.
        this.disposeViewSubscriptions();
        this.viewSubscriptions.push(
            webviewView.webview.onDidReceiveMessage((message) => {
                const command = parseSidebarMessage(message);
                if (!command) {
                    // Anything not on the allowlist is dropped, never dispatched.
                    this.output.appendLine('Ignored an unrecognised sidebar message.');
                    return;
                }
                void vscode.commands.executeCommand(SIDEBAR_COMMAND_MAP[command]);
            }),
            webviewView.onDidChangeVisibility(() => {
                this.render();
                // Reaching this handler means the view was already resolved, so
                // a transition to visible can only be the user selecting the
                // container. Those are never subject to the startup grace.
                this.maybeAutoOpen({ userDriven: true });
            }),
            webviewView.onDidDispose(() => {
                if (this.view === webviewView) {
                    this.view = undefined;
                }
                this.disposeViewSubscriptions();
            }),
        );

        this.maybeAutoOpen({ userDriven: false });
    }

    private disposeViewSubscriptions(): void {
        for (const disposable of this.viewSubscriptions.splice(0)) {
            disposable.dispose();
        }
    }

    /**
     * Open the tool when the user deliberately revealed the container.
     *
     * The first resolve of a window is ambiguous — VS Code restores the
     * previously selected container — so it renders the sidebar but starts
     * nothing unless the window has been up long enough to rule that out.
     */
    private maybeAutoOpen(options: { userDriven: boolean }): void {
        const config = vscode.workspace.getConfiguration('sqlFileDetectionTool');
        const decision = shouldAutoOpen({
            enabled: config.get<boolean>('openOnActivityBarClick', true),
            visible: this.view?.visible === true,
            msSinceActivation: this.windowUptimeMs(),
            userDriven: options.userDriven,
            windowFocused: this.isWindowFocused(),
        });
        if (!decision) {
            return;
        }
        // An open is already on its way. Without this, toggling the container
        // during a cold start (which can take tens of seconds) queues one more
        // open per toggle, and they all run once the backend is ready.
        if (this.autoOpenPending || this.backend.currentState === 'starting') {
            return;
        }
        // `openExternal` cannot focus an existing OS browser tab, so a passive
        // reveal must not re-open one. Simple Browser reuses its single panel
        // and the user may well have closed it, so that path always re-opens.
        const usesExternalBrowser =
            config.get<string>('openIn', 'simpleBrowser') === 'externalBrowser';
        const info = this.backend.current;
        if (usesExternalBrowser && info && this.isUiOpen(info.host, info.port)) {
            return;
        }
        // openTool reuses a running backend and focuses the existing tab, so
        // repeated clicks never produce a second process or a second tab.
        this.autoOpenPending = true;
        this.openTool()
            .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                this.output.appendLine(`Could not open the tool: ${redact(message)}`);
                // onState already renders the failure, but a pre-start failure
                // has no state transition, so make sure the sidebar says something.
                this.setDetail('The backend could not start. Check the output log, then retry.');
            })
            .finally(() => {
                this.autoOpenPending = false;
            });
    }

    private isWindowFocused(): boolean {
        // `window.state` is unavailable in some hosts; unknown means "focused"
        // so this signal can never block a genuine click on its own.
        return vscode.window.state?.focused !== false;
    }

    private onState(state: BackendState): void {
        if (state === 'running') {
            this.detail = 'The interface is open in an editor tab.';
        } else if (state === 'starting') {
            this.detail = 'Preparing the Python environment and starting the backend.';
        } else if (state === 'failed') {
            this.detail =
                'The backend could not start. Check the output log, then retry.';
        } else {
            this.detail = 'Select Open Tool to start the local backend.';
        }
        this.render();
    }

    /** Replace the detail line. Callers must never pass secret-bearing text. */
    setDetail(detail: string): void {
        this.detail = detail;
        this.render();
    }

    private model(): SidebarModel {
        const platform = vscode.workspace
            .getConfiguration('sqlFileDetectionTool')
            .get<string>('defaultPlatform', 'azure_sql_db');
        return {
            state: this.backend.currentState,
            detail: this.detail,
            version: String(this.context.extension?.packageJSON?.version ?? ''),
            platformLabel:
                platform === 'azure_sql_db' ? 'Azure SQL Database' : platform,
        };
    }

    private render(): void {
        if (!this.view) {
            return;
        }
        const nonce = createNonce();
        this.view.webview.html = buildSidebarHtml(
            this.model(),
            nonce,
            this.view.webview.cspSource,
        );
    }

    dispose(): void {
        this.disposeViewSubscriptions();
        for (const disposable of this.disposables.splice(0)) {
            disposable.dispose();
        }
        this.view = undefined;
    }
}
