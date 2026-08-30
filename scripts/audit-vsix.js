#!/usr/bin/env node
/**
 * Audit a built `.vsix` mechanically.
 *
 * A VSIX is a zip. This opens it, lists every entry, and fails if anything that
 * must not ship is present or anything that must ship is missing. The point is
 * that "the extension is Python-free" stops being a claim in a README and
 * becomes a build-time assertion over the real artifact: no `.py`, no
 * `pyproject.toml`, no `external_file_detection/`, no `node_modules`, no
 * TypeScript sources, no test fixtures, no source maps and nothing
 * credential-shaped.
 *
 * The bundled JavaScript is scanned too, because an ignore list can only police
 * file names. A `pip install` string or a `child_process` require inside
 * `dist/extension.js` would pass every path check and still reintroduce exactly
 * the runtime this version removed.
 *
 * Usage: node scripts/audit-vsix.js [path/to/extension.vsix] [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { unzipSync } = require('fflate');

const repoRoot = path.join(__dirname, '..');

/** Path patterns that must never appear in the archive. */
const FORBIDDEN_PATHS = [
    [/\.py[cwoi]?$/i, 'a Python source or bytecode file'],
    [/\.ipynb$/i, 'a notebook'],
    [/(^|\/)external_file_detection\//i, 'the Python package directory'],
    [/(^|\/)pyproject\.toml$/i, 'the Python build definition'],
    [/(^|\/)requirements[^/]*\.txt$/i, 'a Python requirements file'],
    [/(^|\/)setup\.(py|cfg)$/i, 'a Python setup file'],
    [/\.(whl|egg|tar\.gz)$/i, 'a Python distribution artifact'],
    [/(^|\/)[^/]*\.egg-info(\/|$)/i, 'Python distribution metadata'],
    [/(^|\/)(\.venv|venv|__pycache__|\.pytest_cache)\//i, 'a Python cache or environment'],
    [/(^|\/)node_modules\//, 'an unbundled dependency tree'],
    [/\.tsx?$/i, 'raw TypeScript'],
    [/\.map$/i, 'a source map'],
    [/(^|\/)(tests?|test_data|demo|docs|scripts|out)\//i, 'development-only content'],
    [/(^|\/)(tsconfig|\.eslintrc)[^/]*$/i, 'build configuration'],
    [/(^|\/)AGENTS\.md$/i, 'internal agent instructions'],
    [/(^|\/)\.git(\/|attributes$|ignore$)/i, 'Git metadata'],
    [/(^|\/)frames\//i, 'raw capture frames'],
    [/\.(env|pem|key|pfx|p12|pubxml)$/i, 'a credential-shaped file'],
    [/(^|\/)[^/]*secret[^/]*$/i, 'a file named like a secret'],
    [/\.(psd|mp4|mov)$/i, 'a capture scratch artifact'],
];

/** Entries the extension cannot work without. */
/**
 * Every asset `package.json` promises, derived from the manifest itself.
 *
 * Hardcoding this list is how a packaging audit acquires a blind spot: drop the
 * walkthrough markdown from `.vscodeignore` and a hardcoded list happily ships a
 * VSIX with four broken walkthrough steps. Reading the manifest means the audit
 * checks what the extension actually claims to contribute, so a new contributed
 * asset is policed the moment it is declared.
 */
function manifestAssets() {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const assets = new Set();
    const add = (value) => {
        if (typeof value !== 'string' || value === '') {
            return;
        }
        assets.add(`extension/${value.replace(/^\.\//, '').replace(/^\//, '')}`);
    };

    add(manifest.main);
    add(manifest.icon);
    for (const container of Object.values(manifest.contributes?.viewsContainers ?? {})) {
        for (const entry of container) {
            add(entry.icon);
        }
    }
    for (const views of Object.values(manifest.contributes?.views ?? {})) {
        for (const view of views) {
            add(view.icon);
        }
    }
    for (const walkthrough of manifest.contributes?.walkthroughs ?? []) {
        for (const step of walkthrough.steps ?? []) {
            add(step.media?.markdown);
            add(step.media?.image?.path ?? step.media?.image);
            add(step.media?.svg);
        }
    }
    return [...assets].sort();
}

/**
 * Files the package must contain regardless of what the manifest declares.
 *
 * Each entry is a list of accepted names, because `vsce` renames the three
 * files the Marketplace renders: `README.md` becomes `readme.md`,
 * `CHANGELOG.md` becomes `changelog.md`, and `LICENSE` becomes `LICENSE.txt`.
 * Matching a list rather than a single string keeps the check honest instead of
 * making it pass by loosening it to a substring.
 *
 * The manifest-derived assets from {@link manifestAssets} are appended to this
 * list at audit time.
 */
const REQUIRED_PATHS = [
    ['extension/package.json'],
    ['extension/media/webview/main.js'],
    ['extension/media/webview/main.css'],
    ['extension/README.md', 'extension/readme.md'],
    ['extension/CHANGELOG.md', 'extension/changelog.md'],
    ['extension/LICENSE', 'extension/LICENSE.txt', 'extension/license.txt'],
    ['extension/THIRD_PARTY_NOTICES.md'],
];

/**
 * Literals that a vendored dependency legitimately contains, removed before the
 * loopback rule is applied.
 *
 * `@azure/storage-blob` embeds the Azurite emulator connection string — the
 * published, universally known development credential that `UseDevelopmentStorage=true`
 * expands to. It is not a secret and not a loopback client this extension can
 * reach, but it does contain `http://127.0.0.1:10000`, which would otherwise
 * trip the loopback rule below. Excising exactly that literal keeps the rule
 * strict everywhere else instead of weakening the pattern.
 *
 * The pattern is anchored on the literal `devstoreaccount1`, so it cannot match
 * a real storage account, and the tail is length-capped so it can only ever
 * swallow the emulator's own well-known key — never an unrelated credential
 * that happened to be concatenated into a long neighbouring literal. The
 * exception is applied *only* to the loopback rule, so a credential hiding
 * inside that span is still caught by the secret patterns.
 */
const VENDOR_LITERAL_EXCEPTIONS = [
    /DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;[^"'`]{0,200}/g,
];

/**
 * Strings that would betray a re-introduced Python or server runtime.
 *
 * `localhost` is deliberately absent: `src/net/safeHttp.ts` names it to *reject*
 * it, and an SSRF denylist that cannot spell its own denied host is worse than
 * useless. The URL forms below catch an actual loopback client instead.
 */
const FORBIDDEN_BUNDLE_STRINGS = [
    [/\bflask\b/i, 'Flask'],
    [/\bpip\s+install\b/i, 'a pip install'],
    [/\bvirtualenv\b/i, 'virtualenv'],
    [/\bvenv\b/i, 'a virtual environment'],
    [/child_process/, 'process spawning'],
    [/\bworker_threads\b/, 'worker threads'],
    [/["'`](python3?(\.exe)?|py|pip3?)["'`]/i, 'a quoted interpreter name'],
    [/\/api\/health\b/, 'a backend health endpoint'],
    [/\bsetupBackend|startBackend|stopBackend\b/i, 'a backend lifecycle command'],
    [/\bsimpleBrowser\b/i, 'the Simple Browser'],
];

/**
 * The loopback rule, kept separate because it is the only one the vendor
 * exception applies to.
 */
const LOOPBACK_URL = [/https?:\/\/(localhost|127\.0\.0\.1)/i, 'a loopback URL'];

/**
 * Credential shapes, matched against the *content* of every text entry in the
 * archive rather than against filenames.
 *
 * A filename denylist only catches a secret that someone was kind enough to
 * name `.env`. A key pasted into any `src/**` file is inlined into the bundle
 * by esbuild and ships under a perfectly innocent name, so the audit has to
 * read the bytes it is vouching for.
 */
const SECRET_PATTERNS = [
    [/AccountKey=[A-Za-z0-9+/=]{20,}/, 'a storage account key'],
    [/[?&]sig=[A-Za-z0-9%+/=]{20,}/, 'a SAS signature'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'a JSON Web Token'],
    [/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
    [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
];

/** Entries whose bytes are text worth scanning for a credential. */
const TEXT_ENTRY = /\.(js|css|json|md|txt|svg|html|xml|map|vsixmanifest)$/i;

/** Bundle text with the documented vendor exceptions removed. */
function scannableBundle(code) {
    let scannable = code;
    for (const pattern of VENDOR_LITERAL_EXCEPTIONS) {
        scannable = scannable.replace(pattern, '');
    }
    return scannable;
}

/** Hard ceiling for the packaged extension. Exceeding it is a packaging bug. */
const MAX_VSIX_BYTES = 5 * 1024 * 1024;

function findVsix() {
    const explicit = process.argv.slice(2).find((arg) => arg.endsWith('.vsix'));
    if (explicit) {
        return path.resolve(explicit);
    }
    const dist = path.join(repoRoot, 'dist');
    if (!fs.existsSync(dist)) {
        throw new Error('no dist directory; run "npm run package" first');
    }
    const candidates = fs
        .readdirSync(dist)
        .filter((name) => name.endsWith('.vsix'))
        .map((name) => path.join(dist, name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (candidates.length === 0) {
        throw new Error('no .vsix in dist; run "npm run package" first');
    }
    return candidates[0];
}

function auditVsix(vsixPath) {
    const archive = fs.readFileSync(vsixPath);
    const entries = unzipSync(new Uint8Array(archive));
    const names = Object.keys(entries).sort();
    const problems = [];

    for (const name of names) {
        const normalized = name.replace(/\\/g, '/');
        // Metadata vsce always writes; not extension content.
        if (normalized === '[Content_Types].xml' || normalized === 'extension.vsixmanifest') {
            continue;
        }
        for (const [pattern, label] of FORBIDDEN_PATHS) {
            if (pattern.test(normalized)) {
                problems.push(`${normalized} is ${label}`);
            }
        }
    }

    const required = [...REQUIRED_PATHS, ...manifestAssets().map((asset) => [asset])];
    for (const accepted of required) {
        if (!accepted.some((name) => names.includes(name))) {
            problems.push(`${accepted[0]} is missing from the package`);
        }
    }

    // Every shipped script, not just the extension-host bundle. `media/webview/main.js`
    // is 30 KiB of JavaScript that ships and runs; policing only the bundle
    // would leave the renderer free to reacquire a backend.
    for (const name of names) {
        if (!name.endsWith('.js')) {
            continue;
        }
        const code = Buffer.from(entries[name]).toString('utf8');
        const shortName = name.replace(/^extension\//, '');
        for (const [pattern, label] of FORBIDDEN_BUNDLE_STRINGS) {
            if (pattern.test(code)) {
                problems.push(`${shortName} contains ${label}`);
            }
        }
        // Only the loopback rule gets the vendor exception, so an excised span
        // cannot hide a credential from the secret scan below.
        if (LOOPBACK_URL[0].test(scannableBundle(code))) {
            problems.push(`${shortName} contains ${LOOPBACK_URL[1]}`);
        }
    }

    const bundle = entries['extension/dist/extension.js'];
    if (bundle && !/require\((["'])vscode\1\)/.test(Buffer.from(bundle).toString('utf8'))) {
        problems.push('dist/extension.js does not require the vscode module');
    }

    // Every shipped text file, not just the bundle: a credential pasted into
    // any source file is inlined by esbuild, and one pasted into the README or
    // a walkthrough step ships verbatim.
    for (const name of names) {
        if (!TEXT_ENTRY.test(name)) {
            continue;
        }
        let text = Buffer.from(entries[name]).toString('utf8');
        if (name === 'extension/dist/extension.js') {
            text = scannableBundle(text);
        }
        for (const [pattern, label] of SECRET_PATTERNS) {
            if (pattern.test(text)) {
                problems.push(`${name} appears to contain ${label}`);
            }
        }
    }

    const totalBytes = fs.statSync(vsixPath).size;
    if (totalBytes > MAX_VSIX_BYTES) {
        problems.push(
            `the package is ${(totalBytes / 1024 / 1024).toFixed(2)} MB, over the ` +
                `${MAX_VSIX_BYTES / 1024 / 1024} MB ceiling`,
        );
    }

    const files = names
        .map((name) => ({ name, bytes: entries[name].length }))
        .sort((a, b) => b.bytes - a.bytes);

    return { vsixPath, totalBytes, files, problems };
}

function main() {
    const report = auditVsix(findVsix());
    if (process.argv.includes('--json')) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(report, null, 2));
    } else {
        // eslint-disable-next-line no-console
        console.log(
            `${path.basename(report.vsixPath)} — ${(report.totalBytes / 1024).toFixed(1)} KiB ` +
                `compressed, ${report.files.length} entries`,
        );
        for (const file of report.files) {
            // eslint-disable-next-line no-console
            console.log(`  ${(file.bytes / 1024).toFixed(1).padStart(9)} KiB  ${file.name}`);
        }
    }
    if (report.problems.length > 0) {
        console.error('\nVSIX audit failed:');
        for (const problem of report.problems) {
            console.error(`  - ${problem}`);
        }
        process.exit(1);
    }
    // Stated as what was checked, not as a guarantee. A filename denylist plus
    // a set of credential shapes is a strong gate, but it is not proof that no
    // secret of an unrecognised form is present.
    // eslint-disable-next-line no-console
    console.log(
        '\nVSIX audit passed: no Python, sources, dependencies, tests or fixtures; ' +
            'no backend runtime in the bundle; no credential-shaped filenames or ' +
            `content matching ${SECRET_PATTERNS.length} known secret patterns.`,
    );
}

module.exports = {
    auditVsix,
    manifestAssets,
    scannableBundle,
    FORBIDDEN_PATHS,
    REQUIRED_PATHS,
    FORBIDDEN_BUNDLE_STRINGS,
    LOOPBACK_URL,
    SECRET_PATTERNS,
    VENDOR_LITERAL_EXCEPTIONS,
};

if (require.main === module) {
    main();
}
