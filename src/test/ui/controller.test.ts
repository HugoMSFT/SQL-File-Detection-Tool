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
import { Readable } from 'node:stream';

import { AppStateStore } from '../../appState';
import { UiController, metadataForDisplay } from '../../ui/controller';
import type { OpenDialogOptions, UiHost } from '../../ui/host';
import type { AzureBridge, AzureConnectionInfo } from '../../ui/host';
import type { BlobBrowser } from '../../azure/blobBrowser';
import type { AppStateSnapshot } from '../../protocol';
import type { StatementKind } from '../../native';
import type { RawResponse, SafeHttpDeps } from '../../net/safeHttp';

const REPO = path.resolve(__dirname, '..', '..', '..');
const FIXTURES = path.join(REPO, 'test_data');
const DEMO = path.join(REPO, 'demo');

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
    readonly cleaned: string[];
    readonly dialogs: OpenDialogOptions[];
    readonly downloadDir: string;
    dialogResult: readonly string[] | undefined;
    activeFile: string | undefined;
    activeLimitation: string | undefined;
    saveResult: string | undefined;
    panelOpens: number;
    clock: number;
    azure: FakeAzureBridge;
}

class FakeAzureBridge implements AzureBridge {
    info: AzureConnectionInfo = {
        connected: false,
        mode: null,
        identity: null,
        account: null,
        canListSubscriptions: false,
    };
    connectCalls: string[] = [];
    disconnectCalls = 0;
    connectResult: AzureConnectionInfo | Error | undefined;
    currentBrowser: BlobBrowser | undefined;
    token: string | undefined;

    async connect(mode: string): Promise<AzureConnectionInfo> {
        this.connectCalls.push(mode);
        if (this.connectResult instanceof Error) {
            throw this.connectResult;
        }
        this.info = this.connectResult ?? {
            connected: true,
            mode: 'anonymous',
            identity: 'Anonymous public access',
            account: 'myaccount',
            canListSubscriptions: false,
        };
        return this.info;
    }

    async disconnect(): Promise<void> {
        this.disconnectCalls += 1;
        this.currentBrowser = undefined;
        this.info = {
            connected: false,
            mode: null,
            identity: null,
            account: null,
            canListSubscriptions: false,
        };
    }

    async useAccount(account: string): Promise<AzureConnectionInfo> {
        this.info = { ...this.info, connected: true, account };
        return this.info;
    }

    browser(): BlobBrowser | undefined {
        return this.currentBrowser;
    }

    async armToken(): Promise<string | undefined> {
        return this.token;
    }
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
        cleaned: [],
        dialogs: [],
        downloadDir,
        dialogResult: undefined,
        activeFile: undefined,
        activeLimitation: undefined,
        saveResult: undefined,
        panelOpens: 0,
        clock: 0,
        azure: new FakeAzureBridge(),
    };
    const host: UiHost = {
        version: '1.1.1',
        azure: state.azure,
        workspaceFolders: () => folders,
        activeFilePath: () => state.activeFile,
        activeFileLimitation: () => state.activeLimitation,
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
        downloadDirectory: async () => downloadDir,
        cleanupDownload: async (absolute) => {
            state.cleaned.push(absolute);
            await fs.promises.rm(absolute, { force: true });
        },
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

        await ui.handle({ type: 'resetParserOverride', key: 'fieldDelimiter' });
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
        service: {
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
        },
    });
    try {
        record.activeFile = path.join(FIXTURES, 'sample.csv');
        await ui.handle({ type: 'analyzeCurrentFile' });
        await settle();
        const error = snapshot(record).error;
        assert.ok(error, 'the failure surfaces as state, not an exception');
        assert.ok(!error.includes('SECRET'), 'the message is redacted');
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

// -- current file / workspace flow -------------------------------------------

test('analyzing the current file produces metadata, preview and SQL', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.activeFile = path.join(FIXTURES, 'employees.csv');
        await ui.handle({ type: 'analyzeCurrentFile' });
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

test('an unsupported editor scheme is reported instead of failing obscurely', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.activeLimitation =
            'The active editor is not a file on disk, so the native reader cannot open it.';
        await ui.handle({ type: 'analyzeCurrentFile' });
        await settle();
        assert.equal(snapshot(record).error, record.activeLimitation);
        assert.equal(snapshot(record).files.length, 0);

        record.activeLimitation = undefined;
        record.activeFile = undefined;
        await ui.handle({ type: 'analyzeCurrentFile' });
        await settle();
        assert.match(snapshot(record).error ?? '', /No file is open/i);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('choosing a folder lists files and selects the first', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.dialogResult = [FIXTURES];
        await ui.handle({ type: 'openFolderDialog' });
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

test('folder scans stop after one child level and skip non-SQL files', async () => {
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
        assert.deepEqual(
            state.files.map((entry) => entry.label).sort(),
            ['direct.csv', 'top.csv'],
        );
        assert.equal(
            state.files.find((entry) => entry.label === 'direct.csv')?.folderLabel,
            'year',
        );
        assert.ok(!state.files.some((entry) => entry.label === 'deep.csv'));

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

test('cancelling the folder picker leaves the state untouched', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.dialogResult = undefined;
        await ui.handle({ type: 'openFileDialog' });
        await ui.handle({ type: 'openFolderDialog' });
        await settle();
        assert.equal(snapshot(record).files.length, 0);
        assert.equal(snapshot(record).error, null);
        assert.deepEqual(
            record.dialogs.map((dialog) => dialog.folders),
            [false, true],
        );
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('the renderer can only select files the host listed', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.activeFile = path.join(FIXTURES, 'sample.csv');
        await ui.handle({ type: 'analyzeCurrentFile' });
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
            path.join(FIXTURES, 'sample.csv'),
            path.join(FIXTURES, 'sample.parquet'),
        ]);
        await settle();
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
        assert.ok((state.preview?.rows.length ?? 0) > 0);
        assert.equal(record.preferences.get('activeTab'), 'preview');
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

// -- formats ------------------------------------------------------------------

for (const [name, fixture, fileType] of [
    ['CSV', path.join(FIXTURES, 'employees.csv'), 'csv'],
    ['TSV', path.join(FIXTURES, 'web_access_logs.tsv'), 'csv'],
    ['JSON', path.join(FIXTURES, 'sample.json'), 'json'],
    ['JSON Lines', path.join(FIXTURES, 'events.jsonl'), 'json'],
    ['Parquet', path.join(FIXTURES, 'sample.parquet'), 'parquet'],
] as const) {
    test(`${name} is analysed natively and generates SQL`, async () => {
        const record = recorder();
        const ui = controller(record);
        try {
            record.activeFile = fixture;
            await ui.handle({ type: 'analyzeCurrentFile' });
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

for (const [name, fixture] of [
    ['Delta', path.join(FIXTURES, 'delta_table')],
    ['Iceberg', path.join(FIXTURES, 'iceberg_table')],
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
    const unicode = path.join(DEMO, 'collation_cases_utf8.csv');
    if (!fs.existsSync(unicode)) {
        return;
    }
    const record = recorder({ workspaceFolders: [DEMO] });
    const ui = controller(record);
    try {
        record.activeFile = unicode;
        await ui.handle({ type: 'analyzeCurrentFile' });
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
    const orc = path.join(DEMO, 'all_types.orc');
    if (!fs.existsSync(orc)) {
        return;
    }
    const record = recorder({ workspaceFolders: [DEMO] });
    const ui = controller(record);
    try {
        record.activeFile = orc;
        await ui.handle({ type: 'analyzeCurrentFile' });
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
        record.activeFile = path.join(FIXTURES, 'employees.csv');
        await ui.handle({ type: 'analyzeCurrentFile' });
        await settle();
        const before = snapshot(record).statements?.create_table as string;

        await ui.handle({ type: 'setTableName', value: 'Employees' });
        await ui.handle({ type: 'setSchemaName', value: 'hr' });
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
        await ui.handle({ type: 'clearColumnOverrides' });
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
        record.activeFile = path.join(FIXTURES, 'sample.csv');
        await ui.handle({ type: 'analyzeCurrentFile' });
        await settle();

        for (const value of ['C', 'Cu', 'Cus', 'Cust', 'Custo']) {
            await ui.handle({ type: 'setTableName', value });
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
        record.activeFile = path.join(FIXTURES, 'employees.csv');
        await ui.handle({ type: 'analyzeCurrentFile' });
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
        record.activeFile = path.join(FIXTURES, 'employees.csv');
        await ui.handle({ type: 'analyzeCurrentFile' });
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

test('export all emits shared prerequisites once across many files', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.saveResult = path.join(record.downloadDir, 'out.sql');
        record.dialogResult = [FIXTURES];
        await ui.handle({ type: 'openFolderDialog' });
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
        record.activeFile = path.join(FIXTURES, 'employees.csv');
        await ui.handle({ type: 'analyzeCurrentFile' });
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

test('a superseded analysis cannot overwrite newer state', async () => {
    const record = recorder();
    let release: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
        release = resolve;
    });
    let call = 0;
    const ui = controller(record, {
        service: {
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
        },
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
    const ui = controller(record);
    try {
        record.activeFile = path.join(FIXTURES, 'employees.csv');
        const running = ui.handle({ type: 'analyzeCurrentFile' });
        await ui.handle({ type: 'cancel' });
        await running;
        await settle();
        assert.equal(snapshot(record).busy, false);
        assert.equal(snapshot(record).progress, null);
    } finally {
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
        service: {
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
        },
    });
    try {
        record.activeFile = path.join(FIXTURES, 'sample.csv');
        await ui.handle({ type: 'analyzeCurrentFile' });
        await settle();
        await ui.handle({ type: 'setCredentialName', value: 'cert_cred' });
        await ui.handle({ type: 'setAuthMethod', value: 'managed_identity' });
        await ui.handle({ type: 'setTableName', value: 'staged_orders' });
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

function fakeBrowser(overrides: Partial<BlobBrowser> = {}): BlobBrowser {
    return {
        account: 'myaccount',
        listContainers: async () => ({ names: ['data', 'logs'], continuation: null }),
        listBlobs: async () => ({
            entries: [
                { name: 'year=2020/', sizeBytes: null, isPrefix: true },
                { name: 'a.csv', sizeBytes: 10, isPrefix: false },
                { name: 'notes.md', sizeBytes: 10, isPrefix: false },
            ],
            continuation: 'next-page',
        }),
        downloadBlob: async () => ({ path: '', bytes: 0 }),
        blobUrl: (container: string, blob: string) =>
            `https://myaccount.blob.core.windows.net/${container}/${blob}`,
        ...overrides,
    } as BlobBrowser;
}

test('connecting lists containers and never exposes a credential', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.azure.currentBrowser = fakeBrowser();
        await ui.handle({ type: 'azureConnect', mode: 'anonymous' });
        await settle();

        const azure = snapshot(record).azure;
        assert.equal(azure.connected, true);
        assert.equal(azure.account, 'myaccount');
        assert.deepEqual(azure.containers, ['data', 'logs']);
        assert.deepEqual(record.azure.connectCalls, ['anonymous']);
        assert.ok(!JSON.stringify(snapshot(record)).toLowerCase().includes('sig='));
        assert.ok(!JSON.stringify(snapshot(record)).includes('AccountKey'));
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('every auth mode is routed through the bridge unchanged', async () => {
    for (const mode of ['vscode', 'sas', 'connectionString', 'anonymous'] as const) {
        const record = recorder();
        const ui = controller(record);
        try {
            record.azure.currentBrowser = fakeBrowser();
            await ui.handle({ type: 'azureConnect', mode });
            await settle();
            assert.deepEqual(record.azure.connectCalls, [mode]);
            assert.equal(snapshot(record).azure.connected, true);
        } finally {
            await ui.dispose();
            cleanup(record);
        }
    }
});

test('a failed connection is reported redacted and leaves nothing connected', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.azure.connectResult = new Error(
            'Auth failed for https://a.blob.core.windows.net/c?sv=1&sig=SECRETSIG',
        );
        await ui.handle({ type: 'azureConnect', mode: 'sas' });
        await settle();

        const azure = snapshot(record).azure;
        assert.equal(azure.connected, false);
        assert.equal(azure.busy, false);
        assert.ok(azure.error);
        assert.ok(!azure.error.includes('SECRETSIG'), azure.error);
        assert.ok(!record.logs.join('\n').includes('SECRETSIG'));
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('browsing pages blobs and marks which ones can be analysed', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.azure.currentBrowser = fakeBrowser();
        await ui.handle({ type: 'azureConnect', mode: 'anonymous' });
        await ui.handle({
            type: 'azureListBlobs',
            container: 'data',
            prefix: '',
            continuation: '',
        });
        await settle();

        const azure = snapshot(record).azure;
        assert.equal(azure.container, 'data');
        assert.equal(azure.continuation, 'next-page');
        assert.deepEqual(
            azure.blobs.map((blob) => [blob.name, blob.supported]),
            [
                ['year=2020/', true],
                ['a.csv', true],
                ['notes.md', false],
            ],
        );
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('browsing without an account asks for one instead of failing', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.azure.currentBrowser = undefined;
        await ui.handle({ type: 'azureListContainers' });
        await ui.handle({
            type: 'azureListBlobs',
            container: 'data',
            prefix: '',
            continuation: '',
        });
        await settle();
        assert.match(snapshot(record).azure.error ?? '', /storage account/i);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('subscription discovery degrades gracefully without an ARM token', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.azure.token = undefined;
        await ui.handle({ type: 'azureListSubscriptions' });
        await settle();
        assert.match(snapshot(record).azure.error ?? '', /storage account name/i);
        assert.equal(snapshot(record).azure.canListSubscriptions, false);

        await ui.handle({ type: 'azureListAccounts', subscriptionId: 'sub-1' });
        await settle();
        assert.match(snapshot(record).azure.error ?? '', /Microsoft account/i);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('analyzing a blob keeps the copy local and the SQL pointed at the URL', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        const local = path.join(record.downloadDir, 'a.csv');
        fs.writeFileSync(local, 'id,name\n1,Ada\n2,Grace\n');
        record.azure.currentBrowser = fakeBrowser({
            downloadBlob: async () => ({ path: local, bytes: 24 }),
        });
        await ui.handle({ type: 'azureConnect', mode: 'anonymous' });
        await ui.handle({ type: 'azureAnalyzeBlob', container: 'data', blob: 'a.csv' });
        await settle();

        const state = snapshot(record);
        assert.equal(state.error, null);
        assert.equal(
            state.storageUrl,
            'https://myaccount.blob.core.windows.net/data/a.csv',
        );
        assert.equal(state.metadata?.file_type, 'csv');
        assert.equal(state.sourceKind, 'azure');
        assert.equal(state.quickAnalyze.source.baseLocation, 'https://myaccount.blob.core.windows.net/data');
        assert.equal(state.quickAnalyze.source.relativePath, 'a.csv');
        assert.equal(state.quickAnalyze.source.objects[0].required, false);
        assert.equal(state.dataSource, 'ds_myaccount_data');
        assert.match(state.notice ?? '', /local copy/i);
        assert.ok(!state.storageUrl.includes('sig='), 'the URL in SQL is never signed');

        await ui.loadFiles([path.join(FIXTURES, 'sample.csv')]);
        await settle();
        assert.equal(snapshot(record).sourceKind, 'local');
        assert.equal(snapshot(record).storageUrl, '');
        assert.deepEqual(snapshot(record).quickAnalyze.source.objects, []);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('disconnecting clears every trace of the Azure session from the state', async () => {
    const record = recorder();
    const ui = controller(record);
    try {
        record.azure.currentBrowser = fakeBrowser();
        await ui.handle({ type: 'azureConnect', mode: 'anonymous' });
        await ui.handle({
            type: 'azureListBlobs',
            container: 'data',
            prefix: '',
            continuation: '',
        });
        await settle();
        await ui.handle({ type: 'azureDisconnect' });
        await settle();

        const azure = snapshot(record).azure;
        assert.equal(record.azure.disconnectCalls, 1);
        assert.deepEqual(
            {
                connected: azure.connected,
                mode: azure.mode,
                identity: azure.identity,
                account: azure.account,
                container: azure.container,
                prefix: azure.prefix,
                continuation: azure.continuation,
            },
            {
                connected: false,
                mode: null,
                identity: null,
                account: null,
                container: null,
                prefix: '',
                continuation: null,
            },
        );
        assert.deepEqual(azure.blobs, []);
        assert.deepEqual(azure.containers, []);
        assert.deepEqual(azure.subscriptions, []);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

// -- public URL ---------------------------------------------------------------

function httpDeps(body: string, headers: Record<string, string> = {}): SafeHttpDeps {
    return {
        resolve: async () => ['93.184.216.34'],
        request: async () => {
            const response: RawResponse = {
                statusCode: 200,
                headers,
                body: Readable.from([Buffer.from(body)]),
                destroy: () => undefined,
            };
            return response;
        },
    };
}

test('a public Azure URL is analysed and remains directly queryable', async () => {
    const record = recorder();
    const ui = controller(record, {
        http: httpDeps('id,name\n1,Ada\n2,Grace\n'),
    });
    try {
        await ui.handle({
            type: 'publicUrlAnalyze',
            url: 'https://azureopendatastorage.blob.core.windows.net/nyctlc/sample.csv',
        });
        await settle();

        const state = snapshot(record);
        assert.equal(state.error, null);
        assert.equal(
            state.storageUrl,
            'https://azureopendatastorage.blob.core.windows.net/nyctlc/sample.csv',
        );
        assert.match(state.notice ?? '', /reads the storage URL directly/i);
        assert.equal(state.metadata?.file_type, 'csv');
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('a generic public host is analysed but the SQL says to stage the file', async () => {
    const record = recorder();
    const ui = controller(record, { http: httpDeps('id,name\n1,Ada\n') });
    try {
        await ui.handle({
            type: 'publicUrlAnalyze',
            url: 'https://example.com/data/sample.csv',
        });
        await settle();

        const state = snapshot(record);
        assert.equal(state.error, null);
        assert.equal(state.storageUrl, '', 'a generic host is not a queryable location');
        assert.match(state.notice ?? '', /Stage the file/i);
        assert.equal(state.metadata?.file_type, 'csv');
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('a public URL is subject to the SSRF policy', async () => {
    for (const [url, pattern] of [
        ['http://example.com/a.csv', /https/i],
        ['https://127.0.0.1/a.csv', /publicly routable/i],
        ['https://169.254.169.254/a.csv', /publicly routable/i],
        ['https://localhost/a.csv', /Local host names/i],
        ['https://user:pass@example.com/a.csv', /credentials/i],
        ['https://example.com/setup.exe', /supported data file/i],
    ] as const) {
        const record = recorder();
        const ui = controller(record, {
            http: {
                resolve: async () => ['93.184.216.34'],
                request: async () => assert.fail(`a request was made for ${url}`),
            },
        });
        try {
            await ui.handle({ type: 'publicUrlAnalyze', url });
            await settle();
            assert.match(snapshot(record).error ?? '', pattern, url);
            assert.equal(snapshot(record).busy, false);
        } finally {
            await ui.dispose();
            cleanup(record);
        }
    }
});

test('a public download that overruns the cap leaves nothing behind', async () => {
    const record = recorder();
    const ui = controller(record, {
        http: httpDeps('x', { 'content-length': '999999999999' }),
    });
    try {
        await ui.handle({
            type: 'publicUrlAnalyze',
            url: 'https://example.com/huge.csv',
        });
        await settle();
        assert.match(snapshot(record).error ?? '', /limit/i);
        assert.deepEqual(fs.readdirSync(record.downloadDir), []);
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});

test('downloaded temp files are cleaned up on dispose', async () => {
    const record = recorder();
    const ui = controller(record, { http: httpDeps('id,name\n1,Ada\n') });
    try {
        await ui.handle({
            type: 'publicUrlAnalyze',
            url: 'https://example.com/data/sample.csv',
        });
        await settle();
        assert.equal(fs.readdirSync(record.downloadDir).length, 1);
        await ui.dispose();
        assert.equal(record.cleaned.length, 1);
        assert.deepEqual(fs.readdirSync(record.downloadDir), []);
    } finally {
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
        record.dialogResult = [FIXTURES];
        await ui.handle({ type: 'openFolderDialog' });
        await settle();
        const serialised = JSON.stringify(snapshot(record));
        assert.ok(!serialised.includes(FIXTURES.replace(/\\/g, '\\\\')), 'no workspace root');
        assert.ok(!serialised.includes(os.homedir().replace(/\\/g, '\\\\')), 'no home directory');
    } finally {
        await ui.dispose();
        cleanup(record);
    }
});
