'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { containedPath, temporaryRoot, redact, isolatedEnvironment, runProcess, sha256 } = require('../tooling-support');
const {
    cliScript, launchArguments, processDescendants, waitFor, resolveExecutable,
    revealNamingControls, selectAllStable,
    visibleWebview,
} = require('../installed-smoke');
const { fixtureBytes, fixtureRows } = require('../regression-fixtures');

test('artifact paths reject traversal, absolute paths and symlink escapes', () => {
    const owned = temporaryRoot('sqlfdt-path-test-');
    try {
        for (const invalid of ['../x', '/x', 'a/../../x', 'C:/x', 'a\\x', './x', '', 'a//x']) {
            assert.throws(() => containedPath(owned.root, invalid));
        }
        assert.equal(containedPath(owned.root, 'a/b'), path.join(owned.root, 'a/b'));
        const outside = temporaryRoot('sqlfdt-outside-test-');
        try {
            fs.symlinkSync(outside.root, path.join(owned.root, 'escape'), 'junction');
            assert.throws(() => containedPath(owned.root, 'escape/file'), /symlink/);
        } finally { outside.cleanup(); }
    } finally { owned.cleanup(); }
});

test('owned temporary directory is removed even when work fails', () => {
    const owned = temporaryRoot('sqlfdt-failure-test-');
    assert.throws(() => {
        try {
            fs.writeFileSync(path.join(owned.root, 'fixture'), 'synthetic');
            throw new Error('intentional failure');
        } finally { owned.cleanup(); }
    }, /intentional/);
    assert.equal(fs.existsSync(owned.root), false);
});

test('cleanup refuses a replaced ownership marker', () => {
    const owned = temporaryRoot('sqlfdt-marker-test-');
    const marker = path.join(owned.root, '.sqlfdt-owned');
    const identity = fs.readFileSync(marker);
    try {
        fs.writeFileSync(marker, 'foreign');
        assert.throws(() => owned.cleanup(), /not owned/);
        assert.ok(fs.existsSync(owned.root));
    } finally {
        fs.writeFileSync(marker, identity);
        owned.cleanup();
    }
});

test('isolated children inherit neither credentials nor normal VS Code state', async () => {
    const owned = temporaryRoot('sqlfdt-env-test-');
    const previous = process.env.SQLFDT_SYNTHETIC_CREDENTIAL;
    process.env.SQLFDT_SYNTHETIC_CREDENTIAL = 'not-a-real-credential';
    try {
        const env = isolatedEnvironment(owned.root);
        assert.equal(env.SQLFDT_SYNTHETIC_CREDENTIAL, undefined);
        assert.equal(env.VSCODE_IPC_HOOK_CLI, undefined);
        assert.equal(env.NODE_OPTIONS, undefined);
        const result = await runProcess(process.execPath,
            ['-e', 'process.stdout.write(process.env.SQLFDT_SYNTHETIC_CREDENTIAL || "absent")'], { env });
        assert.equal(result.code, 0);
        assert.equal(result.stdout, 'absent');
        for (const key of ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'APPDATA', 'LOCALAPPDATA']) {
            assert.ok(env[key].startsWith(owned.root + path.sep));
        }
        const args = launchArguments(owned.root);
        assert.ok(args.includes(`--extensions-dir=${path.join(owned.root, 'extensions')}`));
        assert.ok(args.includes(`--user-data-dir=${path.join(owned.root, 'user-data')}`));
        assert.ok(args.some((arg) => arg.includes('smoke-driver')));
        assert.ok(args.includes('--disable-extension=vscode.microsoft-authentication'));
    } finally {
        if (previous === undefined) { delete process.env.SQLFDT_SYNTHETIC_CREDENTIAL; }
        else { process.env.SQLFDT_SYNTHETIC_CREDENTIAL = previous; }
        owned.cleanup();
    }
});

test('child timeout/cancellation and wait deadlines reject rather than silently succeed', async () => {
    await assert.rejects(runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { timeout: 50 }), /timed out/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { signal: controller.signal }), /canceled/);
    await assert.rejects(waitFor('missing condition', () => false, { timeout: 1 }), /Timed out/);
});

test('PID cleanup owns only the specific child tree, never another app', () => {
    const table = [
        { pid: 1, parent: 0 }, { pid: 12, parent: 1 }, { pid: 20, parent: 12 },
        { pid: 21, parent: 20 }, { pid: 99, parent: 1 }, { pid: 100, parent: 99 },
    ];
    assert.deepEqual(processDescendants(table, 12).map((row) => row.pid), [12, 20, 21]);
});

test('collapsed File settings is opened before interacting with naming controls', async () => {
    let visible = false;
    let clicks = 0;
    const input = {
        isVisible: async () => visible,
        waitFor: async () => assert.equal(visible, true),
    };
    const ui = { locator: (selector) => selector === '[data-edit="tableName"]'
        ? input
        : { filter: () => ({ click: async () => { clicks++; visible = true; } }) } };
    await revealNamingControls(ui);
    assert.equal(clicks, 1);
    await revealNamingControls(ui);
    assert.equal(clicks, 1, 'A visible baseline field does not require a settings disclosure');
});

function selectionControl(dispatch = true) {
    const calls = [];
    let disposed = false;
    const input = { value: 'before', selectionStart: 0, selectionEnd: 6, isConnected: true };
    const original = function (...args) {
        calls.push(args);
        return true;
    };
    input.ownerDocument = { activeElement: input, execCommand: original };
    return {
        input, original, calls, disposed: () => disposed,
        control: {
            press: async (key) => {
                assert.equal(key, 'ControlOrMeta+A');
                if (dispatch) {
                    setTimeout(() => input.ownerDocument.execCommand('selectAll', false, null), 25);
                }
            },
            evaluateHandle: async (callback) => {
                const state = callback(input);
                return {
                    evaluate: async (read) => read(state),
                    dispose: async () => { disposed = true; },
                };
            },
            evaluate: async (callback) => callback(input),
        },
    };
}

test('Select All waits for native completion, forwarding original arguments and restoring the method', async () => {
    const setup = selectionControl();
    await selectAllStable(setup.control);
    assert.deepEqual(setup.calls, [['selectAll', false, null]]);
    assert.equal(setup.input.ownerDocument.execCommand, setup.original);
    assert.equal(setup.disposed(), true);
});

test('a missing native Select All event times out and removes its observer', async () => {
    const setup = selectionControl(false);
    await assert.rejects(selectAllStable(setup.control, 10), /Timed out/);
    assert.equal(setup.input.ownerDocument.execCommand, setup.original);
    assert.equal(setup.disposed(), true);
});

test('webview selection rejects a retained hidden iframe even when its document looks visible', async () => {
    let visible = false;
    const root = { parentFrame: () => null };
    const frame = {
        isDetached: () => false,
        locator: () => ({ isVisible: async () => true }),
        parentFrame: () => root,
        page: () => ({ viewportSize: () => ({ width: 1000, height: 800 }) }),
        frameElement: async () => ({
            isVisible: async () => visible,
            boundingBox: async () => ({ x: 0, y: 0, width: 900, height: 700 }),
        }),
    };
    assert.equal(await visibleWebview(frame, 'panel'), false);
    visible = true;
    assert.equal(await visibleWebview(frame, 'panel'), true);
});

test('VS Code CLI path and macOS renamed binary stay inside the selected installation', () => {
    assert.equal(cliScript('/Code.app/Contents/MacOS/Code', 'darwin'), '/Code.app/Contents/Resources/app/out/cli.js');
    const owned = temporaryRoot('sqlfdt-code-test-');
    try {
        fs.writeFileSync(path.join(owned.root, 'Code'), '');
        assert.equal(resolveExecutable(path.join(owned.root, 'Electron'), 'darwin'), path.join(owned.root, 'Code'));
        assert.throws(() => resolveExecutable(path.join(owned.root, 'missing')), /missing/);
    } finally { owned.cleanup(); }
});

test('failure artifacts redact roots, known credentials, authorization and URL signatures', () => {
    const text = redact('host=/private/run Password=synthetic; Bearer bearer-test ?sig=signature&x=1 custom-synthetic',
        ['/private/run', 'custom-synthetic']);
    for (const material of ['/private/run', 'synthetic', 'bearer-test', 'signature']) {
        assert.ok(!text.includes(material));
    }
});

test('fixtures are deterministic and never exceed the 100-row cap', () => {
    assert.equal(fixtureRows().length, 100);
    assert.equal(fixtureRows()[99].amount, 700);
    for (const count of [0, 101, 1.5, '100']) {
        assert.throws(() => fixtureBytes(count), /100/);
    }
    assert.deepEqual(Object.fromEntries(Object.entries(fixtureBytes()).map(([key, value]) => [key, sha256(value)])),
        Object.fromEntries(Object.entries(fixtureBytes()).map(([key, value]) => [key, sha256(value)])));
    assert.equal(JSON.parse(fixtureBytes()['sample-utf16.json'].toString('utf16le').slice(1)).length, 100);
});
