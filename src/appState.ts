/**
 * The single shared model behind every native surface.
 *
 * Both the Activity Bar {@link vscode.WebviewViewProvider} and the wider editor
 * panel render this one store, so the two can never diverge: a change made in
 * the sidebar is visible in the panel on the next frame and vice versa.
 *
 * The store also owns the *file registry*, which is the security-relevant half
 * of this module. The renderer is never given a filesystem path; it is given an
 * opaque id that the host minted, and only the host can turn that id back into
 * an absolute path plus the allowed root it must be contained by. That makes it
 * structurally impossible for the webview to widen the analysis root.
 *
 * Nothing here imports `vscode`.
 */

import * as crypto from 'crypto';
import * as path from 'path';

import type {
    FileMetadata,
    NativeSupport,
    PreviewResult,
    SupportedFormat,
    TargetPlatform,
} from './native';
import { DEFAULT_TARGET_PLATFORM, PLATFORM_LABELS, PLATFORMS } from './native';
import {
    folderProfileFor,
    parserOptionsFor,
    polyBaseGuidance,
    sourceReadiness,
} from './quickAnalyze';
import type {
    AppStateSnapshot,
    AppearanceMode,
    AzureState,
    FileEntry,
    Limitation,
    UiTab,
} from './protocol';

/** Everything the host knows about one listed file. */
export interface RegisteredFile {
    readonly id: string;
    /** Absolute path. Never leaves the extension host. */
    readonly absolutePath: string;
    /** Root the analysis of this file is confined to. Host-chosen. */
    readonly allowedRoot: string;
    readonly entry: FileEntry;
}

export const EMPTY_AZURE_STATE: AzureState = {
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
    error: null,
    busy: false,
};

/** Default preview row count. Bounded again on every request. */
export const DEFAULT_PREVIEW_ROWS = 25;

export interface AppStateOptions {
    readonly version: string;
    readonly platform?: TargetPlatform;
    readonly activeTab?: UiTab;
    readonly appearance?: AppearanceMode;
    readonly formats?: readonly SupportedFormat[];
    /** Workspace folders, used to build relative display labels. */
    readonly workspaceFolders?: readonly string[];
}

function initialSnapshot(options: AppStateOptions): AppStateSnapshot {
    return {
        version: options.version,
        platform: options.platform ?? DEFAULT_TARGET_PLATFORM,
        platforms: PLATFORMS.map((id) => ({ id, label: PLATFORM_LABELS[id] })),
        activeTab: options.activeTab ?? 'quick_analyze',
        files: [],
        selectedFileId: null,
        sourceLabel: null,
        metadata: null,
        preview: null,
        statements: null,
        tableName: '',
        schemaName: 'dbo',
        dataSource: 'MyDataSource',
        credentialName: '',
        authMethod: '',
        storageUrl: '',
        formatName: '',
        parserOverrides: {},
        sourceKind: 'local',
        folderProfile: null,
        quickAnalyze: {
            options: [],
            source: sourceReadiness({
                sourceKind: 'local',
                storageUrl: '',
                fileName: '',
                fileType: 'unknown',
                dataSource: 'MyDataSource',
                credentialName: '',
                formatName: '',
                authMethod: '',
                platform: options.platform ?? DEFAULT_TARGET_PLATFORM,
                selectedStatement: 'openrowset',
            }),
            folderProfile: null,
            selectedStatement: 'openrowset',
            polybase: polyBaseGuidance(
                options.platform ?? DEFAULT_TARGET_PLATFORM,
                'openrowset',
            ),
        },
        columnOverrides: {},
        previewRows: DEFAULT_PREVIEW_ROWS,
        busy: false,
        progress: null,
        error: null,
        notice: null,
        limitation: null,
        azure: EMPTY_AZURE_STATE,
        formats: options.formats ?? [],
        appearance: options.appearance ?? 'auto',
        lastAnalysisMs: null,
    };
}

/**
 * Build the label the renderer shows for *absolutePath*.
 *
 * Preference order is workspace-relative, then the file name prefixed by its
 * immediate parent. An absolute path is never returned, because the renderer
 * has no use for one and leaking a home directory (which frequently contains a
 * user name) into a rendered document is gratuitous.
 */
export function displayLabel(
    absolutePath: string,
    workspaceFolders: readonly string[] = [],
): { label: string; folderLabel: string } {
    const resolved = path.resolve(absolutePath);
    for (const folder of workspaceFolders) {
        const root = path.resolve(folder);
        const relative = path.relative(root, resolved);
        if (
            relative !== '' &&
            !relative.startsWith(`..${path.sep}`) &&
            relative !== '..' &&
            !path.isAbsolute(relative)
        ) {
            const parts = relative.split(path.sep);
            return {
                label: parts[parts.length - 1],
                folderLabel: parts.slice(0, -1).join('/'),
            };
        }
    }
    return {
        label: path.basename(resolved),
        folderLabel: path.basename(path.dirname(resolved)),
    };
}

export type StateListener = (snapshot: AppStateSnapshot) => void;

/**
 * Mutable state plus the file registry.
 *
 * `update` replaces named fields and notifies every subscriber with a fresh
 * frozen snapshot, so a renderer can never hold a live reference to host state.
 */
export class AppStateStore {
    private snapshot: AppStateSnapshot;
    private readonly listeners = new Set<StateListener>();
    private readonly registry = new Map<string, RegisteredFile>();
    private workspaceFolders: readonly string[];

    constructor(private readonly options: AppStateOptions) {
        this.workspaceFolders = options.workspaceFolders ?? [];
        this.snapshot = Object.freeze(initialSnapshot(options));
    }

    get state(): AppStateSnapshot {
        return this.snapshot;
    }

    setWorkspaceFolders(folders: readonly string[]): void {
        this.workspaceFolders = folders.slice();
    }

    subscribe(listener: StateListener): () => void {
        this.listeners.add(listener);
        listener(this.snapshot);
        return () => {
            this.listeners.delete(listener);
        };
    }

    update(patch: Partial<AppStateSnapshot>): AppStateSnapshot {
        this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
        for (const listener of [...this.listeners]) {
            listener(this.snapshot);
        }
        return this.snapshot;
    }

    /** Merge a partial Azure state without clobbering unrelated fields. */
    updateAzure(patch: Partial<AzureState>): AppStateSnapshot {
        return this.update({ azure: { ...this.snapshot.azure, ...patch } });
    }

    /** Clear everything derived from a file, keeping user-entered options. */
    clearSelection(): void {
        this.update({
            selectedFileId: null,
            sourceLabel: null,
            metadata: null,
            preview: null,
            statements: null,
            columnOverrides: {},
            parserOverrides: {},
            limitation: null,
            lastAnalysisMs: null,
        });
    }

    /**
     * Replace the file list.
     *
     * Ids are random rather than derived from the path, so an id cannot be
     * guessed or forged by a renderer that knows (or can brute force) a
     * filename, and a stale id from a previous listing stops resolving.
     */
    setFiles(
        files: ReadonlyArray<{
            absolutePath: string;
            allowedRoot: string;
            fileType: string;
            sizeBytes: number;
            nativeSupport: NativeSupport;
            isDirectory: boolean;
        }>,
    ): readonly FileEntry[] {
        this.registry.clear();
        const entries: FileEntry[] = [];
        for (const file of files) {
            const id = crypto.randomBytes(12).toString('hex');
            const { label, folderLabel } = displayLabel(
                file.absolutePath,
                this.workspaceFolders,
            );
            const entry: FileEntry = {
                id,
                label,
                folderLabel,
                fileType: file.fileType,
                sizeBytes: file.sizeBytes,
                nativeSupport: file.nativeSupport,
                isDirectory: file.isDirectory,
            };
            this.registry.set(id, {
                id,
                absolutePath: path.resolve(file.absolutePath),
                allowedRoot: path.resolve(file.allowedRoot),
                entry,
            });
            entries.push(entry);
        }
        this.update({ files: entries });
        return entries;
    }

    /** Resolve a renderer-supplied id, or `undefined` when it is unknown. */
    lookup(fileId: string): RegisteredFile | undefined {
        return this.registry.get(fileId);
    }

    /** The currently selected file, if any. */
    get selected(): RegisteredFile | undefined {
        const id = this.snapshot.selectedFileId;
        return id ? this.registry.get(id) : undefined;
    }

    /** Reset to a pristine model, e.g. on disconnect or deactivate. */
    reset(): void {
        this.registry.clear();
        this.snapshot = Object.freeze({
            ...initialSnapshot(this.options),
            platform: this.snapshot.platform,
            appearance: this.snapshot.appearance,
            formats: this.snapshot.formats,
        });
        for (const listener of [...this.listeners]) {
            listener(this.snapshot);
        }
    }

    dispose(): void {
        this.listeners.clear();
        this.registry.clear();
    }
}

/** Metadata-driven limitation text. Kept here so both surfaces agree. */
export function limitationFor(metadata: FileMetadata | null): Limitation | null {
    if (!metadata) {
        return null;
    }
    if (metadata.file_type === 'orc' || metadata.native_support === 'unsupported_native') {
        return {
            code: 'orc_unsupported',
            title: 'The native extension cannot inspect ORC yet',
            detail:
                'ORC stores its schema in a compressed footer with a stripe layout the ' +
                'bundled TypeScript reader does not implement, so the extension will not ' +
                'guess a schema it cannot read. Column names, types and row counts are ' +
                'unavailable; the generated SQL below is a template you must complete.',
            manualWorkaround:
                'If you have separately installed the optional Python command line package, ' +
                'you can run it yourself against this file to obtain a schema. The extension ' +
                'never installs or launches Python on your behalf.',
        };
    }
    if (metadata.file_type === 'rc' || metadata.native_support === 'recognition_only') {
        return {
            code: 'rcfile_recognition_only',
            title: 'RCFile is recognised but not parsed',
            detail:
                'The format is identified from its magic bytes only. No schema, row count ' +
                'or preview is available, and none is invented.',
            manualWorkaround: null,
        };
    }
    return null;
}

/** True when a preview is worth requesting for *metadata*. */
export function supportsPreview(metadata: FileMetadata | null): boolean {
    if (!metadata) {
        return false;
    }
    if (metadata.native_support && metadata.native_support !== 'supported') {
        return false;
    }
    return metadata.file_type !== 'unknown';
}

/** Rebuild the derived Quick Analyze view model after any relevant state change. */
export function quickAnalyzePatch(
    state: AppStateSnapshot,
    metadata: FileMetadata | null,
    folderMetadata: readonly FileMetadata[] = [],
): Pick<AppStateSnapshot, 'folderProfile' | 'quickAnalyze'> {
    const folderProfile = folderProfileFor(folderMetadata);
    const selected = state.quickAnalyze.selectedStatement;
    return {
        folderProfile,
        quickAnalyze: {
            options: parserOptionsFor(metadata, state.parserOverrides),
            source: sourceReadiness({
                sourceKind: state.sourceKind,
                storageUrl: state.storageUrl,
                fileName: metadata?.file_name ?? '',
                fileType: metadata?.file_type ?? 'unknown',
                dataSource: state.dataSource,
                credentialName: state.credentialName,
                formatName: state.formatName,
                authMethod: state.authMethod,
                platform: state.platform,
                selectedStatement: selected,
            }),
            folderProfile,
            selectedStatement: selected,
            polybase: polyBaseGuidance(state.platform, selected),
        },
    };
}

export type { AppStateSnapshot, PreviewResult };
