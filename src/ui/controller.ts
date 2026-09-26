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
    FileChangedError,
    SimpleCancellationTokenSource,
    deduplicateSharedPrerequisites,
    describeError,
    DIRECTORY_SCAN_MAX_DEPTH,
    DIRECTORY_SCAN_MAX_DIRECTORIES,
    DIRECTORY_SCAN_MAX_FILES,
    effectiveStorageUrl,
    generateBulkInsert,
    generateCredentialSetup,
    generateExternalFileFormat,
    generateExternalTable,
    generateOpenrowset,
    inferDataSourceType,
    externalTableRecommendedSqlType,
    isSqlSourceFile,
    knownStorageLocation,
    markProvisionalSql,
    nativeAnalysisService,
    NATIVE_SUPPORT_BY_TYPE,
    normalizeDataSourceType,
    normalizeGuidedAuthMethod,
    type FileMetadata,
    type AnalysisPreview,
    type FileType,
    type GeneratorMetadata,
    type GeneratedStatements,
    type NativeAnalysisService,
    type PreviewResult,
    sqlSourceFileType,
    type StatementKind,
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
    MAX_PREVIEW_ROWS,
    MIN_PREVIEW_ROWS,
    isStatementKind,
    parseWebviewRequest,
    type AppStateSnapshot,
    type WebviewRequest,
} from '../protocol';
import { resolveDocumentationUrl } from '../documentation';
import { createSerialQueue, redact } from '../util';
import type { UiHost } from './host';
import { AzureBrowser } from '../azure/browser';
import {
    DEFAULT_FILE_SETTINGS,
    IMPORT_PROFILES_PREFERENCE,
    MAX_PROFILE_NAME_LENGTH,
    MAX_SETTING_NAME_LENGTH,
    SettingsValidationError,
    fileSettingsFrom,
    settingName,
    validateColumnName,
    validateFileSettings,
    validateImportProfile,
    validateImportProfiles,
    validateParserOverrides,
    validatedSqlType,
    type FileSettings,
    type ImportProfile,
    type ObjectNameKey,
} from '../fileSettings';

/** Files the extension will analyse in one "Export All" pass. */
export const MAX_EXPORT_FILES = 100;

/** How long to wait after the last keystroke before regenerating SQL. */
export const REGENERATE_DEBOUNCE_MS = 180;

export interface ControllerDeps {
    readonly service?: NativeAnalysisService;
    readonly azure?: AzureBrowser;
    /** Injected so debounce is deterministic under test. */
    readonly setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
    readonly clearTimeoutImpl?: (handle: unknown) => void;
}

type LocalSourceState = Pick<
    AppStateSnapshot,
    | 'fileFilter'
    | 'selectedFileId'
    | 'sourceLabel'
    | 'locationLabel'
    | 'metadata'
    | 'preview'
    | 'tableName'
    | 'schemaName'
    | 'dataSource'
    | 'dataSourceType'
    | 'credentialName'
    | 'authMethod'
    | 'storageGoal'
    | 'storageUrl'
    | 'azureFolderPreview'
    | 'remoteSchema'
    | 'formatName'
    | 'parserOverrides'
    | 'sourceKind'
    | 'folderProfile'
    | 'columnOverrides'
    | 'canUndoSettings'
    | 'recommendedSqlTypes'
    | 'limitation'
    | 'lastAnalysisMs'
>;

interface LocalSourceSnapshot {
    readonly files: readonly RegisteredFile[];
    readonly state: LocalSourceState;
    readonly rawMetadata: FileMetadata | null;
    readonly folderMetadata: readonly FileMetadata[];
}

interface AnalysisOperation {
    readonly token: SimpleCancellationTokenSource;
    readonly generation: number;
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

function localLocationLabel(
    absolutePath: string,
    workspaceFolders: readonly string[],
): string {
    const resolved = path.resolve(absolutePath);
    for (const folder of workspaceFolders) {
        const root = path.resolve(folder);
        const relative = path.relative(root, resolved);
        if (relative === '') {
            return path.basename(root);
        }
        if (
            !relative.startsWith(`..${path.sep}`)
            && relative !== '..'
            && !path.isAbsolute(relative)
        ) {
            return [path.basename(root), relative.split(path.sep).join('/')].join('/');
        }
    }
    const parent = path.basename(path.dirname(resolved));
    return parent ? `.../${parent}/${path.basename(resolved)}` : path.basename(resolved);
}

/** Platform-neutral SQL type recommendations shown in the schema editor. */
export function recommendedSqlTypes(
    metadata: FileMetadata,
): Readonly<Record<string, string>> {
    return Object.fromEntries((metadata.schema ?? []).map(([column, detectedType]) =>
        [column, externalTableRecommendedSqlType(metadata, column, detectedType)]));
}

export class UiController {
    private readonly service: NativeAnalysisService;
    private readonly azure: AzureBrowser | undefined;
    private readonly queue = createSerialQueue();
    private readonly profileQueue = createSerialQueue();
    private profiles: readonly ImportProfile[] = [];
    private tokenSource: SimpleCancellationTokenSource | undefined;
    private generation = 0;
    private regenerateHandle: unknown;
    /** The untouched metadata, i.e. the copy that still has a real path. */
    private rawMetadata: FileMetadata | null = null;
    private folderMetadata: readonly FileMetadata[] = [];
    private disposed = false;
    /** Benchmark instrumentation: only the first analysis is timed in the log. */
    private firstAnalysisLogged = false;
    private localSourceSnapshot: LocalSourceSnapshot | undefined;

    constructor(
        private readonly host: UiHost,
        private readonly store: AppStateStore,
        private readonly deps: ControllerDeps = {},
    ) {
        this.service = deps.service ?? nativeAnalysisService;
        this.azure = deps.azure;
        this.store.setWorkspaceFolders(this.host.workspaceFolders());
        this.store.update({
            formats: this.service.listFormats(),
        });
        this.loadImportProfiles();
        this.generateNow();
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
            if (error instanceof SettingsValidationError) {
                this.host.log(`Settings were not changed: ${error.message}`);
                this.store.update({ error: error.message });
                return;
            }
            const message = redact(describeError(error));
            this.host.log(`Request "${request.type}" failed: ${message}`);
            this.store.update({ busy: false, progress: null, error: message });
        }
    }

    async authenticationChanged(): Promise<void> {
        const browser = this.azure?.authenticationChanged();
        if (this.azure) {
            this.store.update({ azure: this.azure.snapshot });
        }
        await browser;
        if (this.azure && !this.disposed) {
            this.store.update({ azure: this.azure.snapshot });
        }
    }

    private async dispatch(request: WebviewRequest): Promise<void> {
        switch (request.type) {
            case 'ready':
            case 'refresh':
                this.store.setWorkspaceFolders(this.host.workspaceFolders());
                this.store.update({});
                return;
            case 'cancel': {
                this.cancelActive();
                this.store.update({
                    busy: false,
                    progress: null,
                    notice: 'Analysis canceled.',
                });
                return;
            }
            case 'dismissNotice':
                this.store.update({ notice: null, error: null });
                return;
            case 'setPlatform': {
                const platform = this.service.normalizePlatform(request.platform);
                const inferred = inferDataSourceType(this.store.state.storageUrl);
                const dataSourceType = normalizeDataSourceType(
                    this.store.state.dataSourceType,
                    platform,
                );
                const authMethod = normalizeGuidedAuthMethod(
                    this.store.state.authMethod,
                    platform,
                    dataSourceType,
                );
                const storageUrl =
                    inferred && normalizeDataSourceType(inferred, platform) !== inferred
                        ? ''
                        : this.store.state.storageUrl;
                this.store.update({
                    platform,
                    dataSourceType,
                    authMethod,
                    storageUrl,
                    notice:
                        storageUrl !== this.store.state.storageUrl
                            ? 'The storage URL was cleared because the selected SQL platform does not support that source.'
                            : this.store.state.notice,
                });
                this.refreshQuickAnalyze();
                void this.host.setPreference('platform', platform);
                this.regenerate();
                return;
            }
            case 'setTab': {
                if (isStatementKind(request.tab)) {
                    const nextState = {
                        ...this.store.state,
                        activeTab: request.tab,
                        quickAnalyze: {
                            ...this.store.state.quickAnalyze,
                            selectedStatement: request.tab,
                        },
                    };
                    this.store.update({
                        activeTab: request.tab,
                        ...quickAnalyzePatch(nextState, this.rawMetadata, this.folderMetadata),
                    });
                } else {
                    this.store.update({ activeTab: request.tab });
                }
                void this.host.setPreference('activeTab', request.tab);
                return;
            }
            case 'setFileFilter':
                this.store.update({ fileFilter: request.value });
                return;
            case 'selectFile':
                return this.selectFile(request.fileId);
            case 'activateLocalSource':
                return this.showLocalSource();
            case 'openLocalDialog':
                return this.browseLocal();
            case 'openAzureBrowser':
                this.activateAzureSource();
                return this.runAzure(() => this.requireAzure().open());
            case 'azureBrowserConnect':
                return this.runAzure(() => this.requireAzure().connect());
            case 'azureBrowserOpenPublicContainer':
                this.activateAzureSource();
                return this.runAzure(() =>
                    this.requireAzure().openPublicContainer(request.url, request.prefix),
                );
            case 'azureBrowserRefresh':
                return this.runAzure(() => this.requireAzure().refresh());
            case 'azureBrowserDisconnect': {
                const azure = this.requireAzure();
                azure.disconnect();
                this.store.update({ azure: azure.snapshot });
                return;
            }
            case 'azureBrowserClose': {
                const azure = this.requireAzure();
                azure.close();
                this.store.update({ azure: azure.snapshot });
                return;
            }
            case 'azureBrowserRetry':
                return this.runAzure(() => this.requireAzure().retry());
            case 'azureBrowserSelectTenant':
                return this.runAzure(() =>
                    this.requireAzure().selectTenant(request.tenantId),
                );
            case 'azureBrowserSelectSubscription':
                return this.runAzure(() =>
                    this.requireAzure().selectSubscription(request.subscriptionId),
                );
            case 'azureBrowserSelectAccount':
                return this.runAzure(() =>
                    this.requireAzure().selectAccount(request.accountId),
                );
            case 'azureBrowserOpenEntry':
                return this.runAzure(() =>
                    this.requireAzure().openEntry(request.entryId),
                );
            case 'azureBrowserNavigate':
                return this.runAzure(() =>
                    this.requireAzure().navigate(request.depth),
                );
            case 'azureBrowserLoadMore':
                return this.runAzure(() => this.requireAzure().loadMore());
            case 'azureBrowserUseSelectedFile':
                this.useSelectedAzureFile();
                return;
            case 'azureBrowserUseCurrentFolder':
                this.useCurrentAzureFolder();
                return;
            case 'setTableName':
                this.setObjectName(request.fileId, 'tableName', request.value);
                return;
            case 'setSchemaName':
                this.setObjectName(request.fileId, 'schemaName', request.value);
                return;
            case 'setDataSource':
                this.setObjectName(request.fileId, 'dataSource', request.value);
                return;
            case 'setCredentialName':
                this.setObjectName(request.fileId, 'credentialName', request.value);
                return;
            case 'setAuthMethod':
                this.store.update({
                    authMethod:
                        request.value === 'public'
                        && this.store.state.authMethod === 'public'
                            ? 'public'
                            : normalizeGuidedAuthMethod(
                                request.value,
                                this.store.state.platform,
                                this.store.state.dataSourceType,
                            ),
                });
                this.refreshQuickAnalyze();
                this.regenerate();
                return;
            case 'setStorageGoal':
                this.store.update({ storageGoal: request.value });
                this.generateNow();
                return;
            case 'setAzureFolderFormat': {
                const remoteSchema = this.store.state.remoteSchema;
                if (
                    !remoteSchema ||
                    !remoteSchema.formats.includes(request.value)
                ) {
                    this.store.update({
                        error: 'Choose one of the formats detected in this Azure folder.',
                    });
                    return;
                }
                this.store.update({
                    remoteSchema: {
                        ...remoteSchema,
                        status: 'not_analyzed',
                        selectedFormat: request.value,
                        message:
                            'The folder format is selected, but its columns and parser settings have not been analyzed.',
                    },
                    error: null,
                });
                this.generateNow();
                return;
            }
            case 'setStorageUrl': {
                const value = request.value.trim();
                if (!value) {
                    this.store.update({
                        storageUrl: '',
                        azureFolderPreview: null,
                        remoteSchema: null,
                        error: null,
                        notice: 'Known storage URL cleared. Safe placeholders are used instead.',
                    });
                    this.refreshQuickAnalyze();
                    this.generateNow();
                    return;
                }
                const location = knownStorageLocation(value);
                const dataSourceType = normalizeDataSourceType(
                    location.dataSourceType,
                    this.store.state.platform,
                );
                if (dataSourceType !== location.dataSourceType) {
                    this.store.update({
                        error:
                            `${this.store.state.credentialSetup.dataSourceOptions
                                .map((option) => option.label)
                                .join(', ')} are the supported storage services for the selected SQL platform.`,
                    });
                    return;
                }
                const requestedAuth = location.hadSasSignature
                    ? 'sas'
                    : this.store.state.authMethod === 'public'
                        ? null
                        : this.store.state.authMethod;
                const authMethod = normalizeGuidedAuthMethod(
                    requestedAuth,
                    this.store.state.platform,
                    dataSourceType,
                );
                const changedSource = location.storageUrl !== this.store.state.storageUrl;
                const inferredFileType = sqlSourceFileType(location.storageUrl);
                const selectableFormats: readonly FileType[] = [
                    'csv',
                    'text',
                    'json',
                    'parquet',
                    'orc',
                    'rc',
                    'delta',
                    'iceberg',
                ];
                const remoteSchema = this.rawMetadata
                    ? null
                    : inferredFileType && inferredFileType !== 'unknown'
                        ? {
                              status: 'not_analyzed' as const,
                              formats: [inferredFileType],
                              selectedFormat: inferredFileType,
                              message:
                                  'The file format is inferred from the URL, but its columns and parser settings have not been analyzed.',
                          }
                        : {
                              status: 'format_required' as const,
                              formats: selectableFormats,
                              selectedFormat: null,
                              message:
                                  'Choose the file format represented by this URL before goal-specific SQL is generated.',
                          };
                this.store.update({
                    storageUrl: location.storageUrl,
                    sourceKind:
                        dataSourceType === 's3' ? 'public_https' : 'azure',
                    azureFolderPreview: changedSource
                        ? null
                        : this.store.state.azureFolderPreview,
                    remoteSchema:
                        changedSource || !this.store.state.remoteSchema
                            ? remoteSchema
                            : this.store.state.remoteSchema,
                    dataSourceType,
                    authMethod,
                    error: null,
                    notice: location.removedSuffix
                        ? 'Storage location applied. Query parameters and fragments were removed before SQL generation.'
                        : 'Storage location applied to Storage SQL.',
                });
                this.refreshQuickAnalyze();
                this.generateNow();
                return;
            }
            case 'setFormatName':
                this.setObjectName(request.fileId, 'formatName', request.value);
                return;
            case 'setParserOverride': {
                this.currentSettingsFile(request.fileId);
                const value = request.key === 'firstRow'
                    ? Number(request.value)
                    : request.value === '\\t' && request.key === 'fieldDelimiter'
                        ? '\t'
                        : request.value;
                const parserOverrides = validateParserOverrides({
                    ...this.store.state.parserOverrides,
                    [request.key]: value,
                });
                this.changeSettings({ parserOverrides });
                return;
            }
            case 'resetParserOverride': {
                this.currentSettingsFile(request.fileId);
                const parserOverrides = { ...this.store.state.parserOverrides };
                delete parserOverrides[request.key];
                this.changeSettings({ parserOverrides }, true);
                return;
            }
            case 'setColumnOverride': {
                this.currentSettingsFile(request.fileId);
                const column = validateColumnName(request.column);
                if (!this.rawMetadata?.schema?.some(([name]) => name === column)) {
                    throw new SettingsValidationError('That column is not in the selected file. Analyze the file again to refresh its schema.');
                }
                const overrides = { ...this.store.state.columnOverrides };
                if (request.sqlType.trim() === '') {
                    delete overrides[column];
                } else {
                    overrides[column] = validatedSqlType(request.sqlType);
                }
                this.changeSettings({ columnOverrides: overrides });
                return;
            }
            case 'clearColumnOverrides':
                this.currentSettingsFile(request.fileId);
                this.changeSettings({ columnOverrides: {} }, true);
                return;
            case 'resetFileSettings':
                this.currentSettingsFile(request.fileId);
                this.changeSettings({
                    ...DEFAULT_FILE_SETTINGS,
                    tableName: this.defaultTableName(),
                }, true, 'Settings reset. The selected file and detected facts have not changed. Undo restores your previous settings.');
                return;
            case 'undoFileSettings': {
                const file = this.currentSettingsFile(request.fileId);
                const previous = this.store.undoSettings(file);
                if (!previous) {
                    throw new SettingsValidationError('There is no settings change to undo for this file.');
                }
                const matched = this.matchingSettings(previous, this.rawMetadata);
                this.changeSettings(matched.settings, true, this.missingColumnsNotice(matched.missing) ?? 'Previous file settings restored.', false);
                return;
            }
            case 'saveImportProfile':
                return this.saveImportProfile(request.fileId, request.name);
            case 'applyImportProfile':
                this.applyImportProfile(request.fileId, request.name);
                return;
            case 'deleteImportProfile':
                return this.deleteImportProfile(request.name);
            case 'setPreviewRows': {
                const rows = Math.max(
                    MIN_PREVIEW_ROWS,
                    Math.min(request.rows, MAX_PREVIEW_ROWS),
                );
                this.store.update({ previewRows: rows });
                return this.refreshPreview();
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
            default: {
                // Exhaustiveness: adding a request type without a case is a
                // compile error rather than a silently ignored message.
                const exhaustive: never = request;
                void exhaustive;
                return;
            }
        }
    }

    // -- local settings and explicitly saved profiles ------------------------

    private currentSettingsFile(fileId: string): RegisteredFile {
        const file = this.store.selected;
        if (
            this.store.state.sourceMode !== 'local' || !file
            || file.id !== fileId || !file.settingsIdentity
        ) {
            throw new SettingsValidationError('Those settings belong to a different or unavailable file. Select the file again.');
        }
        return file;
    }

    private setObjectName(fileId: string | null, key: ObjectNameKey, value: string): void {
        if (fileId !== null) {
            this.currentSettingsFile(fileId);
        } else if (this.store.state.selectedFileId !== null) {
            throw new SettingsValidationError('Those object names are not for the selected file.');
        }
        this.changeSettings({ [key]: settingName(value) });
    }

    private changeSettings(
        patch: Partial<FileSettings>,
        replace = false,
        notice?: string,
        rememberUndo = true,
    ): void {
        const settings = validateFileSettings({ ...fileSettingsFrom(this.store.state), ...patch });
        const file = this.store.selected;
        if (file) {
            this.store.rememberSettings(file, settings, rememberUndo);
        }
        this.store.update({
            ...settings,
            canUndoSettings: !!file && this.store.canUndoSettings(file),
            settingsRevision: this.store.state.settingsRevision + (replace ? 1 : 0),
            error: null,
            notice: notice ?? this.store.state.notice,
        });
        this.refreshQuickAnalyze();
        if (replace) {
            this.generateNow();
        } else {
            this.regenerate();
        }
    }

    private defaultTableName(metadata: GeneratorMetadata | null = this.rawMetadata): string {
        return metadata
            ? this.service.resolveTableName(metadata, null).slice(0, MAX_SETTING_NAME_LENGTH)
            : '';
    }

    private matchingSettings(
        settings: FileSettings,
        metadata: FileMetadata | null,
    ): { settings: FileSettings; missing: string[] } {
        if (!metadata || metadata.analysis_stage === 'provisional') {
            return { settings, missing: [] };
        }
        const columns = new Set((metadata.schema ?? []).map(([name]) => name));
        const missing = Object.keys(settings.columnOverrides).filter((name) => !columns.has(name));
        return {
            settings: {
                ...settings,
                columnOverrides: Object.fromEntries(
                    Object.entries(settings.columnOverrides).filter(([name]) => columns.has(name)),
                ),
            },
            missing,
        };
    }

    private missingColumnsNotice(missing: readonly string[]): string | null {
        if (missing.length === 0) {
            return null;
        }
        const rest = missing.length > 8 ? ` and ${missing.length - 8} more` : '';
        return `Skipped SQL type overrides for columns not in this file: ${missing.slice(0, 8).join(', ')}${rest}. Other settings were kept.`;
    }

    private loadImportProfiles(): void {
        try {
            const stored = this.host.getPreference<unknown>(IMPORT_PROFILES_PREFERENCE, []);
            this.profiles = validateImportProfiles(stored);
            this.store.update({ importProfiles: this.profiles.map((profile) => profile.name) });
        } catch {
            // A corrupt preference is untrusted data, including its error text.
            const warning = 'Saved import profiles could not be loaded because they are invalid, unsupported, or too large. No saved data was changed.';
            this.host.log(warning);
            this.host.showWarning(warning);
            this.store.update({ notice: warning });
        }
    }

    private saveImportProfile(fileId: string, name: string): Promise<void> {
        this.currentSettingsFile(fileId);
        // Capture before any await: another surface may select a different file.
        const profile = validateImportProfile({
            version: 1,
            name,
            ...fileSettingsFrom(this.store.state),
        });
        return this.profileQueue(async () => {
            const existing = this.profiles.find((entry) => entry.name === profile.name);
            const profiles = existing
                ? this.profiles.map((entry) => entry.name === profile.name ? profile : entry)
                : [...this.profiles, profile];
            await this.persistImportProfiles(profiles, 'Import profile saved. Only object names and parser and SQL type overrides were saved.');
        });
    }

    private applyImportProfile(fileId: string, name: string): void {
        this.currentSettingsFile(fileId);
        const profile = this.profiles.find((entry) => entry.name === name);
        if (!profile) {
            throw new SettingsValidationError('That import profile is no longer available.');
        }
        if (!this.rawMetadata || this.rawMetadata.analysis_stage === 'provisional') {
            throw new SettingsValidationError('Wait for file analysis to finish before applying an import profile.');
        }
        const matched = this.matchingSettings(fileSettingsFrom(profile), this.rawMetadata);
        this.changeSettings(matched.settings, true, this.missingColumnsNotice(matched.missing)
            ?? 'Import profile applied. The target platform, source, and SQL runtime access have not changed.');
    }

    private deleteImportProfile(name: string): Promise<void> {
        const validatedName = settingName(name, MAX_PROFILE_NAME_LENGTH, false);
        return this.profileQueue(async () => {
            if (!this.profiles.some((entry) => entry.name === validatedName)) {
                throw new SettingsValidationError('That import profile is no longer available.');
            }
            await this.persistImportProfiles(
                this.profiles.filter((entry) => entry.name !== validatedName),
                'Import profile deleted. Current file settings have not changed.',
            );
        });
    }

    private async persistImportProfiles(value: readonly ImportProfile[], notice: string): Promise<void> {
        const profiles = validateImportProfiles(value);
        try {
            await this.host.setPreference(IMPORT_PROFILES_PREFERENCE, profiles);
        } catch {
            throw new SettingsValidationError('Import profiles could not be saved. The previous saved profiles are unchanged; try again.');
        }
        if (!this.disposed) {
            this.profiles = profiles;
            this.store.update({ importProfiles: profiles.map((profile) => profile.name), notice, error: null });
        }
    }

    // -- cancellation / staleness -------------------------------------------

    private begin(): AnalysisOperation {
        this.cancelActive();
        const token = new SimpleCancellationTokenSource();
        this.tokenSource = token;
        return { token, generation: this.generation };
    }

    private cancelActive(): void {
        this.generation += 1;
        this.tokenSource?.cancel();
        this.tokenSource = undefined;
        this.azure?.cancel();
        if (this.store.state.busy) {
            this.store.update({ busy: false, progress: null });
        }
    }

    private requireAzure(): AzureBrowser {
        if (!this.azure) {
            throw new Error('Azure browsing is unavailable in this host.');
        }
        return this.azure;
    }

    private async runAzure(operation: () => Promise<unknown>): Promise<void> {
        const pending = operation();
        const azure = this.requireAzure();
        this.store.update({ azure: azure.snapshot, error: null });
        await pending;
        this.store.update({ azure: azure.snapshot });
    }

    private useSelectedAzureFile(): void {
        const azure = this.requireAzure();
        const selection = azure.selectedLocation();
        if (!selection) {
            this.store.update({ azure: azure.snapshot, error: 'Select a file from a successful Azure listing first.' });
            return;
        }
        this.activateAzureSource();
        const location = knownStorageLocation(selection.url);
        const dataSourceType = normalizeDataSourceType(
            location.dataSourceType,
            this.store.state.platform,
        );
        if (dataSourceType !== location.dataSourceType) {
            this.store.update({
                azure: azure.snapshot,
                error:
                    'The selected Azure storage type is not supported by the current SQL platform. Choose another source or change the target platform.',
            });
            return;
        }
        const authMethod = selection.access === 'public' ? 'public' : normalizeGuidedAuthMethod(
            this.store.state.authMethod === 'public'
                ? null
                : this.store.state.authMethod,
            this.store.state.platform,
            dataSourceType,
        );
        const fileType = sqlSourceFileType(location.storageUrl) ?? 'unknown';
        azure.close();
        this.store.update({
            azure: azure.snapshot,
            activeTab: 'credential_setup',
            sourceKind: 'azure',
            storageUrl: location.storageUrl,
            azureFolderPreview: null,
            remoteSchema: {
                status: fileType === 'unknown' ? 'format_required' : 'not_analyzed',
                formats: fileType === 'unknown' ? [] : [fileType],
                selectedFormat: fileType === 'unknown' ? null : fileType,
                message: fileType === 'unknown'
                    ? 'The selected file type is unknown, so goal-specific SQL cannot be generated safely.'
                    : 'The Azure file location is selected, but its columns and parser settings have not been analyzed.',
            },
            dataSourceType,
            authMethod,
            error: null,
            notice:
                selection.access === 'public'
                    ? 'Public Azure file location selected. SQL runtime access is Public (no credential); remote bytes were not downloaded or analyzed.'
                    : 'Azure file location selected. Configure SQL credentials for this URL; remote bytes were not downloaded or analyzed.',
        });
        this.refreshQuickAnalyze();
        this.generateNow();
    }

    private useCurrentAzureFolder(): void {
        const azure = this.requireAzure();
        const selection = azure.currentFolderLocation();
        if (!selection) {
            this.store.update({ azure: azure.snapshot, error: 'Open a folder from a successful Azure listing first.' });
            return;
        }
        const snapshot = azure.snapshot;
        this.activateAzureSource();
        const location = knownStorageLocation(selection.url);
        const dataSourceType = normalizeDataSourceType(
            location.dataSourceType,
            this.store.state.platform,
        );
        if (dataSourceType !== location.dataSourceType) {
            this.store.update({
                azure: azure.snapshot,
                error:
                    'The selected Azure storage type is not supported by the current SQL platform. Choose another source or change the target platform.',
            });
            return;
        }
        const authMethod = selection.access === 'public' ? 'public' : normalizeGuidedAuthMethod(
            this.store.state.authMethod === 'public'
                ? null
                : this.store.state.authMethod,
            this.store.state.platform,
            dataSourceType,
        );
        const label = snapshot.path.join('/');
        const formats = [...new Set(
            snapshot.entries
                .filter((entry) => entry.kind === 'file')
                .map((entry) => sqlSourceFileType(entry.name))
                .filter(
                    (format): format is FileType =>
                        format !== undefined && format !== 'unknown',
                ),
        )].sort();
        const selectedFormat = formats.length === 1 ? formats[0]! : null;
        azure.close();
        this.rawMetadata = null;
        this.folderMetadata = [];
        this.store.setFiles([]);
        this.store.update({
            azure: azure.snapshot,
            activeTab: 'credential_setup',
            fileFilter: '',
            selectedFileId: null,
            sourceLabel: label,
            metadata: null,
            preview: null,
            statements: null,
            sourceKind: 'azure',
            storageUrl: location.storageUrl,
            dataSourceType,
            authMethod,
            parserOverrides: {},
            folderProfile: null,
            azureFolderPreview: {
                label,
                url: location.storageUrl,
                items: snapshot.entries.map((entry) => ({
                    kind: entry.kind === 'file' ? 'file' : 'folder',
                    name: entry.name,
                    format: entry.format,
                    sizeBytes: entry.sizeBytes,
                    modifiedAt: entry.modifiedAt,
                })),
                truncated: snapshot.hasMore,
            },
            remoteSchema: {
                status: selectedFormat ? 'not_analyzed' : 'format_required',
                formats,
                selectedFormat,
                message: selectedFormat
                    ? 'The Azure folder format is known, but its columns and parser settings have not been analyzed.'
                    : formats.length > 1
                        ? 'This folder contains multiple file formats. Choose the format to target before SQL is generated.'
                        : 'No supported file format was detected in this folder. Choose a file or a folder containing supported files.',
            },
            error: null,
            notice:
                selection.access === 'public'
                    ? 'Public Azure folder location selected. SQL runtime access is Public (no credential); Preview contains listing metadata only, not remote file bytes.'
                    : 'Azure folder location selected. Configure SQL credentials for this URL; browse metadata remains available in Preview.',
        });
        this.refreshQuickAnalyze();
        this.generateNow();
    }

    /** True when *generation* is still the newest request. */
    private isCurrent(generation: number): boolean {
        return !this.disposed && generation === this.generation;
    }

    // -- file selection ------------------------------------------------------

    private async showLocalSource(): Promise<void> {
        this.cancelActive();
        this.activateLocalSource();
        if (!this.store.state.sourceLabel && this.store.state.files.length === 0) {
            await this.browseLocal();
        }
    }

    private async browseLocal(): Promise<void> {
        this.cancelActive();
        this.activateLocalSource();
        const generation = this.generation;
        const picked = await this.host.showOpenDialog({
            files: true,
            folders: true,
            many: true,
            title: 'Select data files or a folder to analyze',
        });
        if (!this.isCurrent(generation) || !picked || picked.length === 0) {
            return;
        }
        const folders = picked.filter((item) => item.isDirectory);
        if (folders.length > 0) {
            if (picked.length !== 1) {
                this.store.update({
                    error: 'Select one folder or one or more files, not both.',
                });
                return;
            }
            await this.loadDirectory(folders[0].path);
            return;
        }
        await this.loadFiles(picked.map((item) => item.path));
    }

    /**
     * Analyse the selected directory and its immediate child folders.
     *
     * The directory itself becomes the allowed root, so nothing outside the
     * folder the user chose can be read even if it is linked into it.
     */
    async loadDirectory(directory: string): Promise<void> {
        this.activateLocalSource();
        this.folderMetadata = [];
        this.rawMetadata = null;
        this.store.setFiles([]);
        this.store.clearSelection();
        const selectedLabel = localLocationLabel(
            directory,
            this.host.workspaceFolders(),
        );
        const state = this.store.state;
        this.store.update({
            sourceLabel: selectedLabel,
            locationLabel: selectedLabel,
            sourceKind: 'local',
            fileFilter: '',
            storageUrl: '',
            azureFolderPreview: null,
            remoteSchema: null,
            authMethod:
                state.authMethod === 'public'
                    ? normalizeGuidedAuthMethod(
                          null,
                          state.platform,
                          state.dataSourceType,
                      )
                    : state.authMethod,
            parserOverrides: {},
            folderProfile: null,
        });
        this.refreshQuickAnalyze();
        const { token, generation } = this.begin();
        this.store.update({ busy: true, progress: 'Scanning folder…', error: null });
        try {
            const result = await this.service.analyzeDirectory({
                filePath: directory,
                allowedRoot: directory,
                maxDepth: DIRECTORY_SCAN_MAX_DEPTH,
                maxFiles: DIRECTORY_SCAN_MAX_FILES,
                maxDirectories: DIRECTORY_SCAN_MAX_DIRECTORIES,
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
            const label = localLocationLabel(result.root, this.host.workspaceFolders());
            this.store.update({
                busy: false,
                progress: null,
                sourceLabel: label,
                notice:
                    result.files.length === 0
                        ? 'No supported data files were found in that folder.'
                        : result.truncated
                        ? `Showing ${result.files.length} data files. This folder is larger than one scan covers, so part of it was not listed.`
                        : null,
            });
            this.refreshQuickAnalyze();
            const first = this.store.state.files[0];
            if (first) {
                await this.selectFile(first.id);
            } else {
                this.store.clearSelection();
                this.generateNow();
            }
        } catch (error) {
            this.failIfCurrent(generation, error);
        }
    }

    /** Analyse one or more explicitly chosen files. */
    async loadFiles(paths: readonly string[]): Promise<void> {
        this.activateLocalSource();
        this.cancelActive();
        this.folderMetadata = [];
        const supportedPaths = paths.filter(isSqlSourceFile);
        const skipped = paths.length - supportedPaths.length;
        if (supportedPaths.length === 0) {
            this.rawMetadata = null;
            this.store.setFiles([]);
            this.store.clearSelection();
            this.generateNow();
            this.store.update({
                busy: false,
                progress: null,
                fileFilter: '',
                error:
                    'No SQL-readable data file was selected. Use CSV, TSV, DAT, JSON, ' +
                    'Parquet, ORC, RCFile, Delta, Iceberg, or a folder containing them.',
            });
            return;
        }
        const entries = supportedPaths.map((absolute) => {
            const fileType = sqlSourceFileType(absolute) ?? 'unknown';
            return {
                absolutePath: absolute,
                // A chosen file is confined to its own directory, matching the
                // native core's implied-root rule.
                allowedRoot: path.dirname(path.resolve(absolute)),
                fileType,
                sizeBytes: 0,
                nativeSupport: NATIVE_SUPPORT_BY_TYPE[fileType],
                isDirectory: false,
            };
        });
        this.rawMetadata = null;
        this.store.clearSelection();
        this.store.setFiles(entries);
        const first = this.store.state.files[0];
        const label = localLocationLabel(
            supportedPaths[0],
            this.host.workspaceFolders(),
        );
        const parents = new Set(
            supportedPaths.map((item) => path.dirname(path.resolve(item))),
        );
        const sharedFolder = parents.size === 1
            ? localLocationLabel(
                  path.dirname(path.resolve(supportedPaths[0])),
                  this.host.workspaceFolders(),
              )
            : null;
        const state = this.store.state;
        this.store.update({
            sourceLabel:
                supportedPaths.length === 1
                    ? label
                    : sharedFolder
                        ? `${sharedFolder} (${supportedPaths.length} files)`
                        : `${supportedPaths.length} selected files`,
            locationLabel: label,
            sourceKind: 'local',
                    fileFilter: '',
            storageUrl: '',
            azureFolderPreview: null,
            remoteSchema: null,
            authMethod:
                state.authMethod === 'public'
                    ? normalizeGuidedAuthMethod(
                          null,
                          state.platform,
                          state.dataSourceType,
                      )
                    : state.authMethod,
            parserOverrides: {},
            folderProfile: null,
            error: null,
            notice: null,
        });
        this.refreshQuickAnalyze();
        const selecting = first ? this.selectFile(first.id) : undefined;
        const selectionGeneration = this.generation;
        await selecting;
        if (skipped > 0 && this.isCurrent(selectionGeneration)) {
            this.store.update({
                notice:
                    `${skipped} unsupported ${skipped === 1 ? 'file was' : 'files were'} skipped.`,
            });
        }
    }

    private async selectFile(fileId: string): Promise<void> {
        if (!this.store.lookup(fileId)) {
            // A stale id from a previous listing. Say so rather than guessing.
            this.store.update({ error: 'That file is no longer in the list. Refresh and try again.' });
            return;
        }
        const operation = this.begin();
        this.activateLocalSource();
        const previousFile = this.store.selected;
        try {
            const file = await this.store.identifyFile(fileId);
            if (!this.isCurrent(operation.generation)) {
                return;
            }
            if (!file) {
                throw new Error('That file is no longer in the list. Refresh and try again.');
            }
            const changed = this.store.state.selectedFileId !== fileId
                || previousFile?.settingsIdentity !== file.settingsIdentity;
            const settings = changed
                ? this.store.settingsFor(file, {
                      ...DEFAULT_FILE_SETTINGS,
                      tableName: this.defaultTableName({ file_path: file.absolutePath }),
                  })
                : fileSettingsFrom(this.store.state);
            this.store.rememberSettings(file, settings, false);
            if (changed) {
                this.rawMetadata = null;
            }
            this.store.update({
                ...settings,
                selectedFileId: fileId,
                locationLabel: localLocationLabel(file.absolutePath, this.host.workspaceFolders()),
                activeTab: 'preview',
                metadata: changed ? null : this.store.state.metadata,
                preview: changed ? null : this.store.state.preview,
                statements: changed ? null : this.store.state.statements,
                recommendedSqlTypes: changed ? {} : this.store.state.recommendedSqlTypes,
                limitation: changed ? null : this.store.state.limitation,
                lastAnalysisMs: changed ? null : this.store.state.lastAnalysisMs,
                canUndoSettings: this.store.canUndoSettings(file),
                settingsRevision: this.store.state.settingsRevision + (changed ? 1 : 0),
                error: null,
                notice: null,
            });
            this.refreshQuickAnalyze();
            void this.host.setPreference('activeTab', 'preview');
            await this.analyzeSelected(file, operation);
        } catch (error) {
            this.failIfCurrent(operation.generation, error);
        }
    }

    private activateLocalSource(): void {
        const azure = this.azure;
        if (azure) {
            azure.disconnect();
            azure.close();
        }
        const snapshot = this.localSourceSnapshot;
        this.localSourceSnapshot = undefined;
        if (snapshot) {
            this.rawMetadata = snapshot.rawMetadata;
            this.folderMetadata = snapshot.folderMetadata;
            this.store.restoreFiles(snapshot.files);
            const inferred = inferDataSourceType(snapshot.state.storageUrl);
            const storageUrl =
                inferred
                && normalizeDataSourceType(inferred, this.store.state.platform) !== inferred
                    ? ''
                    : snapshot.state.storageUrl;
            this.store.update({
                ...snapshot.state,
                ...(azure ? { azure: azure.snapshot } : {}),
                sourceMode: 'local',
                activeTab: 'preview',
                storageUrl,
                azureFolderPreview: storageUrl ? snapshot.state.azureFolderPreview : null,
                remoteSchema: storageUrl ? snapshot.state.remoteSchema : null,
                sourceKind: storageUrl ? snapshot.state.sourceKind : 'local',
                statements: null,
                busy: false,
                progress: null,
                error: null,
                notice: null,
                settingsRevision: this.store.state.settingsRevision + 1,
            });
            void this.host.setPreference('activeTab', 'preview');
            this.refreshQuickAnalyze();
            this.generateNow();
            return;
        }
        if (this.store.state.files.length === 0) {
            this.rawMetadata = null;
            this.folderMetadata = [];
            this.store.clearSelection();
        }
        const state = this.store.state;
        this.store.update({
            ...(azure ? { azure: azure.snapshot } : {}),
            sourceMode: 'local',
            activeTab: 'preview',
            sourceKind: 'local',
            storageUrl: '',
            azureFolderPreview: null,
            remoteSchema: null,
            authMethod:
                state.authMethod === 'public'
                    ? normalizeGuidedAuthMethod(
                          null,
                          state.platform,
                          state.dataSourceType,
                      )
                    : state.authMethod,
            error: null,
            notice: null,
        });
        void this.host.setPreference('activeTab', 'preview');
        this.refreshQuickAnalyze();
        this.generateNow();
    }

    private activateAzureSource(): void {
        if (this.store.state.sourceMode === 'azure') {
            return;
        }
        const state = this.store.state;
        this.localSourceSnapshot = {
            files: this.store.snapshotFiles(),
            state: {
                fileFilter: state.fileFilter,
                selectedFileId: state.selectedFileId,
                sourceLabel: state.sourceLabel,
                locationLabel: state.locationLabel,
                metadata: state.metadata,
                preview: state.preview,
                tableName: state.tableName,
                schemaName: state.schemaName,
                dataSource: state.dataSource,
                dataSourceType: state.dataSourceType,
                credentialName: state.credentialName,
                authMethod: state.authMethod,
                storageGoal: state.storageGoal,
                storageUrl: state.storageUrl,
                azureFolderPreview: state.azureFolderPreview,
                remoteSchema: state.remoteSchema,
                formatName: state.formatName,
                parserOverrides: state.parserOverrides,
                sourceKind: state.sourceKind,
                folderProfile: state.folderProfile,
                columnOverrides: state.columnOverrides,
                canUndoSettings: state.canUndoSettings,
                recommendedSqlTypes: state.recommendedSqlTypes,
                limitation: state.limitation,
                lastAnalysisMs: state.lastAnalysisMs,
            },
            rawMetadata: this.rawMetadata,
            folderMetadata: this.folderMetadata,
        };
        this.cancelActive();
        this.rawMetadata = null;
        this.folderMetadata = [];
        this.store.setFiles([]);
        this.store.clearSelection();
        this.store.update({
            sourceMode: 'azure',
            activeTab: 'preview',
            fileFilter: '',
            sourceKind: 'azure',
            storageUrl: '',
            azureFolderPreview: null,
            remoteSchema: null,
            ...DEFAULT_FILE_SETTINGS,
            canUndoSettings: false,
            settingsRevision: this.store.state.settingsRevision + 1,
            recommendedSqlTypes: {},
            busy: false,
            progress: null,
            error: null,
            notice: null,
        });
    }

    private async analyzeSelected(
        file: RegisteredFile,
        operation = this.begin(),
    ): Promise<void> {
        const { token, generation } = operation;
        const started = this.host.now();
        const current = (): boolean =>
            this.isCurrent(generation)
            && this.store.state.selectedFileId === file.id
            && this.store.state.sourceMode === 'local';
        this.store.update({
            busy: true,
            progress: `Analyzing ${file.entry.label}…`,
            error: null,
            preview: null,
        });
        try {
            const result = await this.service.analyzeProgressively({
                filePath: file.absolutePath,
                allowedRoot: file.allowedRoot,
                token: token.token,
                maxRows: this.store.state.previewRows,
                progress: {
                    report: ({ message }) => {
                        if (current() && message) {
                            this.store.update({
                                progress: this.rawMetadata?.analysis_stage === 'provisional'
                                    ? `Sample preview — analyzing file… ${message}`
                                    : message,
                            });
                        }
                    },
                },
                onPreview: (sample) => {
                    if (!current()) {
                        return;
                    }
                    this.rawMetadata = sample.metadata;
                    this.applyMetadata(sample.metadata, this.host.now() - started, false, sample.preview);
                    this.store.update({ progress: 'Sample preview — analyzing file…' });
                    if (sample.preview.error) {
                        this.host.log(`Sample preview: ${redact(sample.preview.error)}`);
                    }
                    if (!this.firstAnalysisLogged) {
                        this.host.log(`First native sample preview published in ${Math.round(this.host.now() - started)} ms.`);
                    }
                },
            });
            if (!current()) {
                return;
            }
            this.rawMetadata = result.metadata;
            const elapsedMs = this.host.now() - started;
            this.applyMetadata(
                result.metadata, elapsedMs, true,
                supportsPreview(result.metadata) ? result.preview : null,
            );
            if (!this.firstAnalysisLogged) {
                this.firstAnalysisLogged = true;
                this.host.log(`First native analysis completed in ${Math.round(elapsedMs)} ms.`);
            }

            this.store.update({ busy: false, progress: null });
        } catch (error) {
            this.failIfCurrent(generation, error);
        }
    }

    private async refreshPreview(): Promise<void> {
        const file = this.store.selected;
        const metadata = this.rawMetadata;
        if (!file || (metadata && !supportsPreview(metadata))) {
            return;
        }
        if (!metadata && !['csv', 'json', 'text'].includes(file.entry.fileType)) {
            await this.analyzeSelected(file);
            return;
        }
        const { token, generation } = this.begin();
        this.store.update({ busy: true, progress: 'Reading preview rows…' });
        try {
            const request = {
                filePath: file.absolutePath,
                allowedRoot: file.allowedRoot,
                maxRows: this.store.state.previewRows,
                token: token.token,
            };
            let sample: AnalysisPreview | undefined;
            let preview: PreviewResult;
            if (!metadata || metadata.analysis_stage === 'provisional') {
                sample = await this.service.samplePreview(request);
                preview = sample.preview;
            } else {
                preview = await this.service.previewAnalyzed({ ...request, metadata });
            }
            if (!this.isCurrent(generation) || this.store.state.selectedFileId !== file.id) {
                return;
            }
            if (sample) {
                this.rawMetadata = sample.metadata;
                this.applyMetadata(sample.metadata, 0, false, preview);
            }
            this.store.update({
                preview,
                busy: false,
                progress: null,
                error: preview.error ? redact(preview.error) : null,
                notice: sample
                    ? 'Sample preview only — analysis incomplete. Select the file again to finish analysis.'
                    : this.store.state.notice,
            });
        } catch (error) {
            this.failIfCurrent(generation, error);
        }
    }

    private failIfCurrent(generation: number, error: unknown): void {
        if (error instanceof CancellationError || !this.isCurrent(generation)) {
            return;
        }
        const message = redact(describeError(error));
        this.host.log(`Analysis failed: ${message}`);
        if (error instanceof FileChangedError && this.rawMetadata?.analysis_stage !== 'provisional') {
            this.rawMetadata = null;
            this.store.update({ metadata: null, preview: null, statements: null });
        }
        this.store.update({ busy: false, progress: null, error: message });
    }

    // -- generation ----------------------------------------------------------

    private applyMetadata(
        metadata: FileMetadata,
        elapsedMs: number,
        authoritative = true,
        preview?: PreviewResult | null,
    ): void {
        const display = metadataForDisplay(metadata, this.host.workspaceFolders());
        const state = this.store.state;
        const matched = authoritative
            ? this.matchingSettings(fileSettingsFrom(state), metadata)
            : { settings: fileSettingsFrom(state), missing: [] };
        const settings = matched.settings;
        const file = this.store.selected;
        if (file) {
            this.store.rememberSettings(file, settings, false);
        }
        this.store.update({
            ...settings,
            metadata: display,
            ...(preview !== undefined ? { preview } : {}),
            recommendedSqlTypes: recommendedSqlTypes(metadata),
            limitation: limitationFor(metadata),
            canUndoSettings: !!file && this.store.canUndoSettings(file),
            settingsRevision: state.settingsRevision + (matched.missing.length > 0 ? 1 : 0),
            notice: this.missingColumnsNotice(matched.missing) ?? state.notice,
            authMethod: state.authMethod,
            lastAnalysisMs: authoritative ? Math.max(0, Math.round(elapsedMs)) : null,
            error: metadata.error || preview?.error
                ? redact(metadata.error || preview?.error || '')
                : null,
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
        this.store.update(patch);
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
        if (this.disposed) {
            return;
        }
        const state = this.store.state;
        if (!this.rawMetadata) {
            if (state.remoteSchema?.status === 'format_required') {
                this.store.update({ statements: null });
                return;
            }
            const storageUrl = effectiveStorageUrl(
                state.platform,
                state.dataSourceType,
                state.storageUrl || null,
                '<file>',
            );
            const remoteMetadata = this.remoteSetupMetadata();
            const credentialSetup = generateCredentialSetup({
                dataSource: state.dataSource || 'MyDataSource',
                credentialName: state.credentialName || null,
                authMethod: state.authMethod || null,
                targetPlatform: state.platform,
                storageUrl,
                metadata: remoteMetadata,
                storageGoal: state.storageGoal,
            });
            const goalSql = remoteMetadata
                ? this.storageGoalSql(remoteMetadata, credentialSetup)
                : credentialSetup;
            this.store.update({
                statements: {
                    credential_setup: goalSql,
                },
            });
            return;
        }
        const generated = this.service.generateStatements({
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
            dataSourceType: state.dataSourceType,
            formatName: state.formatName || null,
            parserOverrides:
                Object.keys(state.parserOverrides).length > 0
                    ? { ...state.parserOverrides }
                    : undefined,
        });
        const credentialSetup = generateCredentialSetup({
            dataSource: state.dataSource || 'MyDataSource',
            credentialName: state.credentialName || null,
            authMethod: state.authMethod || null,
            targetPlatform: state.platform,
            storageUrl: effectiveStorageUrl(
                state.platform,
                state.dataSourceType,
                state.storageUrl || null,
                this.rawMetadata.file_name,
            ),
            metadata: this.rawMetadata,
            storageGoal: state.storageGoal,
        });
        const statements: GeneratedStatements = {
            ...generated,
            credential_setup: markProvisionalSql(state.storageUrl
                ? this.storageGoalSql(this.rawMetadata, credentialSetup, true)
                : credentialSetup, this.rawMetadata),
        };
        this.store.update({ statements });
    }

    private remoteSetupMetadata(): GeneratorMetadata | null {
        const state = this.store.state;
        if (state.sourceKind === 'local' || !state.storageUrl) {
            return null;
        }
        const selected = state.azure.entries.find(
            (entry) => entry.id === state.azure.selectedEntryId && entry.kind === 'file',
        );
        const folderFiles = state.azureFolderPreview?.items.filter(
            (entry) => entry.kind === 'file',
        ) ?? [];
        const names = selected ? [selected.name] : folderFiles.map((entry) => entry.name);
        const detectedTypes = names
            .map((name) => sqlSourceFileType(name))
            .filter(
                (detected): detected is FileType =>
                    detected !== undefined && detected !== 'unknown',
            );
        const requestedFormat = state.remoteSchema?.selectedFormat;
        const fileType = requestedFormat
            ? requestedFormat as FileType
            : detectedTypes[0];
        if (!fileType) {
            return null;
        }
        const extension = fileType === 'text' ? 'txt' : fileType;
        const fileName = selected?.name ?? `<file-name>.${extension}`;
        return {
            file_path: fileName,
            file_name: fileName,
            file_type: fileType,
            schema: [['replace_with_actual_column', 'string']],
            delimiter: ',',
            encoding: 'utf-8',
            codepage: '65001',
            has_header: true,
        };
    }

    private storageGoalSql(
        metadata: GeneratorMetadata,
        credentialSetup: string,
        schemaAnalyzed = false,
    ): string {
        const state = this.store.state;
        const configuredMetadata: GeneratorMetadata = {
            ...metadata,
            sql_type_overrides: { ...state.columnOverrides },
            parser_overrides: { ...state.parserOverrides },
        };
        const dataSource = state.dataSource || 'MyDataSource';
        const isFolder = state.azureFolderPreview !== null;
        const extension = metadata.file_type === 'text'
            ? 'txt'
            : String(metadata.file_type || 'csv');
        const folderRoot = state.storageUrl.endsWith('/')
            ? state.storageUrl
            : `${state.storageUrl}/`;
        const operationStorageUrl = isFolder
            ? state.storageGoal === 'openrowset'
                ? `${folderRoot}**/*.${extension}`
                : state.storageGoal === 'bulk_insert'
                    ? `${folderRoot}<file-name>.${extension}`
                    : state.storageUrl
            : state.storageUrl;
        const shared = {
            tableName: state.tableName || null,
            schemaName: state.schemaName || 'dbo',
            dataSource,
            targetPlatform: state.platform,
            storageUrl: operationStorageUrl,
        };
        const selectionNote = schemaAnalyzed
            ? [
                  '-- SELECTED REMOTE SOURCE',
                  `-- File: ${state.storageUrl}`,
                  '-- Schema and parser settings come from the analyzed local file.',
              ].join('\n')
            : [
                  '-- ====================================================================',
                  '-- TEMPLATE ONLY - REMOTE SCHEMA NOT ANALYZED',
                  '-- DO NOT EXECUTE UNTIL THE PLACEHOLDER SCHEMA IS REPLACED',
                  '-- ====================================================================',
                  '-- SELECTED REMOTE SOURCE',
                  `-- ${isFolder ? 'Folder' : 'File'}: ${state.storageUrl}`,
                  '-- File contents were not downloaded or inspected.',
                  '-- Replace [replace_with_actual_column] with the real column definitions',
                  '-- and confirm delimiter, header, encoding, and format settings.',
              ].join('\n');

        let operation: string;
        if (state.storageGoal === 'bulk_insert') {
            operation = generateBulkInsert(configuredMetadata, {
                ...shared,
                includePrereq: false,
                credentialName: state.credentialName || null,
                authMethod: state.authMethod || null,
            });
        } else if (state.storageGoal === 'openrowset') {
            operation = generateOpenrowset(configuredMetadata, shared);
        } else {
            operation = [
                generateExternalFileFormat(configuredMetadata, {
                    formatName: state.formatName || null,
                    targetPlatform: state.platform,
                }),
                generateExternalTable(configuredMetadata, {
                    ...shared,
                    fileFormat: state.formatName || null,
                }),
            ].join('\n\n');
        }
        return [selectionNote, credentialSetup, operation]
            .filter((part) => part.trim().length > 0)
            .join('\n\n');
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
            dataSourceType: state.dataSourceType,
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
        this.store.update({
            notice:
                kind === 'credential_setup'
                    ? 'Opened the generated script as a SQL document for the MSSQL extension.'
                    : 'Opened the statement in a SQL editor.',
        });
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
        const entries: Array<{ metadata: FileMetadata; file: RegisteredFile }> = [];
        const budget = Math.min(files.length, MAX_EXPORT_FILES);
        this.store.update({ busy: true, progress: 'Preparing export…', error: null });
        try {
            for (let index = 0; index < budget; index += 1) {
                const registered = await this.store.identifyFile(files[index].id);
                if (!this.isCurrent(generation)) {
                    return;
                }
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
                entries.push({ metadata, file: registered });
            }
            const state = this.store.state;
            const seen = new Set<string>();
            const missing = new Set<string>();
            const script = entries.map(({ metadata, file }) => {
                const matched = this.matchingSettings(this.store.settingsFor(file), metadata);
                matched.missing.forEach((column) => missing.add(column));
                const settings = matched.settings;
                return deduplicateSharedPrerequisites(this.service.generateCompleteDocument({
                    metadata: { ...metadata, sql_type_overrides: { ...settings.columnOverrides } },
                    tableName: settings.tableName || null,
                    schemaName: settings.schemaName || 'dbo',
                    dataSource: settings.dataSource || 'MyDataSource',
                    credentialName: settings.credentialName || null,
                    formatName: settings.formatName || null,
                    parserOverrides: { ...settings.parserOverrides },
                    authMethod: state.authMethod || null,
                    targetPlatform: state.platform,
                    storageUrl: state.storageUrl || null,
                    dataSourceType: state.dataSourceType,
                }), seen);
            }).join('\n\n');
            if (!this.isCurrent(generation)) {
                return;
            }
            this.store.update({
                busy: false,
                progress: null,
                notice: [
                    files.length > budget ? `Exported the first ${budget} of ${files.length} files.` : '',
                    this.missingColumnsNotice([...missing]),
                ].filter(Boolean).join(' ') || null,
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

    // -- lifecycle -----------------------------------------------------------

    /** Re-read workspace folders, e.g. after a folder was added or removed. */
    refreshWorkspace(): void {
        this.store.setWorkspaceFolders(this.host.workspaceFolders());
        this.store.update({});
    }

    /** Analyse an explicit path chosen outside the webview (a command). */
    async analyzePath(target: string, isDirectory: boolean): Promise<void> {
        await (isDirectory ? this.loadDirectory(target) : this.loadFiles([target]));
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
        this.localSourceSnapshot = undefined;
        this.profiles = [];
        this.azure?.disconnect();
    }
}

export { DEFAULT_PREVIEW_ROWS };
