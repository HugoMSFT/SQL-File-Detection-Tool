/**
 * The VS Code surface of the native interface.
 *
 * Two webviews render the same {@link AppStateStore}: the primary editor panel
 * and an optional Activity Bar view. Because both subscribe to one store and
 * post one snapshot type, they cannot drift apart, and neither of them holds
 * state of its own.
 *
 * This module is the only place in the native path that imports `vscode`.
 * Everything below it — the controller, the Azure bridge, the HTTP guard, the
 * analysis core — is plain TypeScript reached through {@link UiHost}, which is
 * what lets the tests assert that opening and analysing never starts a process,
 * binds a port or looks for a Python interpreter.
 *
 * Revealing the Activity Bar entry opens the editor panel by default. Both
 * surfaces use a bundled HTML shell plus two bundled assets; the first analysis
 * happens only when the user asks for one.
 */

import * as vscode from 'vscode';

import { AppStateStore } from './appState';
import { NativeAzureBridge, type AuthEnvironment } from './azure/connection';
import { expiryFromJwt, tenantIdFromJwt } from './azureScopes';
import { redactAzure } from './azure/storageUrl';
import type { AzureAuthMode } from './protocol';
import { UiController } from './ui/controller';
import type { OpenDialogOptions, UiHost } from './ui/host';
import { buildWebviewHtml, createNonce } from './ui/webviewShell';
import { redact } from './util';

export const SIDEBAR_VIEW_ID = 'sqlFileDetectionTool.sidebar';
export const PANEL_VIEW_TYPE = 'sqlFileDetectionTool.panel';

const AUTH_PROVIDER = 'microsoft';
const DOWNLOAD_DIR = 'downloads';

/** File dialog filters, kept in step with the native reader's formats. */
const OPEN_FILTERS: Record<string, string[]> = {
    'Data files': [
        'csv',
        'tsv',
        'txt',
        'dat',
        'json',
        'jsonl',
        'ndjson',
        'parquet',
        'snappy',
        'orc',
        'rc',
    ],
};

function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
    return {
        enableScripts: true,
        enableCommandUris: false,
        enableForms: false,
        // The webview may only read from the extension's own media folder, so
        // even a bug in URI construction cannot expose a workspace file.
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    };
}

function renderHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    surface: 'sidebar' | 'panel',
): string {
    const media = vscode.Uri.joinPath(extensionUri, 'media', 'webview');
    return buildWebviewHtml({
        nonce: createNonce(),
        cspSource: webview.cspSource,
        scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js')).toString(),
        styleUri: webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css')).toString(),
        surface,
    });
}

/** {@link UiHost} implemented against the real editor. */
class VsCodeUiHost implements UiHost {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
        readonly azure: NativeAzureBridge,
        private readonly revealPanel: () => Promise<void>,
    ) {}

    get version(): string {
        const packaged = this.context.extension?.packageJSON as { version?: string } | undefined;
        return packaged?.version ?? '0.0.0';
    }

    workspaceFolders(): readonly string[] {
        return (vscode.workspace.workspaceFolders ?? [])
            .filter((folder) => folder.uri.scheme === 'file')
            .map((folder) => folder.uri.fsPath);
    }

    activeFilePath(): string | undefined {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.uri.scheme === 'file') {
            return editor.document.uri.fsPath;
        }
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        if (input && typeof input === 'object' && 'uri' in input) {
            const uri = (input as { uri?: vscode.Uri }).uri;
            if (uri?.scheme === 'file') {
                return uri.fsPath;
            }
        }
        return undefined;
    }

    /**
     * Explain why the active editor has no analysable path.
     *
     * The native reader needs a real file. A virtual or remote document has
     * none, so the UI says so rather than failing with something obscure.
     */
    activeFileLimitation(): string | undefined {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        const uri =
            vscode.window.activeTextEditor?.document.uri ??
            (input && typeof input === 'object' && 'uri' in input
                ? (input as { uri?: vscode.Uri }).uri
                : undefined);
        if (!uri) {
            return 'No file is open in the active editor.';
        }
        if (uri.scheme === 'file') {
            return undefined;
        }
        if (uri.scheme === 'untitled') {
            return 'This editor has not been saved yet. Save it to a file first.';
        }
        return (
            `The active editor uses the "${uri.scheme}" scheme, which has no local file for ` +
            'the native reader to open. Save or download a copy locally and analyse that.'
        );
    }

    async showOpenDialog(options: OpenDialogOptions): Promise<readonly string[] | undefined> {
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: !options.folders,
            canSelectFolders: options.folders,
            canSelectMany: options.many,
            openLabel: options.folders ? 'Analyze folder' : 'Analyze',
            title: options.title,
            filters: options.folders ? undefined : OPEN_FILTERS,
        });
        if (!picked || picked.length === 0) {
            return undefined;
        }
        const local = picked.filter((uri) => uri.scheme === 'file');
        if (local.length === 0) {
            this.showWarning(
                'Only files on the local filesystem can be analysed natively. Download a copy first.',
            );
            return undefined;
        }
        return local.map((uri) => uri.fsPath);
    }

    async copyToClipboard(text: string): Promise<void> {
        await vscode.env.clipboard.writeText(text);
    }

    async openUntitledDocument(content: string, languageId: string): Promise<void> {
        const document = await vscode.workspace.openTextDocument({ content, language: languageId });
        await vscode.window.showTextDocument(document, { preview: false });
    }

    async openExternal(url: string): Promise<boolean> {
        return vscode.env.openExternal(vscode.Uri.parse(url, true));
    }

    async saveTextFile(suggestedName: string, content: string): Promise<string | undefined> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const target = await vscode.window.showSaveDialog({
            title: 'Export generated SQL',
            defaultUri:
                folders.length > 0
                    ? vscode.Uri.joinPath(folders[0].uri, suggestedName)
                    : undefined,
            filters: { 'SQL script': ['sql'] },
        });
        if (!target) {
            return undefined;
        }
        await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
        const document = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(document, { preview: false });
        return target.fsPath;
    }

    showInformation(message: string): void {
        void vscode.window.showInformationMessage(`SQL File Detection Tool: ${message}`);
    }

    showWarning(message: string): void {
        void vscode.window.showWarningMessage(`SQL File Detection Tool: ${message}`);
    }

    showError(message: string): void {
        void vscode.window.showErrorMessage(`SQL File Detection Tool: ${message}`);
    }

    log(message: string): void {
        this.output.appendLine(redactAzure(message));
    }

    /** A directory inside the extension's own storage, created on demand. */
    async downloadDirectory(): Promise<string> {
        const directory = vscode.Uri.joinPath(this.context.globalStorageUri, DOWNLOAD_DIR);
        await vscode.workspace.fs.createDirectory(directory);
        return directory.fsPath;
    }

    async cleanupDownload(absolutePath: string): Promise<void> {
        try {
            await vscode.workspace.fs.delete(vscode.Uri.file(absolutePath), {
                recursive: true,
                useTrash: false,
            });
        } catch {
            /* a temp file that is already gone is the desired end state */
        }
    }

    getPreference<T>(key: string, fallback: T): T {
        return this.context.globalState.get<T>(`native.${key}`, fallback);
    }

    async setPreference(key: string, value: unknown): Promise<void> {
        await this.context.globalState.update(`native.${key}`, value);
    }

    async openPanel(): Promise<void> {
        await this.revealPanel();
    }

    now(): number {
        return Date.now();
    }
}

/** {@link AuthEnvironment} implemented against the real editor. */
function createAuthEnvironment(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): AuthEnvironment {
    return {
        async getSession(scopes, request) {
            const session = await vscode.authentication.getSession(
                AUTH_PROVIDER,
                scopes,
                request.interactive
                    ? {
                          createIfNone: {
                              detail:
                                  'SQL File Detection Tool needs delegated access to browse Azure Storage.',
                          },
                          clearSessionPreference: request.clearSessionPreference,
                          account: request.account,
                      }
                    : { silent: true, account: request.account },
            );
            if (!session) {
                return undefined;
            }
            return {
                accessToken: session.accessToken,
                expiresOnMs: expiryFromJwt(session.accessToken),
                tenantId: tenantIdFromJwt(session.accessToken),
                account: session.account
                    ? { id: session.account.id, label: session.account.label }
                    : undefined,
            };
        },
        async prompt(options) {
            return vscode.window.showInputBox({
                title: options.title,
                prompt: options.prompt,
                password: options.password,
                placeHolder: options.placeHolder,
                ignoreFocusOut: true,
            });
        },
        async confirm(message, yes, no) {
            const answer = await vscode.window.showInformationMessage(
                `SQL File Detection Tool: ${message}`,
                { modal: true },
                yes,
                no,
            );
            return answer === yes;
        },
        secrets: {
            get: (key) => Promise.resolve(context.secrets.get(key)),
            store: (key, value) => Promise.resolve(context.secrets.store(key, value)),
            delete: (key) => Promise.resolve(context.secrets.delete(key)),
        },
        log(message) {
            output.appendLine(redactAzure(message));
        },
        now: () => Date.now(),
        setTimer(callback, delayMs) {
            const handle = setTimeout(callback, delayMs);
            handle.unref?.();
            return {
                cancel: () => clearTimeout(handle),
            };
        },
    };
}

/** One webview bound to the shared store. */
class Surface implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        webview: vscode.Webview,
        extensionUri: vscode.Uri,
        surface: 'sidebar' | 'panel',
        store: AppStateStore,
        onMessage: (raw: unknown) => void,
    ) {
        webview.options = webviewOptions(extensionUri);
        webview.html = renderHtml(webview, extensionUri, surface);
        const unsubscribe = store.subscribe((snapshot) => {
            void webview.postMessage({ type: 'state', state: snapshot });
        });
        this.disposables.push(webview.onDidReceiveMessage(onMessage), {
            dispose: unsubscribe,
        });
    }

    dispose(): void {
        for (const disposable of this.disposables.splice(0)) {
            disposable.dispose();
        }
    }
}

/**
 * Owns the store, the controller, the Azure bridge and both webviews.
 *
 * Everything the extension entry point needs is a method here, so `activate`
 * stays a list of command registrations.
 */
export class NativeUi implements vscode.Disposable, vscode.WebviewViewProvider {
    readonly store: AppStateStore;
    readonly controller: UiController;
    readonly azure: NativeAzureBridge;

    private readonly host: VsCodeUiHost;
    private readonly disposables: vscode.Disposable[] = [];
    private viewSubscriptions: vscode.Disposable[] = [];
    private view: vscode.WebviewView | undefined;
    private viewSurface: Surface | undefined;
    private panel: vscode.WebviewPanel | undefined;
    private panelSurface: Surface | undefined;
    private panelOpenFromActivityBarPending = false;
    private firstRenderLogged = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
        /** Monotonic activation timestamp, for the first-render measurement. */
        private readonly activatedAtMs: number,
    ) {
        this.azure = new NativeAzureBridge(createAuthEnvironment(context, output));
        this.host = new VsCodeUiHost(context, output, this.azure, () => this.openPanel());
        this.store = new AppStateStore({
            version:
                (context.extension?.packageJSON as { version?: string } | undefined)?.version ??
                '0.0.0',
            workspaceFolders: this.host.workspaceFolders(),
            platform: vscode.workspace
                .getConfiguration('sqlFileDetectionTool')
                .get<string>('defaultPlatform', 'azure_sql_db') as never,
        });
        this.controller = new UiController(this.host, this.store);
        this.disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this.controller.refreshWorkspace();
            }),
        );
    }

    /** Restore a remembered Azure credential without blocking activation. */
    restoreAzure(): void {
        this.store.updateAzure({ busy: true, error: null });
        void this.azure
            .restore()
            .then((info) => {
                if (info.connected) {
                    this.store.updateAzure({
                        busy: false,
                        connected: true,
                        mode: info.mode,
                        identity: info.identity,
                        account: info.account,
                        tenantId: info.tenantId,
                        containers: info.container ? [info.container] : [],
                        container: info.container,
                        prefix: info.prefix,
                        canListSubscriptions: info.canListSubscriptions,
                    });
                    if (info.container) {
                        void this.controller.handle({
                            type: 'azureListBlobs',
                            container: info.container,
                            prefix: info.prefix,
                            continuation: '',
                        });
                    } else if (info.account) {
                        void this.controller.handle({ type: 'azureListContainers' });
                    }
                    return;
                }
                this.store.updateAzure({ busy: false });
            })
            .catch((error) => {
                this.host.log(`Could not restore Azure Storage access: ${redactAzure(error)}`);
                this.store.updateAzure({ busy: false });
            });
    }

    // -- WebviewViewProvider -------------------------------------------------

    async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
        this.disposeViewSubscriptions();
        this.view = view;
        this.viewSurface?.dispose();
        this.viewSurface = new Surface(
            view.webview,
            this.context.extensionUri,
            'sidebar',
            this.store,
            (raw) => this.onMessage(raw),
        );
        this.viewSubscriptions.push(
            view.onDidChangeVisibility(() => {
                if (view.visible) {
                    void this.openPanelFromActivityBar(view);
                }
            }),
            view.onDidDispose(() => {
                if (this.view === view) {
                    this.viewSurface?.dispose();
                    this.viewSurface = undefined;
                    this.view = undefined;
                }
                this.disposeViewSubscriptions();
            }),
        );
        if (view.visible) {
            await this.openPanelFromActivityBar(view);
        }
    }

    private usesEditorByDefault(): boolean {
        return (
            vscode.workspace
                .getConfiguration('sqlFileDetectionTool')
                .get<'editor' | 'sidebar'>('defaultView', 'editor') !== 'sidebar'
        );
    }

    /** Open the configured primary surface. */
    async openDefault(): Promise<void> {
        if (this.usesEditorByDefault()) {
            await this.openPanel();
            return;
        }
        await this.revealSidebar();
    }

    /** Focus the Activity Bar view when the user explicitly opts into it. */
    private async revealSidebar(): Promise<void> {
        if (this.view) {
            this.view.show?.(true);
            return;
        }
        await vscode.commands.executeCommand(`${SIDEBAR_VIEW_ID}.focus`);
    }

    /**
     * Treat the Activity Bar icon as an editor launcher by default.
     *
     * The registered view still renders so users who select the sidebar setting
     * retain the complete alternate surface. In editor mode, the panel is ready
     * before the primary sidebar is closed, avoiding an empty intermediate UI.
     */
    private async openPanelFromActivityBar(view: vscode.WebviewView): Promise<void> {
        if (
            !this.usesEditorByDefault() ||
            !view.visible ||
            this.view !== view ||
            this.panelOpenFromActivityBarPending
        ) {
            return;
        }
        this.panelOpenFromActivityBarPending = true;
        try {
            await this.openPanel();
        } catch (error) {
            const message = redact(error instanceof Error ? error.message : String(error));
            this.host.log(`Could not open the editor panel from the Activity Bar: ${message}`);
            this.host.showError(`Could not open the editor panel: ${message}`);
            return;
        } finally {
            this.panelOpenFromActivityBarPending = false;
        }

        if (this.view === view && view.visible) {
            try {
                await vscode.commands.executeCommand('workbench.action.closeSidebar');
            } catch (error) {
                this.host.log(
                    `Editor panel opened, but the sidebar could not close: ${redact(
                        error instanceof Error ? error.message : String(error),
                    )}`,
                );
            }
        }
    }

    async openPanel(): Promise<void> {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active, false);
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            PANEL_VIEW_TYPE,
            'SQL File Detection Tool',
            vscode.ViewColumn.Active,
            { ...webviewOptions(this.context.extensionUri), retainContextWhenHidden: true },
        );
        this.panelSurface = new Surface(
            this.panel.webview,
            this.context.extensionUri,
            'panel',
            this.store,
            (raw) => this.onMessage(raw),
        );
        this.panel.onDidDispose(() => {
            this.panelSurface?.dispose();
            this.panelSurface = undefined;
            this.panel = undefined;
        });
    }

    // -- commands ------------------------------------------------------------

    async analyzePath(target: string, isDirectory: boolean): Promise<void> {
        await this.openDefault();
        await this.controller.analyzePath(target, isDirectory);
    }

    async analyzeCurrentFile(): Promise<void> {
        await this.openDefault();
        await this.controller.handle({ type: 'analyzeCurrentFile' });
    }

    async connectAzure(mode: AzureAuthMode = 'vscode'): Promise<void> {
        await this.openDefault();
        await this.controller.handle({ type: 'setTab', tab: 'credential_setup' });
        await this.controller.handle({ type: 'azureConnect', mode });
    }

    async disconnectAzure(): Promise<void> {
        await this.controller.handle({ type: 'azureDisconnect' });
    }

    // -- plumbing ------------------------------------------------------------

    /**
     * Route one untrusted webview message.
     *
     * Validation lives in the controller so the sidebar and the panel cannot
     * diverge on what they accept; this only records the first render.
     */
    private onMessage(raw: unknown): void {
        if (
            !this.firstRenderLogged &&
            typeof raw === 'object' &&
            raw !== null &&
            (raw as { type?: unknown }).type === 'ready'
        ) {
            this.firstRenderLogged = true;
            this.output.appendLine(
                `Native interface rendered ${Math.round(
                    Date.now() - this.activatedAtMs,
                )} ms after activation.`,
            );
        }
        void this.controller.handle(raw);
    }

    dispose(): void {
        this.disposeViewSubscriptions();
        for (const disposable of this.disposables.splice(0)) {
            disposable.dispose();
        }
        this.viewSurface?.dispose();
        this.panelSurface?.dispose();
        this.panel?.dispose();
        this.azure.dispose();
        void this.controller.dispose();
        this.store.dispose();
    }

    private disposeViewSubscriptions(): void {
        for (const disposable of this.viewSubscriptions.splice(0)) {
            disposable.dispose();
        }
    }
}
