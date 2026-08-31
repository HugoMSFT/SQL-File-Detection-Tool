/**
 * Tests for the shared model and, more importantly, the file registry.
 *
 * The registry is the containment mechanism: the renderer only ever holds an
 * opaque id, and only the host can turn one back into a path plus the root that
 * path must sit under. These tests pin that property down, along with the
 * display labels (which must never carry an absolute path) and the format
 * limitation copy (which must never promise a capability the extension lacks).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';

import {
    AppStateStore,
    DEFAULT_PREVIEW_ROWS,
    EMPTY_AZURE_STATE,
    displayLabel,
    limitationFor,
    supportsPreview,
} from '../appState';
import type { FileMetadata } from '../native';

const ROOT = path.resolve(path.sep === '\\' ? 'C:\\work\\project' : '/work/project');

function store(): AppStateStore {
    return new AppStateStore({ version: '1.1.1', workspaceFolders: [ROOT] });
}

function listing(count = 3): Parameters<AppStateStore['setFiles']>[0] {
    return Array.from({ length: count }, (_, index) => ({
        absolutePath: path.join(ROOT, 'data', `file${index}.csv`),
        allowedRoot: path.join(ROOT, 'data'),
        fileType: 'csv',
        sizeBytes: 100 + index,
        nativeSupport: 'supported' as const,
        isDirectory: false,
    }));
}

test('the initial snapshot is frozen and carries no file state', () => {
    const state = store().state;
    assert.ok(Object.isFrozen(state));
    assert.equal(state.version, '1.1.1');
    assert.equal(state.platform, 'azure_sql_db');
    assert.deepEqual(state.files, []);
    assert.equal(state.selectedFileId, null);
    assert.equal(state.metadata, null);
    assert.equal(state.activeTab, 'preview');
    assert.equal(state.quickAnalyze.selectedStatement, 'openrowset');
    assert.equal(state.dataSourceType, 'azure_blob');
    assert.equal(state.authMethod, 'managed_identity');
    assert.equal(state.credentialSetup.authMethod, 'managed_identity');
    assert.equal(state.previewRows, DEFAULT_PREVIEW_ROWS);
    assert.deepEqual(state.azure, EMPTY_AZURE_STATE);
    assert.ok(state.platforms.some((entry) => entry.id === 'azure_sql_db'));
});

test('credential selections stay normalized in the shared snapshot', () => {
    const state = store().update({
        platform: 'sql_server_2022',
        dataSourceType: 's3',
        authMethod: 'managed_identity',
    });
    assert.equal(state.dataSourceType, 's3');
    assert.equal(state.authMethod, 's3_access_key');
    assert.equal(state.credentialSetup.authMethod, 's3_access_key');
});

test('file ids are opaque, unguessable and unrelated to the path', () => {
    const first = store().setFiles(listing());
    const second = store().setFiles(listing());
    for (const entry of first) {
        assert.match(entry.id, /^[0-9a-f]{24}$/);
        assert.ok(!entry.id.includes('file'), 'an id must not embed the name');
    }
    assert.equal(new Set(first.map((entry) => entry.id)).size, first.length);
    // Two stores listing the identical files must not agree on ids, or an id
    // becomes a guessable handle to a path.
    assert.notDeepEqual(
        first.map((entry) => entry.id),
        second.map((entry) => entry.id),
    );
});

test('an entry never carries an absolute path and the lookup does', () => {
    const model = store();
    const entries = model.setFiles(listing(1));
    const entry = entries[0];
    assert.equal(entry.label, 'file0.csv');
    assert.equal(entry.folderLabel, 'data');
    assert.ok(!JSON.stringify(entry).includes(ROOT.replace(/\\/g, '\\\\')));

    const resolved = model.lookup(entry.id);
    assert.ok(resolved);
    assert.equal(resolved.absolutePath, path.join(ROOT, 'data', 'file0.csv'));
    assert.equal(resolved.allowedRoot, path.join(ROOT, 'data'));
});

test('an unknown, forged or stale id does not resolve', () => {
    const model = store();
    const entries = model.setFiles(listing());
    const stale = entries[0].id;

    assert.equal(model.lookup('deadbeefdeadbeefdeadbeef'), undefined);
    assert.equal(model.lookup(''), undefined);
    assert.equal(model.lookup('../../etc/passwd'), undefined);
    assert.equal(model.lookup('__proto__'), undefined);
    assert.equal(model.lookup('constructor'), undefined);

    model.setFiles(listing(1));
    assert.equal(model.lookup(stale), undefined, 'a previous listing must stop resolving');
});

test('every listed file carries its own allowed root', () => {
    const model = store();
    const entries = model.setFiles([
        {
            absolutePath: path.join(ROOT, 'a', 'x.csv'),
            allowedRoot: path.join(ROOT, 'a'),
            fileType: 'csv',
            sizeBytes: 1,
            nativeSupport: 'supported',
            isDirectory: false,
        },
        {
            absolutePath: path.join(ROOT, 'b', 'y.csv'),
            allowedRoot: path.join(ROOT, 'b'),
            fileType: 'csv',
            sizeBytes: 1,
            nativeSupport: 'supported',
            isDirectory: false,
        },
    ]);
    assert.equal(model.lookup(entries[0].id)?.allowedRoot, path.join(ROOT, 'a'));
    assert.equal(model.lookup(entries[1].id)?.allowedRoot, path.join(ROOT, 'b'));
});

test('subscribers see an immediate snapshot and every later one', () => {
    const model = store();
    const seen: number[] = [];
    const unsubscribe = model.subscribe((snapshot) => seen.push(snapshot.files.length));
    assert.deepEqual(seen, [0], 'a subscriber is primed with current state');

    model.setFiles(listing(2));
    assert.deepEqual(seen, [0, 2]);

    unsubscribe();
    model.setFiles(listing(1));
    assert.deepEqual(seen, [0, 2], 'an unsubscribed listener hears nothing');
});

test('each published snapshot is a fresh frozen object', () => {
    const model = store();
    const before = model.state;
    const after = model.update({ tableName: 'Customers' });
    assert.notEqual(before, after, 'a listener must not hold live host state');
    assert.ok(Object.isFrozen(after));
    assert.equal(before.tableName, '');
    assert.equal(after.tableName, 'Customers');
    assert.throws(() => {
        (after as { tableName: string }).tableName = 'mutated';
    }, TypeError);
});

test('azure state merges rather than clobbers', () => {
    const model = store();
    model.updateAzure({ connected: true, account: 'myaccount' });
    model.updateAzure({ container: 'data' });
    assert.equal(model.state.azure.connected, true);
    assert.equal(model.state.azure.account, 'myaccount');
    assert.equal(model.state.azure.container, 'data');
});

test('clearing the selection keeps user-entered options', () => {
    const model = store();
    const entries = model.setFiles(listing(1));
    model.update({
        selectedFileId: entries[0].id,
        tableName: 'Customers',
        schemaName: 'sales',
        platform: 'fabric_sql_db',
        columnOverrides: { id: 'BIGINT' },
        lastAnalysisMs: 12,
    });
    model.clearSelection();

    assert.equal(model.state.selectedFileId, null);
    assert.equal(model.state.metadata, null);
    assert.equal(model.state.lastAnalysisMs, null);
    assert.deepEqual(model.state.columnOverrides, {});
    assert.equal(model.state.tableName, 'Customers', 'a typed table name survives');
    assert.equal(model.state.schemaName, 'sales');
    assert.equal(model.state.platform, 'fabric_sql_db');
});

test('reset clears files and registry but keeps durable preferences', () => {
    const model = store();
    const entries = model.setFiles(listing(2));
    model.update({ platform: 'sql_server_2022', appearance: 'compact', tableName: 'X' });
    model.reset();

    assert.deepEqual(model.state.files, []);
    assert.equal(model.lookup(entries[0].id), undefined);
    assert.equal(model.state.tableName, '');
    assert.equal(model.state.platform, 'sql_server_2022');
    assert.equal(model.state.appearance, 'compact');
});

test('the selected getter follows the registry, not the id alone', () => {
    const model = store();
    const entries = model.setFiles(listing(1));
    assert.equal(model.selected === undefined, true);
    model.update({ selectedFileId: entries[0].id });
    assert.equal(model.selected?.entry.label, 'file0.csv');
    model.setFiles(listing(1));
    assert.equal(model.selected === undefined, true, 'a stale selection resolves to nothing');
});

test('display labels are workspace relative and never absolute', () => {
    assert.deepEqual(displayLabel(path.join(ROOT, 'data', 'a.csv'), [ROOT]), {
        label: 'a.csv',
        folderLabel: 'data',
    });
    assert.deepEqual(displayLabel(path.join(ROOT, 'a.csv'), [ROOT]), {
        label: 'a.csv',
        folderLabel: '',
    });
    const outside = path.resolve(path.sep === '\\' ? 'C:\\elsewhere\\home\\u\\a.csv' : '/elsewhere/home/u/a.csv');
    const label = displayLabel(outside, [ROOT]);
    assert.equal(label.label, 'a.csv');
    assert.equal(label.folderLabel, 'u', 'only the immediate parent, not the whole path');
    assert.ok(!label.folderLabel.includes(path.sep));
    // A sibling directory whose name merely starts with the root must not be
    // mistaken for being inside it.
    const sibling = `${ROOT}-backup${path.sep}a.csv`;
    assert.equal(displayLabel(sibling, [ROOT]).folderLabel, path.basename(`${ROOT}-backup`));
});

function metadata(overrides: Partial<FileMetadata>): FileMetadata {
    return {
        file_path: '/tmp/x',
        file_name: 'x',
        file_type: 'csv',
        size_bytes: 1,
        ...overrides,
    } as FileMetadata;
}

test('ORC reports an accurate limitation and no automatic Python', () => {
    const limitation = limitationFor(metadata({ file_type: 'orc', native_support: 'unsupported_native' }));
    assert.ok(limitation);
    assert.equal(limitation.code, 'orc_unsupported');
    assert.match(limitation.title, /cannot inspect ORC/i);
    assert.ok(limitation.manualWorkaround);
    assert.match(limitation.manualWorkaround, /separately installed/i);
    assert.match(limitation.manualWorkaround, /never installs or launches Python/i);
    assert.ok(!/we will install|automatically/i.test(limitation.manualWorkaround));
    assert.equal(supportsPreview(metadata({ file_type: 'orc', native_support: 'unsupported_native' })), false);
});

test('RCFile is described as recognition only', () => {
    const limitation = limitationFor(metadata({ file_type: 'rc', native_support: 'recognition_only' }));
    assert.ok(limitation);
    assert.equal(limitation.code, 'rcfile_recognition_only');
    assert.equal(limitation.manualWorkaround, null);
    assert.match(limitation.detail, /none is invented/i);
    assert.equal(supportsPreview(metadata({ file_type: 'rc', native_support: 'recognition_only' })), false);
});

test('supported formats carry no limitation and do support preview', () => {
    for (const fileType of ['csv', 'json', 'parquet', 'delta', 'iceberg'] as const) {
        const value = metadata({ file_type: fileType, native_support: 'supported' });
        assert.equal(limitationFor(value), null, fileType);
        assert.equal(supportsPreview(value), true, fileType);
    }
    assert.equal(limitationFor(null), null);
    assert.equal(supportsPreview(null), false);
    assert.equal(supportsPreview(metadata({ file_type: 'unknown' })), false);
});
