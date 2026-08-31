/**
 * Tests for the manifest's command wiring and the Azure scope helpers.
 *
 * These avoid importing anything that requires the `vscode` module at runtime.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
    assert.ok(registered.length >= 6);
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

test('the manifest defaults the interface to an editor tab', () => {
    const setting =
        manifest.contributes.configuration.properties['sqlFileDetectionTool.defaultView'];
    assert.equal(setting.default, 'editor');
    assert.deepEqual(setting.enum, ['editor', 'sidebar']);
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
    assert.deepEqual(properties, [
        'sqlFileDetectionTool.defaultPlatform',
        'sqlFileDetectionTool.defaultView',
    ]);
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
    // Version 2.0 ships a single bundled file rather than the `out/` tree, so
    // `node_modules` never has to be packaged.
    assert.equal(manifest.main, './dist/extension.js');
});
