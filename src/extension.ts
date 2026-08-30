/**
 * SQL File Detection Tool — VS Code extension entry point.
 *
 * Starts and supervises the bundled Python Flask backend on a loopback port,
 * opens the UI, and brokers Azure sign-in through VS Code's Microsoft
 * authentication provider.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';

import { AzureSignIn } from './azureSignIn';
import { BackendManager } from './backend';
import { PythonEnvironment } from './pythonEnv';
import { SIDEBAR_VIEW_ID, SidebarProvider } from './sidebar';
import {
    buildAppUrl,
    createSerialQueue,
    isSupportedFile,
    normalizePlatform,
    redact,
} from './util';

let output: vscode.OutputChannel;
let backend: BackendManager;
let azure: AzureSignIn;
let sidebar: SidebarProvider | undefined;

interface OpenOptions {
    path?: string;
    folder?: string;
    azure?: boolean;
}

/**
 * Serialises concurrent open requests.
 *
 * Two quick clicks on the Activity Bar icon must not race into two backend
 * starts or two Simple Browser tabs. Requests are queued rather than collapsed:
 * each caller carries its own target (a file, a folder, or the Azure explorer),
 * so returning an earlier caller's promise would silently drop the newer
 * request's path and the analysis-root hint that goes with it.
 */
let openQueue = createSerialQueue();

async function openUi(options: OpenOptions = {}): Promise<void> {
    return openQueue(() => doOpenUi(options));
}

async function doOpenUi(options: OpenOptions): Promise<void> {
    const info = await backend.ensureStarted({
        hint: options.path ?? options.folder,
        hintIsDirectory: !!options.folder,
    });
    const url = buildAppUrl({ host: info.host, port: info.port, ...options });
    // asExternalUri makes this work over Remote SSH, WSL and Codespaces by
    // establishing a port-forwarding tunnel where one is needed.
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(url));
    const openIn = vscode.workspace
        .getConfiguration('sqlFileDetectionTool')
        .get<string>('openIn', 'simpleBrowser');
    if (openIn === 'externalBrowser') {
        await vscode.env.openExternal(external);
        uiOpenedFor = `${info.host}:${info.port}`;
        return;
    }
    try {
        // Simple Browser keeps a single panel, so this navigates and focuses
        // the existing tab instead of opening another one.
        await vscode.commands.executeCommand('simpleBrowser.show', external.toString(true));
    } catch {
        await vscode.env.openExternal(external);
    }
    uiOpenedFor = `${info.host}:${info.port}`;
}

/**
 * Identifies the backend instance the interface was last opened against.
 *
 * Simple Browser reuses its single panel, but `openExternal` cannot focus an
 * existing OS browser tab. Recording which backend we already opened lets a
 * *passive* reveal skip re-opening and avoid piling up tabs; explicit commands
 * still open unconditionally.
 */
let uiOpenedFor: string | undefined;

export function isUiAlreadyOpenFor(host: string, port: number): boolean {
    return uiOpenedFor === `${host}:${port}`;
}

async function withErrors(label: string, action: () => Promise<void>): Promise<void> {
    try {
        await action();
    } catch (err) {
        const message = redact(err instanceof Error ? err.message : String(err));
        output.appendLine(`${label}: ${message}`);
        const choice = await vscode.window.showErrorMessage(
            `SQL File Detection Tool — ${label}: ${message}`,
            'Show Log',
        );
        if (choice === 'Show Log') {
            output.show(true);
        }
    }
}

function activeFilePath(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') {
        return editor.document.uri.fsPath;
    }
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (tab && typeof tab === 'object' && 'uri' in tab) {
        const uri = (tab as { uri: vscode.Uri }).uri;
        if (uri?.scheme === 'file') {
            return uri.fsPath;
        }
    }
    return undefined;
}

async function pickWorkspaceFolder(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        vscode.window.showWarningMessage(
            'SQL File Detection Tool: open a folder or workspace first.',
        );
        return undefined;
    }
    if (folders.length === 1) {
        return folders[0].uri.fsPath;
    }
    const picked = await vscode.window.showWorkspaceFolderPick();
    return picked?.uri.fsPath;
}

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel('SQL File Detection Tool');
    const statusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100,
    );
    const env = new PythonEnvironment(context, output);
    backend = new BackendManager(context, output, env, statusBar);
    context.subscriptions.push(
        // A backend that is no longer running cannot have a live interface, and
        // the OS may hand the same port to its replacement, so drop the record
        // rather than let it wrongly suppress a later open.
        backend.onDidChangeState((state) => {
            if (state !== 'running') {
                uiOpenedFor = undefined;
            }
        }),
    );
    azure = new AzureSignIn(backend, output);
    sidebar = new SidebarProvider(
        context,
        backend,
        // Go through the command rather than calling openUi directly, so a
        // failure surfaces the same redacted notification and "Show Log"
        // action the user gets from every other entry point.
        () =>
            Promise.resolve(
                vscode.commands.executeCommand('sqlFileDetectionTool.open'),
            ).then(() => undefined),
        output,
        () => process.uptime() * 1000,
        isUiAlreadyOpenFor,
    );

    const platform = normalizePlatform(
        vscode.workspace
            .getConfiguration('sqlFileDetectionTool')
            .get<string>('defaultPlatform', 'azure_sql_db'),
    );
    output.appendLine(`SQL File Detection Tool activated. Default platform: ${platform}`);

    context.subscriptions.push(
        output,
        statusBar,
        backend,
        azure,
        sidebar,
        vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebar, {
            webviewOptions: { retainContextWhenHidden: false },
        }),
        vscode.commands.registerCommand('sqlFileDetectionTool.open', () =>
            withErrors('could not open', () => openUi()),
        ),
        vscode.commands.registerCommand('sqlFileDetectionTool.analyzeCurrentFile', () =>
            withErrors('could not analyze the current file', async () => {
                const target = activeFilePath();
                if (!target) {
                    vscode.window.showWarningMessage(
                        'SQL File Detection Tool: no file is open in the active editor.',
                    );
                    return;
                }
                if (!isSupportedFile(target)) {
                    const answer = await vscode.window.showWarningMessage(
                        `${target} is not a recognised data file. Analyze it anyway?`,
                        'Analyze',
                        'Cancel',
                    );
                    if (answer !== 'Analyze') {
                        return;
                    }
                }
                await openUi({ path: target });
            }),
        ),
        vscode.commands.registerCommand('sqlFileDetectionTool.analyzeWorkspaceFolder', () =>
            withErrors('could not analyze the workspace folder', async () => {
                const folder = await pickWorkspaceFolder();
                if (folder) {
                    await openUi({ folder });
                }
            }),
        ),
        vscode.commands.registerCommand(
            'sqlFileDetectionTool.analyzeSelected',
            (resource?: vscode.Uri) =>
                withErrors('could not analyze the selection', async () => {
                    const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
                    if (!uri || uri.scheme !== 'file') {
                        vscode.window.showWarningMessage(
                            'SQL File Detection Tool: select a local file or folder.',
                        );
                        return;
                    }
                    let isDirectory = false;
                    try {
                        isDirectory = (await fs.promises.stat(uri.fsPath)).isDirectory();
                    } catch {
                        isDirectory = false;
                    }
                    await openUi(
                        isDirectory ? { folder: uri.fsPath } : { path: uri.fsPath },
                    );
                }),
        ),
        vscode.commands.registerCommand('sqlFileDetectionTool.connectAzureStorage', () =>
            withErrors('Azure sign-in failed', async () => {
                await backend.ensureStarted();
                await azure.signIn();
                vscode.window.showInformationMessage(
                    'SQL File Detection Tool: signed in to Azure. Use the Azure Storage button in the app to browse.',
                );
                await openUi({ azure: true });
            }),
        ),
        vscode.commands.registerCommand('sqlFileDetectionTool.disconnectAzureStorage', () =>
            withErrors('Azure sign-out failed', async () => {
                await azure.signOut();
                vscode.window.showInformationMessage(
                    'SQL File Detection Tool: Azure tokens cleared.',
                );
            }),
        ),
        vscode.commands.registerCommand('sqlFileDetectionTool.stopBackend', () =>
            withErrors('could not stop the backend', async () => {
                await azure.signOut().catch(() => undefined);
                backend.stop();
                vscode.window.showInformationMessage(
                    'SQL File Detection Tool: backend stopped.',
                );
            }),
        ),
        vscode.commands.registerCommand('sqlFileDetectionTool.setupBackend', () =>
            withErrors('backend setup failed', async () => {
                backend.stop();
                await env.create(true);
                vscode.window.showInformationMessage(
                    'SQL File Detection Tool: the Python backend environment is ready.',
                );
            }),
        ),
    );
}

export function deactivate(): void {
    try {
        azure?.dispose();
    } finally {
        try {
            sidebar?.dispose();
        } finally {
            sidebar = undefined;
            openQueue = createSerialQueue();
            uiOpenedFor = undefined;
            backend?.stop();
        }
    }
}
