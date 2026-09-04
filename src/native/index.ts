/**
 * Public entry point for the native (TypeScript) analysis and SQL generation
 * core.
 *
 * Consumers should import from `./native` rather than reaching into individual
 * modules, so the internal file layout stays free to change.
 */

export * from './types';
export * from './errors';
export {
    NEVER_CANCELLED,
    SimpleCancellationTokenSource,
    throwIfCancelled,
    type CancellationToken,
    type ProgressReport,
    type ProgressReporter,
} from './cancellation';
export {
    NativeAnalysisService,
    nativeAnalysisService,
    type AnalysisRequest,
    type DirectoryAnalysis,
    type DirectoryAnalysisRequest,
    type ExportEntry,
    type GenerationRequest,
    type MultiFileRequest,
    type PreviewRequest,
} from './service';
export {
    analyzeFileMetadata,
    clearMetadataCache,
    detectFileType,
    listSupportedFormats,
    scanDirectory,
    NATIVE_SUPPORT_BY_TYPE,
    SUPPORTED_EXTENSIONS,
    SQL_SOURCE_EXTENSIONS,
    isSqlSourceFile,
    sqlSourceFileType,
} from './detector';
export { clampPreviewRows, getPreviewData } from './preview';
export {
    directorySize,
    impliedRoot,
    isWithinRoot,
    listContainedEntries,
    resolveWithinRoot,
} from './paths';
export {
    deduplicateSharedPrerequisites,
    generateAllStatements,
    generateBestPractices,
    generateBulkInsert,
    generateCompleteDdl,
    generateCopyInto,
    generateCreateTable,
    generateCredentialSetup,
    generateExternalFileFormat,
    generateExternalTable,
    generateForJsonPath,
    generateJsonFunctions,
    resolveTableName,
    type BulkInsertOptions,
    type CredentialSetupOptions,
    type ExternalTableOptions,
    type GenerateAllOptions,
    type StatementOptions,
} from './sql/generator';
export { generateOpenrowset, type OpenrowsetOptions } from './sql/openrowset';
export {
    DEFAULT_TARGET_PLATFORM,
    PLATFORMS,
    PLATFORM_FEATURES,
    PLATFORM_LABELS,
    TYPE_MAPPING,
    hasIncompleteTypeEvidence,
    externalTableRecommendedSqlType,
    inferredColumnSqlType,
    mapTypeToSql,
    normalizePlatform,
    supports,
    type ExternalFormatType,
    type PlatformFeature,
} from './sql/typeMapping';
export {
    EXTERNAL_DATA_SOURCE_TYPES,
    GUIDED_AUTH_METHODS,
    credentialWizardState,
    dataSourceOptionsFor,
    effectiveStorageUrl,
    inferDataSourceType,
    knownStorageLocation,
    normalizeDataSourceType,
    normalizeGuidedAuthMethod,
    type CredentialWizardOption,
    type CredentialWizardState,
    type ExternalDataSourceType,
    type GuidedAuthMethod,
    type KnownStorageLocation,
} from './sql/credentialWizard';
export {
    DuplicateColumnError,
    cleanIdentifier,
    escapeIdentifier,
    quoteLiteral,
    validateUniqueColumnNames,
} from './sql/escaping';
