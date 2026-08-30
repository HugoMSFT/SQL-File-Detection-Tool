/**
 * Tests for the webview document shell and the bundled renderer assets.
 *
 * The shell is the security envelope for everything the user sees, so the CSP,
 * the nonce and the absence of any inline or remote execution path are asserted
 * directly, and the bundled script is scanned for the APIs it has promised not
 * to use.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildWebviewHtml, contentSecurityPolicy, createNonce } from '../ui/webviewShell';

const mediaDir = path.join(__dirname, '..', '..', 'media', 'webview');
const script = fs.readFileSync(path.join(mediaDir, 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(mediaDir, 'main.css'), 'utf8');

/**
 * The script with comments removed.
 *
 * The file documents the APIs it refuses to use, so a naive substring scan
 * would match its own prose. Only executable text is checked.
 */
const scriptCode = script
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

function render(surface: 'sidebar' | 'panel' = 'sidebar'): string {
    return buildWebviewHtml({
        nonce: 'TESTNONCE123',
        cspSource: 'vscode-webview://abc',
        scriptUri: 'vscode-webview://abc/media/webview/main.js',
        styleUri: 'vscode-webview://abc/media/webview/main.css',
        surface,
    });
}

test('nonces are random, long enough and alphanumeric', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
        const nonce = createNonce();
        assert.match(nonce, /^[A-Za-z0-9]+$/);
        assert.ok(nonce.length >= 16, `nonce too short: ${nonce}`);
        assert.ok(!seen.has(nonce), 'nonces must not repeat');
        seen.add(nonce);
    }
});

test('the CSP denies everything by default and allows no inline or remote code', () => {
    const policy = contentSecurityPolicy('N0NCE', 'vscode-webview://abc');
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /script-src 'nonce-N0NCE'/);
    assert.match(policy, /style-src vscode-webview:\/\/abc/);
    assert.ok(!policy.includes('unsafe-inline'));
    assert.ok(!policy.includes('unsafe-eval'));
    assert.ok(!policy.includes('*'));
    assert.ok(!policy.includes('http:'));
    assert.ok(!policy.includes('https:'));
    assert.ok(
        !policy.includes('connect-src'),
        'omitting connect-src leaves default-src none, so the renderer cannot call out',
    );
});

test('the document carries the CSP and the nonce on its only script', () => {
    const html = render();
    assert.match(html, /<meta http-equiv="Content-Security-Policy"/);
    assert.match(html, /script-src 'nonce-TESTNONCE123'/);
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    assert.equal(scripts.length, 1, 'exactly one script tag');
    assert.match(scripts[0], /nonce="TESTNONCE123"/);
    assert.match(scripts[0], /src="vscode-webview:\/\/abc\/media\/webview\/main\.js"/);
});

test('the document has no inline handlers, inline styles or javascript: urls', () => {
    const html = render();
    assert.ok(!/\son[a-z]+\s*=\s*"/i.test(html), 'no inline event handler attributes');
    assert.ok(!/<style\b/i.test(html), 'no inline style element');
    assert.ok(!/\sstyle\s*=/i.test(html), 'no style attributes');
    assert.ok(!/javascript:/i.test(html));
    // The only external references are the two extension-owned webview URIs.
    const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    for (const reference of references) {
        assert.ok(
            reference.startsWith('vscode-webview://') || reference.startsWith('#'),
            `unexpected resource reference: ${reference}`,
        );
    }
    assert.ok(!/http:\/\//i.test(html), 'no plaintext http reference anywhere');
});

test('both surfaces render the same inert shell with a surface marker', () => {
    const sidebar = render('sidebar');
    const panel = render('panel');
    assert.match(sidebar, /<body class="surface-sidebar" data-surface="sidebar">/);
    assert.match(panel, /<body class="surface-panel" data-surface="panel">/);
    const normalise = (html: string, surface: string): string =>
        html.replace(
            `<body class="surface-${surface}" data-surface="${surface}">`,
            '<body>',
        );
    assert.equal(
        normalise(sidebar, 'sidebar'),
        normalise(panel, 'panel'),
        'the two surfaces must not diverge structurally',
    );
});

test('the shell ships templates rather than rendered data', () => {
    const html = render();
    for (const id of [
        'tpl-file-item',
        'tpl-tab',
        'tpl-kv',
        'tpl-sql',
        'tpl-limitation',
        'tpl-schema-row',
        'tpl-azure',
        'tpl-format-row',
    ]) {
        assert.ok(html.includes(`id="${id}"`), `${id} template is missing`);
    }
});

test('the shell exposes the whole product workflow, not a launcher', () => {
    const html = render();
    for (const action of [
        'openFileDialog',
        'openFolderDialog',
        'analyzeCurrentFile',
        'analyzeWorkspaceFolder',
        'exportAllSql',
        'openInEditor',
        'publicUrlAnalyze',
        'azureDisconnect',
        'showOrcGuidance',
    ]) {
        assert.ok(html.includes(`data-action="${action}"`), `${action} is not reachable`);
    }
    for (const mode of ['vscode', 'sas', 'connectionString', 'anonymous']) {
        assert.ok(html.includes(`data-azure-connect="${mode}"`), `${mode} is not offered`);
    }
});

test('the shell has no trace of the removed server flow', () => {
    const html = render().toLowerCase();
    for (const banned of [
        /localhost/,
        /127\.0\.0\.1/,
        /simplebrowser/,
        /\bflask\b/,
        /\bpython\b/,
        /\bpip\b/,
        /\bvenv\b/,
        /\bbackend\b/,
        /\bport\b/,
        /\bspawn\b/,
    ]) {
        assert.ok(!banned.test(html), `the shell still mentions ${banned}`);
    }
});

test('accessibility landmarks and live regions are present', () => {
    const html = render();
    assert.match(html, /class="skip-link"/);
    assert.match(html, /role="status"[^>]*aria-live="polite"/);
    assert.match(html, /id="error" class="error" role="alert"/);
    assert.match(html, /role="toolbar"/);
    assert.match(html, /role="tablist"/);
    assert.match(html, /role="tabpanel"/);
    assert.match(html, /role="listbox"/);
    assert.match(html, /<main class="content" id="main" tabindex="-1">/);
});

// -- bundled renderer -------------------------------------------------------

test('the renderer never constructs markup from strings', () => {
    for (const banned of [
        'innerHTML',
        'outerHTML',
        'insertAdjacentHTML',
        'document.write',
        'eval(',
        'new Function',
        "setAttribute('on",
    ]) {
        assert.ok(!scriptCode.includes(banned), `main.js uses ${banned}`);
    }
});

test('the renderer has no network capability of its own', () => {
    for (const banned of [
        'fetch(',
        'XMLHttpRequest',
        'WebSocket',
        'EventSource',
        'navigator.sendBeacon',
        'import(',
        'localStorage',
        'sessionStorage',
        'document.cookie',
    ]) {
        assert.ok(!scriptCode.includes(banned), `main.js uses ${banned}`);
    }
});

test('the renderer talks to the host only through postMessage', () => {
    assert.ok(script.includes('acquireVsCodeApi()'));
    assert.ok(script.includes('vscode.postMessage(message)'));
    assert.ok(
        script.includes("window.addEventListener('message'"),
        'the renderer must listen for host state',
    );
    assert.ok(
        script.includes("message.type !== 'state'"),
        'the renderer must ignore anything that is not a state envelope',
    );
});

test('the renderer renders values as text, never as markup', () => {
    assert.ok(script.includes('textContent'));
    // Templates are cloned rather than built.
    assert.ok(script.includes('cloneNode(true)'));
});

test('the stylesheet uses theme variables rather than fixed colours', () => {
    assert.ok(styles.includes('var(--vscode-foreground)'));
    assert.ok(styles.includes('var(--vscode-button-background)'));
    assert.ok(
        !/#[0-9a-f]{3,8}\b/i.test(styles),
        'a literal colour would break light, dark or high contrast themes',
    );
    assert.ok(styles.includes('prefers-reduced-motion'), 'reduced motion must be honoured');
    assert.ok(styles.includes('--vscode-contrastBorder'), 'high contrast borders must be used');
    assert.ok(
        !styles.includes('@import') && !styles.includes('url(http'),
        'the stylesheet must not pull a remote resource',
    );
});

test('the renderer keeps the keyboard workflow', () => {
    assert.ok(script.includes("'ArrowDown'"));
    assert.ok(script.includes("'ArrowUp'"));
    assert.ok(script.includes("'Home'"));
    assert.ok(script.includes("'End'"));
    assert.ok(script.includes('aria-selected'));
});
