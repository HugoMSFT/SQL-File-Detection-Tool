/**
 * Performance and isolation guarantees for the *packaged* extension.
 *
 * `nativeRuntime.test.ts` proves the compiled `out/` tree is Python-free. That
 * is the tree the tests import, not the tree users install: what ships is the
 * single esbuild bundle at `dist/extension.js`, with its dependencies inlined
 * and minified. A bundler can pull in a code path that tree-shaking missed, or
 * resolve a package to a different entry point than `tsc` did (`fflate` ships a
 * Node build that probes `worker_threads`), so the shipped artifact is loaded
 * and activated here in its own right.
 *
 * Everything an installed extension must not need is taken away first: PATH is
 * blanked so no interpreter can be found, `child_process` throws on every entry
 * point, and `http`/`https`/`net`/`dns` throw so an offline machine is
 * indistinguishable from this test host. Activation, first render and analysis
 * then have to succeed on bundled code and local files alone.
 *
 * The timings are recorded as regression guards, not benchmarks. Budgets carry
 * enough slack for a loaded shared CI runner; the measured values are printed
 * so a regression can be read off the log rather than inferred from a failure.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { createMockVscode } from './mocks/vscode';

const REPO = path.resolve(__dirname, '..', '..');
const BUNDLE = path.join(REPO, 'dist', 'extension.js');
const SAMPLE = path.join(REPO, 'data sample', 'csv', 'employees.csv');

/**
 * Budgets are ceilings for a shared runner, not targets. The targets are an
 * order of magnitude lower and are asserted separately where the measurement is
 * stable enough to be worth failing on.
 */
const BUDGET = {
    /** Reading and evaluating the whole bundle, cold. */
    loadMs: 1500,
    /** `activate()` itself, once the module is evaluated. */
    activateMs: 500,
    /** Activity Bar click to a rendered shell. Target is under 100ms. */
    firstRenderMs: 400,
    /** A second view resolve, with every asset already read. */
    warmRenderMs: 100,
    /** A real CSV read, sniffed, typed and turned into DDL. */
    firstAnalysisMs: 8000,
    /** Re-analysing the same unchanged file must be served from cache. */
    repeatAnalysisMs: 2000,
    /** Heap kept after 20 analyses of the same file, in MiB. */
    retainedHeapMib: 96,
} as const;

interface Sabotage {
    restore(): void;
    attempts: string[];
}

/**
 * Remove every escape hatch an installed extension must not depend on:
 * subprocesses, the network, and anything findable on PATH.
 */
function isolate(): Sabotage {
    const attempts: string[] = [];
    const restores: Array<() => void> = [];

    const forbid = (moduleName: string, names: readonly string[]): void => {
        // Reached through require so the properties stay writable; an ES module
        // namespace object exposes getters only and cannot be sabotaged.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const target = require(moduleName) as Record<string, unknown>;
        for (const name of names) {
            const original = target[name];
            if (typeof original !== 'function') {
                continue;
            }
            target[name] = (...args: unknown[]): never => {
                attempts.push(`${moduleName}.${name}(${String(args[0])})`);
                throw new Error(`${moduleName}.${name} must not run in the packaged extension`);
            };
            restores.push(() => {
                target[name] = original;
            });
        }
    };

    forbid('node:child_process', [
        'spawn', 'spawnSync', 'exec', 'execFile', 'execSync', 'execFileSync', 'fork',
    ]);
    // Offline: activation and a local-file analysis must never reach the network.
    forbid('node:http', ['request', 'get']);
    forbid('node:https', ['request', 'get']);
    forbid('node:net', ['connect', 'createConnection', 'createServer']);
    forbid('node:dns', ['lookup', 'resolve']);

    const previousPath = process.env.PATH;
    process.env.PATH = path.join(REPO, 'does-not-exist');
    restores.push(() => {
        process.env.PATH = previousPath;
    });

    return {
        attempts,
        restore: (): void => {
            for (const restore of restores.reverse()) {
                restore();
            }
        },
    };
}

/** Load the bundle with `vscode` resolved to the mock, then restore the loader. */
function loadBundle(mockModule: Record<string, unknown>): {
    extension: { activate(context: unknown): void; deactivate(): void };
    loadMs: number;
} {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('node:module') as {
        _load(request: string, parent: unknown, isMain: boolean): unknown;
    };
    const load = Module._load;
    Module._load = function patched(request: string, parent: unknown, isMain: boolean): unknown {
        if (request === 'vscode') {
            return mockModule;
        }
        return load.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[BUNDLE];
        const started = process.hrtime.bigint();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const extension = require(BUNDLE) as { activate(context: unknown): void; deactivate(): void };
        const loadMs = Number(process.hrtime.bigint() - started) / 1e6;
        return { extension, loadMs };
    } finally {
        Module._load = load;
    }
}

/** Resolve when the host has posted an analysis result, or throw on timeout. */
async function waitForAnalysis(posted: unknown[], from: number, budgetMs: number): Promise<void> {
    const deadline = Date.now() + budgetMs;
    const done = (): boolean =>
        posted
            .slice(from)
            .some(
                (message) =>
                    (message as { state?: { lastAnalysisMs?: number | null } }).state
                        ?.lastAnalysisMs != null,
            );
    while (!done() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(done(), `no analysis result within ${budgetMs}ms`);
}

test('the packaged bundle exists and is the file the manifest points at', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
        main: string;
    };
    assert.equal(manifest.main, './dist/extension.js');
    assert.ok(fs.existsSync(BUNDLE), 'run `npm run bundle` before the tests');
});

test('the packaged bundle activates, renders and analyses with no Python, no subprocess and no network', async () => {
    const sabotage = isolate();
    try {
        const mock = createMockVscode();
        const { extension, loadMs } = loadBundle(mock.module);

        const activateStart = process.hrtime.bigint();
        extension.activate(mock.state.context);
        const activateMs = Number(process.hrtime.bigint() - activateStart) / 1e6;

        assert.deepEqual(sabotage.attempts, [], 'loading or activating reached a forbidden API');
        assert.ok(
            mock.state.views.has('sqlFileDetectionTool.sidebar'),
            'the packaged bundle registers the native view',
        );

        // Activity Bar click -> rendered shell.
        const provider = mock.state.views.get('sqlFileDetectionTool.sidebar') as {
            resolveWebviewView(view: unknown, ctx: unknown, token: unknown): unknown;
        };
        const view = mock.state.makeView();
        const renderStart = process.hrtime.bigint();
        await provider.resolveWebviewView(view, {}, { isCancellationRequested: false });
        const firstRenderMs = Number(process.hrtime.bigint() - renderStart) / 1e6;

        assert.ok(view.webview.html.length > 0, 'the shell renders from bundled assets');
        assert.match(view.webview.html, /Content-Security-Policy/);
        assert.ok(!/http:\/\//.test(view.webview.html), 'no plaintext http origin in the shell');
        assert.equal(mock.state.panels.length, 1, 'the Activity Bar opens one editor panel');
        assert.ok(
            mock.state.executedCommands.includes('workbench.action.closeSidebar'),
            'the editor panel replaces the primary sidebar',
        );
        const panel = mock.state.panels[0];
        assert.match(panel.webview.html, /data-surface="panel"/);

        // First analysis of a real file.
        mock.state.activeEditorPath = SAMPLE;
        const analyze = mock.state.commands.get('sqlFileDetectionTool.analyzeCurrentFile');
        assert.ok(analyze, 'the analyze command is registered');

        const firstStart = process.hrtime.bigint();
        await analyze();
        await waitForAnalysis(panel.webview.posted, 0, BUDGET.firstAnalysisMs);
        const firstAnalysisMs = Number(process.hrtime.bigint() - firstStart) / 1e6;

        // Repeat analysis of the same unchanged file.
        const repeatFrom = panel.webview.posted.length;
        const repeatStart = process.hrtime.bigint();
        await analyze();
        await waitForAnalysis(panel.webview.posted, repeatFrom, BUDGET.repeatAnalysisMs);
        const repeatAnalysisMs = Number(process.hrtime.bigint() - repeatStart) / 1e6;

        // Memory retention: repeated analysis of one file must not accumulate.
        global.gc?.();
        const heapBefore = process.memoryUsage().heapUsed;
        for (let index = 0; index < 20; index += 1) {
            const from = panel.webview.posted.length;
            await analyze();
            await waitForAnalysis(panel.webview.posted, from, BUDGET.repeatAnalysisMs);
        }
        global.gc?.();
        const retainedMib = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);

        // A second resolve has every asset cached; this is the steady state a
        // user sees on every subsequent Activity Bar click. Measured last so it
        // cannot redirect the analysis results away from the view above.
        const warmView = mock.state.makeView();
        const warmStart = process.hrtime.bigint();
        await provider.resolveWebviewView(warmView, {}, { isCancellationRequested: false });
        const warmRenderMs = Number(process.hrtime.bigint() - warmStart) / 1e6;
        assert.ok(warmView.webview.html.length > 0, 'the shell re-renders');

        // eslint-disable-next-line no-console
        console.log(
            `  packaged benchmark: load ${loadMs.toFixed(1)}ms, ` +
                `activate ${activateMs.toFixed(1)}ms, ` +
                `first render ${firstRenderMs.toFixed(1)}ms, ` +
                `warm render ${warmRenderMs.toFixed(1)}ms, ` +
                `first analysis ${firstAnalysisMs.toFixed(1)}ms, ` +
                `repeat analysis ${repeatAnalysisMs.toFixed(1)}ms, ` +
                `retained ${retainedMib.toFixed(1)}MiB`,
        );

        assert.deepEqual(sabotage.attempts, [], 'the packaged run reached a forbidden API');
        assert.ok(loadMs < BUDGET.loadMs, `bundle load took ${loadMs.toFixed(1)}ms`);
        assert.ok(activateMs < BUDGET.activateMs, `activation took ${activateMs.toFixed(1)}ms`);
        assert.ok(
            firstRenderMs < BUDGET.firstRenderMs,
            `first render took ${firstRenderMs.toFixed(1)}ms`,
        );
        assert.ok(
            warmRenderMs < BUDGET.warmRenderMs,
            `warm render took ${warmRenderMs.toFixed(1)}ms`,
        );
        assert.ok(
            firstAnalysisMs < BUDGET.firstAnalysisMs,
            `first analysis took ${firstAnalysisMs.toFixed(1)}ms`,
        );
        assert.ok(
            repeatAnalysisMs < BUDGET.repeatAnalysisMs,
            `repeat analysis took ${repeatAnalysisMs.toFixed(1)}ms`,
        );
        assert.ok(
            retainedMib < BUDGET.retainedHeapMib,
            `20 repeat analyses retained ${retainedMib.toFixed(1)}MiB`,
        );

        const serialised = JSON.stringify(view.webview.posted);
        assert.ok(!/localhost|127\.0\.0\.1|flask/i.test(serialised), 'no backend chatter');
        assert.ok(serialised.includes('employees.csv'), 'the analysis reached the renderer');

        extension.deactivate();
    } finally {
        sabotage.restore();
        delete require.cache[BUNDLE];
    }
});
