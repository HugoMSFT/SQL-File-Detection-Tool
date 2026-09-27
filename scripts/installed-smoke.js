#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');
const { unzipSync } = require('fflate');
const { auditVsix } = require('./audit-vsix');
const { writeFixtures, fixtureBytes } = require('./regression-fixtures');
const { sha256, temporaryRoot, redact, isolatedEnvironment, runProcess } = require('./tooling-support');

const REPO = path.resolve(__dirname, '..');
const VSCODE_VERSION = '1.139.1';

async function waitFor(label, predicate, { timeout = 20_000, signal } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const result = await predicate();
        if (result) { return result; }
        await sleep(30, undefined, { signal });
    }
    const error = new Error(`Timed out waiting for ${label}`);
    error.code = 'WAIT_DEADLINE';
    throw error;
}

function cliScript(executable, platform = process.platform) {
    return platform === 'darwin'
        ? path.resolve(executable, '../../Resources/app/out/cli.js')
        : path.resolve(executable, '../resources/app/out/cli.js');
}

function resolveExecutable(candidate, platform = process.platform) {
    if (fs.existsSync(candidate)) { return fs.realpathSync(candidate); }
    const renamed = path.join(path.dirname(candidate), 'Code');
    if (platform === 'darwin' && path.basename(candidate) === 'Electron' && fs.existsSync(renamed)) {
        return fs.realpathSync(renamed);
    }
    throw new Error('The pinned VS Code executable is missing');
}

async function revealNamingControls(ui) {
    const input = ui.locator('[data-edit="tableName"]');
    if (!await input.isVisible()) {
        await ui.locator('details.file-settings > summary').click();
    }
    await input.waitFor({ state: 'visible' });
}

async function selectAllStable(control, timeout = 5000) {
    // Electron on macOS can apply a delayed native Select All after keyup.
    // Observe the forwarded operation, not animation frames (which can pause).
    const observation = await control.evaluateHandle((input) => {
        const document = input.ownerDocument;
        const original = document.execCommand;
        const descriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
        const state = { completed: false, restore: undefined };
        const observed = function (command, ...args) {
            const result = Reflect.apply(original, this, [command, ...args]);
            if (this === document && String(command).toLowerCase() === 'selectall') {
                state.completed = true;
            }
            return result;
        };
        Object.defineProperty(document, 'execCommand', {
            value: observed, configurable: true, writable: true,
        });
        state.restore = () => {
            if (document.execCommand !== observed) {
                throw new Error('Select All observer was replaced concurrently');
            }
            if (descriptor) {
                Object.defineProperty(document, 'execCommand', descriptor);
            } else {
                delete document.execCommand;
            }
        };
        return state;
    });
    try {
        await control.press('ControlOrMeta+A');
        await waitFor('native Select All completion and full selection', async () =>
            await observation.evaluate((state) => state.completed) &&
            await control.evaluate((input) =>
                input.isConnected && input.ownerDocument.activeElement === input &&
                input.selectionStart === 0 && input.selectionEnd === input.value.length),
        { timeout });
    } finally {
        try {
            await observation.evaluate((state) => state.restore());
        } finally {
            await observation.dispose();
        }
    }
}

async function visibleWebview(candidate, surface) {
    if (candidate.isDetached()) { return false; }
    try {
        if (!await candidate.locator(`body[data-surface="${surface}"] #app-title`).isVisible()) {
            return false;
        }
        // VS Code can retain hidden iframe documents after panel recreation.
        // Visibility inside that document alone does not identify the live UI.
        for (let frame = candidate; frame.parentFrame(); frame = frame.parentFrame()) {
            const owner = await frame.frameElement();
            if (!await owner.isVisible()) { return false; }
            const box = await owner.boundingBox();
            const viewport = candidate.page().viewportSize();
            if (!box || (viewport && (box.x + box.width <= 0 || box.y + box.height <= 0 ||
                box.x >= viewport.width || box.y >= viewport.height))) {
                return false;
            }
        }
        return true;
    } catch (error) {
        if (candidate.isDetached()) { return false; }
        throw error;
    }
}

function launchArguments(root) {
    return [
        '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-updates',
        '--disable-workspace-trust', '--disable-telemetry', '--disable-crash-reporter',
        '--disable-gpu', '--password-store=basic', '--use-inmemory-secretstorage',
        '--disable-extension=vscode.microsoft-authentication',
        '--disable-extension=vscode.github-authentication',
        `--user-data-dir=${path.join(root, 'user-data')}`,
        `--extensions-dir=${path.join(root, 'extensions')}`,
        `--extensionDevelopmentPath=${path.join(__dirname, 'smoke-driver')}`,
        path.join(root, 'workspace'),
    ];
}

function processDescendants(table, rootPid) {
    const owned = new Set([rootPid]);
    let previous;
    do {
        previous = owned.size;
        for (const row of table) {
            if (owned.has(row.parent)) { owned.add(row.pid); }
        }
    } while (previous !== owned.size);
    return table.filter((row) => owned.has(row.pid));
}

async function processTable() {
    if (process.platform === 'win32') {
        const result = await runProcess('powershell.exe', [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
            'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress',
        ], { timeout: 10_000 });
        assert.equal(result.code, 0, 'Could not inspect owned Windows process IDs');
        return JSON.parse(result.stdout).map((row) =>
            ({ pid: row.ProcessId, parent: row.ParentProcessId, started: row.CreationDate }));
    }
    const result = await runProcess('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { timeout: 10_000 });
    assert.equal(result.code, 0, 'Could not inspect owned Unix process IDs');
    return result.stdout.trim().split('\n').map((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        assert.ok(match, 'Invalid process inventory');
        return { pid: Number(match[1]), parent: Number(match[2]), started: match[3] };
    });
}

async function trackProcesses(child, tracked) {
    for (const row of processDescendants(await processTable(), child.pid)) {
        tracked.set(row.pid, row.started);
    }
}

async function closeApplication(app, child, tracked) {
    await trackProcesses(child, tracked);
    const liveOwned = async () => (await processTable()).filter((row) => tracked.get(row.pid) === row.started);
    let timeout;
    let closeFailure;
    try {
        if (child.exitCode === null && child.signalCode === null) {
            await Promise.race([
                app.close(),
                new Promise((_, reject) => {
                    timeout = setTimeout(() => reject(new Error('VS Code did not exit within 15 seconds')), 15_000);
                }),
            ]);
        }
    } catch (error) {
        closeFailure = error;
    }
    clearTimeout(timeout);
    const remaining = await liveOwned();
    for (const row of remaining.reverse()) {
        assert.notEqual(row.pid, process.pid, 'Refusing to kill the test runner');
        try {
            process.kill(row.pid, 'SIGKILL');
        } catch (error) {
            if (error.code !== 'ESRCH') { throw error; }
        }
    }
    await waitFor('all owned VS Code process IDs to exit', async () => (await liveOwned()).length === 0,
        { timeout: 10_000 });
    return {
        trackedProcessCount: tracked.size, remainingProcessCount: 0,
        forcedTermination: remaining.length > 0,
        gracefulExitError: closeFailure?.message ?? null,
    };
}

async function smoke(options) {
    const vsix = path.resolve(options.vsix);
    const audit = auditVsix(vsix);
    assert.deepEqual(audit.problems, [], 'VSIX audit must pass before installation');
    const bytes = fs.readFileSync(vsix);
    const entries = unzipSync(bytes);
    const manifest = JSON.parse(Buffer.from(entries['extension/package.json']).toString('utf8'));
    const bundleSha = sha256(entries['extension/dist/extension.js']);
    const artifacts = path.resolve(options.artifacts);
    fs.mkdirSync(artifacts, { recursive: true });
    // macOS's default /var/folders temp path can exceed its Unix socket limit.
    const owned = temporaryRoot('sqlfdt-installed-', process.platform === 'darwin' ? '/tmp' : undefined);
    const { root } = owned;
    const report = {
        schemaVersion: 1, status: 'FAIL', platform: process.platform, architecture: process.arch,
        version: manifest.version, vsixSha256: sha256(bytes), bundleSha256: bundleSha,
        boundary: 'Installed VSIX; only extension-owned VS Code auth/network imports are guarded by the external driver. No live OAuth/Azure.',
        checks: [], regressions: [], cleanupVerified: false,
    };
    let app;
    let child;
    let page;
    let failure;
    const logs = [];
    const tracked = new Map();
    const abort = new AbortController();
    let cancellationClose;
    const cancel = () => {
        abort.abort(new Error('Installed smoke canceled'));
        if (app && !cancellationClose) {
            cancellationClose = app.close().catch((error) => {
                report.cancellationCloseError = redact(error.message, [root, REPO]);
            });
        }
    };
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    const timer = setTimeout(cancel, 5 * 60_000);
    const bounded = { signal: abort.signal };
    try {
        const env = isolatedEnvironment(root);
        for (const relative of ['mailbox', 'extensions', 'user-data/User', 'workspace/stress']) {
            fs.mkdirSync(path.join(root, relative), { recursive: true });
        }
        fs.writeFileSync(path.join(root, 'user-data/User/settings.json'), JSON.stringify({
            'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
            'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
            'settingsSync.enabled': false, 'workbench.startupEditor': 'none',
            'workbench.enableExperiments': false, 'window.restoreWindows': 'none',
            'files.hotExit': 'off', 'security.workspace.trust.enabled': false,
            'workbench.editor.enablePreview': false, 'window.zoomLevel': 0,
            'sqlFileDetectionTool.defaultView': 'editor',
        }));
        writeFixtures(path.join(root, 'workspace/samples'), 3);
        const stressBytes = fixtureBytes(100)['sample.csv'];
        for (let index = 0; index < 1024; index++) {
            fs.writeFileSync(path.join(root, 'workspace/stress', `part-${index}.csv`), stressBytes);
        }
        if (options.progressivePreview) {
            fs.writeFileSync(path.join(root, 'workspace/large.csv'),
                '\ufeffid,label,amount\n' + '1,fixture_progressive_sample,7\n'.repeat(400_000));
        }
        const executable = resolveExecutable(options.code
            ? options.code
            : await require('@vscode/test-electron').downloadAndUnzipVSCode({
                version: VSCODE_VERSION, cachePath: path.join(root, 'vscode'), timeout: 30_000,
            }));
        const install = await runProcess(executable, [
            cliScript(executable), '--install-extension', vsix, '--force',
            `--user-data-dir=${path.join(root, 'user-data')}`,
            `--extensions-dir=${path.join(root, 'extensions')}`,
        ], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 90_000, signal: abort.signal });
        assert.equal(install.code, 0, redact(install.stderr, [root]));
        const { _electron: electron } = require('playwright-core');
        app = await electron.launch({
            executablePath: executable, args: launchArguments(root),
            env: { ...env, SQLFDT_SMOKE_ROOT: root, SQLFDT_SMOKE_BUNDLE_SHA: bundleSha },
            timeout: 60_000,
        });
        child = app.process();
        child.stdout?.on('data', (data) => logs.push(String(data)));
        child.stderr?.on('data', (data) => logs.push(String(data)));
        page = await app.firstWindow({ timeout: 30_000 });
        await trackProcesses(child, tracked);
        page.setDefaultTimeout(15_000);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await waitFor('the separate driver to start',
            () => fs.existsSync(path.join(root, 'mailbox/ready.json')), bounded);

        let sequence = 0;
        const command = async (action, extra = {}) => {
            abort.signal.throwIfAborted();
            const id = ++sequence;
            const mailbox = path.join(root, 'mailbox');
            fs.writeFileSync(path.join(mailbox, 'request.tmp'), JSON.stringify({ id, action, ...extra }));
            fs.renameSync(path.join(mailbox, 'request.tmp'), path.join(mailbox, 'request.json'));
            const response = await waitFor(`driver ${action}`, () => {
                const file = path.join(mailbox, 'response.json');
                if (!fs.existsSync(file)) { return false; }
                const message = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (message.id !== id) { return false; }
                fs.unlinkSync(file);
                return message;
            }, bounded);
            assert.equal(response.error, undefined, response.error);
            assert.deepEqual(response.result.attempts, [], 'The installed extension attempted auth/network');
            assert.deepEqual(response.result.errors, []);
            report.lastProbe = response.result;
            if (action !== 'probe') { await trackProcesses(child, tracked); }
            return response.result;
        };
        const frame = async (surface = 'panel') => {
            return waitFor(`the real ${surface} webview`, async () => {
                for (const candidate of page.frames()) {
                    if (await visibleWebview(candidate, surface)) {
                        return candidate;
                    }
                }
                return false;
            }, bounded);
        };
        const settled = async (predicate = () => true) => {
            return waitFor('final (not provisional) analysis state', async () => {
                const result = await command('probe');
                return result.snapshot && !result.snapshot.busy && result.inFlight === 0 &&
                    predicate(result.snapshot) ? result : false;
            }, bounded);
        };
        const tab = async (ui, name) => {
            await ui.locator(`[data-tab="${name}"]`).click();
            await waitFor(`the ${name} tab`, async () =>
                (await ui.locator(`[data-tab="${name}"]`).getAttribute('aria-selected')) === 'true', bounded);
        };
        const verifyTyped = async (control, expected, matches) => {
            try {
                await waitFor('typed value to survive host updates', async () =>
                    matches((await command('probe')).snapshot) && await control.inputValue() === expected,
                { ...bounded, timeout: 2000 });
            } catch (error) {
                if (error.code !== 'WAIT_DEADLINE') { throw error; }
                report.regressions.push({
                    check: 'Fast keyboard typing preserves the complete value and caret',
                    expected, actual: await control.inputValue(),
                    continuation: 'Whole-field replacement below exercises independent scenarios; this failure still fails the run.',
                });
                await page.screenshot({
                    path: path.join(artifacts, `typing-${report.regressions.length}.png`), timeout: 10_000,
                });
                await control.fill(expected);
                await settled(matches);
            }
        };
        await command('activate');
        let ui = await frame();
        let probe = await settled();
        assert.equal(probe.active, true);
        assert.equal(probe.version, manifest.version);
        assert.equal(probe.bundleSha256, bundleSha);
        report.vscodeVersion = probe.vscodeVersion;
        report.checks.push('Audited installed bundle activates and renders without authentication or extension network calls');
        if (options.failAfterActivation) {
            throw new Error('Intentional smoke failure after activation (cleanup regression)');
        }

        await ui.locator('[data-source-mode="local"]').focus();
        await ui.locator('[data-source-mode="local"]').press('ArrowRight');
        await ui.locator('[data-source-mode="azure"]').press('Enter');
        await ui.locator('#azure-browser').waitFor({ state: 'visible' });
        await ui.locator('[data-source-mode="azure"]').press('Escape');
        await ui.locator('#azure-browser').waitFor({ state: 'hidden' });
        await command('probe');
        report.checks.push('Source keyboard navigation and Azure open/Escape close do not sign in or fetch');

        await command('analyze', { sample: 'samples' });
        await settled((state) => state.previewCount === 3 && !state.error);
        await ui.locator('.file-item').filter({ hasText: 'sample.csv' }).click();
        await settled((state) => state.activeTab === 'preview' && state.previewCount === 3);
        assert.match(await ui.locator('#panel tbody').innerText(), /fixture_001/);
        await ui.locator('#file-list').focus();
        await ui.locator('#file-list').press('End');
        await settled((state) => state.previewCount === 3);
        await ui.locator('.file-item').filter({ hasText: 'sample.csv' }).click();
        await settled();
        await tab(ui, 'metadata');
        assert.match(await ui.locator('#panel').innerText(), /Columns\s+3/);
        await tab(ui, 'schema');
        const override = ui.getByRole('textbox', { name: 'SQL type for label', exact: true });
        await override.focus();
        await selectAllStable(override);
        await override.pressSequentially('NVARCHAR(80)', { delay: 25 });
        await verifyTyped(override, 'NVARCHAR(80)', (state) => state.columnOverrides.label === 'NVARCHAR(80)');
        assert.equal(await override.inputValue(), 'NVARCHAR(80)');
        await tab(ui, 'create_table');
        await revealNamingControls(ui);
        const tableName = ui.locator('[data-edit="tableName"]');
        await tableName.focus();
        await selectAllStable(tableName);
        await tableName.pressSequentially('smoke_table', { delay: 25 });
        await tableName.press('Home');
        await tableName.pressSequentially('edited_', { delay: 25 });
        await verifyTyped(tableName, 'edited_smoke_table', (state) => state.tableName === 'edited_smoke_table');
        await ui.locator('[data-edit="schemaName"]').fill('smoke_schema');
        await ui.locator('#platform').selectOption('sql_server_2022');
        await settled((state) => state.tableName === 'edited_smoke_table' && state.schemaName === 'smoke_schema');
        await waitFor('SQL regenerated from edited metadata', async () => {
            const sql = await ui.locator('.sql code').innerText();
            return sql.includes('[smoke_schema].[edited_smoke_table]') && sql.includes('NVARCHAR(80)');
        }, bounded);
        await ui.locator('[data-sql-action="open"]').click();
        probe = await waitFor('real SQL editor document', async () => {
            const result = await command('probe');
            return result.activeSqlDocument &&
                result.documents.some((text) => text.includes('[smoke_schema].[edited_smoke_table]')) ? result : false;
        }, bounded);
        await command('closeSqlDocument');
        await command('editor');
        ui = await frame();
        await tab(ui, 'preview');
        await ui.locator('[data-edit="previewRows"]').fill('2');
        await ui.locator('[data-edit="previewRows"]').press('Tab');
        await settled((state) => state.previewRows === 2 && state.previewCount === 2);
        report.checks.push('Local analyze -> Preview/Metadata/Schema/SQL, generated SQL editor, and preview row settings');
        if (report.regressions.length === 0) {
            report.checks.push('Fast keyboard typing and caret survive host state updates');
        }

        await tab(ui, 'create_table');
        await revealNamingControls(ui);
        const originalFileId = (await command('probe')).snapshot.selectedFileId;
        await ui.locator('[data-edit="importProfileName"]').fill('Smoke profile');
        await ui.locator('[data-action="saveImportProfile"]').click();
        await settled((state) => state.importProfiles.includes('Smoke profile'));
        await ui.locator('[data-action="resetFileSettings"]').click();
        await settled((state) => state.tableName === 'sample' && Object.keys(state.columnOverrides).length === 0);
        await ui.locator('[data-action="undoFileSettings"]').click();
        await settled((state) => state.tableName === 'edited_smoke_table' && state.columnOverrides.label === 'NVARCHAR(80)');
        await ui.locator('.file-item').filter({ hasText: 'sample.json' }).click();
        await settled((state) => state.selectedFileId !== originalFileId && Object.keys(state.columnOverrides).length === 0);
        await revealNamingControls(ui);
        await ui.locator('[data-edit="importProfile"]').selectOption('Smoke profile');
        await ui.locator('[data-action="applyImportProfile"]').click();
        await settled((state) => state.tableName === 'edited_smoke_table' && state.columnOverrides.label === 'NVARCHAR(80)');
        await ui.locator('.file-item').filter({ hasText: 'sample.csv' }).click();
        await settled((state) => state.selectedFileId === originalFileId &&
            state.tableName === 'edited_smoke_table' && state.columnOverrides.label === 'NVARCHAR(80)');
        await revealNamingControls(ui);
        await ui.locator('[data-edit="importProfile"]').selectOption('Smoke profile');
        await ui.locator('[data-action="deleteImportProfile"]').click();
        await settled((state) => state.importProfiles.length === 0 && state.columnOverrides.label === 'NVARCHAR(80)');
        report.checks.push('Per-file settings survive A/B/A selection; Reset/Undo and profile Save/Apply/Delete keep the correct file');

        await ui.locator('[data-source-tab="credential_setup"]').click();
        const draft = 'abs://samples@sqlfdtdemo.blob.core.windows.net/unsubmitted.csv';
        await ui.locator('.storage-url-input').fill(draft);
        await ui.locator('#platform').selectOption('sql_server_2025');
        await settled((state) => state.platform === 'sql_server_2025');
        assert.equal(await ui.locator('.storage-url-input').inputValue(), draft);
        await tab(ui, 'schema');
        assert.equal(await ui.getByRole('textbox', { name: 'SQL type for label', exact: true }).inputValue(), 'NVARCHAR(80)');
        await command('sidebar');
        ui = await frame('sidebar');
        await tab(ui, 'create_table');
        await revealNamingControls(ui);
        assert.equal(await ui.locator('[data-edit="tableName"]').inputValue(), 'edited_smoke_table');
        assert.match(await ui.locator('.sql code').innerText(), /NVARCHAR\(80\)/);
        await ui.locator('[data-source-tab="credential_setup"]').click();
        await ui.locator('.storage-url-input').fill(draft);
        await command('hideSidebar');
        await command('sidebar');
        ui = await frame('sidebar');
        assert.equal(await ui.locator('.storage-url-input').inputValue(), draft);
        await command('editor');
        ui = await frame();
        await tab(ui, 'preview');
        assert.equal(await ui.locator('[data-edit="previewRows"]').inputValue(), '2');
        await command('closeEditors');
        await command('editor');
        ui = await frame();
        probe = await settled();
        assert.equal(probe.defaultView, 'sidebar');
        assert.equal(probe.snapshot.platform, 'sql_server_2025');
        assert.equal(probe.snapshot.tableName, 'edited_smoke_table');
        assert.equal(probe.snapshot.columnOverrides.label, 'NVARCHAR(80)');
        report.checks.push('Draft survives unrelated state updates and sidebar renderer recreation; edits/settings survive sidebar/editor relocation and panel recreation');

        const cancelClick = ui.locator('#cancel').click();
        await command('analyze', { sample: 'stress' });
        await cancelClick;
        await settled((state) => /canceled/i.test(state.notice || ''));
        await command('analyze', { sample: 'sample.json' });
        await settled((state) => state.previewCount === 2 && !state.error);
        await tab(ui, 'preview');
        assert.match(await ui.locator('#panel tbody').innerText(), /fixture_001/);
        report.checks.push('Cancel real directory analysis, then select and preview a different file without stale results');

        if (options.progressivePreview) {
            const previousSamples = (await command('probe')).provisionalSnapshots;
            await command('analyze', { sample: 'large.csv' });
            probe = await waitFor('an early provisional preview', async () => {
                const result = await command('probe');
                return result.provisionalSnapshots > previousSamples ? result : false;
            }, bounded);
            await settled((state) => state.analysisStage === null && state.metadataRows === 400_000);
            report.checks.push('Large CSV emits a provisional preview while busy before final whole-file metadata');
        }
        report.finalProbe = await command('probe');
        if (report.regressions.length > 0) {
            throw new Error(`${report.regressions.length} installed keyboard-typing regression(s); see report and typing screenshots`);
        }
        report.status = 'PASS';
    } catch (error) {
        failure = error;
        report.error = redact(error.message, [root, REPO]);
        if (page && !page.isClosed()) {
            try {
                await page.screenshot({ path: path.join(artifacts, 'failure.png'), timeout: 10_000 });
            } catch (screenshotError) {
                report.screenshotError = redact(screenshotError.message, [root, REPO]);
            }
        }
    } finally {
        clearTimeout(timer);
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
        try {
            if (app && child) {
                report.processCleanup = await closeApplication(app, child, tracked);
                if (report.processCleanup.gracefulExitError) {
                    report.shutdownError = redact(report.processCleanup.gracefulExitError, [root, REPO]);
                    report.status = 'FAIL';
                    failure = new Error(report.shutdownError);
                }
            }
        } catch (cleanupError) {
            report.processCleanupError = redact(cleanupError.message, [root, REPO]);
            report.status = 'FAIL';
            failure = cleanupError;
        }
        try {
            owned.cleanup();
            report.cleanupVerified = !report.processCleanupError;
        } catch (cleanupError) {
            report.cleanupError = redact(cleanupError.message, [root, REPO]);
            report.status = 'FAIL';
            failure = cleanupError;
        }
        fs.writeFileSync(path.join(artifacts, 'report.json'), redact(JSON.stringify(report, null, 2), [root, REPO]));
        fs.writeFileSync(path.join(artifacts, 'vscode.log'), redact(logs.join('').slice(-500_000), [root, REPO]));
    }
    if (failure) { throw new Error(report.error || report.cleanupError || report.processCleanupError || report.shutdownError); }
    console.log(`Installed VSIX smoke PASS: ${report.checks.length} checks; isolated profile removed.`);
    return report;
}

if (require.main === module) {
    const { values } = parseArgs({ options: {
        vsix: { type: 'string' }, code: { type: 'string' },
        artifacts: { type: 'string', default: '.artifacts/installed-smoke' },
        'progressive-preview': { type: 'boolean', default: false },
        'fail-after-activation': { type: 'boolean', default: false },
    } });
    const manifest = require('../package.json');
    smoke({
        vsix: values.vsix || `dist/${manifest.name}-${manifest.version}.vsix`,
        code: values.code, artifacts: values.artifacts, progressivePreview: values['progressive-preview'],
        failAfterActivation: values['fail-after-activation'],
    }).catch((error) => { console.error(redact(error.message)); process.exitCode = 1; });
}

module.exports = {
    smoke, waitFor, cliScript, launchArguments, VSCODE_VERSION, processDescendants,
    resolveExecutable, revealNamingControls,
    selectAllStable,
    visibleWebview,
};
