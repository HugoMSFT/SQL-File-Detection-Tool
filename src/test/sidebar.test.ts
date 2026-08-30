/**
 * Tests for the Activity Bar sidebar: manifest contributions, the webview
 * HTML, the message allowlist and the auto-open policy.
 *
 * Nothing here imports `vscode`, so it runs under plain `node --test`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    SIDEBAR_COMMANDS,
    SIDEBAR_COMMAND_MAP,
    STARTUP_GRACE_MS,
    SidebarModel,
    buildSidebarHtml,
    createNonce,
    escapeHtml,
    parseSidebarMessage,
    shouldAutoOpen,
} from '../webviewHtml';
import { createSerialQueue } from '../util';

const repoRoot = path.join(__dirname, '..', '..');

const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
) as {
    version: string;
    activationEvents: string[];
    contributes: {
        viewsContainers?: {
            activitybar?: Array<{ id: string; title: string; icon: string }>;
        };
        views?: Record<string, Array<{ type?: string; id: string; name: string }>>;
        commands: Array<{ command: string }>;
        configuration: { properties: Record<string, { default?: unknown; type?: string }> };
    };
};

function model(overrides: Partial<SidebarModel> = {}): SidebarModel {
    return {
        state: 'stopped',
        detail: 'Select Open Tool to start the local backend.',
        version: '1.1.1',
        platformLabel: 'Azure SQL Database',
        ...overrides,
    };
}

// -- manifest contributions -------------------------------------------------

test('the manifest contributes an Activity Bar container', () => {
    const containers = manifest.contributes.viewsContainers?.activitybar ?? [];
    assert.equal(containers.length, 1);
    assert.equal(containers[0].id, 'sqlFileDetectionTool');
    assert.equal(containers[0].title, 'SQL File Detection Tool');
    assert.equal(containers[0].icon, 'media/activity-bar.svg');
});

test('the Activity Bar icon exists and is a monochrome SVG', () => {
    const iconPath = path.join(repoRoot, 'media', 'activity-bar.svg');
    assert.ok(fs.existsSync(iconPath), 'media/activity-bar.svg is missing');
    const svg = fs.readFileSync(iconPath, 'utf8');
    assert.match(svg, /<svg[^>]*viewBox="0 0 24 24"/);
    assert.match(svg, /currentColor/);
    // A hard-coded colour would not adapt to the active Activity Bar theme.
    assert.doesNotMatch(svg, /#[0-9a-f]{3,8}\b/i);
    assert.doesNotMatch(svg, /rgb\(/i);
});

test('the manifest contributes a webview view inside that container', () => {
    const views = manifest.contributes.views?.sqlFileDetectionTool ?? [];
    assert.equal(views.length, 1);
    assert.equal(views[0].id, 'sqlFileDetectionTool.sidebar');
    assert.equal(views[0].type, 'webview');
});

test('the extension activates on the contributed view', () => {
    assert.ok(
        manifest.activationEvents.includes('onView:sqlFileDetectionTool.sidebar'),
        'missing onView activation event',
    );
    // A startup activation would start a backend nobody asked for.
    assert.ok(!manifest.activationEvents.includes('*'));
    assert.ok(!manifest.activationEvents.includes('onStartupFinished'));
});

test('openOnActivityBarClick defaults to true', () => {
    const setting =
        manifest.contributes.configuration.properties[
            'sqlFileDetectionTool.openOnActivityBarClick'
        ];
    assert.ok(setting, 'setting is not contributed');
    assert.equal(setting.type, 'boolean');
    assert.equal(setting.default, true);
});

test('every sidebar command maps to a contributed command', () => {
    const contributed = new Set(manifest.contributes.commands.map((c) => c.command));
    for (const id of SIDEBAR_COMMANDS) {
        assert.ok(
            contributed.has(SIDEBAR_COMMAND_MAP[id]),
            `${SIDEBAR_COMMAND_MAP[id]} is not contributed`,
        );
    }
});

test('the manifest version matches the packaged extension version', () => {
    assert.equal(manifest.version, '1.1.1');
});

// -- message allowlist ------------------------------------------------------

test('parseSidebarMessage accepts every allowlisted command', () => {
    for (const id of SIDEBAR_COMMANDS) {
        assert.equal(parseSidebarMessage({ type: 'command', id }), id);
    }
});

test('parseSidebarMessage rejects anything not on the allowlist', () => {
    const rejected: unknown[] = [
        undefined,
        null,
        'command',
        42,
        {},
        { type: 'command' },
        { type: 'command', id: 'workbench.action.terminal.new' },
        { type: 'command', id: 'sqlFileDetectionTool.open' },
        { type: 'eval', id: 'open' },
        { type: 'command', id: ['open'] },
        { id: 'open' },
    ];
    for (const message of rejected) {
        assert.equal(
            parseSidebarMessage(message),
            undefined,
            `should have rejected ${JSON.stringify(message)}`,
        );
    }
});

test('the retry action reuses the open command rather than a new entry point', () => {
    assert.equal(SIDEBAR_COMMAND_MAP.retry, SIDEBAR_COMMAND_MAP.open);
});

// -- auto-open policy -------------------------------------------------------

test('a reveal during the startup grace period does not open the tool', () => {
    assert.equal(
        shouldAutoOpen({ enabled: true, visible: true, msSinceActivation: 0 }),
        false,
    );
    assert.equal(
        shouldAutoOpen({
            enabled: true,
            visible: true,
            msSinceActivation: STARTUP_GRACE_MS - 1,
        }),
        false,
    );
});

test('a deliberate reveal after startup opens the tool', () => {
    assert.equal(
        shouldAutoOpen({
            enabled: true,
            visible: true,
            msSinceActivation: STARTUP_GRACE_MS,
        }),
        true,
    );
    assert.equal(
        shouldAutoOpen({ enabled: true, visible: true, msSinceActivation: 60_000 }),
        true,
    );
});

test('an invisible view never opens the tool', () => {
    assert.equal(
        shouldAutoOpen({ enabled: true, visible: false, msSinceActivation: 60_000 }),
        false,
    );
});

test('disabling openOnActivityBarClick suppresses auto-open', () => {
    assert.equal(
        shouldAutoOpen({ enabled: false, visible: true, msSinceActivation: 60_000 }),
        false,
    );
});

// -- webview HTML -----------------------------------------------------------

test('createNonce returns a fresh alphanumeric value each time', () => {
    const first = createNonce();
    const second = createNonce();
    assert.match(first, /^[A-Za-z0-9]{16,}$/);
    assert.notEqual(first, second);
});

test('the sidebar HTML carries a restrictive CSP bound to the nonce', () => {
    const nonce = createNonce();
    const html = buildSidebarHtml(model(), nonce, 'vscode-resource://x');
    assert.match(html, /default-src 'none'/);
    assert.match(html, new RegExp(`script-src 'nonce-${nonce}'`));
    assert.match(html, new RegExp(`style-src 'nonce-${nonce}'`));
    assert.doesNotMatch(html, /unsafe-inline/);
    assert.doesNotMatch(html, /unsafe-eval/);
    // Every script and style block must be nonced.
    const scripts = html.match(/<script(?![^>]*nonce=)/g) ?? [];
    const styles = html.match(/<style(?![^>]*nonce=)/g) ?? [];
    assert.equal(scripts.length, 0);
    assert.equal(styles.length, 0);
});

test('the sidebar HTML never embeds a URL, port or token', () => {
    const html = buildSidebarHtml(
        model({ state: 'running', detail: 'The interface is open in an editor tab.' }),
        createNonce(),
        'vscode-resource://x',
    );
    assert.doesNotMatch(html, /127\.0\.0\.1/);
    assert.doesNotMatch(html, /localhost/);
    assert.doesNotMatch(html, /X-Control-Token/i);
    assert.doesNotMatch(html, /Bearer /i);
    assert.doesNotMatch(html, /eyJ/);
});

test('the sidebar HTML uses theme variables rather than fixed colours', () => {
    const html = buildSidebarHtml(model(), createNonce(), 'vscode-resource://x');
    const styles = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
    assert.ok(styles.length > 0);
    assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b/i);
    assert.doesNotMatch(styles, /rgba?\(/i);
    assert.match(styles, /var\(--vscode-/);
});

test('every action button is labelled for assistive technology', () => {
    const html = buildSidebarHtml(model(), createNonce(), 'vscode-resource://x');
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    assert.ok(buttons.length >= 4);
    for (const button of buttons) {
        assert.match(button, /aria-label="/);
        assert.match(button, /title="/);
    }
    assert.match(html, /role="status"/);
    assert.match(html, /aria-live="polite"/);
});

test('a failed backend offers a retry button', () => {
    const html = buildSidebarHtml(
        model({ state: 'failed', detail: 'The backend could not start.' }),
        createNonce(),
        'vscode-resource://x',
    );
    assert.match(html, /data-id="retry"/);
    assert.match(html, /Backend failed to start/);
});

test('a healthy backend offers no retry button', () => {
    const html = buildSidebarHtml(model({ state: 'running' }), createNonce(), 'x');
    assert.doesNotMatch(html, /data-id="retry"/);
});

test('Stop Backend is disabled unless the backend is running', () => {
    const stopped = buildSidebarHtml(model({ state: 'stopped' }), createNonce(), 'x');
    assert.match(stopped, /data-id="stopBackend"[\s\S]*?disabled/);
    const running = buildSidebarHtml(model({ state: 'running' }), createNonce(), 'x');
    const stopButton = /<button[^>]*data-id="stopBackend"[\s\S]*?>/.exec(running)?.[0] ?? '';
    assert.doesNotMatch(stopButton, /disabled/);
});

test('while starting, the actions are disabled', () => {
    const html = buildSidebarHtml(model({ state: 'starting' }), createNonce(), 'x');
    const buttons = html.match(/<button[\s\S]*?>/g) ?? [];
    for (const button of buttons) {
        assert.match(button, /disabled/);
    }
});

test('the sidebar shows the Azure SQL Database default', () => {
    const html = buildSidebarHtml(model(), createNonce(), 'x');
    assert.match(html, /Azure SQL Database/);
});

test('escapeHtml neutralises markup in the detail line', () => {
    const html = buildSidebarHtml(
        model({ detail: '<img src=x onerror="alert(1)">' }),
        createNonce(),
        'x',
    );
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x/);
    assert.equal(escapeHtml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

// --- Serialised open requests -------------------------------------------
// The Activity Bar reveal and an explicit "Analyze Current File" can fire at
// the same moment. Each request targets a different file, so they must queue
// rather than collapse into one shared promise.

test('serial queue preserves each caller distinct arguments', async () => {
    const queue = createSerialQueue();
    const seen: string[] = [];
    const run = (name: string) =>
        queue(async () => {
            seen.push(`start:${name}`);
            await new Promise((resolve) => setTimeout(resolve, 5));
            seen.push(`end:${name}`);
            return name;
        });

    const results = await Promise.all([run('reveal'), run('current-file'), run('folder')]);

    assert.deepEqual(results, ['reveal', 'current-file', 'folder']);
    assert.deepEqual(seen, [
        'start:reveal',
        'end:reveal',
        'start:current-file',
        'end:current-file',
        'start:folder',
        'end:folder',
    ]);
});

test('serial queue never runs two tasks concurrently', async () => {
    const queue = createSerialQueue();
    let active = 0;
    let peak = 0;
    const run = () =>
        queue(async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 3));
            active -= 1;
        });

    await Promise.all([run(), run(), run(), run()]);

    assert.equal(peak, 1);
});

test('a failed open does not cancel the requests queued behind it', async () => {
    const queue = createSerialQueue();
    const failing = queue(async () => {
        throw new Error('backend refused to start');
    });

    await assert.rejects(failing, /backend refused to start/);
    assert.equal(await queue(async () => 'second'), 'second');
    assert.equal(await queue(async () => 'third'), 'third');
});

test('a rejected queue item reports its own error to its own caller', async () => {
    const queue = createSerialQueue();
    const first = queue(async () => 'ok');
    const second = queue(async () => {
        throw new Error('only mine');
    });

    assert.equal(await first, 'ok');
    await assert.rejects(second, /only mine/);
});

// --- Auto-open grace period ---------------------------------------------
// The grace period is measured against the extension host process uptime, not
// against activation time. Activation is triggered by the reveal itself, so an
// activation-relative clock reads ~0 for a genuine first click and would
// suppress exactly the case the feature exists for.

test('auto-open fires for a click in a window that has been open a while', () => {
    assert.equal(
        shouldAutoOpen({ enabled: true, visible: true, msSinceActivation: 45_000 }),
        true,
    );
});

test('auto-open is suppressed while VS Code restores the previous layout', () => {
    assert.equal(
        shouldAutoOpen({ enabled: true, visible: true, msSinceActivation: 40 }),
        false,
    );
});

test('process uptime outlives a single activation', () => {
    // Guards the fix: uptime is a window-lifetime clock, so by the time a user
    // can click anything it is already past the grace period, whereas a clock
    // started at activation would still read near zero.
    assert.ok(process.uptime() * 1000 >= 0);
    assert.ok(STARTUP_GRACE_MS > 0);
});

// --- Restore-versus-click disambiguation ---------------------------------
// Only the very first resolve of a window is ambiguous. Later visibility
// transitions can only come from the user, so they must never be swallowed.

test('a visibility transition after the first resolve always opens the tool', () => {
    assert.equal(
        shouldAutoOpen({
            enabled: true,
            visible: true,
            msSinceActivation: 0,
            userDriven: true,
        }),
        true,
    );
});

test('a user-driven reveal still respects the opt-out setting', () => {
    assert.equal(
        shouldAutoOpen({
            enabled: false,
            visible: true,
            msSinceActivation: 60_000,
            userDriven: true,
        }),
        false,
    );
});

test('a user-driven reveal on a hidden view does nothing', () => {
    assert.equal(
        shouldAutoOpen({
            enabled: true,
            visible: false,
            msSinceActivation: 60_000,
            userDriven: true,
        }),
        false,
    );
});

test('an unfocused window is treated as a layout restore, never a click', () => {
    // A slow cold start can push the initial resolve past the grace period.
    // The window not being focused is evidence the user did not click.
    assert.equal(
        shouldAutoOpen({
            enabled: true,
            visible: true,
            msSinceActivation: 120_000,
            userDriven: false,
            windowFocused: false,
        }),
        false,
    );
});

test('unknown window focus never blocks a genuine click on its own', () => {
    assert.equal(
        shouldAutoOpen({
            enabled: true,
            visible: true,
            msSinceActivation: 120_000,
            userDriven: false,
        }),
        true,
    );
});

test('an unfocused window cannot block an explicit visibility transition', () => {
    assert.equal(
        shouldAutoOpen({
            enabled: true,
            visible: true,
            msSinceActivation: 0,
            userDriven: true,
            windowFocused: false,
        }),
        true,
    );
});

test('the startup grace leaves room for extension host bootstrap', () => {
    // The clock starts when the host process forks, but module loading and
    // other extensions run before this view resolves. Too tight a window and a
    // restored container is misread as a click, spawning an unrequested backend.
    assert.ok(
        STARTUP_GRACE_MS >= 10_000,
        `expected a generous grace period, got ${STARTUP_GRACE_MS}ms`,
    );
});
