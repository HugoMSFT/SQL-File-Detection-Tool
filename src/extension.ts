/**
 * SQL File Detection Tool — VS Code extension entry point.
 *
 * The default runtime is entirely native. Activation registers commands and a
 * webview view provider; it does not create a virtual environment, install a
 * package, start a server, choose a port or launch a browser. The primary editor
 * panel renders bundled HTML, CSS and JavaScript, and all analysis runs in the
 * extension host through `src/native`.
 *
 * The Python package remains available as an optional, separately installed
 * command line and web application. Nothing here launches it, and no contributed
 * command reaches it.
 */

import * as vscode from 'vscode';

import { NativeUi, SIDEBAR_VIEW_ID } from './nativeView';
import { redact } from './util';

let output: vscode.OutputChannel | undefined;
let ui: NativeUi | undefined;

const LEGACY_AZURE_SECRET_KEY = 'sqlFileDetection.azure.credential';

async function withErrors(label: string, action: () => Promise<void>): Promise<void> {
    try {
        await action();
    } catch (err) {
        const message = redact(err instanceof Error ? err.message : String(err));
        output?.appendLine(`${label}: ${message}`);
        const choice = await vscode.window.showErrorMessage(
            `SQL File Detection Tool — ${label}: ${message}`,
            'Show Log',
        );
        if (choice === 'Show Log') {
            output?.show(true);
        }
    }
}

/** Resolve the target of a context-menu invocation to a local path. */
async function resolveTarget(
    resource: vscode.Uri | undefined,
): Promise<{ path: string; isDirectory: boolean } | undefined> {
    const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
        vscode.window.showWarningMessage(
            'SQL File Detection Tool: select a local file or folder first.',
        );
        return undefined;
    }
    if (uri.scheme !== 'file') {
        vscode.window.showWarningMessage(
            `SQL File Detection Tool: the "${uri.scheme}" scheme has no local file the native reader can open. Save a copy locally and analyse that.`,
        );
        return undefined;
    }
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        return {
            path: uri.fsPath,
            isDirectory: (stat.type & vscode.FileType.Directory) !== 0,
        };
    } catch {
        return { path: uri.fsPath, isDirectory: false };
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const activatedAtMs = Date.now();
    output = vscode.window.createOutputChannel('SQL File Detection Tool');
    void Promise.resolve(context.secrets.delete(LEGACY_AZURE_SECRET_KEY)).catch((error: unknown) => {
        output?.appendLine(
            `Could not remove the retired storage credential: ${redact(error)}`,
        );
    });
    const native = new NativeUi(context, output, activatedAtMs);
    ui = native;

    context.subscriptions.push(
        output,
        native,
        vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, native, {
            // The view is cheap to rebuild from the shared store, so there is
            // no reason to keep a hidden renderer alive.
            webviewOptions: { retainContextWhenHidden: false },
        }),
        vscode.commands.registerCommand('sqlFileDetectionTool.open', () =>
            withErrors('could not open', () => native.openDefault()),
        ),
        vscode.commands.registerCommand('sqlFileDetectionTool.openInEditor', () =>
            withErrors('could not open the editor panel', () => native.openPanel()),
        ),
        vscode.commands.registerCommand('sqlFileDetectionTool.analyzeCurrentFile', () =>
            withErrors('could not analyze the current file', () =>
                native.analyzeCurrentFile(),
            ),
        ),
        vscode.commands.registerCommand(
            'sqlFileDetectionTool.analyzeSelected',
            (resource?: vscode.Uri) =>
                withErrors('could not analyze the selection', async () => {
                    const target = await resolveTarget(resource);
                    if (target) {
                        await native.analyzePath(target.path, target.isDirectory);
                    }
                }),
        ),
    );

    output.appendLine(
        `SQL File Detection Tool activated natively in ${Math.round(
            Date.now() - activatedAtMs,
        )} ms. No Python interpreter, server or port is used.`,
    );
}

export function deactivate(): void {
    try {
        ui?.dispose();
    } finally {
        ui = undefined;
        output = undefined;
    }
}
