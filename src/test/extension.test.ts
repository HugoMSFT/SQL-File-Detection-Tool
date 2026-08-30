/**
 * Tests for the process helpers and the manifest's command wiring.
 *
 * These avoid importing anything that requires the `vscode` module at runtime.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { candidateInterpreters, run, venvPython } from '../process';
import { ARM_SCOPES, STORAGE_SCOPES, expiryFromJwt, refreshDelayMs } from '../azureScopes';

const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as {
    name: string;
    publisher: string;
    main: string;
    contributes: {
        commands: Array<{ command: string; title: string; category?: string }>;
        configuration: { properties: Record<string, { default?: unknown; enum?: string[] }> };
        menus: Record<string, Array<{ command: string; when?: string }>>;
    };
};

test('venvPython points at the platform-correct interpreter', () => {
    const resolved = venvPython(path.join('a', 'b'));
    if (process.platform === 'win32') {
        assert.equal(resolved, path.join('a', 'b', 'Scripts', 'python.exe'));
    } else {
        assert.equal(resolved, path.join('a', 'b', 'bin', 'python'));
    }
});

test('candidateInterpreters puts the configured interpreter first', () => {
    const candidates = candidateInterpreters('/usr/bin/python3.12');
    assert.equal(candidates[0], '/usr/bin/python3.12');
    assert.ok(candidates.length > 1);
    assert.equal(new Set(candidates).size, candidates.length);
});

test('candidateInterpreters works with no configuration', () => {
    const candidates = candidateInterpreters('');
    assert.ok(candidates.length >= 2);
    assert.ok(candidates.every((c) => typeof c === 'string' && c.length > 0));
});

test('run executes with an argument array and no shell interpretation', async () => {
    // If a shell were involved, the `&&` and `;` below would be operators.
    const marker = 'a && b ; c | d';
    const result = await run(process.execPath, [
        '-e',
        'process.stdout.write(process.argv[1])',
        marker,
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, marker);
});

test('run reports a non-zero exit code without throwing', async () => {
    const result = await run(process.execPath, ['-e', 'process.exit(3)']);
    assert.equal(result.code, 3);
});

test('run rejects when the command does not exist', async () => {
    await assert.rejects(() => run('definitely-not-a-real-command-xyz', []));
});

test('expiryFromJwt reads the exp claim', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
    const token = `eyJhbGciOiJub25lIn0.${payload}.sig`;
    assert.equal(expiryFromJwt(token), exp * 1000);
});

test('expiryFromJwt falls back to an assumed lifetime for opaque tokens', () => {
    const now = 1_700_000_000_000;
    const expiry = expiryFromJwt('opaque-token', now);
    assert.ok(expiry > now);
    assert.ok(expiry <= now + 60 * 60 * 1000);
});

test('Azure scopes are the delegated storage and ARM scopes', () => {
    assert.deepEqual(STORAGE_SCOPES, ['https://storage.azure.com/user_impersonation']);
    assert.deepEqual(ARM_SCOPES, ['https://management.azure.com/user_impersonation']);
});

test('refreshDelayMs refreshes ahead of expiry and never spins', () => {
    const now = 1_700_000_000_000;
    // One hour out: refresh five minutes early.
    assert.equal(refreshDelayMs(now + 60 * 60 * 1000, now), 55 * 60 * 1000);
    // Already expired: floor at 30 seconds rather than firing in a loop.
    assert.equal(refreshDelayMs(now - 1000, now), 30000);
});

test('the manifest declares every command the extension registers', () => {
    const declared = manifest.contributes.commands.map((c) => c.command).sort();
    assert.deepEqual(declared, [
        'sqlFileDetectionTool.analyzeCurrentFile',
        'sqlFileDetectionTool.analyzeSelected',
        'sqlFileDetectionTool.analyzeWorkspaceFolder',
        'sqlFileDetectionTool.connectAzureStorage',
        'sqlFileDetectionTool.disconnectAzureStorage',
        'sqlFileDetectionTool.open',
        'sqlFileDetectionTool.openInEditor',
    ]);
});

test('the backend lifecycle commands are gone from the manifest', () => {
    const declared = manifest.contributes.commands.map((c) => c.command);
    assert.ok(!declared.includes('sqlFileDetectionTool.setupBackend'));
    assert.ok(!declared.includes('sqlFileDetectionTool.stopBackend'));
});

test('every registered command exists in the manifest', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'extension.ts'),
        'utf8',
    );
    const registered = [
        ...source.matchAll(/registerCommand\(\s*'([^']+)'/g),
    ].map((m) => m[1]);
    assert.ok(registered.length >= 7);
    const declared = new Set(manifest.contributes.commands.map((c) => c.command));
    for (const command of registered) {
        assert.ok(declared.has(command), `${command} is missing from package.json`);
    }
});

test('the manifest defaults the platform setting to Azure SQL Database', () => {
    const setting =
        manifest.contributes.configuration.properties['sqlFileDetectionTool.defaultPlatform'];
    assert.equal(setting.default, 'azure_sql_db');
    assert.ok(setting.enum?.includes('azure_sql_db'));
    assert.equal(setting.enum?.[0], 'azure_sql_db');
});

test('no server or interpreter settings remain in the native manifest', () => {
    // Layer 2 removed the loopback backend from the default runtime, so the
    // settings that only made sense for a server must not survive: a stale
    // "host" or "pythonPath" would imply a runtime the extension no longer has.
    const properties = Object.keys(manifest.contributes.configuration.properties);
    for (const removed of [
        'sqlFileDetectionTool.host',
        'sqlFileDetectionTool.openIn',
        'sqlFileDetectionTool.rootDirectory',
        'sqlFileDetectionTool.pythonPath',
        'sqlFileDetectionTool.backendInterpreter',
        'sqlFileDetectionTool.installAzureExtras',
        'sqlFileDetectionTool.openOnActivityBarClick',
    ]) {
        assert.ok(!properties.includes(removed), `${removed} should have been removed`);
    }
    assert.deepEqual(properties, ['sqlFileDetectionTool.defaultPlatform']);
});

test('the explorer context menu is wired to the analyze command', () => {
    const explorer = manifest.contributes.menus['explorer/context'] ?? [];
    assert.ok(
        explorer.some((item) => item.command === 'sqlFileDetectionTool.analyzeSelected'),
    );
});

test('the manifest metadata is Marketplace-ready', () => {
    assert.equal(manifest.publisher, 'HugoMSFT');
    assert.equal(manifest.name, 'sql-file-detection-tool');
    assert.equal(manifest.main, './out/extension.js');
});
