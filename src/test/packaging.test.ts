/**
 * Packaging guarantees for the shipped extension.
 *
 * Version 2.0 makes a specific promise: the VSIX is a native extension with no
 * Python in it. These tests are what make that promise checkable rather than
 * merely stated. They work at three levels, because each one can be defeated on
 * its own:
 *
 *   1. `.vscodeignore` is an allowlist, so a file added to the repository later
 *      cannot ship by accident.
 *   2. `dist/extension.js` — the artifact VS Code actually loads — is scanned
 *      for the vocabulary of the removed runtime, because an ignore list can
 *      only police file *names*.
 *   3. The built `.vsix`, when one is present, is opened and audited entry by
 *      entry through `scripts/audit-vsix.js`.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

const REPO = path.resolve(__dirname, '..', '..');
const BUNDLE = path.join(REPO, 'dist', 'extension.js');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const audit = require(path.join(REPO, 'scripts', 'audit-vsix.js')) as {
    auditVsix(vsixPath: string): {
        totalBytes: number;
        files: Array<{ name: string; bytes: number }>;
        problems: string[];
    };
    scannableBundle(code: string): string;
    manifestAssets(): string[];
    FORBIDDEN_BUNDLE_STRINGS: ReadonlyArray<readonly [RegExp, string]>;
    LOOPBACK_URL: readonly [RegExp, string];
    SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]>;
};

const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
    version: string;
    main: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    activationEvents: string[];
    contributes: Record<string, unknown>;
};

function readBundle(): string {
    assert.ok(
        fs.existsSync(BUNDLE),
        'dist/extension.js is missing; run "npm run bundle" before the tests',
    );
    return fs.readFileSync(BUNDLE, 'utf8');
}

test('the manifest points at the bundle and builds it before publishing', () => {
    assert.equal(manifest.main, './dist/extension.js');
    assert.match(manifest.scripts['vscode:prepublish'], /bundle/);
    assert.match(manifest.scripts.bundle, /scripts\/build\.js/);
});

test('the extension stays on the first Marketplace release line', () => {
    assert.match(manifest.version, /^1\.0\.\d+$/);
});

test('activation is scoped to the Activity Bar view, never to startup', () => {
    for (const event of manifest.activationEvents) {
        assert.ok(
            !['*', 'onStartupFinished'].includes(event),
            `${event} would activate the extension before the user asks for it`,
        );
        assert.match(event, /^on(View|Command):sqlFileDetectionTool\./);
    }
    assert.deepEqual(manifest.activationEvents, ['onView:sqlFileDetectionTool.sidebar']);
});

test('runtime dependencies are the four the native core needs', () => {
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
        'chardet',
        'fflate',
        'hyparquet',
        'iconv-lite',
    ]);
    assert.ok(!Object.keys(manifest.devDependencies).some((name) => name.startsWith('@azure/')));
});

test('.vscodeignore excludes everything and then allows the payload back', () => {
    const lines = fs
        .readFileSync(path.join(REPO, '.vscodeignore'), 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));

    assert.equal(lines[0], '**', 'the first rule must exclude everything');
    for (const line of lines.slice(1)) {
        assert.ok(line.startsWith('!'), `${line} would widen the package beyond the allowlist`);
    }
    for (const allowed of lines.slice(1)) {
        assert.ok(
            !/\*/.test(allowed),
            `${allowed} allows a glob; every shipped file must be named explicitly`,
        );
        assert.ok(
            fs.existsSync(path.join(REPO, allowed.slice(1))),
            `${allowed} is allowed into the package but does not exist`,
        );
    }
    for (const required of [
        '!dist/extension.js',
        '!MARKETPLACE.md',
        '!MARKETPLACE_CHANGELOG.md',
        '!LICENSE',
    ]) {
        assert.ok(lines.includes(required), `${required} must be shipped`);
    }
});

test('the allowlist admits every asset the manifest contributes', () => {
    // The other direction of the check above: that one proves everything
    // allowed exists on disk, this one proves everything the manifest promises
    // is allowed. Without it, deleting a `!media/walkthrough/*.md` line ships a
    // package whose walkthrough steps are all broken, and every other packaging
    // assertion still passes.
    const allowed = new Set(
        fs
            .readFileSync(path.join(REPO, '.vscodeignore'), 'utf8')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.startsWith('!'))
            .map((line) => line.slice(1)),
    );
    const declared = audit.manifestAssets().map((asset) => asset.replace(/^extension\//, ''));
    assert.ok(declared.length > 0, 'the manifest declares no assets, so this test proves nothing');
    for (const asset of declared) {
        assert.ok(allowed.has(asset), `${asset} is contributed by package.json but not shipped`);
    }
});

test('the bundle carries no Python, server or spawn vocabulary', () => {
    const code = readBundle();
    for (const [pattern, label] of audit.FORBIDDEN_BUNDLE_STRINGS) {
        assert.ok(!pattern.test(code), `the bundle contains ${label}`);
    }
    const [loopback, loopbackLabel] = audit.LOOPBACK_URL;
    assert.ok(
        !loopback.test(audit.scannableBundle(code)),
        `the bundle contains ${loopbackLabel}`,
    );
});

test('the bundle carries nothing shaped like a credential', () => {
    const code = audit.scannableBundle(readBundle());
    for (const [pattern, label] of audit.SECRET_PATTERNS) {
        assert.ok(!pattern.test(code), `the bundle appears to contain ${label}`);
    }
});

test('the secret patterns actually match the credentials they name', () => {
    // A scan that cannot recognise a planted secret is decoration. Each pattern
    // is proved against a synthetic value of its own shape, so the audit's
    // green result means something.
    const planted = [
        'AccountKey=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF==',
        'https://acct.blob.core.windows.net/c/b?sv=2022-11-02&sig=aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsbw%3D%3D',
        '-----BEGIN RSA PRIVATE KEY-----',
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
        'ghp_0123456789abcdefghijklmnopqrstuvwx',
        'xoxb-0123456789-0123456789-abcdefghij',
        'AKIAIOSFODNN7EXAMPLE',
    ];
    assert.equal(planted.length, audit.SECRET_PATTERNS.length);
    audit.SECRET_PATTERNS.forEach(([pattern, label], index) => {
        assert.ok(pattern.test(planted[index]), `${label} pattern does not match its own shape`);
    });
});

test('the bundle inlines its dependencies and externalises only vscode', () => {
    const code = readBundle();
    for (const dependency of Object.keys(manifest.dependencies)) {
        const pattern = new RegExp(`require\\((["'])${dependency.replace('/', '\\/')}\\1\\)`);
        assert.ok(!pattern.test(code), `${dependency} was left unbundled`);
    }
    assert.match(code, /require\((["'])vscode\1\)/);
});

test('the bundle stays within a size that loads quickly', () => {
    const bytes = fs.statSync(BUNDLE).size;
    // Dominated by the iconv-lite CJK tables. The ceiling leaves headroom for
    // dependency updates while still failing if node_modules is inlined wholesale.
    assert.ok(
        bytes < 3 * 1024 * 1024,
        `the bundle is ${(bytes / 1024 / 1024).toFixed(2)} MiB`,
    );
});

test('the third party notices cover every bundled package', () => {
    const notices = fs.readFileSync(path.join(REPO, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    for (const dependency of Object.keys(manifest.dependencies)) {
        assert.ok(notices.includes(`\`${dependency}\``), `${dependency} is not in the notices`);
    }
    assert.ok(!/UNKNOWN/.test(notices), 'a bundled package has no license metadata');
});

test('a built VSIX contains no Python, sources, dependencies or secrets', (t) => {
    const dist = path.join(REPO, 'dist');
    const vsix = `sql-file-detection-tool-${manifest.version}.vsix`;
    if (!fs.existsSync(path.join(dist, vsix))) {
        t.skip('no .vsix in dist; run "npm run package" to audit the real archive');
        return;
    }
    const report = audit.auditVsix(path.join(dist, vsix));
    assert.deepEqual(report.problems, [], report.problems.join('; '));
    assert.ok(
        report.totalBytes < 5 * 1024 * 1024,
        `${vsix} is ${(report.totalBytes / 1024 / 1024).toFixed(2)} MB`,
    );
});
