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
    EXTERNAL_DATA_SOURCE_TYPES,
    GUIDED_AUTH_METHODS,
    type CredentialWizardState,
    type ExternalDataSourceType,
    type GuidedAuthMethod,
} from './native';

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
    'azure',
] as const;

export type UiTab = (typeof UI_TABS)[number];

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

/** Ways the extension can talk to Azure Storage. */
export const AZURE_AUTH_MODES = [
    'vscode',
    'sas',
    'connectionString',
    'anonymous',
] as const;

export type AzureAuthMode = (typeof AZURE_AUTH_MODES)[number];

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
    | (Base & { readonly type: 'selectFile'; readonly fileId: string })
    | (Base & { readonly type: 'openFileDialog' })
    | (Base & { readonly type: 'openFolderDialog' })
    | (Base & { readonly type: 'analyzeCurrentFile' })
    | (Base & { readonly type: 'setTableName'; readonly value: string })
    | (Base & { readonly type: 'setSchemaName'; readonly value: string })
    | (Base & { readonly type: 'setDataSource'; readonly value: string })
    | (Base & {
          readonly type: 'setDataSourceType';
          readonly value: ExternalDataSourceType;
      })
    | (Base & { readonly type: 'setCredentialName'; readonly value: string })
    | (Base & {
          readonly type: 'setAuthMethod';
          readonly value: GuidedAuthMethod | 'public';
      })
    | (Base & { readonly type: 'setStorageUrl'; readonly value: string })
    | (Base & { readonly type: 'setFormatName'; readonly value: string })
    | (Base & {
          readonly type: 'setParserOverride';
          readonly fileId: string;
          readonly key: keyof ParserOverrides;
          readonly value: string;
      })
    | (Base & { readonly type: 'resetParserOverride'; readonly key: keyof ParserOverrides })
    | (Base & {
          readonly type: 'setColumnOverride';
          readonly fileId: string;
          readonly column: string;
          readonly sqlType: string;
      })
    | (Base & { readonly type: 'clearColumnOverrides' })
    | (Base & { readonly type: 'setPreviewRows'; readonly rows: number })
    | (Base & { readonly type: 'copyStatement'; readonly kind: StatementKind })
    | (Base & {
          readonly type: 'openStatementInEditor';
          readonly kind: StatementKind;
      })
    | (Base & { readonly type: 'exportAllSql' })
    | (Base & { readonly type: 'openInEditor' })
    | (Base & { readonly type: 'openDocumentation'; readonly id: DocumentationId })
    | (Base & { readonly type: 'azureConnect'; readonly mode: AzureAuthMode })
    | (Base & { readonly type: 'azureDisconnect' })
    | (Base & { readonly type: 'azureListSubscriptions' })
    | (Base & {
          readonly type: 'azureListAccounts';
          readonly subscriptionId: string;
      })
    | (Base & { readonly type: 'azureSetAccount'; readonly account: string })
    | (Base & { readonly type: 'azureListContainers' })
    | (Base & {
          readonly type: 'azureListBlobs';
          readonly container: string;
          readonly prefix: string;
          readonly continuation: string;
      })
    | (Base & {
          readonly type: 'azureAnalyzeBlob';
          readonly container: string;
          readonly blob: string;
      })
    | (Base & { readonly type: 'publicUrlAnalyze'; readonly url: string })
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

/** Non-secret description of the current Azure connection. */
export interface AzureState {
    readonly connected: boolean;
    readonly mode: AzureAuthMode | null;
    /** Account label (an email or "SAS token"); never a credential. */
    readonly identity: string | null;
    readonly account: string | null;
    readonly subscriptions: ReadonlyArray<{ id: string; name: string }>;
    readonly accounts: readonly string[];
    readonly containers: readonly string[];
    readonly container: string | null;
    readonly prefix: string;
    readonly blobs: ReadonlyArray<{
        name: string;
        sizeBytes: number | null;
        supported: boolean;
    }>;
    readonly continuation: string | null;
    readonly canListSubscriptions: boolean;
    readonly error: string | null;
    readonly busy: boolean;
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
    readonly activeTab: UiTab;
    readonly files: readonly FileEntry[];
    readonly selectedFileId: string | null;
    readonly sourceLabel: string | null;
    readonly metadata: FileMetadata | null;
    readonly preview: PreviewResult | null;
    readonly statements: Readonly<Record<string, string>> | null;
    readonly tableName: string;
    readonly schemaName: string;
    readonly dataSource: string;
    readonly dataSourceType: ExternalDataSourceType;
    readonly credentialName: string;
    readonly authMethod: string;
    readonly credentialSetup: CredentialWizardState;
    readonly storageUrl: string;
    readonly formatName: string;
    readonly parserOverrides: Readonly<ParserOverrides>;
    readonly sourceKind: SourceKind;
    readonly folderProfile: FolderProfile | null;
    readonly quickAnalyze: QuickAnalyzeState;
    readonly columnOverrides: Readonly<Record<string, string>>;
    readonly recommendedSqlTypes: Readonly<Record<string, string>>;
    readonly previewRows: number;
    readonly busy: boolean;
    readonly progress: string | null;
    readonly error: string | null;
    readonly notice: string | null;
    readonly limitation: Limitation | null;
    readonly azure: AzureState;
    readonly formats: readonly SupportedFormat[];
    /** Milliseconds the last analysis took; drives the perf readout. */
    readonly lastAnalysisMs: number | null;
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

const BUILDERS: Record<string, Builder> = {
    ready: () => ({ type: 'ready' }),
    refresh: () => ({ type: 'refresh' }),
    cancel: () => ({ type: 'cancel' }),
    dismissNotice: () => ({ type: 'dismissNotice' }),
    openFileDialog: () => ({ type: 'openFileDialog' }),
    openFolderDialog: () => ({ type: 'openFolderDialog' }),
    analyzeCurrentFile: () => ({ type: 'analyzeCurrentFile' }),
    clearColumnOverrides: () => ({ type: 'clearColumnOverrides' }),
    exportAllSql: () => ({ type: 'exportAllSql' }),
    openInEditor: () => ({ type: 'openInEditor' }),
    azureDisconnect: () => ({ type: 'azureDisconnect' }),
    azureListSubscriptions: () => ({ type: 'azureListSubscriptions' }),
    azureListContainers: () => ({ type: 'azureListContainers' }),
    showOrcGuidance: () => ({ type: 'showOrcGuidance' }),
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
    selectFile: (source) => {
        const fileId = text(source, 'fileId', 64);
        return fileId ? { type: 'selectFile', fileId } : undefined;
    },
    setTableName: (source) => {
        const value = text(source, 'value', 256);
        return value === undefined ? undefined : { type: 'setTableName', value };
    },
    setSchemaName: (source) => {
        const value = text(source, 'value', 256);
        return value === undefined ? undefined : { type: 'setSchemaName', value };
    },
    setDataSource: (source) => {
        const value = text(source, 'value', 256);
        return value === undefined ? undefined : { type: 'setDataSource', value };
    },
    setDataSourceType: (source) => {
        const value = member(source, 'value', EXTERNAL_DATA_SOURCE_TYPES);
        return value === undefined ? undefined : { type: 'setDataSourceType', value };
    },
    setCredentialName: (source) => {
        const value = text(source, 'value', 256);
        return value === undefined
            ? undefined
            : { type: 'setCredentialName', value };
    },
    setAuthMethod: (source) => {
        const value = member(source, 'value', [...GUIDED_AUTH_METHODS, 'public'] as const);
        return value === undefined ? undefined : { type: 'setAuthMethod', value };
    },
    setStorageUrl: (source) => {
        const value = text(source, 'value', MAX_URL_LENGTH);
        return value === undefined ? undefined : { type: 'setStorageUrl', value };
    },
    setFormatName: (source) => {
        const value = text(source, 'value', 256);
        return value === undefined ? undefined : { type: 'setFormatName', value };
    },
    setParserOverride: (source) => {
        const fileId = text(source, 'fileId', 64);
        const key = member(source, 'key', [
            'format',
            'firstRow',
            'fieldDelimiter',
            'rowTerminator',
            'quoteCharacter',
            'codepage',
            'compression',
        ] as const);
        const value = text(source, 'value', 128);
        return !fileId || key === undefined || value === undefined
            ? undefined
            : { type: 'setParserOverride', fileId, key, value };
    },
    resetParserOverride: (source) => {
        const key = member(source, 'key', [
            'format',
            'firstRow',
            'fieldDelimiter',
            'rowTerminator',
            'quoteCharacter',
            'codepage',
            'compression',
        ] as const);
        return key === undefined ? undefined : { type: 'resetParserOverride', key };
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
    azureConnect: (source) => {
        const mode = member(source, 'mode', AZURE_AUTH_MODES);
        return mode === undefined ? undefined : { type: 'azureConnect', mode };
    },
    azureListAccounts: (source) => {
        const subscriptionId = text(source, 'subscriptionId', 64);
        return subscriptionId
            ? { type: 'azureListAccounts', subscriptionId }
            : undefined;
    },
    azureSetAccount: (source) => {
        const account = text(source, 'account', 64);
        return account ? { type: 'azureSetAccount', account } : undefined;
    },
    azureListBlobs: (source) => {
        const container = text(source, 'container', 128);
        const prefix = text(source, 'prefix', 1024);
        const continuation = text(source, 'continuation', MAX_TEXT_LENGTH);
        return container && prefix !== undefined && continuation !== undefined
            ? { type: 'azureListBlobs', container, prefix, continuation }
            : undefined;
    },
    azureAnalyzeBlob: (source) => {
        const container = text(source, 'container', 128);
        const blob = text(source, 'blob', 1024);
        return container && blob
            ? { type: 'azureAnalyzeBlob', container, blob }
            : undefined;
    },
    publicUrlAnalyze: (source) => {
        const url = text(source, 'url', MAX_URL_LENGTH);
        return url ? { type: 'publicUrlAnalyze', url } : undefined;
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
    const id = requestId(raw);
    return (id === undefined ? built : { ...built, requestId: id }) as WebviewRequest;
}

/** True when *value* is one of the statement tabs. */
export function isStatementKind(value: unknown): value is StatementKind {
    return typeof value === 'string' && (STATEMENT_KINDS as readonly string[]).includes(value);
}
