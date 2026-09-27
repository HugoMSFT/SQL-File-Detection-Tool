/**
 * The typed message contract between the native webview and the extension host.
 *
 * The webview is treated as untrusted. Every inbound message is parsed by
 * {@link parseWebviewRequest}, which accepts only an allowlisted shape: an
 * exact `type`, exactly the fields that type declares, and values inside hard
 * bounds. Anything else is dropped without dispatch, so a compromised renderer
 * cannot reach an arbitrary command, an arbitrary path or an arbitrary host.
 *
 * Two rules shape the design and are enforced by tests:
 *
 *   * The webview never sends a filesystem path or an allowed root. It sends an
 *     opaque `fileId` that the host minted, so containment can never be
 *     bypassed from the renderer side.
 *   * The host never sends a token, connection string or SAS signature in a
 *     state envelope. Files are identified by a workspace-relative display
 *     label rather than an absolute path. Generated T-SQL is the one deliberate
 *     exception: a `BULK INSERT`/`OPENROWSET` statement is only useful if it
 *     names the source, so `statements` may contain the absolute path or the
 *     unsigned blob URL of a file the user chose. It never contains a
 *     credential.
 *
 * Nothing here imports `vscode`, so the contract is unit testable with plain
 * `node --test`.
 */

import type {
    FileMetadata,
    NativeSupport,
    ParserOverrides,
    PreviewResult,
    StatementKind,
    SupportedFormat,
    TargetPlatform,
} from './native';
import {
    DOCUMENTATION_IDS,
    type DocumentationId,
} from './documentation';
import type {
    FolderProfile,
    QuickAnalyzeState,
    SourceKind,
} from './quickAnalyze';
import {
    GUIDED_AUTH_METHODS,
    STORAGE_SETUP_GOALS,
    type CredentialWizardState,
    type ExternalDataSourceType,
    type GuidedAuthMethod,
    type StorageSetupGoal,
} from './native';
import type { AzureBrowserState } from './azure/types';
import { MAX_BLOB_PATH_LENGTH, MAX_PUBLIC_CONTAINER_URL_LENGTH } from './azure/locations';
import { MAX_PROFILE_NAME_LENGTH, PARSER_OVERRIDE_KEYS } from './fileSettings';

/** Upper bound for any free-text field a webview may send. */
export const MAX_TEXT_LENGTH = 2048;

/** Upper bound for a URL the webview may ask the host to fetch. */
export const MAX_URL_LENGTH = 2048;

/** Bounds on the preview row count the webview may request. */
export const MIN_PREVIEW_ROWS = 1;
export const MAX_PREVIEW_ROWS = 500;

/** Tabs the native interface can show. */
export const UI_TABS = [
    'preview',
    'metadata',
    'schema',
    'create_table',
    'bulk_insert',
    'openrowset',
    'external_file_format',
    'create_external_table',
    'credential_setup',
] as const;

export type UiTab = (typeof UI_TABS)[number];
export type SourceBrowserMode = 'local' | 'azure';

/** Statement tabs, i.e. the subset of {@link UI_TABS} the generator produces. */
export const STATEMENT_KINDS: readonly StatementKind[] = [
    'create_table',
    'bulk_insert',
    'openrowset',
    'copy_into',
    'external_file_format',
    'create_external_table',
    'json_functions',
    'for_json',
    'credential_setup',
    'best_practices',
];

// ---------------------------------------------------------------------------
// Webview -> host
// ---------------------------------------------------------------------------

interface Base {
    /** Correlates an optional acknowledgement. Opaque to the host. */
    readonly requestId?: string;
}

export type WebviewRequest =
    | (Base & { readonly type: 'ready' })
    | (Base & { readonly type: 'refresh' })
    | (Base & { readonly type: 'cancel' })
    | (Base & { readonly type: 'dismissNotice' })
    | (Base & { readonly type: 'setPlatform'; readonly platform: string })
    | (Base & { readonly type: 'setTab'; readonly tab: UiTab })
    | (Base & { readonly type: 'setFileFilter'; readonly value: string })
    | (Base & { readonly type: 'selectFile'; readonly fileId: string })
    | (Base & { readonly type: 'activateLocalSource' })
    | (Base & { readonly type: 'openLocalDialog' })
    | (Base & { readonly type: 'openAzureBrowser' })
    | (Base & { readonly type: 'azureBrowserConnect' })
    | (Base & {
          readonly type: 'azureBrowserOpenPublicContainer';
          readonly url: string;
          readonly prefix: string;
      })
    | (Base & { readonly type: 'azureBrowserRefresh' })
    | (Base & { readonly type: 'azureBrowserDisconnect' })
    | (Base & { readonly type: 'azureBrowserClose' })
    | (Base & { readonly type: 'azureBrowserRetry' })
    | (Base & { readonly type: 'azureBrowserLoadMore' })
    | (Base & { readonly type: 'azureBrowserUseSelectedFile' })
    | (Base & { readonly type: 'azureBrowserUseCurrentFolder' })
    | (Base & {
          readonly type: 'azureBrowserSelectTenant';
          readonly tenantId: string;
      })
    | (Base & {
          readonly type: 'azureBrowserSelectSubscription';
          readonly subscriptionId: string;
      })
    | (Base & {
          readonly type: 'azureBrowserSelectAccount';
          readonly accountId: string;
      })
    | (Base & { readonly type: 'azureBrowserOpenEntry'; readonly entryId: string })
    | (Base & { readonly type: 'azureBrowserNavigate'; readonly depth: number })
    | (Base & {
          readonly type: 'setTableName' | 'setSchemaName' | 'setDataSource' | 'setCredentialName' | 'setFormatName';
          /** Null only when editing object names without a selected local file. */
          readonly fileId: string | null;
          readonly value: string;
      })
    | (Base & {
          readonly type: 'setAuthMethod';
          readonly value: GuidedAuthMethod | 'public';
      })
    | (Base & { readonly type: 'setStorageGoal'; readonly value: StorageSetupGoal })
    | (Base & { readonly type: 'setAzureFolderFormat'; readonly value: string })
    | (Base & { readonly type: 'setStorageUrl'; readonly value: string })
    | (Base & {
          readonly type: 'setParserOverride';
          readonly fileId: string;
          readonly key: keyof ParserOverrides;
          readonly value: string;
      })
    | (Base & { readonly type: 'resetParserOverride'; readonly fileId: string; readonly key: keyof ParserOverrides })
    | (Base & {
          readonly type: 'setColumnOverride';
          readonly fileId: string;
          readonly column: string;
          readonly sqlType: string;
      })
    | (Base & { readonly type: 'clearColumnOverrides'; readonly fileId: string })
    | (Base & { readonly type: 'resetFileSettings' | 'undoFileSettings'; readonly fileId: string })
    | (Base & { readonly type: 'saveImportProfile' | 'applyImportProfile'; readonly fileId: string; readonly name: string })
    | (Base & { readonly type: 'deleteImportProfile'; readonly name: string })
    | (Base & { readonly type: 'setPreviewRows'; readonly rows: number })
    | (Base & { readonly type: 'copyStatement'; readonly kind: StatementKind })
    | (Base & {
          readonly type: 'openStatementInEditor';
          readonly kind: StatementKind;
      })
    | (Base & { readonly type: 'exportAllSql' })
    | (Base & { readonly type: 'openInEditor' })
    | (Base & { readonly type: 'openDocumentation'; readonly id: DocumentationId })
    | (Base & { readonly type: 'showOrcGuidance' });

export type WebviewRequestType = WebviewRequest['type'];

// ---------------------------------------------------------------------------
// Host -> webview
// ---------------------------------------------------------------------------

/** One entry in the file list. Carries no absolute path. */
export interface FileEntry {
    /** Opaque host-minted id. The only file handle the webview ever sees. */
    readonly id: string;
    /** Workspace-relative (or basename) label safe to render. */
    readonly label: string;
    /** Safe path beneath the selected root, excluding the file name. */
    readonly folderLabel: string;
    readonly fileType: string;
    readonly sizeBytes: number;
    readonly nativeSupport: NativeSupport;
    /** Set when the entry is a Delta/Iceberg table directory. */
    readonly isDirectory: boolean;
}

/** A limitation the UI must state plainly rather than work around. */
export interface Limitation {
    readonly code: 'orc_unsupported' | 'rcfile_recognition_only' | 'remote_scheme';
    readonly title: string;
    readonly detail: string;
    /** Optional manual, opt-in workaround. Never executed by the extension. */
    readonly manualWorkaround: string | null;
}

/** The complete model both the sidebar and the editor panel render. */
export interface AppStateSnapshot {
    readonly version: string;
    readonly platform: TargetPlatform;
    readonly platforms: ReadonlyArray<{ id: TargetPlatform; label: string }>;
    readonly sourceMode: SourceBrowserMode;
    readonly activeTab: UiTab;
    readonly fileFilter: string;
    readonly files: readonly FileEntry[];
    readonly selectedFileId: string | null;
    readonly sourceLabel: string | null;
    readonly locationLabel: string | null;
    readonly metadata: FileMetadata | null;
    readonly preview: PreviewResult | null;
    readonly statements: Readonly<Record<string, string>> | null;
    readonly tableName: string;
    readonly schemaName: string;
    readonly dataSource: string;
    readonly dataSourceType: ExternalDataSourceType;
    readonly credentialName: string;
    readonly authMethod: string;
    readonly storageGoal: StorageSetupGoal;
    readonly credentialSetup: CredentialWizardState;
    readonly storageUrl: string;
    readonly azureFolderPreview: {
        readonly label: string;
        readonly url: string;
        readonly items: ReadonlyArray<{
            readonly kind: 'folder' | 'file';
            readonly name: string;
            readonly format: string | null;
            readonly sizeBytes: number | null;
            readonly modifiedAt: string | null;
        }>;
        readonly truncated: boolean;
    } | null;
    readonly remoteSchema: {
        readonly status: 'not_analyzed' | 'format_required';
        readonly formats: readonly string[];
        readonly selectedFormat: string | null;
        readonly message: string;
    } | null;
    readonly formatName: string;
    readonly parserOverrides: Readonly<ParserOverrides>;
    readonly sourceKind: SourceKind;
    readonly folderProfile: FolderProfile | null;
    readonly quickAnalyze: QuickAnalyzeState;
    readonly columnOverrides: Readonly<Record<string, string>>;
    readonly canUndoSettings: boolean;
    /** Changes when settings are replaced, so surfaces discard obsolete drafts. */
    readonly settingsRevision: number;
    /** The renderer receives profile names, not persisted settings or identities. */
    readonly importProfiles: readonly string[];
    readonly recommendedSqlTypes: Readonly<Record<string, string>>;
    readonly previewRows: number;
    readonly busy: boolean;
    readonly progress: string | null;
    readonly error: string | null;
    readonly notice: string | null;
    readonly limitation: Limitation | null;
    readonly formats: readonly SupportedFormat[];
    /** Milliseconds the last analysis took; drives the perf readout. */
    readonly lastAnalysisMs: number | null;
    readonly azure: AzureBrowserState;
}

export type HostMessage =
    | { readonly type: 'state'; readonly state: AppStateSnapshot }
    | {
          readonly type: 'ack';
          readonly requestId: string;
          readonly ok: boolean;
          readonly error?: string;
      };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Keys that must never be accepted from a renderer-supplied object. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_KEYS.has(key)) {
            return false;
        }
    }
    return true;
}

function text(
    source: Record<string, unknown>,
    key: string,
    maxLength = MAX_TEXT_LENGTH,
): string | undefined {
    const value = source[key];
    if (typeof value !== 'string') {
        return undefined;
    }
    if (value.length > maxLength) {
        return undefined;
    }
    // A control character has no place in an identifier, a URL or a label and
    // is a classic way to smuggle a terminator past a downstream parser.
    //
    // Tab, newline and carriage return are deliberately *not* rejected here,
    // because a schema override description or a pasted label may legitimately
    // contain them. That is only safe because every SQL sink runs its input
    // through `collapseControlCharacters` in `src/native/sql/escaping.ts`
    // first, which is what actually prevents a smuggled `GO` batch separator.
    // If a value validated here ever reaches generated SQL without passing
    // through that function, this allowance becomes a vulnerability.
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        return undefined;
    }
    return value;
}

function member<T extends string>(
    source: Record<string, unknown>,
    key: string,
    allowed: readonly T[],
): T | undefined {
    const value = source[key];
    return typeof value === 'string' && (allowed as readonly string[]).includes(value)
        ? (value as T)
        : undefined;
}

function boundedInteger(
    source: Record<string, unknown>,
    key: string,
    min: number,
    max: number,
): number | undefined {
    const value = source[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return undefined;
    }
    const rounded = Math.trunc(value);
    return rounded >= min && rounded <= max ? rounded : undefined;
}

function requestId(source: Record<string, unknown>): string | undefined {
    const value = source.requestId;
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
        return undefined;
    }
    return /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined;
}

/**
 * Every request type, with the extra fields it requires.
 *
 * Building the parsed object field by field (rather than spreading the raw
 * message) guarantees that no unexpected property survives into the host.
 */
type Builder = (
    source: Record<string, unknown>,
) => Omit<WebviewRequest, 'requestId'> | undefined;

function objectNameRequest(
    type: 'setTableName' | 'setSchemaName' | 'setDataSource' | 'setCredentialName' | 'setFormatName',
    source: Record<string, unknown>,
): WebviewRequest | undefined {
    const fileId = source.fileId === null ? null : text(source, 'fileId', 64);
    const value = text(source, 'value', 256);
    return fileId === undefined || fileId === '' || value === undefined
        ? undefined
        : { type, fileId, value };
}

function fileSettingsAction(
    type: 'clearColumnOverrides' | 'resetFileSettings' | 'undoFileSettings',
    source: Record<string, unknown>,
): WebviewRequest | undefined {
    const fileId = text(source, 'fileId', 64);
    return fileId ? { type, fileId } : undefined;
}

function profileAction(
    type: 'saveImportProfile' | 'applyImportProfile',
    source: Record<string, unknown>,
): WebviewRequest | undefined {
    const fileId = text(source, 'fileId', 64);
    const name = text(source, 'name', MAX_PROFILE_NAME_LENGTH);
    return fileId && name ? { type, fileId, name } : undefined;
}

const BUILDERS: Record<string, Builder> = {
    ready: () => ({ type: 'ready' }),
    refresh: () => ({ type: 'refresh' }),
    cancel: () => ({ type: 'cancel' }),
    dismissNotice: () => ({ type: 'dismissNotice' }),
    activateLocalSource: () => ({ type: 'activateLocalSource' }),
    openLocalDialog: () => ({ type: 'openLocalDialog' }),
    openAzureBrowser: () => ({ type: 'openAzureBrowser' }),
    azureBrowserConnect: () => ({ type: 'azureBrowserConnect' }),
    azureBrowserOpenPublicContainer: (source) => {
        const url = text(source, 'url', MAX_PUBLIC_CONTAINER_URL_LENGTH);
        const prefix = source.prefix === undefined ? '' : text(source, 'prefix', MAX_BLOB_PATH_LENGTH);
        if (
            !url || prefix === undefined
            // eslint-disable-next-line no-control-regex -- these fields are network locations, not labels
            || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(url + prefix)
        ) {
            return undefined;
        }
        return { type: 'azureBrowserOpenPublicContainer', url, prefix };
    },
    azureBrowserRefresh: () => ({ type: 'azureBrowserRefresh' }),
    azureBrowserDisconnect: () => ({ type: 'azureBrowserDisconnect' }),
    azureBrowserClose: () => ({ type: 'azureBrowserClose' }),
    azureBrowserRetry: () => ({ type: 'azureBrowserRetry' }),
    azureBrowserLoadMore: () => ({ type: 'azureBrowserLoadMore' }),
    azureBrowserUseSelectedFile: () => ({ type: 'azureBrowserUseSelectedFile' }),
    azureBrowserUseCurrentFolder: () => ({ type: 'azureBrowserUseCurrentFolder' }),
    clearColumnOverrides: (source) => fileSettingsAction('clearColumnOverrides', source),
    resetFileSettings: (source) => fileSettingsAction('resetFileSettings', source),
    undoFileSettings: (source) => fileSettingsAction('undoFileSettings', source),
    saveImportProfile: (source) => profileAction('saveImportProfile', source),
    applyImportProfile: (source) => profileAction('applyImportProfile', source),
    deleteImportProfile: (source) => {
        const name = text(source, 'name', MAX_PROFILE_NAME_LENGTH);
        return name ? { type: 'deleteImportProfile', name } : undefined;
    },
    exportAllSql: () => ({ type: 'exportAllSql' }),
    openInEditor: () => ({ type: 'openInEditor' }),
    showOrcGuidance: () => ({ type: 'showOrcGuidance' }),
    azureBrowserSelectTenant: (source) => {
        const tenantId = text(source, 'tenantId', 128);
        return tenantId ? { type: 'azureBrowserSelectTenant', tenantId } : undefined;
    },
    azureBrowserSelectSubscription: (source) => {
        const subscriptionId = text(source, 'subscriptionId', 128);
        return subscriptionId
            ? { type: 'azureBrowserSelectSubscription', subscriptionId }
            : undefined;
    },
    azureBrowserSelectAccount: (source) => {
        const accountId = text(source, 'accountId', MAX_TEXT_LENGTH);
        return accountId
            ? { type: 'azureBrowserSelectAccount', accountId }
            : undefined;
    },
    azureBrowserOpenEntry: (source) => {
        const entryId = text(source, 'entryId', 64);
        return entryId ? { type: 'azureBrowserOpenEntry', entryId } : undefined;
    },
    azureBrowserNavigate: (source) => {
        const depth = boundedInteger(source, 'depth', 0, 100);
        return depth === undefined ? undefined : { type: 'azureBrowserNavigate', depth };
    },
    openDocumentation: (source) => {
        const id = member(source, 'id', DOCUMENTATION_IDS);
        return id === undefined ? undefined : { type: 'openDocumentation', id };
    },

    setPlatform: (source) => {
        const platform = text(source, 'platform', 64);
        return platform === undefined ? undefined : { type: 'setPlatform', platform };
    },
    setTab: (source) => {
        const tab = member(source, 'tab', UI_TABS);
        return tab === undefined ? undefined : { type: 'setTab', tab };
    },
    setFileFilter: (source) => {
        const value = text(source, 'value', 256);
        return value === undefined ? undefined : { type: 'setFileFilter', value };
    },
    selectFile: (source) => {
        const fileId = text(source, 'fileId', 64);
        return fileId ? { type: 'selectFile', fileId } : undefined;
    },
    setTableName: (source) => objectNameRequest('setTableName', source),
    setSchemaName: (source) => objectNameRequest('setSchemaName', source),
    setDataSource: (source) => objectNameRequest('setDataSource', source),
    setCredentialName: (source) => objectNameRequest('setCredentialName', source),
    setAuthMethod: (source) => {
        const value = member(source, 'value', [...GUIDED_AUTH_METHODS, 'public'] as const);
        return value === undefined ? undefined : { type: 'setAuthMethod', value };
    },
    setStorageGoal: (source) => {
        const value = member(source, 'value', STORAGE_SETUP_GOALS);
        return value === undefined ? undefined : { type: 'setStorageGoal', value };
    },
    setAzureFolderFormat: (source) => {
        const value = text(source, 'value', 64);
        return value === undefined ? undefined : { type: 'setAzureFolderFormat', value };
    },
    setStorageUrl: (source) => {
        const value = text(source, 'value', MAX_URL_LENGTH);
        return value === undefined ? undefined : { type: 'setStorageUrl', value };
    },
    setFormatName: (source) => objectNameRequest('setFormatName', source),
    setParserOverride: (source) => {
        const fileId = text(source, 'fileId', 64);
        const key = member(source, 'key', PARSER_OVERRIDE_KEYS);
        const value = text(source, 'value', 128);
        return !fileId || key === undefined || value === undefined
            ? undefined
            : { type: 'setParserOverride', fileId, key, value };
    },
    resetParserOverride: (source) => {
        const fileId = text(source, 'fileId', 64);
        const key = member(source, 'key', PARSER_OVERRIDE_KEYS);
        return !fileId || key === undefined ? undefined : { type: 'resetParserOverride', fileId, key };
    },
    setColumnOverride: (source) => {
        const fileId = text(source, 'fileId', 64);
        const column = text(source, 'column', 256);
        const sqlType = text(source, 'sqlType', 128);
        return fileId && column && sqlType !== undefined
            ? { type: 'setColumnOverride', fileId, column, sqlType }
            : undefined;
    },
    setPreviewRows: (source) => {
        const rows = boundedInteger(source, 'rows', MIN_PREVIEW_ROWS, MAX_PREVIEW_ROWS);
        return rows === undefined ? undefined : { type: 'setPreviewRows', rows };
    },
    copyStatement: (source) => {
        const kind = member(source, 'kind', STATEMENT_KINDS);
        return kind === undefined ? undefined : { type: 'copyStatement', kind };
    },
    openStatementInEditor: (source) => {
        const kind = member(source, 'kind', STATEMENT_KINDS);
        return kind === undefined
            ? undefined
            : { type: 'openStatementInEditor', kind };
    },
};

/**
 * Parse an untrusted webview message.
 *
 * Returns the typed request when the message is well formed and allowlisted,
 * and `undefined` for everything else. Callers must treat `undefined` as
 * "drop", never as "use a default".
 */
export function parseWebviewRequest(raw: unknown): WebviewRequest | undefined {
    if (!isPlainRecord(raw)) {
        return undefined;
    }
    const type = raw.type;
    if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(BUILDERS, type)) {
        return undefined;
    }
    if (raw.requestId !== undefined && requestId(raw) === undefined) {
        return undefined;
    }
    const built = BUILDERS[type](raw);
    if (!built) {
        return undefined;
    }
    if (
        [
            'setTableName', 'setSchemaName', 'setDataSource', 'setCredentialName', 'setFormatName',
            'setParserOverride', 'resetParserOverride', 'setColumnOverride', 'clearColumnOverrides',
            'resetFileSettings', 'undoFileSettings', 'saveImportProfile', 'applyImportProfile', 'deleteImportProfile',
        ].includes(type)
        && Object.keys(raw).some((key) => key !== 'requestId' && !Object.prototype.hasOwnProperty.call(built, key))
    ) {
        return undefined;
    }
    const id = requestId(raw);
    return (id === undefined ? built : { ...built, requestId: id }) as WebviewRequest;
}

/** True when *value* is one of the statement tabs. */
export function isStatementKind(value: unknown): value is StatementKind {
    return typeof value === 'string' && (STATEMENT_KINDS as readonly string[]).includes(value);
}
