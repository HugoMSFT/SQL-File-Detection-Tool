#!/usr/bin/env node
/**
 * Bundle the extension host entry point with esbuild.
 *
 * The published extension is a single CommonJS file, `dist/extension.js`. That
 * is what makes the VSIX genuinely self-contained: `node_modules` never ships,
 * so the package cannot pick up an install script, a native binary or a
 * transitive dependency at install time, and VS Code loads one file instead of
 * walking a few hundred.
 *
 * Two properties matter enough to be enforced here rather than left to a flag:
 *
 *   * `hyparquet` is ESM-only. Bundling to CJS is the only way it can run under
 *     VS Code's CommonJS extension host, so the bundle step is not an
 *     optimisation — it is a correctness requirement.
 *   * `vscode` is provided by the host and must stay external. Everything else
 *     is inlined.
 *
 * Production builds are minified with `keepNames` so that stack traces reported
 * by users still name the failing function even though no source map ships.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const repoRoot = path.join(__dirname, '..');
const outfile = path.join(repoRoot, 'dist', 'extension.js');
const production = !process.argv.includes('--dev');
const watch = process.argv.includes('--watch');

/** Fail the build if a bundling mistake would only surface at runtime. */
function verifyBundle() {
    const code = fs.readFileSync(outfile, 'utf8');
    const problems = [];

    // A surviving bare `require("hyparquet")` would mean the ESM-only package
    // was left external and the extension would throw ERR_REQUIRE_ESM on first
    // Parquet analysis.
    for (const bare of ['hyparquet', 'chardet', 'iconv-lite', 'fflate', '@azure/storage-blob']) {
        const pattern = new RegExp(`require\\((["'])${bare.replace('/', '\\/')}\\1\\)`);
        if (pattern.test(code)) {
            problems.push(`${bare} was not bundled`);
        }
    }
    if (!/require\((["'])vscode\1\)/.test(code)) {
        problems.push('the vscode module should stay external');
    }
    if (/\bchild_process\b/.test(code)) {
        problems.push('the bundle can spawn a process');
    }
    if (/\bworker_threads\b/.test(code)) {
        problems.push('the bundle can start a worker thread');
    }
    if (problems.length > 0) {
        throw new Error(`bundle verification failed: ${problems.join('; ')}`);
    }
    return Buffer.byteLength(code);
}

const options = {
    entryPoints: [path.join(repoRoot, 'src', 'extension.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode'],
    // `fflate` resolves to a Node build whose async API probes for
    // `worker_threads` through `createRequire`. Only `unzipSync` is used here,
    // and the sync implementation is byte-identical between builds, so the
    // browser entry point is selected to keep any reference to a thread or a
    // worker out of the shipped bundle entirely.
    alias: { fflate: 'fflate/browser' },
    minify: production,
    keepNames: production,
    // A production bundle ships no map: the sources are not in the package, so
    // a map would only leak paths. A development bundle inlines one, because
    // `main` points at `dist/extension.js` and without it no breakpoint in an
    // Extension Development Host can bind to a TypeScript line.
    sourcemap: production ? false : 'inline',
    treeShaking: true,
    legalComments: 'none',
    logLevel: 'info',
    define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
};

async function main() {
    fs.mkdirSync(path.dirname(outfile), { recursive: true });
    if (watch) {
        const context = await esbuild.context(options);
        await context.watch();
        return;
    }
    await esbuild.build(options);
    const bytes = verifyBundle();
    // eslint-disable-next-line no-console
    console.log(`bundled ${path.relative(repoRoot, outfile)} (${(bytes / 1024).toFixed(1)} KiB)`);
}

// Exported so `scripts/generate-notices.js` measures the dependency graph of
// the bundle that actually ships, rather than re-declaring the options and
// silently diverging from them.
module.exports = { options, outfile, repoRoot, verifyBundle };

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message ?? error);
        process.exit(1);
    });
}
