/**
 * Tests for the extension manifest's command wiring.
 *
 * These avoid importing anything that requires the `vscode` module at runtime.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as {
    name: string;
    publisher: string;
    main: string;
    keywords: string[];
    contributes: {
        commands: Array<{ command: string; title: string; category?: string }>;
        configuration: { properties: Record<string, { default?: unknown; enum?: string[] }> };
        menus: Record<string, Array<{ command: string; when?: string }>>;
    };
};

test('the manifest declares every command the extension registers', () => {
    const declared = manifest.contributes.commands.map((command) => command.command).sort();
    assert.deepEqual(declared, [
        'sqlFileDetectionTool.analyzeCurrentFile',
        'sqlFileDetectionTool.analyzeSelected',
        'sqlFileDetectionTool.open',
        'sqlFileDetectionTool.openInEditor',
    ]);
});

test('the removed runtime commands stay out of the manifest', () => {
    const declared = manifest.contributes.commands.map((command) => command.command);
    for (const removed of [
        'sqlFileDetectionTool.connectAzureStorage',
        'sqlFileDetectionTool.disconnectAzureStorage',
        'sqlFileDetectionTool.setupBackend',
        'sqlFileDetectionTool.stopBackend',
    ]) {
        assert.ok(!declared.includes(removed), `${removed} should have been removed`);
    }
});

test('every registered command exists in the manifest', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'extension.ts'),
        'utf8',
    );
    const registered = [
        ...source.matchAll(/registerCommand\(\s*'([^']+)'/g),
    ].map((match) => match[1]);
    assert.ok(registered.length >= 4);
    const declared = new Set(manifest.contributes.commands.map((command) => command.command));
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
    assert.equal(manifest.main, './dist/extension.js');
    for (const keyword of [
        'etl',
        'data engineering',
        'bulk loading',
        'data virtualization',
        'polybase',
    ]) {
        assert.ok(manifest.keywords.includes(keyword), `${keyword} keyword is missing`);
    }
});
