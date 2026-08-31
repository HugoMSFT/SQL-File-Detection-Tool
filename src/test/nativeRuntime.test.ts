/**
 * Integration-style guarantees for the native runtime.
 *
 * Layer 2 removed Python, Flask and localhost from the default extension
 * runtime. That promise is only worth something if it is enforced
 * mechanically, so these tests walk the *compiled* module graph reachable from
 * the activation entry point and assert that nothing on it can start a
 * process, bind a port, or talk to a backend. They then activate the extension
 * against a mock `vscode` and run a real analysis with `child_process`
 * sabotaged, so any accidental spawn fails loudly instead of silently working
 * on a developer machine that happens to have Python installed.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { createMockVscode } from './mocks/vscode';

const OUT = path.resolve(__dirname, '..');
const REPO = path.resolve(OUT, '..');
const ENTRY = path.join(OUT, 'extension.js');

/** Modules the native path must never pull in, directly or transitively. */
const FORBIDDEN_BUILTINS = ['child_process', 'node:child_process', 'worker_threads', 'node:worker_threads'];

/**
 * Vocabulary that only appears in a server-backed design. Matched against
 * comment-stripped source so that documentation explaining why the native
 * runtime does *not* do these things does not trip the scan.
 */
const FORBIDDEN_VOCABULARY: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bflask\b/i, 'Flask'],
    [/\blocalhost\b/i, 'localhost'],
    [/127\.0\.0\.1/, 'loopback literal'],
    [/\bpip\s+install\b/i, 'pip install'],
    [/\bvirtualenv\b/i, 'virtualenv'],
    [/\bvenv\b/i, 'venv'],
    [/\bhealth(check|Polling)\b/i, 'backend health polling'],
];

/**
 * The native path is allowed to *name* the optional Python CLI when explaining
 * a limitation (ORC), but must never carry anything shaped like an interpreter
 * invocation. Prose cannot produce a quoted executable name or an interpreter
 * path identifier, so these patterns catch code without banning honest copy.
 */
const PYTHON_EXECUTION: ReadonlyArray<readonly [RegExp, string]> = [
    [/(["'`])(python3?(\.exe)?|py|pip3?)\1/i, 'a quoted interpreter name'],
    [/\b(python|interpreter)(Path|Exe|Executable|Command|Bin|Args)\b/i, 'an interpreter path'],
    [/\b-m\s+(pip|flask|external_file_detection)\b/i, 'a module invocation'],
];

function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
}

/** Relative `require` targets in a compiled CommonJS module. */
function requiresOf(source: string): string[] {
    const found: string[] = [];
    for (const match of source.matchAll(/require\((["'])([^"']+)\1\)/g)) {
        found.push(match[2]);
    }
    return found;
}

interface GraphNode {
    readonly file: string;
    readonly source: string;
    readonly stripped: string;
    readonly requires: readonly string[];
}

/**
 * Walks the compiled graph from the activation entry point, following only
 * first-party relative requires. Bare specifiers are recorded (so they can be
 * asserted against) but not followed into `node_modules`.
 */
function nativeGraph(): { nodes: GraphNode[]; bare: Set<string> } {
    assert.ok(fs.existsSync(ENTRY), 'the extension must be compiled before running this test');
    const nodes: GraphNode[] = [];
    const bare = new Set<string>();
    const seen = new Set<string>();
    const queue = [ENTRY];

    while (queue.length > 0) {
        const file = queue.shift() as string;
        if (seen.has(file)) {
            continue;
        }
        seen.add(file);
        const source = fs.readFileSync(file, 'utf8');
        const requires = requiresOf(source);
        nodes.push({ file, source, stripped: stripComments(source), requires });

        for (const specifier of requires) {
            if (!specifier.startsWith('.')) {
                bare.add(specifier);
                continue;
            }
            const resolved = path.resolve(path.dirname(file), specifier);
            for (const candidate of [`${resolved}.js`, path.join(resolved, 'index.js')]) {
                if (fs.existsSync(candidate)) {
                    queue.push(candidate);
                    break;
                }
            }
        }
    }
    return { nodes, bare };
}

const graph = nativeGraph();
const relative = (file: string): string => path.relative(OUT, file).replace(/\\/g, '/');

test('the native module graph reaches the whole product surface', () => {
    const files = new Set(graph.nodes.map((node) => relative(node.file)));
    for (const expected of [
        'extension.js',
        'nativeView.js',
        'ui/controller.js',
        'ui/webviewShell.js',
        'appState.js',
        'protocol.js',
        'azure/connection.js',
        'azure/blobBrowser.js',
        'net/publicData.js',
        'net/safeHttp.js',
        'native/index.js',
    ]) {
        assert.ok(files.has(expected), `${expected} should be reachable from activation`);
    }
});

test('nothing reachable from activation can spawn a process', () => {
    for (const node of graph.nodes) {
        for (const specifier of node.requires) {
            assert.ok(
                !FORBIDDEN_BUILTINS.includes(specifier),
                `${relative(node.file)} requires ${specifier}`,
            );
        }
        assert.ok(
            !/\b(spawn|spawnSync|execFile|execFileSync|execSync)\s*\(/.test(node.stripped),
            `${relative(node.file)} appears to launch a process`,
        );
    }
});

test('the legacy Python backend is not reachable from activation', () => {
    const files = new Set(graph.nodes.map((node) => relative(node.file)));
    for (const legacy of ['backend.js', 'pythonEnv.js', 'process.js', 'webviewHtml.js', 'sidebar.js']) {
        assert.ok(!files.has(legacy), `${legacy} must not be on the native path`);
    }
});

test('no server vocabulary survives on the native path', () => {
    // The SSRF guard's job is to *reject* loopback and link-local destinations,
    // so it necessarily names them. Everything else must be free of the
    // vocabulary of a server-backed design.
    const guards = new Set(['net/ipGuard.js', 'net/safeHttp.js']);

    for (const node of graph.nodes) {
        const name = relative(node.file);
        if (name.startsWith('native/')) {
            // The analysis core is pure TypeScript and covered by Layer 1 tests.
            continue;
        }
        for (const [pattern, label] of FORBIDDEN_VOCABULARY) {
            if (guards.has(name) && /localhost|loopback/.test(label)) {
                continue;
            }
            assert.ok(!pattern.test(node.stripped), `${name} still references ${label}`);
        }
        for (const [pattern, label] of PYTHON_EXECUTION) {
            assert.ok(!pattern.test(node.stripped), `${name} carries ${label}`);
        }
    }
});

test('runtime dependencies stay minimal and justified', () => {
    const manifest = JSON.parse(
        fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    const builtin = /^(node:)?(assert|buffer|crypto|events|fs|https|http|net|os|path|stream|string_decoder|url|util|zlib|dns|tls|timers)(\/.*)?$/;

    for (const specifier of graph.bare) {
        if (specifier === 'vscode' || builtin.test(specifier)) {
            continue;
        }
        const packageName = specifier.startsWith('@')
            ? specifier.split('/').slice(0, 2).join('/')
            : specifier.split('/')[0];
        assert.ok(
            declared.has(packageName),
            `${packageName} is required at runtime but is not a declared dependency`,
        );
    }
});

test('activation registers the native view and never touches a backend', async () => {
    const spawned: string[] = [];
    // Reached through require so the properties stay writable; an ES module
    // namespace object exposes getters only and cannot be sabotaged.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sabotaged = require('node:child_process') as Record<string, unknown>;
    const originals = new Map<string, unknown>();
    for (const name of ['spawn', 'spawnSync', 'exec', 'execFile', 'execSync', 'execFileSync', 'fork']) {
        originals.set(name, sabotaged[name]);
        sabotaged[name] = (...args: unknown[]): never => {
            spawned.push(String(args[0]));
            throw new Error(`child_process.${name} must not run on the native path`);
        };
    }

    // Make Python unfindable for the duration of the test, so any fallback that
    // tries to shell out cannot accidentally succeed.
    const previousPath = process.env.PATH;
    process.env.PATH = path.join(REPO, 'does-not-exist');

    try {
        const mock = createMockVscode();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Module = require('node:module') as {
            _load(request: string, parent: unknown, isMain: boolean): unknown;
        };
        const load = Module._load;
        Module._load = function patched(request: string, parent: unknown, isMain: boolean): unknown {
            if (request === 'vscode') {
                return mock.module;
            }
            return load.call(this, request, parent, isMain);
        };

        try {
            for (const key of Object.keys(require.cache)) {
                if (key.startsWith(OUT) && !key.includes(`${path.sep}test${path.sep}`)) {
                    delete require.cache[key];
                }
            }
            // Loaded dynamically on purpose: the require cache is cleared above
            // so activation runs against the mock vscode module.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const extension = require('../extension') as {
                activate(context: unknown): void;
                deactivate(): void;
            };

            const started = process.hrtime.bigint();
            extension.activate(mock.state.context);
            const activationMs = Number(process.hrtime.bigint() - started) / 1e6;

            assert.equal(spawned.length, 0, 'activation spawned a process');
            assert.ok(activationMs < 500, `activation took ${activationMs.toFixed(1)}ms`);
            assert.ok(
                mock.state.views.has('sqlFileDetectionTool.sidebar'),
                'the native webview view provider is registered',
            );
            assert.ok(mock.state.commands.size >= 5, 'commands are contributed');
            for (const command of mock.state.commands.keys()) {
                assert.ok(
                    !/setup|installBackend|startBackend|stopBackend/i.test(command),
                    `${command} looks like a backend lifecycle command`,
                );
            }

            // First render must come from bundled assets only.
            const provider = mock.state.views.get('sqlFileDetectionTool.sidebar') as {
                resolveWebviewView(view: unknown, ctx: unknown, token: unknown): unknown;
            };
            const view = mock.state.makeView();
            const renderStart = process.hrtime.bigint();
            await provider.resolveWebviewView(view, {}, { isCancellationRequested: false });
            const renderMs = Number(process.hrtime.bigint() - renderStart) / 1e6;

            assert.ok(view.webview.html.length > 0, 'the sidebar renders immediately');
            assert.ok(renderMs < 1500, `first render took ${renderMs.toFixed(1)}ms`);
            assert.equal(spawned.length, 0, 'first render spawned a process');
            assert.ok(!/http:\/\//.test(view.webview.html), 'no plaintext http origin in the shell');
            assert.match(view.webview.html, /Content-Security-Policy/);

            // A real analysis, driven the way a user would drive it, still with
            // child_process sabotaged.
            mock.state.activeEditorPath = path.join(REPO, 'test_data', 'employees.csv');
            const analyze = mock.state.commands.get('sqlFileDetectionTool.analyzeCurrentFile');
            assert.ok(analyze, 'the analyze command is registered');
            const analysisStart = process.hrtime.bigint();
            await analyze();
            // Wait for the analysis result rather than a fixed delay, so the
            // benchmark reflects real work.
            const deadline = Date.now() + 8000;
            const analysed = (): boolean =>
                view.webview.posted.some(
                    (message) =>
                        (message as { state?: { lastAnalysisMs?: number | null } }).state
                            ?.lastAnalysisMs != null,
                );
            while (!analysed() && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            const analysisMs = Number(process.hrtime.bigint() - analysisStart) / 1e6;

            assert.ok(analysed(), 'the analysis produced a result');
            assert.equal(spawned.length, 0, 'analysis spawned a process');
            assert.ok(analysisMs < 8000, `first analysis took ${analysisMs.toFixed(1)}ms`);
            // Recorded so a slow machine can be diagnosed from CI output.
            // eslint-disable-next-line no-console
            console.log(
                `  benchmark: activation ${activationMs.toFixed(1)}ms, ` +
                    `first render ${renderMs.toFixed(1)}ms, ` +
                    `first analysis ${analysisMs.toFixed(1)}ms`,
            );
            const posted = view.webview.posted;
            assert.ok(posted.length > 0, 'the host answered the webview');
            const serialised = JSON.stringify(posted);
            assert.ok(!/localhost|127\.0\.0\.1|flask/i.test(serialised), 'no backend chatter');
            assert.ok(serialised.includes('employees.csv'), 'the analysis reached the renderer');

            extension.deactivate();
        } finally {
            Module._load = load;
        }
    } finally {
        process.env.PATH = previousPath;
        for (const [name, original] of originals) {
            sabotaged[name] = original;
        }
        for (const key of Object.keys(require.cache)) {
            if (key.startsWith(OUT) && !key.includes(`${path.sep}test${path.sep}`)) {
                delete require.cache[key];
            }
        }
    }
});
