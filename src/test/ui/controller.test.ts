/**
 * Tests for the native UI controller — the whole product workflow with no
 * editor, no server and no Python.
 *
 * The host is a plain object, so anything the controller cannot do in pure
 * TypeScript is observable here. The native analysis service is the real one
 * running against the repository's fixtures, so the assertions are about actual
 * CSV, JSON, Parquet, Delta, Iceberg and ORC behaviour rather than a stub's.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AppStateStore } from '../../appState';
import { MicrosoftAuthentication } from '../../azure/auth';
import { AzureBrowser } from '../../azure/browser';
import { StorageBrowserClient, type StoragePage } from '../../azure/storageClient';
import { UiController, metadataForDisplay } from '../../ui/controller';
import type {
    OpenDialogOptions,
    OpenDialogSelection,
    UiHost,
} from '../../ui/host';
import type { AppStateSnapshot } from '../../protocol';
import { DEFAULT_FILE_SETTINGS, IMPORT_PROFILES_PREFERENCE, fileSettingsFrom, type ImportProfile } from '../../fileSettings';
import {
    NativeAnalysisService,
    type AnalysisRequest,
    type ProgressiveAnalysisRequest,
    type StatementKind,
} from '../../native';

const REPO = path.resolve(__dirname, '..', '..', '..');
const SAMPLES = path.join(REPO, 'data sample');
const FIXTURES = path.join(SAMPLES, 'csv');
const DEMO = SAMPLES;

interface Recorder {
    host: UiHost;
    readonly store: AppStateStore;
    readonly logs: string[];
    readonly clipboard: string[];
    readonly untitled: { content: string; languageId: string }[];
    readonly externalUrls: string[];
    readonly saved: { name: string; content: string }[];
    readonly information: string[];
    readonly errors: string[];
    readonly warnings: string[];
    readonly preferences: Map<string, unknown>;
    readonly dialogs: OpenDialogOptions[];
    readonly downloadDir: string;
    dialogResult: readonly OpenDialogSelection[] | undefined;
    saveResult: string | undefined;
    panelOpens: number;
    clock: number;
}

function recorder(options: { workspaceFolders?: string[] } = {}): Recorder {
    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlfd-ctrl-'));
    const folders = options.workspaceFolders ?? [FIXTURES];
    const state: Recorder = {
        host: undefined as unknown as UiHost,
        store: new AppStateStore({ version: '1.1.1', workspaceFolders: folders }),
        logs: [],
        clipboard: [],
        untitled: [],
        externalUrls: [],
        saved: [],
        information: [],
        errors: [],
        warnings: [],
        preferences: new Map<string, unknown>(),
        dialogs: [],
        downloadDir,
        dialogResult: undefined,
        saveResult: undefined,
        panelOpens: 0,
        clock: 0,
    };
    const host: UiHost = {
        version: '1.1.1',
        workspaceFolders: () => folders,
        showOpenDialog: async (dialogOptions) => {
            state.dialogs.push(dialogOptions);
            return state.dialogResult;
        },
        copyToClipboard: async (text) => void state.clipboard.push(text),
        openUntitledDocument: async (content, languageId) =>
            void state.untitled.push({ content, languageId }),
        openExternal: async (url) => {
            state.externalUrls.push(url);
            return true;
        },
        saveTextFile: async (name, content) => {
            state.saved.push({ name, content });
            return state.saveResult;
        },
        showInformation: (message) => state.information.push(message),
        showWarning: (message) => state.warnings.push(message),
        showError: (message) => state.errors.push(message),
        log: (message) => state.logs.push(message),
        getPreference: <T,>(key: string, fallback: T): T =>
            (state.preferences.has(key) ? (state.preferences.get(key) as T) : fallback),
        setPreference: async (key, value) => void state.preferences.set(key, value),
        openPanel: async () => void (state.panelOpens += 1),
        now: () => (state.clock += 1),
    };
    state.host = host;
    return state;
}

function controller(record: Recorder, deps = {}): UiController {
    return new UiController(record.host, record.store, deps);
}

/** Legacy workflow stubs model a service with no speculative sample stage. */
function completeOnlyService<T extends {
    analyze(request: { filePath: string }): Promise<unknown>;
    preview(): Promise<unknown>;
}>(service: T) {
    return {
        ...service,
        analyzeProgressively: async (request: AnalysisRequest) => ({
            metadata: await service.analyze(request),
            preview: await service.preview(),
        }),
        previewAnalyzed: service.preview,
    };
}

function gate<T = void>() {
    let release!: (value: T) => void;
    const promise = new Promise<T>((resolve) => { release = resolve; });
    return { promise, release };
}

/** Real sampling/parsing, with the authoritative service boundary held open. */
class HeldRefinementService extends NativeAnalysisService {
    readonly sampled = gate<void>();
    readonly analyzing = gate<void>();
    readonly final = gate<void>();
    readonly requests: AnalysisRequest[] = [];

    constructor(private readonly heldFile: string) { super(); }

    override async analyzeProgressively(request: ProgressiveAnalysisRequest) {
        return super.analyzeProgressively({
            ...request,
            onPreview: async (sample) => {
                await request.onPreview(sample);
                if (request.filePath === this.heldFile) {
                    this.sampled.release();
                }
            },
        });
    }

    override async analyze(request: AnalysisRequest) {
        this.requests.push(request);
        if (request.filePath === this.heldFile) {
            this.analyzing.release();
            await this.final.promise;
            request.progress?.report({ message: 'Held refinement resumed' });
        }
        return super.analyze(request);
    }
}

/** Wait for the controller's serial queue and any microtasks to settle. */
async function settle(): Promise<void> {
    for (let i = 0; i < 8; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

function snapshot(record: Recorder): AppStateSnapshot {
    return record.store.state;
}

function cleanup(record: Recorder): void {
    fs.rmSync(record.downloadDir, { recursive: true, force: true });
}

test('all settings and one-level Undo are isolated across file switching, refresh and source switching', async () => {
    const record = recorder();
    const azure = new AzureBrowser({ authentication: new MicrosoftAuthentication(async () => undefined) });
    const ui = controller(record, { azure });
    try {
        await ui.loadFiles([path.join(FIXTURES, 'sample.csv'), path.join(FIXTURES, 'employees.csv')]);
        const [first, second] = snapshot(record).files;
        const column = snapshot(record).metadata!.schema![0][0];
        for (const [type, value] of [
            ['setTableName', 'first_table'], ['setSchemaName', 'first_schema'],
            ['setDataSource', 'FirstSource'], ['setCredentialName', 'FirstCredential'],
            ['setFormatName', 'FirstFormat'],
        ]) {
            await ui.handle({ type, fileId: first.id, value });
        }
        await ui.handle({ type: 'setParserOverride', fileId: first.id, key: 'fieldDelimiter', value: '|' });
        await ui.handle({ type: 'setColumnOverride', fileId: first.id, column, sqlType: 'BIGINT' });
        const retained = fileSettingsFrom(snapshot(record));

        await ui.handle({ type: 'selectFile', fileId: second.id });
        assert.deepEqual(fileSettingsFrom(snapshot(record)), { ...DEFAULT_FILE_SETTINGS, tableName: 'employees' });
        assert.equal(snapshot(record).canUndoSettings, false);
        await ui.handle({ type: 'setTableName', fileId: second.id, value: 'second_table' });

        await ui.handle({ type: 'selectFile', fileId: first.id });
        assert.deepEqual(fileSettingsFrom(snapshot(record)), retained);
        await ui.handle({ type: 'refresh' });
        assert.deepEqual(fileSettingsFrom(snapshot(record)), retained);
        assert.equal(snapshot(record).canUndoSettings, true);
        await ui.handle({ type: 'openAzureBrowser' });
        await ui.handle({ type: 'setSchemaName', fileId: null, value: 'azure_schema' });
        await ui.handle({ type: 'setDataSource', fileId: null, value: 'AzureSource' });
        await ui.handle({ type: 'activateLocalSource' });
        assert.deepEqual(fileSettingsFrom(snapshot(record)), retained);
        assert.equal(snapshot(record).selectedFileId, first.id);
        assert.equal(record.dialogs.length, 0);

        const metadata = snapshot(record).metadata;
        const preview = snapshot(record).preview;
        await ui.handle({ type: 'resetFileSettings', fileId: first.id });
        assert.deepEqual(fileSettingsFrom(snapshot(record)), { ...DEFAULT_FILE_SETTINGS, tableName: 'sample' });
        assert.equal(snapshot(record).metadata, metadata, 'Reset is not reanalysis');
        assert.equal(snapshot(record).preview, preview);
        assert.equal(snapshot(record).selectedFileId, first.id);
        assert.equal(snapshot(record).canUndoSettings, true);
        await ui.handle({ type: 'selectFile', fileId: second.id });
        await ui.handle({ type: 'undoFileSettings', fileId: second.id });
        assert.equal(snapshot(record).tableName, 'employees');
        assert.equal(snapshot(record).canUndoSettings, false);
        await ui.handle({ type: 'selectFile', fileId: first.id });
        await ui.handle({ type: 'undoFileSettings', fileId: first.id });
        assert.deepEqual(fileSettingsFrom(snapshot(record)), retained);
        assert.equal(snapshot(record).canUndoSettings, false);

        await ui.loadFiles([path.join(FIXTURES, 'sample.csv')]);
        assert.notEqual(snapshot(record).selectedFileId, first.id, 'a fresh listing has fresh opaque handles');
        assert.deepEqual(fileSettingsFrom(snapshot(record)), retained, 'canonical identity retains settings across a new listing');
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('stale settings, reset, undo and profile messages cannot change another file', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.loadFiles([path.join(FIXTURES, 'sample.csv'), path.join(FIXTURES, 'employees.csv')]);
        const [first, second] = snapshot(record).files;
        await ui.handle({ type: 'saveImportProfile', fileId: first.id, name: 'First' });
        await ui.handle({ type: 'selectFile', fileId: second.id });
        await ui.handle({ type: 'setSchemaName', fileId: second.id, value: 'second_schema' });
        const retained = fileSettingsFrom(snapshot(record));
        const column = snapshot(record).metadata!.schema![0][0];
        const messages = [
            ...['setTableName', 'setSchemaName', 'setDataSource', 'setCredentialName', 'setFormatName']
                .map((type) => ({ type, fileId: first.id, value: 'Wrong' })),
            { type: 'setTableName', fileId: null, value: 'Wrong remote draft' },
            { type: 'setParserOverride', fileId: first.id, key: 'fieldDelimiter', value: '|' },
            { type: 'resetParserOverride', fileId: first.id, key: 'fieldDelimiter' },
            { type: 'setColumnOverride', fileId: first.id, column, sqlType: 'BIGINT' },
            { type: 'clearColumnOverrides', fileId: first.id },
            { type: 'resetFileSettings', fileId: first.id },
            { type: 'undoFileSettings', fileId: first.id },
            { type: 'saveImportProfile', fileId: first.id, name: 'Wrong' },
            { type: 'applyImportProfile', fileId: first.id, name: 'First' },
        ];
        for (const message of messages) {
            await ui.handle(message);
            assert.deepEqual(fileSettingsFrom(snapshot(record)), retained, message.type);
            assert.equal(snapshot(record).canUndoSettings, true);
        }
        assert.deepEqual(snapshot(record).importProfiles, ['First']);
        assert.match(record.logs.at(-1) ?? '', /Settings were not changed/);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('edits made during reanalysis survive completion, including names after a storage URL is applied', async () => {
    const record = recorder();
    const service = new NativeAnalysisService();
    const entered = gate();
    const release = gate();
    const ui = controller(record, { service });
    try {
        await ui.loadFiles([path.join(FIXTURES, 'sample.csv')]);
        const fileId = snapshot(record).selectedFileId!;
        const column = snapshot(record).metadata!.schema![0][0];
        const original = service.analyze.bind(service);
        service.analyze = async (request) => {
            entered.release();
            await release.promise;
            return original(request);
        };
        const pending = ui.handle({ type: 'selectFile', fileId });
        await entered.promise;
        for (const [type, value] of [
            ['setTableName', 'edited_table'], ['setSchemaName', 'edited_schema'],
            ['setDataSource', 'EditedSource'], ['setCredentialName', 'EditedCredential'],
            ['setFormatName', 'EditedFormat'],
        ]) {
            await ui.handle({ type, fileId, value });
        }
        await ui.handle({ type: 'setStorageUrl', value: 'abs://data@account.blob.core.windows.net/sample.csv' });
        await ui.handle({ type: 'setParserOverride', fileId, key: 'fieldDelimiter', value: '|' });
        await ui.handle({ type: 'setColumnOverride', fileId, column, sqlType: 'DECIMAL(18,4)' });
        const edited = fileSettingsFrom(snapshot(record));
        await ui.handle({ type: 'setColumnOverride', fileId, column, sqlType: 'NOT_A_TYPE' });
        assert.equal(snapshot(record).busy, true, 'invalid settings do not end an active analysis');
        release.release();
        await pending;
        assert.deepEqual(fileSettingsFrom(snapshot(record)), edited);
        assert.match(snapshot(record).statements!.create_table, /\[edited_schema\]\.\[edited_table\]/);
        assert.match(snapshot(record).statements!.create_table, /DECIMAL\(18,4\)/);
        assert.match(snapshot(record).statements!.bulk_insert, /FIELDTERMINATOR\s+= '\|'/);
        assert.equal(snapshot(record).busy, false);
    } finally {
        release.release();
        await ui.dispose();
        cleanup(record);
    }
});

test('file selection and source switches suppress a late analysis even when it ignores cancellation', async () => {
    const record = recorder();
    const service = new NativeAnalysisService();
    const azure = new AzureBrowser({ authentication: new MicrosoftAuthentication(async () => undefined) });
    const entered = gate();
    const release = gate();
    const ui = controller(record, { service, azure });
    try {
        await ui.loadFiles([path.join(FIXTURES, 'sample.csv'), path.join(FIXTURES, 'employees.csv')]);
        const [first, second] = snapshot(record).files;
        const original = service.analyze.bind(service);
        const delayed = await original({ filePath: path.join(FIXTURES, 'sample.csv'), allowedRoot: FIXTURES });
        service.analyze = async (request) => {
            if (request.filePath.endsWith('sample.csv')) {
                entered.release();
                await release.promise;
                return delayed;
            }
            return original(request);
        };
        const pending = ui.handle({ type: 'selectFile', fileId: first.id });
        await entered.promise;
        await ui.handle({ type: 'selectFile', fileId: second.id });
        assert.equal(snapshot(record).metadata?.file_name, 'employees.csv', 'the new selection does not wait for obsolete analysis');
        await ui.handle({ type: 'setTableName', fileId: second.id, value: 'kept' });
        await ui.handle({ type: 'openAzureBrowser' });
        assert.equal(snapshot(record).busy, false);
        release.release();
        await pending;
        assert.equal(snapshot(record).sourceMode, 'azure');
        assert.equal(snapshot(record).metadata, null);
        await ui.handle({ type: 'activateLocalSource' });
        assert.equal(snapshot(record).selectedFileId, second.id);
        assert.equal(snapshot(record).metadata?.file_name, 'employees.csv');
        assert.equal(snapshot(record).tableName, 'kept');
    } finally {
        release.release();
        await ui.dispose();
        cleanup(record);
    }
});

test('profiles reload without secrets, apply only matching columns and keep current platform and source choices', async () => {
    const first = recorder();
    const second = recorder();
    const firstUi = controller(first);
    let secondUi: UiController | undefined;
    try {
        const source = path.join(first.downloadDir, 'source.csv');
        const target = path.join(second.downloadDir, 'target.csv');
        fs.writeFileSync(source, 'id,amount\n1,20\n2,30\n');
        fs.writeFileSync(target, 'id,name\n1,Alice\n2,Bob\n');
        await firstUi.loadFiles([source]);
        const firstId = snapshot(first).selectedFileId!;
        await firstUi.handle({ type: 'setTableName', fileId: firstId, value: 'orders' });
        await firstUi.handle({ type: 'setCredentialName', fileId: firstId, value: 'OrdersCredential' });
        await firstUi.handle({ type: 'setParserOverride', fileId: firstId, key: 'fieldDelimiter', value: '|' });
        await firstUi.handle({ type: 'setColumnOverride', fileId: firstId, column: 'id', sqlType: 'BIGINT' });
        await firstUi.handle({ type: 'setColumnOverride', fileId: firstId, column: 'amount', sqlType: 'DECIMAL(18,4)' });
        await firstUi.handle({ type: 'setStorageUrl', value: 'abs://data@account.blob.core.windows.net/source.csv?sig=SECRET' });
        await firstUi.handle({ type: 'saveImportProfile', fileId: firstId, name: 'Orders' });
        const saved = first.preferences.get(IMPORT_PROFILES_PREFERENCE);
        assert.ok(saved);
        assert.doesNotMatch(JSON.stringify(saved), /SECRET|source\.csv|blob\.core|storageUrl|authMethod|platform|file_path|sample_rows/);
        assert.ok(!JSON.stringify(saved).includes(first.downloadDir));
        assert.deepEqual(Object.keys(saved as object), ['0']);
        second.preferences.set(IMPORT_PROFILES_PREFERENCE, JSON.parse(JSON.stringify(saved)));
        let authenticationCalls = 0;
        const azure = new AzureBrowser({
            authentication: new MicrosoftAuthentication(async () => { authenticationCalls += 1; return undefined; }),
        });
        secondUi = controller(second, { azure });
        assert.deepEqual(snapshot(second).importProfiles, ['Orders']);
        assert.equal(snapshot(second).selectedFileId, null, 'file history is session-only');
        assert.equal(authenticationCalls, 0);
        await secondUi.loadFiles([target]);
        const secondId = snapshot(second).selectedFileId!;
        await secondUi.handle({ type: 'setPlatform', platform: 'fabric_sql_db' });
        await secondUi.handle({ type: 'setStorageUrl', value: 'abfss://workspace@onelake.dfs.fabric.microsoft.com/lakehouse/Files/target.csv' });
        const before = snapshot(second);
        await secondUi.handle({ type: 'applyImportProfile', fileId: secondId, name: 'Orders' });
        const applied = snapshot(second);
        assert.equal(applied.tableName, 'orders');
        assert.equal(applied.credentialName, 'OrdersCredential');
        assert.deepEqual(applied.columnOverrides, { id: 'BIGINT' });
        assert.equal(applied.parserOverrides.fieldDelimiter, '|');
        assert.match(applied.notice ?? '', /amount/);
        for (const key of ['platform', 'sourceMode', 'sourceKind', 'storageUrl', 'dataSourceType', 'authMethod', 'selectedFileId'] as const) {
            assert.equal(applied[key], before[key], key);
        }
        assert.equal(applied.authMethod, 'user_identity');
        assert.equal(applied.dataSourceType, 'fabric_onelake');
        await secondUi.handle({ type: 'undoFileSettings', fileId: secondId });
        assert.equal(snapshot(second).tableName, 'target');
        assert.deepEqual(snapshot(second).columnOverrides, {});
        await secondUi.handle({ type: 'deleteImportProfile', name: 'Orders' });
        assert.deepEqual(snapshot(second).importProfiles, []);
        assert.deepEqual(second.preferences.get(IMPORT_PROFILES_PREFERENCE), []);
        assert.equal(authenticationCalls, 0);
    } finally {
        await firstUi.dispose();
        await secondUi?.dispose();
        cleanup(first);
        cleanup(second);
    }
});

test('corrupt saved profiles warn safely on startup and failed preference writes leave saved state intact', async () => {
    const record = recorder();
    record.preferences.set(IMPORT_PROFILES_PREFERENCE, [{ version: 1, name: 'Broken', token: 'SECRET' }]);
    const original = record.host.setPreference;
    record.host = {
        ...record.host,
        setPreference: async (key, value) => {
            if (key === IMPORT_PROFILES_PREFERENCE) {
                throw new Error('unsafe storage failure SECRET');
            }
            await original(key, value);
        },
    };
    const ui = controller(record);
    try {
        assert.deepEqual(snapshot(record).importProfiles, []);
        assert.match(record.warnings[0], /could not be loaded/);
        assert.match(record.logs[0], /No saved data was changed/);
        assert.doesNotMatch(JSON.stringify(record.logs), /SECRET/);
        await ui.loadFiles([path.join(FIXTURES, 'sample.csv')]);
        await ui.handle({ type: 'saveImportProfile', fileId: snapshot(record).selectedFileId, name: 'Valid' });
        assert.match(snapshot(record).error ?? '', /could not be saved/);
        assert.deepEqual(snapshot(record).importProfiles, []);
        assert.deepEqual(record.preferences.get(IMPORT_PROFILES_PREFERENCE), [{ version: 1, name: 'Broken', token: 'SECRET' }]);
        assert.doesNotMatch(JSON.stringify(snapshot(record)), /SECRET/);
        assert.doesNotMatch(JSON.stringify(record.logs), /SECRET/);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('queued profile saves capture the originating file before persistence awaits and do not lose concurrent saves', async () => {
    const record = recorder();
    const entered = gate();
    const release = gate();
    const original = record.host.setPreference;
    let writes = 0;
    record.host = {
        ...record.host,
        setPreference: async (key, value) => {
            if (key === IMPORT_PROFILES_PREFERENCE && ++writes === 1) {
                entered.release();
                await release.promise;
            }
            await original(key, value);
        },
    };
    const ui = controller(record);
    try {
        await ui.loadFiles([path.join(FIXTURES, 'sample.csv'), path.join(FIXTURES, 'employees.csv')]);
        const [first, second] = snapshot(record).files;
        await ui.handle({ type: 'setTableName', fileId: first.id, value: 'first_table' });
        const firstSave = ui.handle({ type: 'saveImportProfile', fileId: first.id, name: 'First' });
        await entered.promise;
        await ui.handle({ type: 'selectFile', fileId: second.id });
        await ui.handle({ type: 'setTableName', fileId: second.id, value: 'second_table' });
        const secondSave = ui.handle({ type: 'saveImportProfile', fileId: second.id, name: 'Second' });
        release.release();
        await Promise.all([firstSave, secondSave]);
        const profiles = record.preferences.get(IMPORT_PROFILES_PREFERENCE) as ImportProfile[];
        assert.deepEqual(profiles.map(({ name, tableName }) => [name, tableName]), [
            ['First', 'first_table'], ['Second', 'second_table'],
        ]);
        assert.equal(snapshot(record).tableName, 'second_table');
    } finally {
        release.release();
        await ui.dispose();
        cleanup(record);
    }
});

test('authoritative schema drift removes and reports only absent overrides, including on Undo', async () => {
    const record = recorder();
    const service = new NativeAnalysisService();
    const ui = controller(record, { service });
    try {
        const source = path.join(record.downloadDir, 'source.csv');
        fs.writeFileSync(source, 'id,amount\n1,20\n2,30\n');
        await ui.loadFiles([source]);
        const fileId = snapshot(record).selectedFileId!;
        await ui.handle({ type: 'setColumnOverride', fileId, column: 'id', sqlType: 'BIGINT' });
        await ui.handle({ type: 'setColumnOverride', fileId, column: 'amount', sqlType: 'DECIMAL(18,4)' });
        await ui.handle({ type: 'setSchemaName', fileId, value: 'kept' });
        const metadata = await service.analyze({ filePath: source, allowedRoot: record.downloadDir });
        service.analyze = async () => ({ ...metadata, schema: [['id', 'int64'], ['replacement', 'string']] });
        await ui.handle({ type: 'selectFile', fileId });
        assert.deepEqual(snapshot(record).columnOverrides, { id: 'BIGINT' });
        assert.equal(snapshot(record).schemaName, 'kept');
        assert.match(snapshot(record).notice ?? '', /amount/);
        await ui.handle({ type: 'undoFileSettings', fileId });
        assert.deepEqual(snapshot(record).columnOverrides, { id: 'BIGINT' });
        assert.match(snapshot(record).notice ?? '', /amount/);
        assert.doesNotMatch(snapshot(record).statements!.create_table, /DECIMAL\(18,4\)/);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('exact source column punctuation survives profiles and prototype-shaped column edits are explicitly rejected', async () => {
    const record = recorder();
    const service = new NativeAnalysisService();
    const source = path.join(FIXTURES, 'sample.csv');
    const metadata = await service.analyze({ filePath: source, allowedRoot: FIXTURES });
    const columns = ['Revenue / USD', 'Key: value', ' padded ', '__proto__', 'constructor', 'prototype'];
    service.analyze = async () => ({ ...metadata, schema: columns.map((name) => [name, 'string']) });
    const ui = controller(record, { service });
    try {
        await ui.loadFiles([source]);
        const fileId = snapshot(record).selectedFileId!;
        for (const column of columns.slice(0, 3)) {
            await ui.handle({ type: 'setColumnOverride', fileId, column, sqlType: 'NVARCHAR(80)' });
        }
        const overrides = { ...snapshot(record).columnOverrides };
        await ui.handle({ type: 'saveImportProfile', fileId, name: 'Exact names' });
        await ui.handle({ type: 'resetFileSettings', fileId });
        await ui.handle({ type: 'applyImportProfile', fileId, name: 'Exact names' });
        assert.deepEqual(snapshot(record).columnOverrides, overrides);
        for (const column of columns.slice(3)) {
            for (const sqlType of ['INT', '']) {
                await ui.handle({ type: 'setColumnOverride', fileId, column, sqlType });
                assert.match(snapshot(record).error ?? '', /prototype keys/);
                assert.deepEqual(snapshot(record).columnOverrides, overrides);
            }
        }
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('multi-file export uses each files retained names and overrides, not the active files settings', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        const firstPath = path.join(record.downloadDir, 'first.csv');
        const secondPath = path.join(record.downloadDir, 'second.csv');
        fs.writeFileSync(firstPath, 'id,value\n1,10\n');
        fs.writeFileSync(secondPath, 'id,value\n2,20\n');
        await ui.loadFiles([firstPath, secondPath]);
        const [first, second] = snapshot(record).files;
        for (const [file, suffix, sqlType, delimiter] of [
            [first, 'First', 'BIGINT', '|'],
            [second, 'Second', 'DECIMAL(18,4)', ';'],
        ] as const) {
            await ui.handle({ type: 'selectFile', fileId: file.id });
            for (const [type, value] of [
                ['setTableName', `Table${suffix}`], ['setSchemaName', `Schema${suffix}`],
                ['setDataSource', `Source${suffix}`], ['setCredentialName', `Credential${suffix}`],
                ['setFormatName', `Format${suffix}`],
            ]) {
                await ui.handle({ type, fileId: file.id, value });
            }
            await ui.handle({ type: 'setColumnOverride', fileId: file.id, column: 'id', sqlType });
            await ui.handle({ type: 'setParserOverride', fileId: file.id, key: 'fieldDelimiter', value: delimiter });
        }
        await ui.handle({ type: 'setPlatform', platform: 'sql_server_2022' });
        await ui.handle({ type: 'exportAllSql' });
        const sql = record.saved[0].content;
        for (const suffix of ['First', 'Second']) {
            assert.ok(sql.includes(`[Schema${suffix}].[Table${suffix}]`));
            assert.ok(sql.includes(`Source${suffix}`));
            assert.ok(sql.includes(`Credential${suffix}`));
            assert.ok(sql.includes(`Format${suffix}`));
        }
        const split = sql.indexOf('CREATE TABLE [SchemaSecond].[TableSecond]');
        assert.ok(split > 0);
        assert.match(sql.slice(0, split), /\[id\]\s+BIGINT/);
        assert.match(sql.slice(split), /\[id\]\s+DECIMAL\(18,4\)/);
        assert.match(sql, /FIELDTERMINATOR\s+= '\|'/);
        assert.match(sql, /FIELDTERMINATOR\s+= ';'/);
        assert.equal(snapshot(record).selectedFileId, second.id);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('the controller applies and resets parser overrides per selected file', async () => {
    const record = recorder();
    const timers: Array<() => void> = [];
    const ui = controller(record, {
        setTimeoutImpl: (fn: () => void) => {
            timers.push(fn);
            return fn;
        },
        clearTimeoutImpl: () => undefined,
    });

    try {
        await ui.loadFiles([path.join(FIXTURES, 'sample.csv')]);
        await settle();
        assert.equal(snapshot(record).activeTab, 'preview');
        const fileId = snapshot(record).selectedFileId as string;
        await ui.handle({
            type: 'setParserOverride',
            fileId,
            key: 'fieldDelimiter',
            value: '|',
        });
        timers.splice(0).forEach((fire) => fire());
        assert.equal(snapshot(record).parserOverrides.fieldDelimiter, '|');
        assert.equal(
            snapshot(record).quickAnalyze.options.find(
                (option) => option.key === 'fieldDelimiter',
            )?.provenance,
            'Overridden',
        );
        assert.match(snapshot(record).statements?.bulk_insert ?? '', /FIELDTERMINATOR\s+= '\|'/);

        await ui.handle({ type: 'resetParserOverride', fileId, key: 'fieldDelimiter' });
        timers.splice(0).forEach((fire) => fire());
        assert.equal(snapshot(record).parserOverrides.fieldDelimiter, undefined);
        assert.equal(
            snapshot(record).quickAnalyze.options.find(
                (option) => option.key === 'fieldDelimiter',
            )?.provenance,
            'Inferred',
        );

    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('documentation messages open only host-mapped links for the current platform', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.handle({ type: 'setPlatform', platform: 'sql_server_2022' });
        await ui.handle({
            type: 'openDocumentation',
            id: 'create_external_table',
        });
        assert.deepEqual(record.externalUrls, [
            'https://learn.microsoft.com/en-us/sql/t-sql/statements/create-external-table-transact-sql?view=sql-server-ver16&preserve-view=true',
        ]);

        await ui.handle({ type: 'setPlatform', platform: 'fabric_sql_db' });
        await ui.handle({ type: 'openDocumentation', id: 'bulk_insert' });
        assert.equal(record.externalUrls.length, 1);
        assert.match(record.logs.at(-1) ?? '', /unavailable for the selected platform/);

        await ui.handle({
            type: 'openDocumentation',
            id: 'https://example.com/not-allowlisted',
        });
        assert.equal(record.externalUrls.length, 1);
        assert.match(record.logs.at(-1) ?? '', /Dropped an unrecognised/);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('folder Quick Analyze keeps per-file facts and reports mixed values', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.loadDirectory(DEMO);
        await settle();
        const state = snapshot(record);
        assert.ok(state.folderProfile);
        assert.equal(state.folderProfile.format, 'Mixed');
        assert.ok(state.folderProfile.outlierCount > 0);
        assert.equal(state.parserOverrides.fieldDelimiter, undefined);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('the file filter is shared and resets for a newly chosen source', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.handle({ type: 'setFileFilter', value: 'sales' });
        assert.equal(snapshot(record).fileFilter, 'sales');

        await ui.loadFiles([path.join(FIXTURES, 'sample.csv')]);
        assert.equal(snapshot(record).fileFilter, '');
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

// -- message validation -------------------------------------------------------

test('a malformed or unknown message is dropped, never defaulted', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        const before = snapshot(record);
        for (const raw of [
            undefined,
            null,
            42,
            'ready',
            [],
            {},
            { type: 'nope' },
            { type: 'selectFile' },
            { type: 'selectFile', fileId: 42 },
            { type: '__proto__' },
            { type: 'constructor' },
            { type: 'setPlatform', platform: { toString: () => 'sql_server_2022' } },
        ]) {
            await ui.handle(raw);
        }
        await settle();
        assert.equal(
            ({} as Record<string, unknown>).polluted,
            undefined,
            'no prototype pollution',
        );
        assert.ok(record.logs.some((line) => line.includes('Dropped an unrecognised')));
        assert.equal(snapshot(record).files.length, before.files.length);
        assert.equal(snapshot(record).error, null);

        // An unexpected extra field on an otherwise valid message is ignored,
        // not treated as instructions.
        await ui.handle({
            type: 'dismissNotice',
            extra: JSON.parse('{"__proto__": {"polluted": true}}'),
        });
        await settle();
        assert.equal(({} as Record<string, unknown>).polluted, undefined);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('handle never throws, whatever the handler does', async () => {
    const record = recorder();
    const ui = controller(record, {
        service: completeOnlyService({
            listFormats: () => [],
            normalizePlatform: () => 'azure_sql_db',
            resolveTableName: () => 'X',
            analyze: async () => {
                throw new Error('boom: AccountKey=SECRET');
            },
            analyzeDirectory: async () => {
                throw new Error('boom');
            },
            preview: async () => {
                throw new Error('boom');
            },
            generateStatements: () => ({}),
            generateCompleteDocument: () => '',
            generateMultiFileScript: () => '',
        }),
    });
    try {
        await ui.analyzePath(path.join(FIXTURES, 'sample.csv'), false);
        await settle();
        const error = snapshot(record).error;
        assert.ok(error, 'the failure surfaces as state, not an exception');
        assert.ok(!error.includes('SECRET'), 'the message is redacted');
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

// -- explicit file / workspace flow ------------------------------------------

test('analyzing an explicit file produces metadata, preview and SQL', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.analyzePath(path.join(FIXTURES, 'employees.csv'), false);
        await settle();

        const state = snapshot(record);
        assert.equal(state.busy, false);
        assert.equal(state.error, null);
        assert.equal(state.files.length, 1);
        assert.equal(state.files[0].label, 'employees.csv');
        assert.ok(state.selectedFileId);
        assert.equal(state.metadata?.file_type, 'csv');
        assert.ok((state.metadata?.schema?.length ?? 0) > 0);
        assert.ok(Object.keys(state.recommendedSqlTypes).length > 0);
        assert.ok(
            (state.metadata?.schema ?? []).every(
                ([column]) => Boolean(state.recommendedSqlTypes[column]),
            ),
        );
        assert.ok((state.preview?.rows.length ?? 0) > 0);
        assert.ok(state.statements?.create_table.includes('CREATE TABLE'));
        assert.ok(typeof state.lastAnalysisMs === 'number');
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('controller preview preserves exact CSV numerics as source text', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlfd-exact-preview-'));
    const source = path.join(root, 'exact.csv');
    fs.writeFileSync(
        source,
        'big,decimal,scientific\n' +
        '9223372036854775807,12345678901234.5678,1e-7\n',
    );
    const record = recorder({ workspaceFolders: [root] });
    const ui = controller(record);
    try {
        await ui.analyzePath(source, false);
        await settle();

        assert.deepEqual(snapshot(record).preview?.rows[0], [
            '9223372036854775807',
            '12345678901234.5678',
            '1e-7',
        ]);
    } finally {
        await ui.dispose();
        cleanup(record);
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('choosing a folder lists files and selects the first', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.dialogResult = [{ path: FIXTURES, isDirectory: true }];
        await ui.handle({ type: 'openLocalDialog' });
        await settle();

        const state = snapshot(record);
        assert.ok(state.files.length > 3, 'the fixture folder has several data files');
        assert.ok(state.selectedFileId);
        assert.ok(state.metadata);
        assert.ok(
            state.files.every((entry) => !entry.label.includes(path.sep)),
            'labels are names, not paths',
        );
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('Browse local accepts one or more files', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.dialogResult = [
            { path: path.join(FIXTURES, 'employees.csv'), isDirectory: false },
            { path: path.join(FIXTURES, 'sample.csv'), isDirectory: false },
        ];
        await ui.handle({ type: 'openLocalDialog' });
        await settle();

        const state = snapshot(record);
        assert.equal(state.sourceMode, 'local');
        assert.equal(state.files.length, 2);
        assert.equal(state.sourceLabel, 'csv (2 files)');
        assert.ok(state.selectedFileId);
        assert.ok(state.metadata);
        assert.deepEqual(record.dialogs[0], {
            files: true,
            folders: true,
            many: true,
            title: 'Select data files or a folder to analyze',
        });
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('Browse local rejects mixed file and folder selections', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.dialogResult = [
            { path: FIXTURES, isDirectory: true },
            { path: path.join(FIXTURES, 'sample.csv'), isDirectory: false },
        ];
        await ui.handle({ type: 'openLocalDialog' });

        assert.match(snapshot(record).error ?? '', /one folder or one or more files/i);
        assert.equal(snapshot(record).files.length, 0);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('outside-workspace File location shows an abbreviated path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlfd-location-'));
    const source = path.join(root, 'private-folder-name', 'orders.csv');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'id\n1\n');
    const record = recorder({ workspaceFolders: [FIXTURES] });
    const ui = controller(record);
    try {
        await ui.loadFiles([source]);
        assert.equal(
            snapshot(record).locationLabel,
            '.../private-folder-name/orders.csv',
        );
        assert.ok(!String(snapshot(record).locationLabel).includes(root));
    } finally {
        await ui.dispose();
        cleanup(record);
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('folder scans reach partitioned layouts and skip non-SQL files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlfd-tree-'));
    fs.mkdirSync(path.join(root, 'year', 'month'), { recursive: true });
    fs.writeFileSync(path.join(root, 'top.csv'), 'id,name\n1,top\n');
    fs.writeFileSync(path.join(root, 'year', 'direct.csv'), 'id,name\n2,direct\n');
    fs.writeFileSync(path.join(root, 'year', 'month', 'deep.csv'), 'id,name\n3,deep\n');
    fs.writeFileSync(path.join(root, 'script.py'), 'id,name\n3,python\n');
    fs.writeFileSync(path.join(root, 'workbook.xlsx'), 'id,name\n4,excel\n');
    fs.writeFileSync(path.join(root, 'table.delta'), 'id,name\n5,not-a-delta-table\n');
    const record = recorder({ workspaceFolders: [root] });
    const ui = controller(record);
    try {
        await ui.loadDirectory(root);
        await settle();

        const state = snapshot(record);
        // Lake layouts nest, so a file below the first level must still be
        // found, and its folder path must stay distinct rather than collapsing
        // onto the folder name alone.
        assert.deepEqual(
            state.files.map((entry) => entry.label).sort(),
            ['deep.csv', 'direct.csv', 'top.csv'],
        );
        assert.equal(
            state.files.find((entry) => entry.label === 'direct.csv')?.folderLabel,
            'year',
        );
        assert.equal(
            state.files.find((entry) => entry.label === 'deep.csv')?.folderLabel,
            'year/month',
        );

        await ui.loadFiles([path.join(root, 'script.py')]);
        assert.equal(snapshot(record).files.length, 0);
        assert.match(snapshot(record).error ?? '', /SQL-readable data file/i);

        await ui.loadFiles([path.join(root, 'table.delta')]);
        assert.equal(snapshot(record).files.length, 0);
        assert.match(snapshot(record).error ?? '', /SQL-readable data file/i);

        await ui.loadFiles([
            path.join(root, 'top.csv'),
            path.join(root, 'workbook.xlsx'),
        ]);
        await settle();
        assert.equal(snapshot(record).files.length, 1);
        assert.match(snapshot(record).notice ?? '', /unsupported file was skipped/i);
    } finally {
        await ui.dispose();
        cleanup(record);
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('starting a folder scan clears the previous file result', async () => {
    const record = recorder();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
    });
    const ui = controller(record, {
        service: completeOnlyService({
            listFormats: () => [],
            normalizePlatform: () => 'azure_sql_db',
            resolveTableName: () => 'T',
            analyze: async ({ filePath }: { filePath: string }) => ({
                file_path: filePath,
                file_name: path.basename(filePath),
                file_type: 'csv',
                size_bytes: 1,
                columns: [],
            }),
            analyzeDirectory: async () => {
                await blocked;
                return { root: DEMO, files: [] };
            },
            preview: async () => ({ columns: [], rows: [], total_rows: 0, truncated: false }),
            generateStatements: () => ({ create_table: 'previous SQL' }),
            generateCompleteDocument: () => 'x',
            generateMultiFileScript: () => 'x',
        }),
    });
    try {
        await ui.loadFiles([path.join(FIXTURES, 'sample.csv')]);
        assert.ok(snapshot(record).metadata);
        assert.ok(snapshot(record).statements);

        const scanning = ui.loadDirectory(DEMO);
        await settle();
        const pending = snapshot(record);
        assert.equal(pending.busy, true);
        assert.equal(pending.selectedFileId, null);
        assert.deepEqual(pending.files, []);
        assert.equal(pending.metadata, null);
        assert.equal(pending.preview, null);
        assert.equal(pending.statements, null);

        release?.();
        await scanning;
    } finally {
        release?.();
        await ui.dispose();
        cleanup(record);
    }
});

test('a cancelled picker still switches to the local source tab', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.dialogResult = undefined;
        await ui.handle({ type: 'activateLocalSource' });
        await settle();
        assert.equal(snapshot(record).files.length, 0);
        assert.equal(snapshot(record).error, null);
        assert.equal(snapshot(record).sourceMode, 'local');
        assert.equal(snapshot(record).activeTab, 'preview');
        assert.deepEqual(
            record.dialogs.map((dialog) => [dialog.files, dialog.folders]),
            [[true, true]],
        );
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('returning from Azure restores the retained folder without a picker', async () => {
    const record = recorder();
    const azure = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async () => undefined),
    });
    const ui = controller(record, { azure });
    try {
        await ui.loadDirectory(FIXTURES);
        await settle();
        const retainedIds = snapshot(record).files.map((file) => file.id);
        const retainedLocation = snapshot(record).sourceLabel;
        const retainedSelection = snapshot(record).selectedFileId;

        await ui.handle({ type: 'openAzureBrowser' });
        assert.equal(snapshot(record).sourceMode, 'azure');
        assert.equal(snapshot(record).azure.open, true);

        await ui.handle({ type: 'activateLocalSource' });

        assert.equal(record.dialogs.length, 0);
        assert.equal(snapshot(record).sourceMode, 'local');
        assert.equal(snapshot(record).azure.open, false);
        assert.deepEqual(snapshot(record).files.map((file) => file.id), retainedIds);
        assert.equal(snapshot(record).sourceLabel, retainedLocation);
        assert.equal(snapshot(record).selectedFileId, retainedSelection);
        assert.equal(snapshot(record).activeTab, 'preview');
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('the renderer can only select files the host listed', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.analyzePath(path.join(FIXTURES, 'sample.csv'), false);
        await settle();
        const good = snapshot(record).selectedFileId as string;

        await ui.handle({ type: 'selectFile', fileId: 'ffffffffffffffffffffffff' });
        await settle();
        assert.match(snapshot(record).error ?? '', /no longer in the list/i);
        assert.equal(snapshot(record).selectedFileId, good, 'the selection did not move');

        // A path is not an id, so it cannot widen the analysis root.
        await ui.handle({ type: 'selectFile', fileId: path.join(os.homedir(), '.ssh', 'id_rsa') });
        await settle();
        assert.equal(snapshot(record).selectedFileId, good);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('selecting a listed file analyzes it immediately and opens Preview', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.loadFiles([
            path.join(FIXTURES, 'employees.csv'),
            path.join(SAMPLES, 'parquet', 'sample.parquet'),
        ]);
        await settle();
        assert.equal(snapshot(record).tableName, 'employees');
        await ui.handle({ type: 'setTab', tab: 'metadata' });
        const parquet = snapshot(record).files.find(
            (entry) => entry.label === 'sample.parquet',
        );
        assert.ok(parquet);

        await ui.handle({ type: 'selectFile', fileId: parquet.id });
        await settle();

        const state = snapshot(record);
        assert.equal(state.selectedFileId, parquet.id);
        assert.equal(state.activeTab, 'preview');
        assert.equal(state.metadata?.file_type, 'parquet');
        assert.equal(state.metadata?.file_name, 'sample.parquet');
        assert.equal(state.tableName, 'sample');
        assert.match(state.statements?.create_table ?? '', /\[dbo\]\.\[sample\]/);
        assert.match(state.statements?.create_external_table ?? '', /CREATE EXTERNAL TABLE/);
        assert.match(
            state.statements?.create_external_table ?? '',
            /NVARCHAR\(4000\)/i,
        );
        assert.ok((state.preview?.rows.length ?? 0) > 0);
        assert.equal(record.preferences.get('activeTab'), 'preview');
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('selecting an existing local file replaces Azure setup state', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.analyzePath(path.join(FIXTURES, 'sample.csv'), false);
        await settle();
        const fileId = snapshot(record).selectedFileId as string;
        assert.ok(snapshot(record).metadata);

        record.store.update({
            sourceMode: 'azure',
            sourceKind: 'azure',
            activeTab: 'credential_setup',
            storageUrl: 'abs://raw@account.blob.core.windows.net/orders.csv',
            remoteSchema: {
                status: 'not_analyzed',
                formats: ['csv'],
                selectedFormat: 'csv',
                message: 'Schema not analyzed.',
            },
        });

        await ui.handle({ type: 'selectFile', fileId });
        await settle();

        assert.equal(snapshot(record).sourceMode, 'local');
        assert.equal(snapshot(record).sourceKind, 'local');
        assert.equal(snapshot(record).activeTab, 'preview');
        assert.equal(snapshot(record).storageUrl, '');
        assert.equal(snapshot(record).remoteSchema, null);
        assert.ok(snapshot(record).metadata);
        assert.ok(snapshot(record).preview);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('selecting another file clears the previous result while analysis is pending', async () => {
    const record = recorder();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
    });
    let call = 0;
    const ui = controller(record, {
        service: completeOnlyService({
            listFormats: () => [],
            normalizePlatform: () => 'azure_sql_db',
            resolveTableName: () => 'T',
            analyze: async ({ filePath }: { filePath: string }) => {
                call += 1;
                if (call === 2) {
                    await blocked;
                }
                return {
                    file_path: filePath,
                    file_name: path.basename(filePath),
                    file_type: 'csv',
                    size_bytes: 1,
                    columns: [],
                };
            },
            analyzeDirectory: async () => ({ root: FIXTURES, files: [] }),
            preview: async () => ({ columns: [], rows: [], total_rows: 0, truncated: false }),
            generateStatements: () => ({ create_table: 'previous SQL' }),
            generateCompleteDocument: () => 'x',
            generateMultiFileScript: () => 'x',
        }),
    });
    try {
        await ui.loadFiles([
            path.join(FIXTURES, 'sample.csv'),
            path.join(FIXTURES, 'employees.csv'),
        ]);
        assert.ok(snapshot(record).metadata);
        assert.ok(snapshot(record).statements);

        const next = snapshot(record).files.find((file) => file.label === 'employees.csv');
        assert.ok(next);
        const selecting = ui.handle({ type: 'selectFile', fileId: next.id });
        await settle();

        const pending = snapshot(record);
        assert.equal(pending.selectedFileId, next.id);
        assert.equal(pending.busy, true);
        assert.equal(pending.metadata, null);
        assert.equal(pending.preview, null);
        assert.equal(pending.statements, null);
        assert.deepEqual(pending.recommendedSqlTypes, {});
        assert.equal(pending.limitation, null);
        assert.equal(pending.lastAnalysisMs, null);

        release?.();
        await selecting;
    } finally {
        release?.();
        await ui.dispose();
        cleanup(record);
    }
});

// -- formats ------------------------------------------------------------------

for (const [name, fixture, fileType] of [
    ['CSV', path.join(FIXTURES, 'employees.csv'), 'csv'],
    ['TSV', path.join(FIXTURES, 'web_access_logs.tsv'), 'csv'],
    ['JSON', path.join(SAMPLES, 'json', 'sample.json'), 'json'],
    ['JSON Lines', path.join(SAMPLES, 'json', 'events.jsonl'), 'json'],
    ['Parquet', path.join(SAMPLES, 'parquet', 'sample.parquet'), 'parquet'],
] as const) {
    test(`${name} is analysed natively and generates SQL`, async () => {
        const record = recorder();
        const ui = controller(record);
        try {
            await ui.analyzePath(fixture, false);
            await settle();
            const state = snapshot(record);
            assert.equal(state.error, null, `${name} should analyse cleanly`);
            assert.equal(state.metadata?.file_type, fileType);
            assert.equal(state.limitation, null);
            assert.ok(state.statements?.create_table.includes('CREATE TABLE'));
        } finally {
            await ui.dispose();
            cleanup(record);
        }
    });
}

test('a large Parquet file keeps the default preview bounded', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.analyzePath(
            path.join(SAMPLES, 'performance', 'events_250k.parquet'),
            false,
        );
        await settle();

        const state = snapshot(record);
        assert.equal(state.error, null);
        assert.equal(state.metadata?.row_count, 250_000);
        assert.equal(state.preview?.rows.length, 25);
        assert.equal(state.preview?.truncated, true);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

for (const [name, fixture] of [
    ['Delta', path.join(SAMPLES, 'tables', 'delta_table')],
    ['Iceberg', path.join(SAMPLES, 'tables', 'iceberg_table')],
] as const) {
    test(`${name} directories are analysed through the native service`, async () => {
        const record = recorder();
        const ui = controller(record);
        try {
            await ui.analyzePath(fixture, true);
            await settle();
            const state = snapshot(record);
            assert.equal(state.error, null);
            assert.ok(state.metadata, `${name} produced no metadata`);
            assert.ok(state.statements);
        } finally {
            await ui.dispose();
            cleanup(record);
        }
    });
}

test('a Unicode CSV keeps its characters through analysis and generation', async () => {
    const unicode = path.join(DEMO, 'unicode', 'collation_cases_utf8.csv');
    if (!fs.existsSync(unicode)) {
        return;
    }
    const record = recorder({ workspaceFolders: [DEMO] });
    const ui = controller(record);
    try {
        await ui.analyzePath(unicode, false);
        await settle();
        const state = snapshot(record);
        assert.equal(state.error, null);
        assert.ok(state.metadata);
        assert.ok(state.statements?.create_table.includes('CREATE TABLE'));
        assert.ok(
            !/\ufffd/.test(JSON.stringify(state.preview ?? {})),
            'no replacement characters in the preview',
        );
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('ORC reports its limitation and never reaches for Python', async () => {
    const orc = path.join(DEMO, 'orc', 'all_types.orc');
    if (!fs.existsSync(orc)) {
        return;
    }
    const record = recorder({ workspaceFolders: [DEMO] });
    const ui = controller(record);
    try {
        await ui.analyzePath(orc, false);
        await settle();

        const state = snapshot(record);
        assert.equal(state.error, null, 'an unsupported format is not an error');
        assert.equal(state.metadata?.file_type, 'orc');
        assert.ok(state.limitation, 'the ORC limitation must be shown');
        assert.equal(state.limitation.code, 'orc_unsupported');
        assert.equal(state.preview, null, 'no preview is invented');
        assert.ok(state.statements, 'a template is still offered');

        await ui.handle({ type: 'showOrcGuidance' });
        await settle();
        const guidance = record.information.join('\n');
        assert.match(guidance, /separately installed/i);
        assert.match(guidance, /never installs or launches Python/i);
        assert.equal(record.warnings.length, 0);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

// -- options, overrides and regeneration --------------------------------------

test('platform, names and overrides regenerate the SQL and persist preferences', async () => {
    const record = recorder();
    const timers: (() => void)[] = [];
    const ui = controller(record, {
        setTimeoutImpl: (fn: () => void) => {
            timers.push(fn);
            return timers.length;
        },
        clearTimeoutImpl: () => undefined,
    });
    try {
        await ui.analyzePath(path.join(FIXTURES, 'employees.csv'), false);
        await settle();
        const before = snapshot(record).statements?.create_table as string;

        await ui.handle({ type: 'setTableName', fileId: snapshot(record).selectedFileId, value: 'Employees' });
        await ui.handle({ type: 'setSchemaName', fileId: snapshot(record).selectedFileId, value: 'hr' });
        await ui.handle({ type: 'setPlatform', platform: 'sql_server_2022' });
        await settle();
        timers.forEach((fire) => fire());

        const after = snapshot(record).statements?.create_table as string;
        assert.notEqual(after, before);
        assert.ok(after.includes('hr'));
        assert.ok(after.includes('Employees'));
        assert.equal(snapshot(record).platform, 'sql_server_2022');
        assert.equal(record.preferences.get('platform'), 'sql_server_2022');

        const column = snapshot(record).metadata?.schema?.[0]?.[0] as string;
        const fileId = snapshot(record).selectedFileId as string;
        await ui.handle({
            type: 'setColumnOverride',
            fileId,
            column,
            sqlType: 'DECIMAL(18,4)',
        });
        await settle();
        timers.forEach((fire) => fire());
        assert.ok(snapshot(record).statements?.create_table.includes('DECIMAL(18,4)'));
        assert.equal(snapshot(record).columnOverrides[column], 'DECIMAL(18,4)');

        await ui.handle({ type: 'setColumnOverride', fileId, column, sqlType: '   ' });
        await settle();
        timers.forEach((fire) => fire());
        assert.equal(snapshot(record).columnOverrides[column], undefined, 'blank clears');

        await ui.handle({ type: 'setColumnOverride', fileId, column, sqlType: 'BIGINT' });
        await ui.handle({ type: 'clearColumnOverrides', fileId });
        await settle();
        assert.deepEqual(snapshot(record).columnOverrides, {});
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('a burst of keystrokes collapses into one regeneration', async () => {
    const record = recorder();
    let scheduled = 0;
    let cleared = 0;
    const pending: (() => void)[] = [];
    const ui = controller(record, {
        setTimeoutImpl: (fn: () => void) => {
            scheduled += 1;
            pending.push(fn);
            return scheduled;
        },
        clearTimeoutImpl: () => {
            cleared += 1;
        },
    });

    try {
        await ui.analyzePath(path.join(FIXTURES, 'sample.csv'), false);
        await settle();

        for (const value of ['C', 'Cu', 'Cus', 'Cust', 'Custo']) {
            await ui.handle({ type: 'setTableName', fileId: snapshot(record).selectedFileId, value });
        }
        await settle();
        assert.equal(scheduled, 5);
        assert.equal(cleared, 4, 'each keystroke cancels the previous timer');
        // Only the final scheduled callback is meant to run.
        pending[pending.length - 1]();
        assert.ok(snapshot(record).statements?.create_table.includes('Custo'));
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('file-scoped edits cannot reach a newly selected file', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.loadFiles([
            path.join(FIXTURES, 'sample.csv'),
            path.join(FIXTURES, 'employees.csv'),
        ]);
        await settle();
        const firstFileId = snapshot(record).selectedFileId as string;
        const secondFileId = snapshot(record).files.find(
            (file) => file.label === 'employees.csv',
        )?.id as string;

        await ui.handle({ type: 'selectFile', fileId: secondFileId });
        await settle();
        const column = snapshot(record).metadata?.schema?.[0]?.[0] as string;

        await ui.handle({
            type: 'setColumnOverride',
            fileId: firstFileId,
            column,
            sqlType: 'DECIMAL(18,4)',
        });
        await ui.handle({
            type: 'setParserOverride',
            fileId: firstFileId,
            key: 'fieldDelimiter',
            value: '|',
        });

        assert.deepEqual(snapshot(record).columnOverrides, {});
        assert.deepEqual(snapshot(record).parserOverrides, {});
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('statement tabs select their own platform documentation', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.handle({ type: 'setTab', tab: 'create_external_table' });
        assert.equal(snapshot(record).quickAnalyze.selectedStatement, 'create_external_table');
        assert.deepEqual(
            snapshot(record).quickAnalyze.documentation.map((link) => link.id),
            ['create_external_table'],
        );

        await ui.handle({ type: 'setTab', tab: 'credential_setup' });
        assert.deepEqual(
            snapshot(record).quickAnalyze.documentation.map((link) => link.id),
            ['create_database_scoped_credential', 'create_external_data_source'],
        );
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('preview row counts are clamped to the allowed range', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.analyzePath(path.join(FIXTURES, 'employees.csv'), false);
        await settle();

        await ui.handle({ type: 'setPreviewRows', rows: 1_000_000 });
        await settle();
        assert.ok(snapshot(record).previewRows <= 500);

        await ui.handle({ type: 'setPreviewRows', rows: -5 });
        await settle();
        assert.ok(snapshot(record).previewRows >= 1);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

// -- clipboard and export -----------------------------------------------------

test('copy and open use the host, not a browser API', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.analyzePath(path.join(FIXTURES, 'employees.csv'), false);
        await settle();

        await ui.handle({ type: 'copyStatement', kind: 'create_table' as StatementKind });
        await settle();
        assert.equal(record.clipboard.length, 1);
        assert.ok(record.clipboard[0].includes('CREATE TABLE'));
        assert.match(snapshot(record).notice ?? '', /Copied/i);

        await ui.handle({ type: 'openStatementInEditor', kind: 'bulk_insert' as StatementKind });
        await settle();
        assert.equal(record.untitled.at(-1)?.languageId, 'sql');
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('copying before an analysis says so rather than copying nothing', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.handle({ type: 'copyStatement', kind: 'create_table' as StatementKind });
        await settle();
        assert.match(snapshot(record).error ?? '', /nothing to copy/i);
        assert.equal(record.clipboard.length, 0);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('mixed Azure folders require an explicit format before goal SQL is generated', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.store.update({
            activeTab: 'credential_setup',
            sourceKind: 'azure',
            storageUrl: 'abs://raw@account.blob.core.windows.net/mixed/',
            azureFolderPreview: {
                label: 'raw/mixed',
                url: 'abs://raw@account.blob.core.windows.net/mixed/',
                items: [
                    {
                        kind: 'file',
                        name: 'orders.csv',
                        format: 'csv',
                        sizeBytes: 10,
                        modifiedAt: null,
                    },
                    {
                        kind: 'file',
                        name: 'orders.parquet',
                        format: 'parquet',
                        sizeBytes: 20,
                        modifiedAt: null,
                    },
                ],
                truncated: false,
            },
            remoteSchema: {
                status: 'format_required',
                formats: ['csv', 'parquet'],
                selectedFormat: null,
                message: 'Choose a format.',
            },
        });

        ui.generateNow();
        assert.equal(snapshot(record).statements, null);

        await ui.handle({ type: 'setAzureFolderFormat', value: 'parquet' });
        const sql = snapshot(record).statements?.credential_setup ?? '';
        assert.match(sql, /FORMAT_TYPE = PARQUET/);
        assert.match(sql, /TEMPLATE ONLY - REMOTE SCHEMA NOT ANALYZED/);
        assert.equal(snapshot(record).remoteSchema?.selectedFormat, 'parquet');

        await ui.handle({ type: 'setAzureFolderFormat', value: 'delta' });
        assert.match(snapshot(record).error ?? '', /formats detected/i);
        assert.equal(snapshot(record).remoteSchema?.selectedFormat, 'parquet');
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('complete setup scripts copy and open as MSSQL-ready SQL documents', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.store.update({
            sourceKind: 'azure',
            storageUrl: 'abs://raw@account.blob.core.windows.net/orders.parquet',
            remoteSchema: {
                status: 'not_analyzed',
                formats: ['parquet'],
                selectedFormat: 'parquet',
                message: 'Schema not analyzed.',
            },
        });
        ui.generateNow();

        await ui.handle({ type: 'copyStatement', kind: 'credential_setup' });
        assert.match(record.clipboard.at(-1) ?? '', /CREATE EXTERNAL DATA SOURCE/);

        await ui.handle({ type: 'openStatementInEditor', kind: 'credential_setup' });
        assert.equal(record.untitled.at(-1)?.languageId, 'sql');
        assert.match(snapshot(record).notice ?? '', /MSSQL extension/);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('export all emits shared prerequisites once across many files', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.saveResult = path.join(record.downloadDir, 'out.sql');
        record.dialogResult = [{ path: FIXTURES, isDirectory: true }];
        await ui.handle({ type: 'openLocalDialog' });
        await settle();
        assert.ok(snapshot(record).files.length > 2);

        await ui.handle({ type: 'exportAllSql' });
        await settle();

        assert.equal(record.saved.length, 1);
        const script = record.saved[0].content;
        assert.ok(script.includes('CREATE TABLE'));
        const occurrences = (needle: string): number => script.split(needle).length - 1;
        // Managed identity is the default now, so no master key is emitted at
        // all. If a secret-based method is ever selected it must still appear
        // exactly once, never per file.
        assert.ok(
            occurrences('CREATE MASTER KEY') <= 1,
            'master key emitted at most once',
        );
        assert.equal(
            occurrences('CREATE MASTER KEY'),
            0,
            'managed identity needs no master key',
        );

        // Each named prerequisite object is created exactly once, which is what
        // makes the script runnable end to end rather than failing on the
        // second identical CREATE.
        const named = /CREATE (?:DATABASE SCOPED CREDENTIAL|EXTERNAL DATA SOURCE|EXTERNAL FILE FORMAT) \[([^\]]+)\]/g;
        const seen = new Map<string, number>();
        for (const match of script.matchAll(named)) {
            const statement = `${match[0]}`;
            seen.set(statement, (seen.get(statement) ?? 0) + 1);
        }
        assert.ok(seen.size > 0, 'the export declares prerequisites');
        for (const [statement, count] of seen) {
            assert.equal(count, 1, `duplicated prerequisite: ${statement}`);
        }
        assert.match(snapshot(record).notice ?? 'Saved', /Saved|Exported/i);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('dismissing the save dialog keeps the work in an untitled buffer', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.saveResult = undefined;
        await ui.analyzePath(path.join(FIXTURES, 'employees.csv'), false);
        await settle();
        await ui.handle({ type: 'exportAllSql' });
        await settle();
        assert.equal(record.untitled.at(-1)?.languageId, 'sql');
        assert.ok(record.untitled.at(-1)?.content.includes('CREATE TABLE'));
        assert.match(snapshot(record).notice ?? '', /untitled editor/i);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('exporting with nothing analysed says so', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.handle({ type: 'exportAllSql' });
        await settle();
        assert.match(snapshot(record).error ?? '', /Analyze a file before exporting/i);
        assert.equal(record.saved.length, 0);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

// -- cancellation and stale results -------------------------------------------

test('a live sample is published while refinement waits and current edits survive final metadata', { timeout: 10_000 }, async () => {
    const record = recorder();
    const file = path.join(record.downloadDir, 'progressive.csv');
    fs.writeFileSync(file, 'id,amount\n' + '1,2\n'.repeat(200) + '2,3.5\n');
    const service = new HeldRefinementService(file);
    const timers: Array<() => void> = [];
    const ui = controller(record, {
        service,
        setTimeoutImpl: (fn: () => void) => { timers.push(fn); return fn; },
        clearTimeoutImpl: () => undefined,
    });
    try {
        const running = ui.loadFiles([file]);
        await service.analyzing.promise;
        const sample = snapshot(record);
        assert.equal(sample.busy, true);
        assert.equal(sample.metadata?.analysis_stage, 'provisional');
        assert.equal(sample.metadata?.schema_inference, 'sampled');
        assert.equal(sample.metadata?.row_count, null);
        assert.equal(sample.preview?.rows.length, 25);
        assert.match(sample.progress ?? '', /Sample preview/);
        assert.match(sample.statements?.create_table ?? '', /^-- SAMPLE ONLY:/);
        const fileId = sample.selectedFileId;
        await ui.handle({ type: 'setTableName', fileId, value: 'my_draft' });
        await ui.handle({ type: 'setSchemaName', fileId, value: 'imports' });
        await ui.handle({ type: 'setParserOverride', fileId, key: 'fieldDelimiter', value: '|' });
        await ui.handle({ type: 'setColumnOverride', fileId, column: 'id', sqlType: 'BIGINT' });
        await ui.handle({ type: 'resetParserOverride', fileId, key: 'fieldDelimiter' });
        await ui.handle({ type: 'setParserOverride', fileId, key: 'firstRow', value: '3' });
        timers.splice(0).forEach((fire) => fire());
        service.final.release();
        await running;
        const final = snapshot(record);
        assert.equal(final.busy, false);
        assert.equal(final.metadata?.analysis_stage, undefined);
        assert.equal(final.metadata?.row_count, 201);
        assert.equal(final.preview?.total_rows, 201);
        assert.equal(new Map(final.metadata?.schema ?? []).get('amount'), 'decimal(2,1)');
        assert.equal(final.tableName, 'my_draft');
        assert.equal(final.schemaName, 'imports');
        assert.equal(final.parserOverrides.fieldDelimiter, undefined);
        assert.equal(final.parserOverrides.firstRow, 3);
        assert.equal(final.columnOverrides.id, 'BIGINT');
        assert.match(final.statements?.create_table ?? '', /\[imports\]\.\[my_draft\]/);
        assert.doesNotMatch(final.statements?.create_table ?? '', /SAMPLE ONLY/);
    } finally {
        service.final.release();
        await ui.dispose();
        cleanup(record);
    }
});

test('refinement and file switching preserve intentionally cleared object names', { timeout: 10_000 }, async () => {
    const record = recorder();
    const first = path.join(record.downloadDir, 'first.csv');
    const second = path.join(record.downloadDir, 'second.csv');
    fs.writeFileSync(first, 'id\n1\n');
    fs.writeFileSync(second, 'id\n2\n');
    const service = new HeldRefinementService(first);
    const ui = controller(record, { service });
    try {
        const running = ui.loadFiles([first, second]);
        await service.analyzing.promise;
        const fileId = snapshot(record).selectedFileId;
        for (const type of ['setTableName', 'setSchemaName', 'setDataSource', 'setCredentialName', 'setFormatName']) {
            await ui.handle({ type, fileId, value: '' });
        }
        const cleared = fileSettingsFrom(snapshot(record));
        service.final.release();
        await running;
        assert.deepEqual(fileSettingsFrom(snapshot(record)), cleared);
        await ui.handle({ type: 'selectFile', fileId: snapshot(record).files[1].id });
        await ui.handle({ type: 'selectFile', fileId });
        assert.deepEqual(fileSettingsFrom(snapshot(record)), cleared);
    } finally {
        service.final.release();
        await ui.dispose();
        cleanup(record);
    }
});

test('profile application waits for refinement so late JSON columns are not lost', { timeout: 10_000 }, async () => {
    const record = recorder();
    const file = path.join(record.downloadDir, 'late-column.json');
    fs.writeFileSync(file, JSON.stringify([
        ...Array.from({ length: 40 }, (_, id) => ({ id })),
        { id: 40, late: 'value' },
    ]));
    record.preferences.set(IMPORT_PROFILES_PREFERENCE, [{
        version: 1,
        name: 'Late column',
        ...DEFAULT_FILE_SETTINGS,
        columnOverrides: { late: 'NVARCHAR(80)' },
    }]);
    const service = new HeldRefinementService(file);
    const ui = controller(record, { service });
    try {
        const running = ui.loadFiles([file]);
        await service.analyzing.promise;
        const fileId = snapshot(record).selectedFileId;
        const settings = fileSettingsFrom(snapshot(record));
        assert.equal(snapshot(record).metadata?.schema?.some(([name]) => name === 'late'), false);
        await ui.handle({ type: 'applyImportProfile', fileId, name: 'Late column' });
        assert.deepEqual(fileSettingsFrom(snapshot(record)), settings);
        assert.match(snapshot(record).error ?? '', /Wait for file analysis to finish/);
        assert.equal(snapshot(record).busy, true);
        service.final.release();
        await running;
        await ui.handle({ type: 'applyImportProfile', fileId, name: 'Late column' });
        assert.deepEqual(snapshot(record).columnOverrides, { late: 'NVARCHAR(80)' });
        assert.equal(snapshot(record).error, null);
    } finally {
        service.final.release();
        await ui.dispose();
        cleanup(record);
    }
});

test('canceling refinement retains an explicit sample-only result and selecting again finishes it', { timeout: 10_000 }, async () => {
    const record = recorder();
    const file = path.join(record.downloadDir, 'cancel.csv');
    fs.writeFileSync(file, 'id\n' + '1\n'.repeat(200));
    const service = new HeldRefinementService(file);
    const ui = controller(record, { service });
    try {
        const running = ui.loadFiles([file]);
        await service.analyzing.promise;
        const fileId = snapshot(record).selectedFileId;
        await ui.handle({ type: 'cancel' });
        assert.equal(snapshot(record).busy, false);
        assert.equal(snapshot(record).metadata?.analysis_stage, 'provisional');
        assert.equal(snapshot(record).preview?.total_rows, null);
        assert.match(snapshot(record).statements?.create_table ?? '', /^-- SAMPLE ONLY:/);
        service.final.release();
        await running;
        assert.equal(snapshot(record).metadata?.analysis_stage, 'provisional');
        await ui.handle({ type: 'selectFile', fileId });
        assert.equal(snapshot(record).metadata?.analysis_stage, undefined);
        assert.equal(snapshot(record).preview?.total_rows, 200);
        assert.equal(snapshot(record).error, null);
    } finally {
        service.final.release();
        await ui.dispose();
        cleanup(record);
    }
});

test('changing preview rows cancels refinement without another complete analysis or a false ready state', { timeout: 10_000 }, async () => {
    const record = recorder();
    const file = path.join(record.downloadDir, 'resize.csv');
    fs.writeFileSync(file, 'id\n' + '1\n'.repeat(200));
    const service = new HeldRefinementService(file);
    const ui = controller(record, { service });
    try {
        const running = ui.loadFiles([file]);
        await service.analyzing.promise;
        await ui.handle({ type: 'setPreviewRows', rows: 5 });
        assert.equal(service.requests.length, 1);
        assert.equal(service.requests[0].token?.isCancellationRequested, true);
        assert.equal(snapshot(record).preview?.rows.length, 5);
        assert.equal(snapshot(record).metadata?.analysis_stage, 'provisional');
        assert.equal(snapshot(record).busy, false);
        assert.match(snapshot(record).notice ?? '', /Sample preview only/);
        assert.match(snapshot(record).statements?.create_table ?? '', /^-- SAMPLE ONLY:/);
        service.final.release();
        await running;
        assert.equal(snapshot(record).preview?.rows.length, 5);
        assert.equal(snapshot(record).preview?.total_rows, null);
        const fileId = snapshot(record).selectedFileId;
        await ui.handle({ type: 'selectFile', fileId });
        const analyses = service.requests.length;
        await ui.handle({ type: 'setPreviewRows', rows: 8 });
        assert.equal(service.requests.length, analyses, 'a final-preview resize reuses authoritative metadata');
        assert.equal(snapshot(record).preview?.rows.length, 8);
        assert.equal(snapshot(record).preview?.total_rows, 200);
    } finally {
        service.final.release();
        await ui.dispose();
        cleanup(record);
    }
});

test('a new selected file finishes before blocked obsolete refinement is released', { timeout: 10_000 }, async () => {
    const record = recorder();
    const first = path.join(record.downloadDir, 'first.csv');
    const second = path.join(record.downloadDir, 'second.csv');
    fs.writeFileSync(first, 'id\n1\n');
    fs.writeFileSync(second, 'id\n2\n3\n');
    const service = new HeldRefinementService(first);
    const ui = controller(record, { service });
    try {
        const running = ui.loadFiles([first, second, path.join(record.downloadDir, 'ignored.xlsx')]);
        await service.analyzing.promise;
        const secondId = snapshot(record).files[1].id;
        await ui.handle({ type: 'selectFile', fileId: secondId });
        assert.equal(service.requests[0].token?.isCancellationRequested, true);
        assert.equal(snapshot(record).metadata?.file_name, 'second.csv');
        assert.equal(snapshot(record).metadata?.row_count, 2);
        const current = snapshot(record);
        service.final.release();
        await running;
        assert.deepEqual(snapshot(record), current, 'late progress, metadata, SQL and previews must all be ignored');
    } finally {
        service.final.release();
        await ui.dispose();
        cleanup(record);
    }
});

test('a preview resize before the first sample cancels the old request and only samples the new limit', { timeout: 10_000 }, async () => {
    const record = recorder();
    const file = path.join(record.downloadDir, 'early.csv');
    fs.writeFileSync(file, 'id\n' + '1\n'.repeat(200));
    const entered = gate<void>();
    const release = gate<void>();
    class DelayedSampleService extends NativeAnalysisService {
        analyses = 0;
        override async analyzeProgressively(request: ProgressiveAnalysisRequest) {
            entered.release();
            await release.promise;
            return super.analyzeProgressively(request);
        }
        override async analyze(request: AnalysisRequest) {
            this.analyses += 1;
            return super.analyze(request);
        }
    }
    const service = new DelayedSampleService();
    const ui = controller(record, { service });
    try {
        const running = ui.loadFiles([file]);
        await entered.promise;
        assert.equal(snapshot(record).metadata, null);
        await ui.handle({ type: 'setPreviewRows', rows: 5 });
        assert.equal(snapshot(record).preview?.rows.length, 5);
        assert.equal(snapshot(record).metadata?.analysis_stage, 'provisional');
        assert.equal(snapshot(record).busy, false);
        release.release();
        await running;
        assert.equal(service.analyses, 0);
        assert.equal(snapshot(record).preview?.rows.length, 5);
    } finally {
        release.release();
        await ui.dispose();
        cleanup(record);
    }
});

test('an obsolete file picker cannot replace a newer selected source', async () => {
    const record = recorder();
    const first = path.join(record.downloadDir, 'picked.csv');
    const second = path.join(record.downloadDir, 'newer.csv');
    fs.writeFileSync(first, 'id\n1\n');
    fs.writeFileSync(second, 'id\n2\n');
    const picked = gate<readonly OpenDialogSelection[]>();
    record.host = { ...record.host, showOpenDialog: async () => picked.promise };
    const ui = controller(record);
    try {
        const picker = ui.handle({ type: 'openLocalDialog' });
        await ui.loadFiles([second]);
        picked.release([{ path: first, isDirectory: false }]);
        await picker;
        assert.equal(snapshot(record).metadata?.file_name, 'newer.csv');
    } finally {
        picked.release([]);
        await ui.dispose();
        cleanup(record);
    }
});

test('source switching cancels refinement, and returning to local restores sample-only provenance', { timeout: 10_000 }, async () => {
    const record = recorder();
    const file = path.join(record.downloadDir, 'source.csv');
    fs.writeFileSync(file, 'id\n1\n2\n');
    const service = new HeldRefinementService(file);
    let authenticationCalls = 0;
    const azure = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async () => {
            authenticationCalls += 1;
            return undefined;
        }),
    });
    const ui = controller(record, { service, azure });
    try {
        const running = ui.loadFiles([file]);
        await service.analyzing.promise;
        await ui.handle({ type: 'openAzureBrowser' });
        assert.equal(snapshot(record).sourceMode, 'azure');
        assert.equal(snapshot(record).metadata, null);
        assert.equal(snapshot(record).busy, false);
        assert.equal(service.requests[0].token?.isCancellationRequested, true);
        await ui.handle({ type: 'activateLocalSource' });
        assert.equal(snapshot(record).sourceMode, 'local');
        assert.equal(snapshot(record).metadata?.analysis_stage, 'provisional');
        assert.equal(snapshot(record).busy, false);
        assert.match(snapshot(record).statements?.create_table ?? '', /^-- SAMPLE ONLY:/);
        const restored = snapshot(record);
        service.final.release();
        await running;
        assert.deepEqual(snapshot(record), restored);
        assert.equal(authenticationCalls, 0);
    } finally {
        service.final.release();
        await ui.dispose();
        cleanup(record);
    }
});

test('public Azure selection preserves local sample provenance and file settings', { timeout: 10_000 }, async () => {
    const record = recorder();
    const file = path.join(record.downloadDir, 'local.csv');
    fs.writeFileSync(file, 'id\n1\n2\n');
    const service = new HeldRefinementService(file);
    let authenticationCalls = 0;
    class PublicFixtureStorage extends StorageBrowserClient {
        override async listPublicBlobs(): Promise<StoragePage> {
            return {
                items: [{
                    kind: 'file',
                    name: 'sample.csv',
                    blobName: 'sample.csv',
                    sizeBytes: 20,
                    modifiedAt: null,
                }],
                continuationToken: undefined,
            };
        }
    }
    const azure = new AzureBrowser({
        authentication: new MicrosoftAuthentication(async () => {
            authenticationCalls += 1;
            assert.fail('Public browsing must not request a Microsoft session.');
        }),
        storage: new PublicFixtureStorage(),
    });
    const ui = controller(record, { service, azure });
    try {
        const running = ui.loadFiles([file]);
        await service.analyzing.promise;
        const fileId = snapshot(record).selectedFileId;
        await ui.handle({ type: 'setTableName', fileId, value: 'my_local_table' });
        await ui.handle({ type: 'setColumnOverride', fileId, column: 'id', sqlType: 'BIGINT' });
        const settings = fileSettingsFrom(snapshot(record));
        await ui.handle({
            type: 'azureBrowserOpenPublicContainer',
            url: 'https://blob001.blob.core.windows.net/raw',
            prefix: '',
        });
        assert.equal(snapshot(record).azure.mode, 'public');
        assert.equal(service.requests[0].token?.isCancellationRequested, true);
        await ui.handle({
            type: 'azureBrowserOpenEntry',
            entryId: snapshot(record).azure.entries[0].id,
        });
        await ui.handle({ type: 'azureBrowserUseSelectedFile' });
        assert.equal(snapshot(record).authMethod, 'public');
        assert.match(snapshot(record).storageUrl, /^abs:\/\/raw@blob001\.blob\.core\.windows\.net\//);
        assert.equal(snapshot(record).metadata, null);

        await ui.handle({ type: 'activateLocalSource' });
        assert.equal(snapshot(record).selectedFileId, fileId);
        assert.equal(snapshot(record).metadata?.analysis_stage, 'provisional');
        assert.equal(snapshot(record).busy, false);
        assert.deepEqual(fileSettingsFrom(snapshot(record)), settings);
        assert.match(snapshot(record).statements?.create_table ?? '', /^-- SAMPLE ONLY:/);
        const restored = snapshot(record);
        service.final.release();
        await running;
        assert.deepEqual(snapshot(record), restored);
        assert.equal(authenticationCalls, 0);
    } finally {
        service.final.release();
        await ui.dispose();
        cleanup(record);
    }
});

test('a source-file edit during refinement leaves the sample explicit until a successful retry', { timeout: 10_000 }, async () => {
    const record = recorder();
    const file = path.join(record.downloadDir, 'edit.csv');
    fs.writeFileSync(file, 'id,amount\n1,2\n');
    const service = new HeldRefinementService(file);
    const ui = controller(record, { service });
    try {
        const running = ui.loadFiles([file]);
        await service.analyzing.promise;
        fs.appendFileSync(file, '2,3.5\n');
        service.final.release();
        await running;
        assert.equal(snapshot(record).busy, false);
        assert.equal(snapshot(record).metadata?.analysis_stage, 'provisional');
        assert.equal(snapshot(record).preview?.total_rows, null);
        assert.match(snapshot(record).error ?? '', /file changed/i);
        assert.match(snapshot(record).statements?.create_table ?? '', /^-- SAMPLE ONLY:/);
        await ui.handle({ type: 'selectFile', fileId: snapshot(record).selectedFileId });
        assert.equal(snapshot(record).metadata?.analysis_stage, undefined);
        assert.equal(snapshot(record).preview?.total_rows, 2);
        assert.equal(snapshot(record).error, null);
    } finally {
        service.final.release();
        await ui.dispose();
        cleanup(record);
    }
});

test('a superseded analysis cannot overwrite newer state', async () => {
    const record = recorder();
    let release: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
        release = resolve;
    });
    let call = 0;
    const ui = controller(record, {
        service: completeOnlyService({
            listFormats: () => [],
            normalizePlatform: () => 'azure_sql_db',
            resolveTableName: () => 'T',
            analyze: async ({ filePath }: { filePath: string }) => {
                call += 1;
                if (call === 1) {
                    await slow;
                    return { file_path: filePath, file_name: 'slow', file_type: 'csv', size_bytes: 1, columns: [] };
                }
                return { file_path: filePath, file_name: 'fast', file_type: 'csv', size_bytes: 1, columns: [] };
            },
            analyzeDirectory: async () => ({ root: FIXTURES, files: [] }),
            preview: async () => ({ columns: [], rows: [], total_rows: 0, truncated: false }),
            generateStatements: () => ({ create_table: 'x' }),
            generateCompleteDocument: () => 'x',
            generateMultiFileScript: () => 'x',
        }),
    });
    try {
        const first = ui.analyzePath(path.join(FIXTURES, 'sample.csv'), false);
        await settle();
        const second = ui.analyzePath(path.join(FIXTURES, 'employees.csv'), false);
        release?.();
        await Promise.all([first, second]);
        await settle();

        assert.equal(
            snapshot(record).metadata?.file_name,
            'fast',
            'the stale result must not win',
        );
        assert.equal(snapshot(record).busy, false);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('an explicit cancel clears progress without leaving an error', async () => {
    const record = recorder();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
    });
    const ui = controller(record, {
        service: completeOnlyService({
            listFormats: () => [],
            normalizePlatform: () => 'azure_sql_db',
            resolveTableName: () => 'T',
            analyze: async ({ filePath }: { filePath: string }) => {
                await blocked;
                return {
                    file_path: filePath,
                    file_name: path.basename(filePath),
                    file_type: 'csv',
                    size_bytes: 1,
                    columns: [],
                };
            },
            analyzeDirectory: async () => ({ root: FIXTURES, files: [] }),
            preview: async () => ({ columns: [], rows: [], total_rows: 0, truncated: false }),
            generateStatements: () => ({}),
            generateCompleteDocument: () => '',
            generateMultiFileScript: () => '',
        }),
    });
    try {
        const running = ui.analyzePath(path.join(FIXTURES, 'employees.csv'), false);
        await settle();
        assert.equal(snapshot(record).busy, true);
        await ui.handle({ type: 'cancel' });
        assert.equal(snapshot(record).notice, 'Analysis canceled.');
        release?.();
        await running;
        await settle();
        assert.equal(snapshot(record).busy, false);
        assert.equal(snapshot(record).progress, null);
        assert.equal(snapshot(record).notice, 'Analysis canceled.');
        assert.equal(snapshot(record).error, null);
    } finally {
        release?.();
        await ui.dispose();
        cleanup(record);
    }
});

// -- Azure --------------------------------------------------------------------

test('credential name, auth method and table name reach the generator', async () => {
    const record = recorder();
    const seen: Record<string, unknown>[] = [];
    const multi: Record<string, unknown>[] = [];
    const timers: (() => void)[] = [];
    const ui = controller(record, {
        setTimeoutImpl: (fn: () => void) => {
            timers.push(fn);
            return timers.length;
        },
        clearTimeoutImpl: () => undefined,
        service: completeOnlyService({
            listFormats: () => [],
            normalizePlatform: () => 'azure_sql_db',
            resolveTableName: () => 'T',
            analyze: async ({ filePath }: { filePath: string }) => ({
                file_path: filePath,
                file_name: 'sample.csv',
                file_type: 'csv',
                size_bytes: 1,
                columns: [],
            }),
            analyzeDirectory: async () => ({ root: FIXTURES, files: [] }),
            preview: async () => ({ columns: [], rows: [], total_rows: 0, truncated: false }),
            generateStatements: (request: Record<string, unknown>) => {
                seen.push(request);
                return { create_table: 'x' };
            },
            generateCompleteDocument: (request: Record<string, unknown>) => {
                multi.push(request);
                return 'x';
            },
            generateMultiFileScript: (request: Record<string, unknown>) => {
                multi.push(request);
                return 'x';
            },
        }),
    });
    try {
        await ui.analyzePath(path.join(FIXTURES, 'sample.csv'), false);
        await settle();
        await ui.handle({ type: 'setCredentialName', fileId: snapshot(record).selectedFileId, value: 'cert_cred' });
        await ui.handle({ type: 'setAuthMethod', value: 'managed_identity' });
        await ui.handle({ type: 'setTableName', fileId: snapshot(record).selectedFileId, value: 'staged_orders' });
        await settle();
        // The regeneration is debounced, so run whatever the debounce queued.
        timers.splice(0).forEach((fn) => fn());
        await settle();

        const last = seen[seen.length - 1];
        assert.ok(last, 'the generator was called');
        assert.equal(last.credentialName, 'cert_cred');
        assert.equal(last.authMethod, 'managed_identity');
        assert.equal(last.tableName, 'staged_orders');

        await ui.handle({ type: 'exportAllSql' });
        await settle();
        const bulk = multi[multi.length - 1];
        assert.ok(bulk, 'the export path reached the generator');
        assert.equal(bulk.credentialName, 'cert_cred');
        assert.equal(bulk.authMethod, 'managed_identity');
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('a known URL configures credential SQL without requiring file analysis', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.handle({
            type: 'setStorageUrl',
            value:
                'https://myaccount.blob.core.windows.net/data/orders.parquet' +
                '?sv=2026&sig=SECRET#details',
        });
        await settle();

        const state = snapshot(record);
        assert.equal(
            state.storageUrl,
            'https://myaccount.blob.core.windows.net/data/orders.parquet',
        );
        assert.equal(state.dataSourceType, 'azure_blob');
        assert.equal(state.authMethod, 'sas');
        assert.equal(state.remoteSchema?.status, 'not_analyzed');
        assert.equal(state.remoteSchema?.selectedFormat, 'parquet');
        assert.match(state.statements?.credential_setup ?? '', /CREATE EXTERNAL DATA SOURCE/);
        assert.match(state.statements?.credential_setup ?? '', /CREATE EXTERNAL TABLE/);
        assert.match(
            state.statements?.credential_setup ?? '',
            /TEMPLATE ONLY - REMOTE SCHEMA NOT ANALYZED/,
        );
        await ui.handle({ type: 'setStorageGoal', value: 'openrowset' });
        assert.match(snapshot(record).statements?.credential_setup ?? '', /OPENROWSET\s*\(/);

        await ui.handle({
            type: 'setStorageUrl',
            value: 'abs://data@myaccount.blob.core.windows.net/orders.csv',
        });
        await ui.handle({ type: 'setStorageGoal', value: 'bulk_insert' });
        assert.match(snapshot(record).statements?.credential_setup ?? '', /BULK INSERT/);
        assert.ok(!JSON.stringify(state).includes('sig=SECRET'));
        assert.ok(!JSON.stringify(state).includes('?sv=2026'));
        assert.match(state.notice ?? '', /removed/i);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('a manual folder URL requires a format before generating goal SQL', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.handle({
            type: 'setStorageUrl',
            value: 'abs://raw@myaccount.blob.core.windows.net/orders/',
        });
        assert.equal(snapshot(record).remoteSchema?.status, 'format_required');
        assert.ok((snapshot(record).remoteSchema?.formats.length ?? 0) > 1);
        assert.equal(snapshot(record).statements, null);

        await ui.handle({ type: 'setAzureFolderFormat', value: 'csv' });
        assert.match(
            snapshot(record).statements?.credential_setup ?? '',
            /CREATE EXTERNAL TABLE/,
        );
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('an invalid known URL leaves the previous storage setup intact', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.handle({
            type: 'setStorageUrl',
            value: 'https://myaccount.blob.core.windows.net/data/orders.parquet',
        });
        await ui.handle({ type: 'setStorageUrl', value: 'https://example.com/orders.parquet' });
        await settle();

        assert.equal(
            snapshot(record).storageUrl,
            'https://myaccount.blob.core.windows.net/data/orders.parquet',
        );
        assert.match(snapshot(record).error ?? '', /not a supported/i);

        await ui.handle({
            type: 'setStorageUrl',
            value:
                'abfss://workspace@onelake.dfs.fabric.microsoft.com/'
                + 'lakehouse.Lakehouse/Files/orders.parquet',
        });
        await settle();
        assert.equal(
            snapshot(record).storageUrl,
            'https://myaccount.blob.core.windows.net/data/orders.parquet',
        );
        assert.match(snapshot(record).error ?? '', /supported storage services/i);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('changing to an incompatible SQL platform clears the known storage URL', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.handle({ type: 'setPlatform', platform: 'sql_server_2022' });
        await ui.handle({ type: 'setStorageUrl', value: 's3://sales-data/year=2026/' });
        assert.equal(snapshot(record).storageUrl, 's3://sales-data/year=2026/');

        await ui.handle({ type: 'setPlatform', platform: 'azure_sql_db' });
        assert.equal(snapshot(record).storageUrl, '');
        assert.match(snapshot(record).notice ?? '', /does not support/i);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('storage setup infers ABS, ADLS, and ABFSS exclusively from the provided URL', async () => {
    const record = recorder();
    const ui = controller(record);
    const large = path.join(SAMPLES, 'performance', 'events_250k.parquet');

    try {
        assert.equal(snapshot(record).activeTab, 'preview');
        assert.equal(snapshot(record).selectedFileId, null);
        assert.equal(snapshot(record).preview, null);

        await ui.loadFiles([large]);
        await settle();
        assert.equal(snapshot(record).metadata?.row_count, 250_000);
        assert.equal(snapshot(record).preview?.rows.length, 25);

        const cases = [
            {
                platform: 'azure_sql_db',
                url: 'abs://raw@myaccount.blob.core.windows.net/events_250k.parquet',
                source: 'azure_blob',
                connector: 'ABS',
                location: "LOCATION = 'abs://raw@myaccount.blob.core.windows.net'",
            },
            {
                platform: 'azure_sql_db',
                url: 'adls://raw@myaccount.dfs.core.windows.net/events_250k.parquet',
                source: 'azure_data_lake',
                connector: 'ADLS',
                location: "LOCATION = 'adls://raw@myaccount.dfs.core.windows.net'",
            },
            {
                platform: 'fabric_sql_db',
                url:
                    'abfss://workspace@onelake.dfs.fabric.microsoft.com/'
                    + 'lakehouse.Lakehouse/Files/events_250k.parquet',
                source: 'fabric_onelake',
                connector: 'ABFSS',
                location:
                    "LOCATION = 'abfss://workspace@onelake.dfs.fabric.microsoft.com/"
                    + "lakehouse.Lakehouse/Files'",
            },
        ] as const;

        for (const entry of cases) {
            await ui.handle({ type: 'setStorageUrl', value: '' });
            await ui.handle({ type: 'setPlatform', platform: entry.platform });
            await ui.handle({ type: 'setStorageUrl', value: entry.url });
            await settle();

            const state = snapshot(record);
            assert.equal(state.error, null);
            assert.equal(state.storageUrl, entry.url);
            assert.equal(state.dataSourceType, entry.source);
            assert.equal(state.credentialSetup.locationPrefix, entry.connector);
            assert.equal(state.remoteSchema, null);
            const sql = state.statements?.credential_setup ?? '';
            assert.match(sql, /CREATE EXTERNAL DATA SOURCE/);
            assert.doesNotMatch(sql, /TEMPLATE ONLY - REMOTE SCHEMA NOT ANALYZED/);
            assert.ok(sql.includes(entry.location), sql);
            if (entry.source === 'azure_blob') {
                assert.doesNotMatch(sql, /TYPE = BLOB_STORAGE|LOCATION = 'https:\/\//);
            }
            const serialized = JSON.stringify(state);
            assert.ok(!serialized.includes('accessToken'));
            assert.ok(!serialized.includes('bearer-token'));
        }
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

// -- preferences, panel and display -------------------------------------------

test('non-sensitive preferences are persisted and file contents are not', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.handle({ type: 'setTab', tab: 'preview' });
        await ui.handle({ type: 'setPlatform', platform: 'sql_server_2019' });
        await settle();

        assert.deepEqual(
            [...record.preferences.entries()].sort(),
            [
                ['activeTab', 'preview'],
                ['platform', 'sql_server_2019'],
            ],
        );
        for (const key of record.preferences.keys()) {
            assert.ok(
                !/token|secret|key|password|content|path/i.test(key),
                `${key} looks sensitive`,
            );
        }
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('opening in the editor asks the host for the panel', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        await ui.handle({ type: 'openInEditor' });
        await settle();
        assert.equal(record.panelOpens, 1);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('metadata crossing the boundary carries a label, not an absolute path', () => {
    const raw = {
        file_path: path.join(FIXTURES, 'delta_table', 'part.parquet'),
        file_name: 'part.parquet',
        file_type: 'parquet',
        size_bytes: 1,
    } as never;
    const display = metadataForDisplay(raw, [FIXTURES]);
    assert.equal(display.file_path, 'delta_table/part.parquet');
    assert.ok(!display.file_path.includes(FIXTURES));
    assert.ok(!path.isAbsolute(display.file_path));
});

test('no snapshot ever contains an absolute filesystem path', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.dialogResult = [{ path: FIXTURES, isDirectory: true }];
        await ui.handle({ type: 'openLocalDialog' });
        await settle();
        const serialised = JSON.stringify(snapshot(record));
        assert.ok(!serialised.includes(FIXTURES.replace(/\\/g, '\\\\')), 'no workspace root');
        assert.ok(!serialised.includes(os.homedir().replace(/\\/g, '\\\\')), 'no home directory');
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});
