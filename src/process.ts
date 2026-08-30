/**
 * Child-process helpers with no `vscode` dependency, so they can be unit
 * tested with plain `node --test`.
 */

import { spawn } from 'child_process';
import * as path from 'path';

export interface RunResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

/**
 * Run a command with an explicit argument array.
 *
 * `shell` is never enabled, so no value here is ever interpreted by a shell.
 */
export function run(
    command: string,
    args: string[],
    options: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            shell: false,
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let timer: NodeJS.Timeout | undefined;
        if (options.timeoutMs) {
            timer = setTimeout(() => child.kill(), options.timeoutMs);
        }
        child.stdout?.on('data', (chunk) => {
            stdout += String(chunk);
        });
        child.stderr?.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.on('error', (err) => {
            if (timer) {
                clearTimeout(timer);
            }
            reject(err);
        });
        child.on('close', (code) => {
            if (timer) {
                clearTimeout(timer);
            }
            resolve({ code, stdout, stderr });
        });
    });
}

/** Path of the python executable inside a venv directory. */
export function venvPython(venvDir: string): string {
    return process.platform === 'win32'
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python');
}

/** Candidate interpreters to try when the user has not configured one. */
export function candidateInterpreters(configured: string): string[] {
    const candidates: string[] = [];
    if (configured) {
        candidates.push(configured);
    }
    if (process.platform === 'win32') {
        candidates.push('py', 'python', 'python3');
    } else {
        candidates.push('python3', 'python');
    }
    return candidates.filter((c, i) => candidates.indexOf(c) === i);
}

/** `py` needs an explicit `-3` so it does not select a Python 2 launcher. */
function interpreterArgs(python: string, args: string[]): string[] {
    return python === 'py' ? ['-3', ...args] : args;
}

/** True when *python* exists and is at least Python 3.9. */
export async function isUsableInterpreter(python: string): Promise<boolean> {
    try {
        const result = await run(
            python,
            interpreterArgs(python, ['-c', 'import sys; print(sys.version_info[:2])']),
            { timeoutMs: 20000 },
        );
        if (result.code !== 0) {
            return false;
        }
        const match = /\((\d+),\s*(\d+)\)/.exec(result.stdout);
        if (!match) {
            return false;
        }
        const major = Number(match[1]);
        const minor = Number(match[2]);
        return major > 3 || (major === 3 && minor >= 9);
    } catch {
        return false;
    }
}

/** True when *python* can already import the backend package and Flask. */
export async function hasBackend(python: string): Promise<boolean> {
    try {
        const result = await run(
            python,
            interpreterArgs(python, [
                '-c',
                'import external_file_detection, flask; print("ok")',
            ]),
            { timeoutMs: 60000 },
        );
        return result.code === 0 && result.stdout.includes('ok');
    } catch {
        return false;
    }
}
