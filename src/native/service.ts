/**
 * Cohesive service API for the native analysis + SQL generation core.
 *
 * This is the surface a WebviewView (or any other host) should consume. It
 * bundles path containment, cancellation and the analysis/generation pipeline
 * into a handful of task-shaped operations so callers never have to resolve
 * paths or thread tokens through individual analyzers themselves.
 *
 * Every operation is constrained to an *allowed root*. A root is either passed
 * explicitly by the host (for example, the workspace folder) or derived from
 * the requested path itself. Paths are resolved with `realpath` before the
 * containment check, so a symlink cannot be used to escape the root.
 */

import * as path from 'path';
import type { CancellationToken, ProgressReporter } from './cancellation';
import { NEVER_CANCELLED, throwIfCancelled } from './cancellation';
import { describeError, FileChangedError, NativeAnalysisError } from './errors';
import {
    analyzeFileMetadata,
    fileRevision,
    listSupportedFormats,
    scanDirectory,
    sqlSourceFileType,
} from './detector';
import { getPreviewData } from './preview';
import { boundedTextPreview, isTextPreviewType } from './samplePreview';
import { impliedRoot, resolveWithinRoot } from './paths';
import { PREVIEW_DEFAULT_ROWS } from './limits';
import type {
    FileMetadata,
    GeneratedStatements,
    GeneratorMetadata,
    PreviewResult,
    StorageReference,
    SupportedFormat,
    TargetPlatform,
    ParserOverrides,
    AnalysisPreview,
    StatementKind,
} from './types';
import {
    deduplicateSharedPrerequisites,
    generateAllStatements,
    generateCompleteDdl,
    resolveTableName,
} from './sql/generator';
import { DEFAULT_TARGET_PLATFORM, PLATFORMS, normalizePlatform } from './sql/typeMapping';
import type { ExternalDataSourceType } from './sql/credentialWizard';

/** Options accepted by every filesystem-touching service call. */
export interface AnalysisRequest {
    /** Path to the file or table directory to analyse. */
    readonly filePath: string;
    /**
     * Directory the operation is confined to. Defaults to the requested path's
     * own directory (or itself, when it is a directory).
     */
    readonly allowedRoot?: string;
    readonly token?: CancellationToken;
    readonly progress?: ProgressReporter;
    /** Yield during complete JSON parsing. Enabled by the progressive UI path. */
    readonly cooperative?: boolean;
}

/** Options for {@link NativeAnalysisService.preview}. */
export interface PreviewRequest extends AnalysisRequest {
    readonly maxRows?: number;
}

/** Opt-in sample publication, followed by the normal authoritative analysis. */
export interface ProgressiveAnalysisRequest extends PreviewRequest {
    readonly onPreview: (sample: AnalysisPreview) => void | Promise<void>;
}

/** Read rows using metadata already returned by analyzeProgressively. */
export interface AnalyzedPreviewRequest extends PreviewRequest {
    readonly metadata: FileMetadata;
}

export function markProvisionalSql(sql: string, metadata: GeneratorMetadata): string {
    return metadata.analysis_stage === 'provisional' && sql
        ? '-- SAMPLE ONLY: analysis is incomplete; schema and row count are not verified. Do not treat this template as ready to run.\n' + sql
        : sql;
}

/** Options for a directory scan. Depth zero means only the selected root. */
export interface DirectoryAnalysisRequest extends AnalysisRequest {
    readonly maxDepth?: number;
    readonly maxFiles?: number;
    readonly maxDirectories?: number;
}

/** Options for the SQL generation entry points. */
export interface GenerationRequest {
    readonly metadata: GeneratorMetadata;
    readonly tableName?: string | null;
    readonly schemaName?: string;
    readonly dataSource?: string | null;
    readonly credentialName?: string | null;
    readonly authMethod?: string | null;
    readonly location?: string | null;
    readonly targetPlatform?: TargetPlatform | string | null;
    readonly storageUrl?: string | null;
    readonly dataSourceType?: ExternalDataSourceType | string | null;
    readonly formatName?: string | null;
    readonly parserOverrides?: ParserOverrides;
}

/** One file in a multi-file export. */
export interface ExportEntry {
    readonly metadata: GeneratorMetadata;
    readonly tableName?: string | null;
}

/** Options for {@link NativeAnalysisService.generateMultiFileScript}. */
export interface MultiFileRequest {
    readonly entries: readonly ExportEntry[];
    readonly schemaName?: string;
    readonly dataSource?: string | null;
    readonly credentialName?: string | null;
    readonly authMethod?: string | null;
    readonly targetPlatform?: TargetPlatform | string | null;
    readonly storageUrl?: string | null;
    readonly dataSourceType?: ExternalDataSourceType | string | null;
}

/** Result of analysing a directory that holds a supported table format. */
export interface DirectoryAnalysis {
    readonly root: string;
    readonly files: FileMetadata[];
    /** True when a ceiling withheld work rather than the scan finishing. */
    readonly truncated: boolean;
}

function reportProgress(
    progress: ProgressReporter | undefined,
    message: string,
    increment?: number,
): void {
    if (progress) {
        progress.report(increment === undefined ? { message } : { message, increment });
    }
}

/**
 * The native core's public service.
 *
 * The class holds no mutable state beyond its default allowed root, so a host
 * may construct one per window or one per request interchangeably.
 */
export class NativeAnalysisService {
    private readonly defaultRoot: string | undefined;

    constructor(defaultRoot?: string) {
        this.defaultRoot = defaultRoot ? path.resolve(defaultRoot) : undefined;
    }

    /** Resolve a caller-supplied path against its allowed root. */
    async resolve(request: AnalysisRequest): Promise<StorageReference> {
        const root =
            request.allowedRoot ??
            this.defaultRoot ??
            (await impliedRoot(request.filePath));
        return resolveWithinRoot(request.filePath, root);
    }

    /** Detect and analyse a single file or table directory. */
    async analyze(request: AnalysisRequest): Promise<FileMetadata> {
        const token = request.token ?? NEVER_CANCELLED;
        throwIfCancelled(token);
        reportProgress(request.progress, 'Resolving path');
        const reference = await this.resolve(request);
        throwIfCancelled(token);
        reportProgress(request.progress, `Analyzing ${path.basename(reference.realPath)}`);
        const metadata = await analyzeFileMetadata(reference, token, request.cooperative);
        throwIfCancelled(token);
        return metadata;
    }

    /**
     * Analyse every supported file in a directory.
     *
     * Delta and Iceberg table directories are treated as a single logical
     * table rather than a list of Parquet parts.
     */
    async analyzeDirectory(request: DirectoryAnalysisRequest): Promise<DirectoryAnalysis> {
        const token = request.token ?? NEVER_CANCELLED;
        throwIfCancelled(token);
        reportProgress(request.progress, 'Resolving directory');
        const reference = await this.resolve(request);
        reportProgress(request.progress, 'Scanning directory');
        const scan = await scanDirectory(
            reference,
            token,
            request.maxDepth,
            request.maxFiles,
            request.maxDirectories,
        );
        return {
            root: reference.realPath,
            files: scan.files,
            truncated: scan.truncated,
        };
    }

    /** Read a bounded tabular preview of a file. */
    async preview(request: PreviewRequest): Promise<PreviewResult> {
        const token = request.token ?? NEVER_CANCELLED;
        throwIfCancelled(token);
        const reference = await this.resolve(request);
        const metadata = await analyzeFileMetadata(reference, token);
        reportProgress(request.progress, 'Reading preview rows');
        const preview = await getPreviewData(
            reference,
            metadata,
            request.maxRows ?? PREVIEW_DEFAULT_ROWS,
            token,
        );
        throwIfCancelled(token);
        return preview;
    }

    private async assertRevision(
        request: AnalysisRequest,
        reference: StorageReference,
        revision: string | null,
        token: CancellationToken,
    ): Promise<void> {
        throwIfCancelled(token);
        const current = await this.resolve(request);
        const currentRevision = await fileRevision(current);
        throwIfCancelled(token);
        if (current.realPath !== reference.realPath || currentRevision !== revision) {
            throw new FileChangedError();
        }
    }

    /** Bounded local text sample only; never scans or inserts into the metadata cache. */
    async samplePreview(request: PreviewRequest): Promise<AnalysisPreview> {
        const token = request.token ?? NEVER_CANCELLED;
        throwIfCancelled(token);
        const reference = await this.resolve(request);
        const fileType = sqlSourceFileType(reference.realPath);
        if (reference.isDirectory || fileType === undefined || !isTextPreviewType(fileType)) {
            throw new NativeAnalysisError('unsupported_format', 'A fast sample requires a local delimited, JSON, or text file.');
        }
        const revision = await fileRevision(reference);
        throwIfCancelled(token);
        const result = await boundedTextPreview(
            reference, fileType, request.maxRows ?? PREVIEW_DEFAULT_ROWS, token,
        );
        await this.assertRevision(request, reference, revision, token);
        if (revision !== null) {
            result.metadata.source_revision = revision;
        }
        return result;
    }

    /**
     * Publish the sample before starting complete work. Non-text readers retain
     * their existing bounded footer/preview path, without a speculative pass.
     */
    async analyzeProgressively(request: ProgressiveAnalysisRequest): Promise<AnalysisPreview> {
        const token = request.token ?? NEVER_CANCELLED;
        throwIfCancelled(token);
        const reference = await this.resolve(request);
        const fileType = sqlSourceFileType(reference.realPath);
        const revision = await fileRevision(reference);
        throwIfCancelled(token);
        if (!reference.isDirectory && fileType !== undefined && isTextPreviewType(fileType)) {
            reportProgress(request.progress, 'Reading bounded sample');
            const sample = await boundedTextPreview(
                reference, fileType, request.maxRows ?? PREVIEW_DEFAULT_ROWS, token,
            );
            await this.assertRevision(request, reference, revision, token);
            if (revision !== null) {
                sample.metadata.source_revision = revision;
            }
            await request.onPreview(sample);
            throwIfCancelled(token);
            // Let the host deliver the preview and admit cancellation before refinement.
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        throwIfCancelled(token);
        const metadata = await this.analyze({ ...request, cooperative: true });
        await this.assertRevision(request, reference, revision, token);
        if (metadata.error) {
            throw new NativeAnalysisError('malformed_input', metadata.error);
        }
        if (revision !== null) {
            metadata.source_revision = revision;
        }
        reportProgress(request.progress, 'Refining preview');
        const preview = await this.previewAnalyzed({ ...request, metadata });
        throwIfCancelled(token);
        return { metadata, preview };
    }

    /** Refresh rows without re-analyzing an uncached file or table. */
    async previewAnalyzed(request: AnalyzedPreviewRequest): Promise<PreviewResult> {
        const token = request.token ?? NEVER_CANCELLED;
        throwIfCancelled(token);
        const reference = await this.resolve(request);
        const metadata = request.metadata;
        const revision = await fileRevision(reference);
        throwIfCancelled(token);
        if (metadata.file_path !== reference.realPath
            || metadata.analysis_stage === 'provisional'
            || (!reference.isDirectory && metadata.source_revision !== revision)) {
            throw new FileChangedError();
        }
        const limit = request.maxRows ?? PREVIEW_DEFAULT_ROWS;
        const preview = await getPreviewData(reference, metadata, limit, token, true);
        await this.assertRevision(request, reference, revision, token);
        return preview;
    }

    /**
     * Analyse a file and return both its metadata and every statement tab.
     *
     * This is the operation a webview needs for "open a file and show me the
     * SQL": it never requires the caller to make two round trips.
     */
    async analyzeAndGenerate(
        request: AnalysisRequest & Omit<GenerationRequest, 'metadata'>,
    ): Promise<{ metadata: FileMetadata; statements: GeneratedStatements }> {
        const metadata = await this.analyze(request);
        const statements = this.generateStatements({ ...request, metadata });
        return { metadata, statements };
    }

    /** Generate every statement tab for already-analysed metadata. */
    generateStatements(request: GenerationRequest): GeneratedStatements {
        const metadata = request.parserOverrides
            ? { ...request.metadata, parser_overrides: request.parserOverrides }
            : request.metadata;
        const statements = generateAllStatements(metadata, {
            tableName: request.tableName ?? null,
            schemaName: request.schemaName ?? 'dbo',
            dataSource: request.dataSource ?? 'MyDataSource',
            credentialName: request.credentialName ?? null,
            authMethod: request.authMethod ?? null,
            location: request.location ?? null,
            targetPlatform: request.targetPlatform ?? DEFAULT_TARGET_PLATFORM,
            storageUrl: request.storageUrl ?? null,
            dataSourceType: request.dataSourceType ?? null,
            formatName: request.formatName ?? null,
        });
        if (metadata.analysis_stage === 'provisional') {
            for (const kind of Object.keys(statements) as StatementKind[]) {
                statements[kind] = markProvisionalSql(statements[kind], metadata);
            }
        }
        return statements;
    }

    /** Generate one runnable, GO-separated document containing every section. */
    generateCompleteDocument(request: GenerationRequest): string {
        const metadata = request.parserOverrides
            ? { ...request.metadata, parser_overrides: request.parserOverrides }
            : request.metadata;
        return markProvisionalSql(generateCompleteDdl(metadata, {
            tableName: request.tableName ?? null,
            schemaName: request.schemaName ?? 'dbo',
            dataSource: request.dataSource ?? 'MyDataSource',
            credentialName: request.credentialName ?? null,
            authMethod: request.authMethod ?? null,
            location: request.location ?? null,
            targetPlatform: request.targetPlatform ?? DEFAULT_TARGET_PLATFORM,
            storageUrl: request.storageUrl ?? null,
            dataSourceType: request.dataSourceType ?? null,
            formatName: request.formatName ?? null,
        }), metadata);
    }

    /**
     * Generate one script for several files, creating shared prerequisites
     * (master key, credentials, data sources, file formats) only once.
     */
    generateMultiFileScript(request: MultiFileRequest): string {
        const seen = new Set<string>();
        const chunks: string[] = [];
        for (const entry of request.entries) {
            const script = generateCompleteDdl(entry.metadata, {
                tableName: entry.tableName ?? null,
                schemaName: request.schemaName ?? 'dbo',
                dataSource: request.dataSource ?? 'MyDataSource',
                credentialName: request.credentialName ?? null,
                authMethod: request.authMethod ?? null,
                targetPlatform: request.targetPlatform ?? DEFAULT_TARGET_PLATFORM,
                storageUrl: request.storageUrl ?? null,
                dataSourceType: request.dataSourceType ?? null,
            });
            chunks.push(markProvisionalSql(deduplicateSharedPrerequisites(script, seen), entry.metadata));
        }
        return chunks.join('\n\n');
    }

    /** Formats the native core recognises, and how completely it reads them. */
    listFormats(): SupportedFormat[] {
        return listSupportedFormats();
    }

    /** Target platforms the generator supports. */
    listPlatforms(): readonly TargetPlatform[] {
        return PLATFORMS;
    }

    /** The table name a caller-supplied override resolves to. */
    resolveTableName(metadata: GeneratorMetadata, tableName?: string | null): string {
        return resolveTableName(metadata, tableName);
    }

    /** Normalise an untrusted platform string to a supported target. */
    normalizePlatform(targetPlatform?: string | null): TargetPlatform {
        return normalizePlatform(targetPlatform);
    }

    /**
     * Analyse a file, returning a metadata object with an `error` key instead
     * of throwing. Convenience for UI surfaces that render errors inline.
     */
    async tryAnalyze(
        request: AnalysisRequest,
    ): Promise<{ ok: true; metadata: FileMetadata } | { ok: false; error: string }> {
        try {
            return { ok: true, metadata: await this.analyze(request) };
        } catch (error) {
            return { ok: false, error: describeError(error) };
        }
    }
}

/** A service bound to no particular root; each call derives its own. */
export const nativeAnalysisService = new NativeAnalysisService();
