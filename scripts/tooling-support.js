'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function containedPath(root, relative) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') ||
        path.posix.isAbsolute(relative) || /^[a-z]:/i.test(relative) ||
        relative.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error('Expected a relative, traversal-free artifact path');
    }
    const resolvedRoot = fs.realpathSync(root);
    const target = path.join(resolvedRoot, ...relative.split('/'));
    let ancestor = target;
    while (!fs.existsSync(ancestor)) {
        ancestor = path.dirname(ancestor);
    }
    const actual = fs.realpathSync(ancestor);
    const remainder = path.relative(resolvedRoot, actual);
    if (remainder === '..' || remainder.startsWith(`..${path.sep}`) || path.isAbsolute(remainder)) {
        throw new Error('Artifact path escapes its root through a symlink');
    }
    return target;
}

function temporaryRoot(prefix, directory = os.tmpdir()) {
    const parent = fs.realpathSync(directory);
    const root = fs.mkdtempSync(path.join(parent, prefix));
    const identity = crypto.randomUUID();
    fs.writeFileSync(path.join(root, '.sqlfdt-owned'), identity, { mode: 0o600 });
    return {
        root,
        cleanup() {
            if (fs.realpathSync(path.dirname(root)) !== parent ||
                fs.lstatSync(root).isSymbolicLink() ||
                fs.readFileSync(path.join(root, '.sqlfdt-owned'), 'utf8') !== identity) {
                throw new Error('Refusing to clean a directory not owned by this run');
            }
            fs.rmSync(root, { recursive: true, force: false, maxRetries: 5, retryDelay: 200 });
            if (fs.existsSync(root)) {
                throw new Error('Isolated directory cleanup was incomplete');
            }
        },
    };
}

function redact(value, privateValues = []) {
    let text = String(value);
    for (const secret of [...privateValues, os.homedir()].filter(Boolean).sort((a, b) => b.length - a.length)) {
        text = text.split(secret).join('[redacted]');
    }
    return text
        .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[redacted authorization]')
        .replace(/([?&](?:sig|token|key|password)=)[^&\s"']+/gi, '$1[redacted]')
        .replace(/\b(?:AccountKey|Password|PWD|VSCE_PAT)\s*=\s*[^;\s]+/gi, '[redacted credential]')
        .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{15,}/g, '[redacted token]');
}

function isolatedEnvironment(root) {
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'DISPLAY', 'LANG']) {
        if (process.env[key]) {
            env[key] = process.env[key];
        }
    }
    for (const directory of ['home', 'tmp', 'appdata', 'localappdata']) {
        fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    return {
        ...env,
        HOME: path.join(root, 'home'),
        USERPROFILE: path.join(root, 'home'),
        APPDATA: path.join(root, 'appdata'),
        LOCALAPPDATA: path.join(root, 'localappdata'),
        TMPDIR: path.join(root, 'tmp'),
        TMP: path.join(root, 'tmp'),
        TEMP: path.join(root, 'tmp'),
        XDG_CONFIG_HOME: path.join(root, 'home', '.config'),
        XDG_CACHE_HOME: path.join(root, 'home', '.cache'),
    };
}

async function runProcess(command, args, { timeout = 60_000, env = process.env, cwd, input, signal } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
        abort();
    }
    try {
        return await new Promise((resolve, reject) => {
            const child = spawn(command, args, {
                cwd, env, shell: false, windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'], signal: controller.signal,
                killSignal: 'SIGKILL',
            });
            let stdout = '';
            let stderr = '';
            let failure;
            child.on('error', (error) => { failure = error; });
            child.stdout.on('data', (chunk) => {
                stdout += chunk;
                if (stdout.length > 2 * 1024 * 1024) { abort(); }
            });
            child.stderr.on('data', (chunk) => {
                stderr += chunk;
                if (stderr.length > 2 * 1024 * 1024) { abort(); }
            });
            child.stdin.on('error', (error) => { failure = error; });
            child.stdin.end(input);
            child.on('close', (code) => {
                if (failure || controller.signal.aborted) {
                    reject(new Error(controller.signal.aborted ? 'Child process canceled or timed out' : 'Child process failed to start'));
                } else {
                    resolve({ code, stdout, stderr });
                }
            });
        });
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}

module.exports = { sha256, containedPath, temporaryRoot, redact, isolatedEnvironment, runProcess };
