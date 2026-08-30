/**
 * The native UI controller.
 *
 * Everything the webview can ask for lands here, and everything the webview
 * ever sees leaves here. The controller owns:
 *
 *   * message validation (delegated to {@link parseWebviewRequest}) and the
 *     "unknown message is dropped, never defaulted" rule;
 *   * the analysis lifecycle, including cancellation and stale-result
 *     suppression, so a slow analysis that the user has moved on from can never
 *     overwrite newer state;
 *   * path containment, by refusing to accept a path from the renderer at all —
 *     only host-minted ids resolve, and each carries the root it is confined to;
 *   * the redaction boundary: nothing that reaches {@link AppStateStore} may be
 *     a token, a key, a SAS signature or an absolute filesystem path.
 *
 * It imports the native core only through `src/native/index.ts` and never
 * touches Python, `child_process`, a port or an HTTP server.
 */

import * as path from 'path';

import {
    CancellationError,
    SimpleCancellationTokenSource,
    describeError,
    nativeAnalysisService,
    type FileMetadata,
    type GeneratedStatements,
    type NativeAnalysisService,
    type ParserOverrides,
    type StatementKind,
    type TargetPlatform,
} from '../native';
import {
    AppStateStore,
    DEFAULT_PREVIEW_ROWS,
    displayLabel,
    limitationFor,
    quickAnalyzePatch,
    supportsPreview,
    type RegisteredFile,
} from '../appState';
import {
    sourceReadiness,
    suggestedObjectNames,
    type SourceKind,
} from '../quickAnalyze';
import {
    MAX_PREVIEW_ROWS,
    MIN_PREVIEW_ROWS,
    parseWebviewRequest,
    type AzureAuthMode,
    type WebviewRequest,
} from '../protocol';
import { resolveDocumentationUrl } from '../documentation';
import { createSerialQueue } from '../util';
import { listStorageAccounts, listSubscriptions } from '../azure/arm';
import { redactAzure } from '../azure/storageUrl';
import type { SafeHttpDeps } from '../net/safeHttp';
import { SafeHttpError } from '../net/safeHttp';
import {
    dataExtension,
    downloadDataFile,
    firstSupportedBlob,
    isAzureStorageUrl,
    storageUrlFor,
} from '../net/publicData';
import type { UiHost } from './host';

/** Files the extension will analyse in one "Export All" pass. */
export const MAX_EXPORT_FILES = 100;

/** How long to wait after the last keystroke before regenerating SQL. */
export const REGENERATE_DEBOUNCE_MS = 180;

/** Blobs / containers fetched per page. Bounded again in the browser. */
const AZURE_PAGE_SIZE = 50;

export interface ControllerDeps {
    /** Injected so network tests never touch DNS or a socket. */
    readonly http?: SafeHttpDeps;
    readonly service?: NativeAnalysisService;
    /** Injected so debounce is deterministic under test. */
    readonly setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
    readonly clearTimeoutImpl?: (handle: unknown) => void;
}

/**
 * Replace the absolute path in metadata with a display label.
 *
 * The renderer has no use for an absolute path, and a home directory usually
 * contains a user name, so the copy that crosses the boundary carries a label
 * instead. The untouched original stays in the host for SQL generation, where
 * the real path is the whole point of a `BULK INSERT`.
 */
export function metadataForDisplay(
    metadata: FileMetadata,
    workspaceFolders: readonly string[],
): FileMetadata {
    const { label, folderLabel } = displayLabel(metadata.file_path, workspaceFolders);
    return {
        ...metadata,
        file_path: folderLabel ? `${folderLabel}/${label}` : label,
    };
}

export class UiController {
    private readonly service: NativeAnalysisService;
    private readonly queue = createSerialQueue();
    private tokenSource: SimpleCancellationTokenSource | undefined;
    private aborter: AbortController | undefined;
    private generation = 0;
    private regenerateHandle: unknown;
    /** Temp files this controller downloaded, cleaned up on dispose. */
    private readonly temporaryFiles = new Set<string>();
    /** The untouched metadata, i.e. the copy that still has a real path. */
    private rawMetadata: FileMetadata | null = null;
    private folderMetadata: readonly FileMetadata[] = [];
    private sourceReferenceUrl = '';
    private disposed = false;
    /** Benchmark instrumentation: only the first analysis is timed in the log. */
    private firstAnalysisLogged = false;

    constructor(
        private readonly host: UiHost,
        private readonly store: AppStateStore,
        private readonly deps: ControllerDeps = {},
    ) {
        this.service = deps.service ?? nativeAnalysisService;
        this.store.setWorkspaceFolders(this.host.workspaceFolders());
        this.store.update({
            formats: this.service.listFormats(),
            appearance: this.host.getPreference('appearance', 'auto'),
        });
    }

    // -- message entry point -------------------------------------------------

    /**
     * Handle one raw message from a webview.
     *
     * Never throws: a renderer must not be able to take down the extension host
     * by posting something the handler did not expect.
     */
    async handle(raw: unknown): Promise<void> {
        const request = parseWebviewRequest(raw);
        if (!request) {
            this.host.log('Dropped an unrecognised or malformed webview message.');
            return;
        }
        try {
            await this.dispatch(request);
        } catch (error) {
            if (error instanceof CancellationError) {
                return;
            }
            const message = redactAzure(describeError(error));
            this.host.log(`Request "${request.type}" failed: ${message}`);
            this.store.update({ busy: false, progress: null, error: message });
        }
    }

    private async dispatch(request: WebviewRequest): Promise<void> {
        switch (request.type) {
            case 'ready':
            case 'refresh':
                this.store.setWorkspaceFolders(this.host.workspaceFolders());
                this.store.update({});
                return;
            case 'cancel':
                this.cancelActive();
                this.store.update({ busy: false, progress: null });
                return;
            case 'dismissNotice':
                this.store.update({ notice: null, error: null });
                return;
            case 'setPlatform': {
                const platform = this.service.normalizePlatform(request.platform);
                this.store.update({ platform });
                this.refreshQuickAnalyze();
                void this.host.setPreference('platform', platform);
                this.regenerate();
                return;
            }
            case 'setTab':
                this.store.update({ activeTab: request.tab });
                void this.host.setPreference('activeTab', request.tab);
                return;
            case 'setPreference':
                this.store.update({ appearance: request.appearance });
                void this.host.setPreference('appearance', request.appearance);
                return;
            case 'selectFile':
                return this.queue(() => this.selectFile(request.fileId));
            case 'openFileDialog':
                return this.queue(() => this.browse(false));
            case 'openFolderDialog':
                return this.queue(() => this.browse(true));
            case 'analyzeCurrentFile':
                return this.queue(() => this.analyzeCurrentFile());
            case 'analyzeWorkspaceFolder':
                return this.queue(() => this.analyzeWorkspaceFolder());
            case 'setTableName':
                this.store.update({ tableName: request.value });
                this.regenerate();
                return;
            case 'setSchemaName':
                this.store.update({ schemaName: request.value });
                this.regenerate();
                return;
            case 'setDataSource':
                this.store.update({ dataSource: request.value });
                this.refreshQuickAnalyze();
                this.regenerate();
                return;
            case 'setCredentialName':
                this.store.update({ credentialName: request.value });
                this.refreshQuickAnalyze();
                this.regenerate();
                return;
            case 'setAuthMethod':
                this.store.update({ authMethod: request.value });
                this.refreshQuickAnalyze();
                this.regenerate();
                return;
            case 'setStorageUrl':
                this.store.update({ storageUrl: request.value });
                this.refreshQuickAnalyze();
                this.regenerate();
                return;
            case 'setFormatName':
                this.store.update({ formatName: request.value });
                this.refreshQuickAnalyze();
                this.regenerate();
                return;
            case 'setStatementKind':
                this.store.update({
                    activeTab: 'quick_analyze',
                    quickAnalyze: {
                        ...this.store.state.quickAnalyze,
                        selectedStatement: request.kind,
                    },
                });
                this.refreshQuickAnalyze();
                return;
            case 'setParserOverride': {
                const value = this.parseParserOverride(request.key, request.value);
                if (value === undefined) {
                    return;
                }
                const parserOverrides = {
                    ...this.store.state.parserOverrides,
                    [request.key]: value,
                };
                this.store.update({ parserOverrides, error: null });
                this.refreshQuickAnalyze();
                this.regenerate();
                return;
            }
            case 'resetParserOverride': {
                const parserOverrides = { ...this.store.state.parserOverrides };
                delete parserOverrides[request.key];
                this.store.update({ parserOverrides });
                this.refreshQuickAnalyze();
                this.regenerate();
                return;
            }
            case 'setColumnOverride': {
                const overrides = { ...this.store.state.columnOverrides };
                if (request.sqlType.trim() === '') {
                    delete overrides[request.column];
                } else {
                    overrides[request.column] = request.sqlType.trim();
                }
                this.store.update({ columnOverrides: overrides });
                this.regenerate();
                return;
            }
            case 'clearColumnOverrides':
                this.store.update({ columnOverrides: {} });
                this.regenerate();
                return;
            case 'setPreviewRows': {
                const rows = Math.max(
                    MIN_PREVIEW_ROWS,
                    Math.min(request.rows, MAX_PREVIEW_ROWS),
                );
                this.store.update({ previewRows: rows });
                return this.queue(() => this.refreshPreview());
            }
            case 'copyStatement':
                return this.copyStatement(request.kind);
            case 'openStatementInEditor':
                return this.openStatementInEditor(request.kind);
            case 'exportAllSql':
                return this.queue(() => this.exportAllSql());
            case 'openInEditor':
                return this.host.openPanel();
            case 'openDocumentation': {
                const url = resolveDocumentationUrl(request.id, this.store.state.platform);
                if (!url) {
                    this.host.log(
                        `Documentation "${request.id}" is unavailable for the selected platform.`,
                    );
                    return;
                }
                await this.host.openExternal(url);
                return;
            }
            case 'showOrcGuidance':
                this.showLimitationGuidance();
                return;
            case 'azureConnect':
                return this.queue(() => this.azureConnect(request.mode));
            case 'azureDisconnect':
                return this.queue(() => this.azureDisconnect());
            case 'azureListSubscriptions':
                return this.queue(() => this.azureListSubscriptions());
            case 'azureListAccounts':
                return this.queue(() => this.azureListAccounts(request.subscriptionId));
            case 'azureSetAccount':
                return this.queue(() => this.azureSetAccount(request.account));
            case 'azureListContainers':
                return this.queue(() => this.azureListContainers());
            case 'azureListBlobs':
                return this.queue(() =>
                    this.azureListBlobs(
                        request.container,
                        request.prefix,
                        request.continuation,
                    ),
                );
            case 'azureAnalyzeBlob':
                return this.queue(() =>
                    this.azureAnalyzeBlob(request.container, request.blob),
                );
            case 'publicUrlAnalyze':
                return this.queue(() => this.analyzePublicUrl(request.url));
            default: {
                // Exhaustiveness: adding a request type without a case is a
                // compile error rather than a silently ignored message.
                const exhaustive: never = request;
                void exhaustive;
                return;
            }
        }
    }

    // -- cancellation / staleness -------------------------------------------

    private begin(): {
        token: SimpleCancellationTokenSource;
        generation: number;
        signal: AbortSignal;
    } {
        this.cancelActive();
        const token = new SimpleCancellationTokenSource();
        const aborter = new AbortController();
        this.tokenSource = token;
        this.aborter = aborter;
        this.generation += 1;
        return { token, generation: this.generation, signal: aborter.signal };
    }

    private cancelActive(): void {
        this.tokenSource?.cancel();
        this.tokenSource = undefined;
        // Cancelling must stop work in flight, not merely discard its result:
        // an in-progress blob or public download reads the same signal.
        this.aborter?.abort();
        this.aborter = undefined;
    }

    /** True when *generation* is still the newest request. */
    private isCurrent(generation: number): boolean {
        return !this.disposed && generation === this.generation;
    }

    // -- file selection ------------------------------------------------------

    private async browse(folders: boolean): Promise<void> {
        const picked = await this.host.showOpenDialog({
            folders,
            many: !folders,
            title: folders ? 'Select a folder to analyze' : 'Select data files to analyze',
        });
        if (!picked || picked.length === 0) {
            return;
        }
        if (folders) {
            await this.loadDirectory(picked[0]);
            return;
        }
        await this.loadFiles(picked);
    }

    private async analyzeCurrentFile(): Promise<void> {
        const limitation = this.host.activeFileLimitation();
        if (limitation) {
            this.store.update({ error: limitation });
            return;
        }
        const target = this.host.activeFilePath();
        if (!target) {
            this.store.update({
                error: 'No file is open in the active editor.',
            });
            return;
        }
        await this.loadFiles([target]);
    }

    private async analyzeWorkspaceFolder(): Promise<void> {
        const folder = await this.host.pickWorkspaceFolder();
        if (!folder) {
            return;
        }
        await this.loadDirectory(folder);
    }

    /**
     * Analyse a directory and list every supported file inside it.
     *
     * The directory itself becomes the allowed root, so nothing outside the
     * folder the user chose can be read even if it is linked into it.
     */
    async loadDirectory(directory: string): Promise<void> {
        this.sourceReferenceUrl = '';
        this.folderMetadata = [];
        this.rawMetadata = null;
        this.store.update({
            sourceKind: 'local',
            storageUrl: '',
            parserOverrides: {},
            folderProfile: null,
        });
        const { token, generation } = this.begin();
        this.store.update({ busy: true, progress: 'Scanning folder…', error: null });
        try {
            const result = await this.service.analyzeDirectory({
                filePath: directory,
                allowedRoot: directory,
                token: token.token,
            });
            if (!this.isCurrent(generation)) {
                return;
            }
            this.store.setFiles(
                result.files.map((file) => ({
                    absolutePath: file.file_path,
                    allowedRoot: result.root,
                    fileType: file.file_type,
                    sizeBytes: file.file_size,
                    nativeSupport: file.native_support ?? 'supported',
                    isDirectory: file.file_type === 'delta' || file.file_type === 'iceberg',
                })),
            );
            this.folderMetadata = result.files;
            const { label } = displayLabel(result.root, this.host.workspaceFolders());
            this.store.update({
                busy: false,
                progress: null,
                sourceLabel: label,
                notice:
                    result.files.length === 0
                        ? 'No supported data files were found in that folder.'
                        : null,
            });
            this.refreshQuickAnalyze();
            const first = this.store.state.files[0];
            if (first) {
                await this.selectFile(first.id);
            } else {
                this.store.clearSelection();
            }
        } catch (error) {
            this.failIfCurrent(generation, error);
        }
    }

    /** Analyse one or more explicitly chosen files. */
    async loadFiles(paths: readonly string[], sourceKind: SourceKind = 'local'): Promise<void> {
        this.folderMetadata = [];
        if (sourceKind === 'local') {
            this.sourceReferenceUrl = '';
        }
        const entries = paths.map((absolute) => ({
            absolutePath: absolute,
            // A single chosen file is confined to its own directory, matching
            // the native core's implied-root rule.
            allowedRoot: path.dirname(path.resolve(absolute)),
            fileType: 'unknown',
            sizeBytes: 0,
            nativeSupport: 'supported' as const,
            isDirectory: false,
        }));
        this.store.setFiles(entries);
        const first = this.store.state.files[0];
        const { label } = displayLabel(paths[0], this.host.workspaceFolders());
        this.store.update({
            sourceLabel: label,
            sourceKind,
            storageUrl: sourceKind === 'local' ? '' : this.store.state.storageUrl,
            parserOverrides: {},
            folderProfile: null,
            error: null,
            notice: null,
        });
        this.refreshQuickAnalyze();
        if (first) {
            await this.selectFile(first.id);
        }
    }

    private async selectFile(fileId: string): Promise<void> {
        const file = this.store.lookup(fileId);
        if (!file) {
            // A stale id from a previous listing. Say so rather than guessing.
            this.store.update({ error: 'That file is no longer in the list. Refresh and try again.' });
            return;
        }
        const changed = this.store.state.selectedFileId !== fileId;
        this.store.update({
            selectedFileId: fileId,
            parserOverrides: changed ? {} : this.store.state.parserOverrides,
            error: null,
            notice: null,
        });
        await this.analyzeSelected(file);
    }

    private async analyzeSelected(file: RegisteredFile): Promise<void> {
        const { token, generation } = this.begin();
        const started = this.host.now();
        this.store.update({
            busy: true,
            progress: `Analyzing ${file.entry.label}…`,
            error: null,
            preview: null,
        });
        try {
            const metadata = await this.service.analyze({
                filePath: file.absolutePath,
                allowedRoot: file.allowedRoot,
                token: token.token,
            });
            if (!this.isCurrent(generation)) {
                return;
            }
            this.rawMetadata = metadata;
            const elapsedMs = this.host.now() - started;
            this.applyMetadata(metadata, elapsedMs);
            if (!this.firstAnalysisLogged) {
                this.firstAnalysisLogged = true;
                this.host.log(`First native analysis completed in ${Math.round(elapsedMs)} ms.`);
            }

            if (supportsPreview(metadata)) {
                this.store.update({ progress: 'Reading preview rows…' });
                const preview = await this.service.preview({
                    filePath: file.absolutePath,
                    allowedRoot: file.allowedRoot,
                    maxRows: this.store.state.previewRows,
                    token: token.token,
                });
                if (!this.isCurrent(generation)) {
                    return;
                }
                this.store.update({ preview });
            }
            this.store.update({ busy: false, progress: null });
        } catch (error) {
            this.failIfCurrent(generation, error);
        }
    }

    private async refreshPreview(): Promise<void> {
        const file = this.store.selected;
        if (!file || !supportsPreview(this.rawMetadata)) {
            return;
        }
        const { token, generation } = this.begin();
        this.store.update({ busy: true, progress: 'Reading preview rows…' });
        try {
            const preview = await this.service.preview({
                filePath: file.absolutePath,
                allowedRoot: file.allowedRoot,
                maxRows: this.store.state.previewRows,
                token: token.token,
            });
            if (!this.isCurrent(generation)) {
                return;
            }
            this.store.update({ preview, busy: false, progress: null });
        } catch (error) {
            this.failIfCurrent(generation, error);
        }
    }

    private failIfCurrent(generation: number, error: unknown): void {
        if (error instanceof CancellationError || !this.isCurrent(generation)) {
            return;
        }
        // A user-initiated cancel is not a failure, and must not leave an error
        // banner behind after the work it stopped.
        if (error instanceof SafeHttpError && error.code === 'cancelled') {
            this.store.update({ busy: false, progress: null });
            return;
        }
        const message = redactAzure(describeError(error));
        this.host.log(`Analysis failed: ${message}`);
        this.store.update({ busy: false, progress: null, error: message });
    }

    // -- generation ----------------------------------------------------------

    private applyMetadata(metadata: FileMetadata, elapsedMs: number): void {
        const display = metadataForDisplay(metadata, this.host.workspaceFolders());
        const state = this.store.state;
        const sourceNames =
            state.sourceKind === 'local' || !state.storageUrl
                ? null
                : suggestedObjectNames(
                      state.storageUrl,
                      metadata.file_type,
                      state.authMethod || (state.azure.mode === 'anonymous' ? 'public' : ''),
                  );
        this.store.update({
            metadata: display,
            limitation: limitationFor(metadata),
            tableName: state.tableName || this.service.resolveTableName(metadata, null),
            dataSource: sourceNames?.dataSource ?? state.dataSource,
            credentialName: sourceNames?.credentialName ?? state.credentialName,
            formatName: sourceNames?.formatName ?? state.formatName,
            authMethod:
                state.authMethod ||
                (state.sourceKind === 'azure' && state.azure.mode === 'anonymous'
                    ? 'public'
                    : state.authMethod),
            lastAnalysisMs: Math.max(0, Math.round(elapsedMs)),
        });
        this.refreshQuickAnalyze();
        this.generateNow();
    }

    private refreshQuickAnalyze(): void {
        const patch = quickAnalyzePatch(
            this.store.state,
            this.rawMetadata,
            this.folderMetadata,
        );
        if (this.sourceReferenceUrl && this.store.state.sourceKind !== 'local') {
            this.store.update({
                ...patch,
                quickAnalyze: {
                ...patch.quickAnalyze,
                source: sourceReadiness({
                    sourceKind: this.store.state.sourceKind,
                    storageUrl: this.sourceReferenceUrl,
                    fileName: this.rawMetadata?.file_name ?? '',
                    fileType: this.rawMetadata?.file_type ?? 'unknown',
                    dataSource: this.store.state.dataSource,
                    credentialName: this.store.state.credentialName,
                    formatName: this.store.state.formatName,
                    authMethod: this.store.state.authMethod,
                    platform: this.store.state.platform,
                    selectedStatement: patch.quickAnalyze.selectedStatement,
                }),
                },
            });
            return;
        }
        this.store.update(patch);
    }

    private parseParserOverride(
        key: keyof ParserOverrides,
        raw: string,
    ): ParserOverrides[keyof ParserOverrides] | undefined {
        if (key === 'firstRow') {
            const value = Number(raw);
            if (!Number.isInteger(value) || value < 1 || value > 1_000_000) {
                this.store.update({ error: 'FIRSTROW must be an integer from 1 to 1000000.' });
                return undefined;
            }
            return value;
        }
        if (key === 'format') {
            const formats = this.store.state.formats.map((entry) => entry.fileType);
            if (!formats.includes(raw as FileMetadata['file_type'])) {
                this.store.update({ error: 'Choose a supported file format.' });
                return undefined;
            }
            return raw as FileMetadata['file_type'];
        }
        if (
            (key === 'fieldDelimiter' || key === 'quoteCharacter') &&
            [...raw].length !== 1
        ) {
            this.store.update({ error: `${key} must be exactly one character.` });
            return undefined;
        }
        if (key === 'rowTerminator' && raw.length === 0) {
            this.store.update({ error: 'Row terminator cannot be empty.' });
            return undefined;
        }
        return raw;
    }

    /** Schedule a regeneration, collapsing bursts of keystrokes into one. */
    private regenerate(): void {
        const setTimeoutImpl =
            this.deps.setTimeoutImpl ??
            ((fn: () => void, ms: number) => setTimeout(fn, ms));
        const clearTimeoutImpl =
            this.deps.clearTimeoutImpl ??
            ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
        if (this.regenerateHandle !== undefined) {
            clearTimeoutImpl(this.regenerateHandle);
        }
        this.regenerateHandle = setTimeoutImpl(() => {
            this.regenerateHandle = undefined;
            this.generateNow();
        }, REGENERATE_DEBOUNCE_MS);
    }

    /** Regenerate every statement tab from the current options. Synchronous. */
    generateNow(): void {
        if (this.disposed || !this.rawMetadata) {
            return;
        }
        const state = this.store.state;
        const statements: GeneratedStatements = this.service.generateStatements({
            metadata: {
                ...this.rawMetadata,
                sql_type_overrides: { ...state.columnOverrides },
            },
            tableName: state.tableName || null,
            schemaName: state.schemaName || 'dbo',
            dataSource: state.dataSource || 'MyDataSource',
            credentialName: state.credentialName || null,
            authMethod: state.authMethod || null,
            targetPlatform: state.platform,
            storageUrl: state.storageUrl || null,
            formatName: state.formatName || null,
            parserOverrides:
                Object.keys(state.parserOverrides).length > 0
                    ? { ...state.parserOverrides }
                    : undefined,
        });
        this.store.update({ statements });
    }

    private completeDocument(): string | null {
        if (!this.rawMetadata) {
            return null;
        }
        const state = this.store.state;
        return this.service.generateCompleteDocument({
            metadata: {
                ...this.rawMetadata,
                sql_type_overrides: { ...state.columnOverrides },
            },
            tableName: state.tableName || null,
            schemaName: state.schemaName || 'dbo',
            dataSource: state.dataSource || 'MyDataSource',
            credentialName: state.credentialName || null,
            authMethod: state.authMethod || null,
            targetPlatform: state.platform,
            storageUrl: state.storageUrl || null,
            formatName: state.formatName || null,
            parserOverrides:
                Object.keys(state.parserOverrides).length > 0
                    ? { ...state.parserOverrides }
                    : undefined,
        });
    }

    // -- clipboard / export --------------------------------------------------

    private async copyStatement(kind: StatementKind): Promise<void> {
        const statements = this.store.state.statements;
        const text = statements?.[kind];
        if (!text) {
            this.store.update({ error: 'There is nothing to copy yet.' });
            return;
        }
        await this.host.copyToClipboard(text);
        this.store.update({ notice: 'Copied to the clipboard.' });
    }

    private async openStatementInEditor(kind: StatementKind): Promise<void> {
        const text = this.store.state.statements?.[kind];
        if (!text) {
            this.store.update({ error: 'There is nothing to open yet.' });
            return;
        }
        await this.host.openUntitledDocument(text, 'sql');
    }

    /**
     * Produce one runnable script for every listed file.
     *
     * Shared prerequisites (master key, credential, external data source, file
     * format) are emitted once across the whole document, which is what makes
     * the result runnable rather than a concatenation that fails on the second
     * `CREATE MASTER KEY`.
     */
    private async exportAllSql(): Promise<void> {
        const files = this.store.state.files;
        if (files.length === 0) {
            const single = this.completeDocument();
            if (!single) {
                this.store.update({ error: 'Analyze a file before exporting.' });
                return;
            }
            await this.deliverExport('sql-file-detection-tool.sql', single);
            return;
        }

        const { token, generation } = this.begin();
        const state = this.store.state;
        const entries: Array<{ metadata: FileMetadata; tableName?: string | null }> = [];
        const budget = Math.min(files.length, MAX_EXPORT_FILES);
        this.store.update({ busy: true, progress: 'Preparing export…', error: null });
        try {
            for (let index = 0; index < budget; index += 1) {
                const registered = this.store.lookup(files[index].id);
                if (!registered) {
                    continue;
                }
                this.store.update({
                    progress: `Analyzing ${files[index].label} (${index + 1}/${budget})…`,
                });
                const metadata = await this.service.analyze({
                    filePath: registered.absolutePath,
                    allowedRoot: registered.allowedRoot,
                    token: token.token,
                });
                if (!this.isCurrent(generation)) {
                    return;
                }
                entries.push({
                    metadata: {
                        ...metadata,
                        sql_type_overrides:
                            registered.id === state.selectedFileId
                                ? { ...state.columnOverrides }
                                : undefined,
                        parser_overrides:
                            registered.id === state.selectedFileId &&
                            Object.keys(state.parserOverrides).length > 0
                                ? { ...state.parserOverrides }
                                : undefined,
                    },
                    // A table name is a per-file override, so it only applies
                    // to the file it was typed for.
                    tableName:
                        registered.id === state.selectedFileId
                            ? state.tableName || null
                            : null,
                });
            }
            const script = this.service.generateMultiFileScript({
                entries,
                schemaName: state.schemaName || 'dbo',
                dataSource: state.dataSource || 'MyDataSource',
                credentialName: state.credentialName || null,
                authMethod: state.authMethod || null,
                targetPlatform: state.platform as TargetPlatform,
                storageUrl: state.storageUrl || null,
            });
            if (!this.isCurrent(generation)) {
                return;
            }
            this.store.update({
                busy: false,
                progress: null,
                notice:
                    files.length > budget
                        ? `Exported the first ${budget} of ${files.length} files.`
                        : null,
            });
            await this.deliverExport('sql-file-detection-tool.sql', script);
        } catch (error) {
            this.failIfCurrent(generation, error);
        }
    }

    private async deliverExport(suggestedName: string, content: string): Promise<void> {
        // Any notice already set (for example a truncation warning) still matters
        // after the file is delivered, so it is carried rather than replaced.
        const existing = this.store.state.notice;
        const withExisting = (message: string): string =>
            existing ? `${existing} ${message}` : message;

        const saved = await this.host.saveTextFile(suggestedName, content);
        if (saved) {
            this.store.update({ notice: withExisting('Saved the SQL script.') });
            return;
        }
        // The user dismissed the save dialog; an untitled buffer keeps the work
        // rather than discarding a script that took real analysis to produce.
        await this.host.openUntitledDocument(content, 'sql');
        this.store.update({
            notice: withExisting('Opened the SQL script in an untitled editor.'),
        });
    }

    private showLimitationGuidance(): void {
        const limitation = this.store.state.limitation;
        if (!limitation) {
            return;
        }
        this.host.showInformation(
            limitation.manualWorkaround
                ? `${limitation.title}. ${limitation.manualWorkaround}`
                : `${limitation.title}. ${limitation.detail}`,
        );
    }

    // -- Azure ---------------------------------------------------------------

    private async azureConnect(mode: AzureAuthMode): Promise<void> {
        this.store.updateAzure({ busy: true, error: null });
        try {
            const info = await this.host.azure.connect(mode);
            this.store.updateAzure({
                busy: false,
                connected: info.connected,
                mode: info.mode,
                identity: info.identity,
                account: info.account,
                canListSubscriptions: info.canListSubscriptions,
                error: null,
            });
            if (info.account) {
                await this.azureListContainers();
            } else if (info.canListSubscriptions) {
                await this.azureListSubscriptions();
            }
        } catch (error) {
            this.azureFail(error);
        }
    }

    private async azureDisconnect(): Promise<void> {
        try {
            await this.host.azure.disconnect();
        } finally {
            this.store.updateAzure({
                connected: false,
                mode: null,
                identity: null,
                account: null,
                subscriptions: [],
                accounts: [],
                containers: [],
                container: null,
                prefix: '',
                blobs: [],
                continuation: null,
                canListSubscriptions: false,
                busy: false,
                error: null,
            });
        }
    }

    private async azureListSubscriptions(): Promise<void> {
        this.store.updateAzure({ busy: true, error: null });
        try {
            const token = await this.host.azure.armToken();
            if (!token) {
                this.store.updateAzure({
                    busy: false,
                    canListSubscriptions: false,
                    error:
                        'Subscription discovery is unavailable. Enter a storage account name to attach directly.',
                });
                return;
            }
            const subscriptions = await listSubscriptions(token);
            this.store.updateAzure({ busy: false, subscriptions, canListSubscriptions: true });
        } catch (error) {
            this.azureFail(error);
        }
    }

    private async azureListAccounts(subscriptionId: string): Promise<void> {
        this.store.updateAzure({ busy: true, error: null });
        try {
            const token = await this.host.azure.armToken();
            if (!token) {
                this.store.updateAzure({
                    busy: false,
                    error: 'Sign in with a Microsoft account to list storage accounts.',
                });
                return;
            }
            const accounts = await listStorageAccounts(token, subscriptionId);
            this.store.updateAzure({ busy: false, accounts });
        } catch (error) {
            this.azureFail(error);
        }
    }

    private async azureSetAccount(account: string): Promise<void> {
        this.store.updateAzure({ busy: true, error: null });
        try {
            const info = await this.host.azure.useAccount(account);
            this.store.updateAzure({
                busy: false,
                account: info.account,
                connected: info.connected,
                mode: info.mode,
                identity: info.identity,
                containers: [],
                container: null,
                blobs: [],
                continuation: null,
            });
            await this.azureListContainers();
        } catch (error) {
            this.azureFail(error);
        }
    }

    private async azureListContainers(): Promise<void> {
        const browser = this.host.azure.browser();
        if (!browser) {
            this.store.updateAzure({
                busy: false,
                error: 'Select a storage account first.',
            });
            return;
        }
        this.store.updateAzure({ busy: true, error: null });
        try {
            const page = await browser.listContainers({ pageSize: AZURE_PAGE_SIZE });
            this.store.updateAzure({ busy: false, containers: page.names });
        } catch (error) {
            this.azureFail(error);
        }
    }

    private async azureListBlobs(
        container: string,
        prefix: string,
        continuation: string,
    ): Promise<void> {
        const browser = this.host.azure.browser();
        if (!browser) {
            this.store.updateAzure({ busy: false, error: 'Select a storage account first.' });
            return;
        }
        this.store.updateAzure({ busy: true, error: null });
        try {
            const page = await browser.listBlobs(container, {
                prefix,
                continuation: continuation || null,
                pageSize: AZURE_PAGE_SIZE,
            });
            this.store.updateAzure({
                busy: false,
                container,
                prefix,
                continuation: page.continuation,
                blobs: page.entries.map((entry) => ({
                    name: entry.name,
                    sizeBytes: entry.sizeBytes,
                    supported: entry.isPrefix || dataExtension(entry.name) !== null,
                })),
            });
        } catch (error) {
            this.azureFail(error);
        }
    }

    private async azureAnalyzeBlob(container: string, blob: string): Promise<void> {
        const browser = this.host.azure.browser();
        if (!browser) {
            this.store.updateAzure({ busy: false, error: 'Select a storage account first.' });
            return;
        }
        const { token, generation, signal } = this.begin();
        this.store.update({ busy: true, progress: `Downloading ${blob}…`, error: null });
        try {
            const directory = await this.host.downloadDirectory();
            const downloaded = await browser.downloadBlob(container, blob, directory, {
                signal,
            });
            this.temporaryFiles.add(downloaded.path);
            if (!this.isCurrent(generation) || token.token.isCancellationRequested) {
                await this.host.cleanupDownload(downloaded.path);
                this.temporaryFiles.delete(downloaded.path);
                return;
            }
            this.sourceReferenceUrl = browser.blobUrl(container, blob);
            this.store.update({ storageUrl: this.sourceReferenceUrl });
            await this.loadFiles([downloaded.path], 'azure');
            this.store.update({
                notice:
                    'Analyzed a local copy. The generated SQL points at the blob URL, not the copy.',
            });
        } catch (error) {
            this.azureFail(error);
            this.store.update({ busy: false, progress: null });
        }
    }

    private azureFail(error: unknown): void {
        const message = redactAzure(describeError(error));
        this.host.log(`Azure request failed: ${message}`);
        this.store.updateAzure({ busy: false, error: message });
    }

    // -- public data ---------------------------------------------------------

    /**
     * Download and analyse a public HTTPS URL.
     *
     * The URL is validated, fetched and stored by
     * {@link ../net/publicData}, which enforces the SSRF policy. The generated
     * SQL only points at the URL when SQL can actually read it; otherwise the
     * user is told to stage the file.
     */
    private async analyzePublicUrl(url: string): Promise<void> {
        const { token, generation, signal } = this.begin();
        const http: SafeHttpDeps = { ...(this.deps.http ?? {}), signal };
        this.store.update({ busy: true, progress: 'Resolving URL…', error: null, notice: null });
        try {
            let target = url;
            if (!dataExtension(url) && isAzureStorageUrl(url)) {
                this.store.update({ progress: 'Listing the public container…' });
                const candidate = await firstSupportedBlob(url, http);
                if (!this.isCurrent(generation)) {
                    return;
                }
                if (!candidate) {
                    this.store.update({
                        busy: false,
                        progress: null,
                        error:
                            'No supported data file was found under that container prefix.',
                    });
                    return;
                }
                target = candidate.url;
            }

            this.store.update({ progress: 'Downloading…' });
            const directory = await this.host.downloadDirectory();
            const downloaded = await downloadDataFile(target, directory, http);
            this.temporaryFiles.add(downloaded.path);
            if (!this.isCurrent(generation) || token.token.isCancellationRequested) {
                await this.host.cleanupDownload(downloaded.path);
                this.temporaryFiles.delete(downloaded.path);
                return;
            }

            const queryable = storageUrlFor(target);
            try {
                const source = new URL(target);
                source.search = '';
                source.hash = '';
                this.sourceReferenceUrl = source.toString();
            } catch {
                this.sourceReferenceUrl = '';
            }
            this.store.update({ storageUrl: queryable ?? '' });
            await this.loadFiles(
                [downloaded.path],
                queryable && isAzureStorageUrl(queryable) ? 'azure' : 'public_https',
            );
            this.store.update({
                busy: false,
                progress: null,
                notice: queryable
                    ? 'Analyzed a local copy. The generated SQL reads the storage URL directly.'
                    : 'SQL cannot read that URL directly. Stage the file in Azure Storage (or a local path SQL can reach) before running the generated script.',
            });
        } catch (error) {
            this.failIfCurrent(generation, error);
        }
    }

    // -- lifecycle -----------------------------------------------------------

    /** Re-read workspace folders, e.g. after a folder was added or removed. */
    refreshWorkspace(): void {
        this.store.setWorkspaceFolders(this.host.workspaceFolders());
        this.store.update({});
    }

    /** Analyse an explicit path chosen outside the webview (a command). */
    async analyzePath(target: string, isDirectory: boolean): Promise<void> {
        await this.queue(() =>
            isDirectory ? this.loadDirectory(target) : this.loadFiles([target]),
        );
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        this.cancelActive();
        if (this.regenerateHandle !== undefined) {
            const clearTimeoutImpl =
                this.deps.clearTimeoutImpl ??
                ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
            clearTimeoutImpl(this.regenerateHandle);
            this.regenerateHandle = undefined;
        }
        this.rawMetadata = null;
        this.folderMetadata = [];
        this.sourceReferenceUrl = '';
        for (const file of this.temporaryFiles) {
            await this.host.cleanupDownload(file);
        }
        this.temporaryFiles.clear();
    }
}

export { DEFAULT_PREVIEW_ROWS };
