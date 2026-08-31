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
import { describeError } from './errors';
import {
    analyzeFileMetadata,
    listSupportedFormats,
    scanDirectory,
} from './detector';
import { getPreviewData } from './preview';
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
} from './types';
import {
    deduplicateSharedPrerequisites,
    generateAllStatements,
    generateCompleteDdl,
    resolveTableName,
} from './sql/generator';
import { DEFAULT_TARGET_PLATFORM, PLATFORMS, normalizePlatform } from './sql/typeMapping';

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
}

/** Options for {@link NativeAnalysisService.preview}. */
export interface PreviewRequest extends AnalysisRequest {
    readonly maxRows?: number;
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
}

/** Result of analysing a directory that holds a supported table format. */
export interface DirectoryAnalysis {
    readonly root: string;
    readonly files: FileMetadata[];
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
        reportProgress(request.progress, `Analyzing ${path.basename(reference.realPath)}`);
        return analyzeFileMetadata(reference, token);
    }

    /**
     * Analyse every supported file in a directory.
     *
     * Delta and Iceberg table directories are treated as a single logical
     * table rather than a list of Parquet parts.
     */
    async analyzeDirectory(request: AnalysisRequest): Promise<DirectoryAnalysis> {
        const token = request.token ?? NEVER_CANCELLED;
        throwIfCancelled(token);
        reportProgress(request.progress, 'Resolving directory');
        const reference = await this.resolve(request);
        reportProgress(request.progress, 'Scanning directory');
        const files = await scanDirectory(reference, token);
        return { root: reference.realPath, files };
    }

    /** Read a bounded tabular preview of a file. */
    async preview(request: PreviewRequest): Promise<PreviewResult> {
        const token = request.token ?? NEVER_CANCELLED;
        throwIfCancelled(token);
        const reference = await this.resolve(request);
        const metadata = await analyzeFileMetadata(reference, token);
        reportProgress(request.progress, 'Reading preview rows');
        return getPreviewData(
            reference,
            metadata,
            request.maxRows ?? PREVIEW_DEFAULT_ROWS,
            token,
        );
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
        return generateAllStatements(metadata, {
            tableName: request.tableName ?? null,
            schemaName: request.schemaName ?? 'dbo',
            dataSource: request.dataSource ?? 'MyDataSource',
            credentialName: request.credentialName ?? null,
            authMethod: request.authMethod ?? null,
            location: request.location ?? null,
            targetPlatform: request.targetPlatform ?? DEFAULT_TARGET_PLATFORM,
            storageUrl: request.storageUrl ?? null,
            formatName: request.formatName ?? null,
        });
    }

    /** Generate one runnable, GO-separated document containing every section. */
    generateCompleteDocument(request: GenerationRequest): string {
        const metadata = request.parserOverrides
            ? { ...request.metadata, parser_overrides: request.parserOverrides }
            : request.metadata;
        return generateCompleteDdl(metadata, {
            tableName: request.tableName ?? null,
            schemaName: request.schemaName ?? 'dbo',
            dataSource: request.dataSource ?? 'MyDataSource',
            credentialName: request.credentialName ?? null,
            authMethod: request.authMethod ?? null,
            location: request.location ?? null,
            targetPlatform: request.targetPlatform ?? DEFAULT_TARGET_PLATFORM,
            storageUrl: request.storageUrl ?? null,
            formatName: request.formatName ?? null,
        });
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
            });
            chunks.push(deduplicateSharedPrerequisites(script, seen));
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
