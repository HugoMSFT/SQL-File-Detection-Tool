/**
 * Lifecycle management for the bundled Python Flask backend.
 *
 * The backend is always started with an explicit argument array (never through
 * a shell), on an OS-assigned free loopback port, with a cryptographically
 * random control token passed through the environment. The token authenticates
 * the extension to the backend's control endpoints; it never appears in a URL,
 * a log line, a setting or a file.
 */

import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { PythonEnvironment } from './pythonEnv';
import {
    buildHealthUrl,
    findFreePort,
    normalizeHost,
    waitForHealth,
} from './legacyBackendUrl';
import { computeRoot, isWithinRoot, normalizePlatform, redact } from './util';
export interface BackendInfo {
    host: string;
    port: number;
    health: Record<string, unknown>;
    /** Directory the backend is allowed to read local files from. */
    root: string;
}

export interface StartOptions {
    /** Path the caller intends to analyze, used to choose the analysis root. */
    hint?: string;
    /** True when *hint* is a directory. */
    hintIsDirectory?: boolean;
}

export type BackendState = 'stopped' | 'starting' | 'running' | 'failed';

export class BackendManager implements vscode.Disposable {
    private child: ChildProcess | undefined;
    private controlToken = '';
    private info: BackendInfo | undefined;
    private starting: Promise<BackendInfo> | undefined;
    private state: BackendState = 'stopped';
    private readonly stateEmitter = new vscode.EventEmitter<BackendState>();

    /** Fires whenever the backend state changes, for the status bar and sidebar. */
    readonly onDidChangeState = this.stateEmitter.event;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
        private readonly env: PythonEnvironment,
        private readonly statusBar: vscode.StatusBarItem,
    ) {
        this.render();
    }

    get running(): boolean {
        return this.state === 'running' && !!this.info;
    }

    get currentState(): BackendState {
        return this.state;
    }

    get current(): BackendInfo | undefined {
        return this.info;
    }

    /**
     * Resolve the analysis root for a request.
     *
     * The backend confines local reads to one directory, so a target outside
     * the current root requires a restart with a wider one.
     */
    private resolveRoot(options: StartOptions = {}): string {
        const config = vscode.workspace.getConfiguration('sqlFileDetectionTool');
        return computeRoot({
            override: config.get<string>('rootDirectory', ''),
            hint: options.hint,
            hintIsDirectory: options.hintIsDirectory,
            workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(
                (folder) => folder.uri.fsPath,
            ),
            home: os.homedir(),
        });
    }

    /** Start the backend if needed and return its loopback coordinates. */
    async ensureStarted(options: StartOptions = {}): Promise<BackendInfo> {
        const alive = this.info && this.child && !this.child.killed;
        if (alive && this.info) {
            if (!options.hint || isWithinRoot(options.hint, this.info.root)) {
                return this.info;
            }
            // The target is outside the root the backend was started with, and
            // that guard is enforced server-side. Restart rather than let every
            // request fail with "outside the allowed root directory".
            this.output.appendLine(
                `Restarting backend: ${options.hint} is outside the current analysis root.`,
            );
            this.stop();
        }
        if (!this.starting) {
            const root = this.resolveRoot(options);
            this.starting = this.start(root).finally(() => {
                this.starting = undefined;
            });
        }
        return this.starting;
    }

    private setState(state: BackendState): void {
        const changed = this.state !== state;
        this.state = state;
        this.render();
        if (changed) {
            this.stateEmitter.fire(state);
        }
    }

    private render(): void {
        const labels: Record<BackendState, string> = {
            stopped: '$(circle-slash) SQL File Detection Tool',
            starting: '$(sync~spin) SQL File Detection Tool',
            running: '$(database) SQL File Detection Tool',
            failed: '$(error) SQL File Detection Tool',
        };
        this.statusBar.text = labels[this.state];
        const detail = this.info
            ? `backend on ${this.info.host}:${this.info.port}`
            : 'backend not running';
        this.statusBar.tooltip = `SQL File Detection Tool — ${this.state} (${detail})`;
        this.statusBar.command = 'sqlFileDetectionTool.open';
        this.statusBar.show();
    }

    private async start(root: string): Promise<BackendInfo> {
        this.setState('starting');
        try {
            const python = await this.env.resolve();
            const config = vscode.workspace.getConfiguration('sqlFileDetectionTool');
            const host = normalizeHost(config.get<string>('host', '127.0.0.1'));
            const port = await findFreePort(host);
            this.controlToken = crypto.randomBytes(32).toString('base64url');

            const args = [
                '-m',
                'external_file_detection.web_gui',
                '--host',
                host,
                '--port',
                String(port),
                '--root-dir',
                root,
            ];
            const env = { ...process.env };
            delete env.PYTHONHOME;
            env.PYTHONUNBUFFERED = '1';
            env.PYTHONDONTWRITEBYTECODE = '1';
            env.SQLFDT_CONTROL_TOKEN = this.controlToken;
            env.PYTHONPATH = [this.env.projectRoot, process.env.PYTHONPATH]
                .filter(Boolean)
                .join(path.delimiter);

            this.output.appendLine(
                `Starting backend: ${python} -m external_file_detection.web_gui --host ${host} --port ${port} --root-dir ${root}`,
            );
            const child = spawn(python, args, {
                cwd: root,
                env,
                shell: false,
                windowsHide: true,
            });
            this.child = child;

            child.stdout?.on('data', (chunk) => {
                this.output.append(redact(String(chunk)));
            });
            child.stderr?.on('data', (chunk) => {
                this.output.append(redact(String(chunk)));
            });
            child.on('exit', (code, signal) => {
                this.output.appendLine(
                    `Backend exited (code=${String(code)}, signal=${String(signal)}).`,
                );
                if (this.child === child) {
                    this.child = undefined;
                    this.info = undefined;
                    this.controlToken = '';
                    this.setState(code === 0 || signal ? 'stopped' : 'failed');
                }
            });
            child.on('error', (err) => {
                this.output.appendLine(`Backend error: ${redact(err.message)}`);
            });

            const health = await waitForHealth(buildHealthUrl(host, port), 90000, () =>
                child.killed || child.exitCode !== null,
            ).catch((err) => {
                this.stop();
                throw err;
            });

            this.info = { host, port, health, root };
            this.setState('running');
            const platform = normalizePlatform(
                config.get<string>('defaultPlatform', 'azure_sql_db'),
            );
            this.output.appendLine(
                `Backend ready. Analysis root: ${root}. Default platform: ${String(health.default_platform ?? platform)}`,
            );
            return this.info;
        } catch (err) {
            this.setState('failed');
            throw err;
        }
    }

    /**
     * Call a backend control endpoint.
     *
     * The control token travels only in a request header over loopback.
     */
    async control(endpoint: string, body: unknown): Promise<Record<string, unknown>> {
        const info = this.info;
        if (!info || !this.controlToken) {
            throw new Error('The backend is not running.');
        }
        const response = await fetch(
            `http://${info.host}:${info.port}/api/control/${endpoint}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Control-Token': this.controlToken,
                },
                body: JSON.stringify(body ?? {}),
            },
        );
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok || payload.success === false) {
            throw new Error(
                redact(String(payload.error ?? `Control request failed (${response.status})`)),
            );
        }
        return payload;
    }

    /** Terminate the backend and forget its control token. */
    stop(): void {
        const child = this.child;
        this.child = undefined;
        this.info = undefined;
        this.controlToken = '';
        if (child && !child.killed) {
            this.output.appendLine('Stopping backend...');
            try {
                child.kill();
            } catch {
                /* already gone */
            }
            // Escalate if the process ignores the polite signal.
            const pid = child.pid;
            setTimeout(() => {
                if (pid && child.exitCode === null && !child.killed) {
                    try {
                        child.kill('SIGKILL');
                    } catch {
                        /* already gone */
                    }
                }
            }, 3000).unref?.();
        }
        this.setState('stopped');
    }

    dispose(): void {
        this.stop();
        this.stateEmitter.dispose();
        void this.context;
    }
}
