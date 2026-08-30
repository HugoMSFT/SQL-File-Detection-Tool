/**
 * Managed Python environment for the bundled backend.
 *
 * The extension never touches the user's workspace virtual environment. It
 * creates its own venv under `context.globalStorageUri` and installs the
 * bundled Python project into it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
    candidateInterpreters,
    hasBackend,
    isUsableInterpreter,
    run,
    venvPython,
} from './process';
import { redact } from './util';

export class PythonEnvironment {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
    ) {}

    private get venvDir(): string {
        return path.join(this.context.globalStorageUri.fsPath, 'backend-venv');
    }

    /** The project root inside the packaged extension. */
    get projectRoot(): string {
        return this.context.extensionUri.fsPath;
    }

    private config<T>(key: string, fallback: T): T {
        return vscode.workspace
            .getConfiguration('sqlFileDetectionTool')
            .get<T>(key, fallback);
    }

    /**
     * Resolve an interpreter that can run the backend, creating and populating
     * the managed environment on first use.
     */
    async resolve(force = false): Promise<string> {
        const override = this.config<string>('backendInterpreter', '').trim();
        if (override) {
            if (!(await hasBackend(override))) {
                throw new Error(
                    `The configured interpreter cannot import the backend: ${override}. ` +
                        'Install the project into it, or clear sqlFileDetectionTool.backendInterpreter.',
                );
            }
            this.output.appendLine(`Using configured interpreter: ${override}`);
            return override;
        }

        const managed = venvPython(this.venvDir);
        if (!force && fs.existsSync(managed) && (await hasBackend(managed))) {
            this.output.appendLine(`Using managed environment: ${managed}`);
            return managed;
        }
        return this.create(force);
    }

    /** Create the managed environment and install the bundled project. */
    async create(force: boolean): Promise<string> {
        const base = await this.findBaseInterpreter();
        const venvDir = this.venvDir;
        const managed = venvPython(venvDir);

        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'SQL File Detection Tool: preparing the Python backend',
                cancellable: false,
            },
            async (progress) => {
                await fs.promises.mkdir(this.context.globalStorageUri.fsPath, {
                    recursive: true,
                });
                if (force && fs.existsSync(venvDir)) {
                    this.output.appendLine('Recreating the managed environment...');
                    await fs.promises.rm(venvDir, { recursive: true, force: true });
                }
                if (!fs.existsSync(managed)) {
                    progress.report({ message: 'creating the virtual environment' });
                    const args =
                        base === 'py'
                            ? ['-3', '-m', 'venv', venvDir]
                            : ['-m', 'venv', venvDir];
                    const created = await run(base, args, { timeoutMs: 300000 });
                    if (created.code !== 0 || !fs.existsSync(managed)) {
                        throw new Error(
                            'Could not create the virtual environment: ' +
                                redact(created.stderr || created.stdout || 'unknown error'),
                        );
                    }
                }

                progress.report({ message: 'upgrading pip' });
                await run(managed, ['-m', 'pip', 'install', '--upgrade', 'pip'], {
                    timeoutMs: 300000,
                });

                progress.report({
                    message: 'installing the backend (this can take a few minutes)',
                });
                const target = this.config<boolean>('installAzureExtras', true)
                    ? `${this.projectRoot}[azure]`
                    : this.projectRoot;
                this.output.appendLine(`Installing ${target}`);
                const installed = await run(
                    managed,
                    ['-m', 'pip', 'install', '--disable-pip-version-check', target],
                    { timeoutMs: 1800000 },
                );
                if (installed.code !== 0) {
                    this.output.appendLine(redact(installed.stdout));
                    this.output.appendLine(redact(installed.stderr));
                    this.output.show(true);
                    throw new Error(
                        'Installing the backend failed. See the SQL File Detection Tool output channel for details.',
                    );
                }
                if (!(await hasBackend(managed))) {
                    throw new Error(
                        'The backend was installed but could not be imported. See the output channel.',
                    );
                }
                this.output.appendLine(`Managed environment ready: ${managed}`);
                return managed;
            },
        );
    }

    private async findBaseInterpreter(): Promise<string> {
        const configured = this.config<string>('pythonPath', '').trim();
        for (const candidate of candidateInterpreters(configured)) {
            if (await isUsableInterpreter(candidate)) {
                this.output.appendLine(`Base interpreter: ${candidate}`);
                return candidate;
            }
        }
        throw new Error(
            'No Python 3.9+ interpreter was found. Install Python, or set ' +
                '"sqlFileDetectionTool.pythonPath" to a Python 3.9+ interpreter.',
        );
    }
}
