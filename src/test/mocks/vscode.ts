/**
 * A deliberately small stand-in for the `vscode` module.
 *
 * It exists so activation and the native webview provider can be exercised in a
 * plain Node test process. Everything it implements is inert: no process is
 * started, no file is written outside a temp directory, and no network call is
 * made. Anything the extension calls that is not modelled here throws, which is
 * exactly what we want — a silent no-op would hide a regression.
 */

import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface MockWebview {
    html: string;
    options: unknown;
    cspSource: string;
    posted: unknown[];
    postMessage(message: unknown): Promise<boolean>;
    asWebviewUri(uri: { fsPath: string; path: string }): { toString(): string };
    onDidReceiveMessage(handler: (message: unknown) => unknown): { dispose(): void };
}

export interface MockView {
    readonly webview: MockWebview;
    visible: boolean;
    title?: string;
    description?: string;
    show(preserveFocus?: boolean): void;
    onDidDispose(handler: () => void): { dispose(): void };
    onDidChangeVisibility(handler: () => void): { dispose(): void };
    /** Deliver a message as if the renderer had posted it. */
    receive(message: unknown): Promise<void>;
    dispose(): void;
}

export interface MockState {
    readonly context: Record<string, unknown>;
    readonly commands: Map<string, (...args: unknown[]) => unknown>;
    readonly views: Map<string, unknown>;
    readonly messages: string[];
    readonly secrets: Map<string, string>;
    readonly globalState: Map<string, unknown>;
    readonly workspaceState: Map<string, unknown>;
    activeEditorPath: string | undefined;
    workspaceRoot: string | undefined;
    makeView(): MockView;
}

function disposable(): { dispose(): void } {
    return { dispose: (): void => undefined };
}

class MockUri {
    private constructor(
        readonly scheme: string,
        readonly fsPath: string,
    ) {}

    static file(target: string): MockUri {
        return new MockUri('file', target);
    }

    static joinPath(base: MockUri, ...segments: string[]): MockUri {
        return new MockUri(base.scheme, path.join(base.fsPath, ...segments));
    }

    get path(): string {
        return this.fsPath.replace(/\\/g, '/');
    }

    toString(): string {
        return `${this.scheme}://${this.path}`;
    }

    with(): MockUri {
        return this;
    }
}

export function createMockVscode(): { module: Record<string, unknown>; state: MockState } {
    const commands = new Map<string, (...args: unknown[]) => unknown>();
    const views = new Map<string, unknown>();
    const messages: string[] = [];
    const secrets = new Map<string, string>();
    const globalState = new Map<string, unknown>();
    const workspaceState = new Map<string, unknown>();
    const storage = path.join(os.tmpdir(), `sqlfdt-mock-${process.pid}`);
    const repoRoot = path.resolve(__dirname, '..', '..', '..');

    const state: MockState = {
        commands,
        views,
        messages,
        secrets,
        globalState,
        workspaceState,
        activeEditorPath: undefined,
        workspaceRoot: undefined,
        context: {
            subscriptions: [] as Array<{ dispose(): void }>,
            extensionUri: MockUri.file(repoRoot),
            extensionPath: repoRoot,
            globalStorageUri: MockUri.file(storage),
            storageUri: MockUri.file(storage),
            secrets: {
                get: async (key: string): Promise<string | undefined> => secrets.get(key),
                store: async (key: string, value: string): Promise<void> => {
                    secrets.set(key, value);
                },
                delete: async (key: string): Promise<void> => {
                    secrets.delete(key);
                },
                onDidChange: () => disposable(),
            },
            globalState: {
                get: <T>(key: string, fallback?: T): T | undefined =>
                    globalState.has(key) ? (globalState.get(key) as T) : fallback,
                update: async (key: string, value: unknown): Promise<void> => {
                    globalState.set(key, value);
                },
                keys: (): string[] => [...globalState.keys()],
                setKeysForSync: (): void => undefined,
            },
            workspaceState: {
                get: <T>(key: string, fallback?: T): T | undefined =>
                    workspaceState.has(key) ? (workspaceState.get(key) as T) : fallback,
                update: async (key: string, value: unknown): Promise<void> => {
                    workspaceState.set(key, value);
                },
                keys: (): string[] => [...workspaceState.keys()],
            },
        },
        makeView: (): MockView => {
            const handlers: Array<(message: unknown) => unknown> = [];
            const webview: MockWebview = {
                html: '',
                options: {},
                cspSource: 'vscode-webview://mock',
                posted: [],
                postMessage: async (message: unknown): Promise<boolean> => {
                    webview.posted.push(message);
                    return true;
                },
                asWebviewUri: (uri) => ({
                    toString: (): string => `https://mock.vscode-cdn.net${uri.path}`,
                }),
                onDidReceiveMessage: (handler) => {
                    handlers.push(handler);
                    return disposable();
                },
            };
            return {
                webview,
                visible: true,
                show: (): void => undefined,
                onDidDispose: () => disposable(),
                onDidChangeVisibility: () => disposable(),
                receive: async (message: unknown): Promise<void> => {
                    for (const handler of handlers) {
                        await handler(message);
                    }
                },
                dispose: (): void => undefined,
            };
        },
    };

    const fsApi = {
        stat: async (uri: MockUri): Promise<{ type: number; size: number }> => {
            const stat = nodeFs.statSync(uri.fsPath);
            return { type: stat.isDirectory() ? 2 : 1, size: stat.size };
        },
        readFile: async (uri: MockUri): Promise<Uint8Array> => nodeFs.readFileSync(uri.fsPath),
        writeFile: async (uri: MockUri, data: Uint8Array): Promise<void> => {
            nodeFs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
            nodeFs.writeFileSync(uri.fsPath, data);
        },
        createDirectory: async (uri: MockUri): Promise<void> => {
            nodeFs.mkdirSync(uri.fsPath, { recursive: true });
        },
        delete: async (uri: MockUri, options?: { recursive?: boolean }): Promise<void> => {
            nodeFs.rmSync(uri.fsPath, { recursive: options?.recursive ?? false, force: true });
        },
        readDirectory: async (): Promise<Array<[string, number]>> => [],
    };

    const module: Record<string, unknown> = {
        Uri: MockUri,
        FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
        ViewColumn: { Active: -1, Beside: -2, One: 1 },
        Disposable: class {
            constructor(private readonly callback: () => void) {}
            dispose(): void {
                this.callback();
            }
            static from(...items: Array<{ dispose(): void }>): { dispose(): void } {
                return {
                    dispose: (): void => {
                        for (const item of items) {
                            item.dispose();
                        }
                    },
                };
            }
        },
        EventEmitter: class {
            private readonly listeners: Array<(value: unknown) => void> = [];
            readonly event = (listener: (value: unknown) => void): { dispose(): void } => {
                this.listeners.push(listener);
                return disposable();
            };
            fire(value: unknown): void {
                for (const listener of this.listeners) {
                    listener(value);
                }
            }
            dispose(): void {
                this.listeners.length = 0;
            }
        },
        window: {
            get activeTextEditor(): unknown {
                return state.activeEditorPath
                    ? { document: { uri: MockUri.file(state.activeEditorPath) } }
                    : undefined;
            },
            tabGroups: { activeTabGroup: { activeTab: undefined } },
            createOutputChannel: (name: string) => ({
                name,
                appendLine: (line: string): void => {
                    messages.push(line);
                },
                append: (line: string): void => {
                    messages.push(line);
                },
                show: (): void => undefined,
                hide: (): void => undefined,
                clear: (): void => undefined,
                replace: (): void => undefined,
                dispose: (): void => undefined,
            }),
            registerWebviewViewProvider: (id: string, provider: unknown) => {
                views.set(id, provider);
                return disposable();
            },
            createWebviewPanel: () => {
                const view = state.makeView();
                return Object.assign(view, {
                    viewColumn: 1,
                    reveal: (): void => undefined,
                    onDidChangeViewState: () => disposable(),
                });
            },
            showErrorMessage: async (message: string): Promise<undefined> => {
                messages.push(`error: ${message}`);
                return undefined;
            },
            showWarningMessage: async (message: string): Promise<undefined> => {
                messages.push(`warning: ${message}`);
                return undefined;
            },
            showInformationMessage: async (message: string): Promise<undefined> => {
                messages.push(`info: ${message}`);
                return undefined;
            },
            showInputBox: async (): Promise<undefined> => undefined,
            showQuickPick: async (): Promise<undefined> => undefined,
            showOpenDialog: async (): Promise<undefined> => undefined,
            showSaveDialog: async (): Promise<undefined> => undefined,
            showTextDocument: async (): Promise<unknown> => ({}),
            showWorkspaceFolderPick: async (): Promise<undefined> => undefined,
            withProgress: async <T>(_options: unknown, task: () => Promise<T>): Promise<T> =>
                task(),
        },
        workspace: {
            get workspaceFolders(): unknown {
                return state.workspaceRoot
                    ? [{ uri: MockUri.file(state.workspaceRoot), name: 'workspace', index: 0 }]
                    : undefined;
            },
            fs: fsApi,
            openTextDocument: async (): Promise<unknown> => ({}),
            onDidChangeWorkspaceFolders: () => disposable(),
            getConfiguration: () => ({
                get: <T>(_key: string, fallback?: T): T | undefined => fallback,
                update: async (): Promise<void> => undefined,
                has: (): boolean => false,
                inspect: (): undefined => undefined,
            }),
        },
        commands: {
            registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
                commands.set(id, handler);
                return disposable();
            },
            executeCommand: async (id: string, ...args: unknown[]): Promise<unknown> => {
                const handler = commands.get(id);
                return handler ? handler(...args) : undefined;
            },
        },
        env: {
            clipboard: {
                writeText: async (text: string): Promise<void> => {
                    globalState.set('__clipboard', text);
                },
                readText: async (): Promise<string> =>
                    String(globalState.get('__clipboard') ?? ''),
            },
            openExternal: async (): Promise<boolean> => {
                throw new Error('the native runtime must not open an external browser');
            },
        },
        authentication: {
            getSession: async (): Promise<undefined> => undefined,
            onDidChangeSessions: () => disposable(),
        },
        CancellationTokenSource: class {
            readonly token = {
                isCancellationRequested: false,
                onCancellationRequested: () => disposable(),
            };
            cancel(): void {
                (this.token as { isCancellationRequested: boolean }).isCancellationRequested = true;
            }
            dispose(): void {
                /* nothing to release */
            }
        },
        ProgressLocation: { Notification: 15, Window: 10 },
        ThemeIcon: class {
            constructor(readonly id: string) {}
        },
    };

    return { module, state };
}
