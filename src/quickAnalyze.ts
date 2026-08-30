import * as path from 'path';

import type {
    FileMetadata,
    FileType,
    ParserOverrides,
    StatementKind,
    TargetPlatform,
} from './native';

export const PROVENANCE = [
    'Detected',
    'Inferred',
    'Assumed',
    'Mapped',
    'From source',
    'Platform default',
    'Unavailable',
    'Unsupported',
    'Mixed',
    'Overridden',
] as const;

export type Provenance = (typeof PROVENANCE)[number];
export type ParserOptionKey = keyof ParserOverrides;
export type SourceKind = 'local' | 'azure' | 'public_https';

export interface ParserOptionState {
    readonly key: ParserOptionKey;
    readonly label: string;
    readonly value: string;
    readonly expectedValue: string;
    readonly provenance: Provenance;
    readonly evidence: string;
    readonly overridden: boolean;
    readonly advanced: boolean;
    readonly warning: string | null;
}

export interface ExternalObjectState {
    readonly kind: 'credential' | 'data_source' | 'file_format';
    readonly name: string;
    readonly required: boolean;
    readonly provenance: Provenance;
    readonly detail: string;
}

export interface SourceReadiness {
    readonly kind: SourceKind;
    readonly baseLocation: string | null;
    readonly relativePath: string | null;
    readonly directLocalRead: boolean;
    readonly stagingRequired: boolean;
    readonly detail: string;
    readonly objects: readonly ExternalObjectState[];
}

export interface PolyBaseGuidance {
    readonly visible: boolean;
    readonly detail: string | null;
}

export interface FolderProfile {
    readonly fileCount: number;
    readonly format: string;
    readonly delimiter: string;
    readonly encoding: string;
    readonly schema: string;
    readonly outlierCount: number;
}

export interface QuickAnalyzeState {
    readonly options: readonly ParserOptionState[];
    readonly source: SourceReadiness;
    readonly folderProfile: FolderProfile | null;
    readonly selectedStatement: StatementKind;
    readonly polybase: PolyBaseGuidance;
}

const DELIMITED = new Set<FileType>(['csv', 'text']);

function shown(value: unknown, fallback = 'Unavailable'): string {
    return value === null || value === undefined || value === '' ? fallback : String(value);
}

function option(
    key: ParserOptionKey,
    label: string,
    expectedValue: string,
    expectedProvenance: Provenance,
    evidence: string,
    overrides: ParserOverrides,
    advanced: boolean,
    warning: string | null = null,
): ParserOptionState {
    const override = overrides[key];
    const overridden = Object.prototype.hasOwnProperty.call(overrides, key);
    return {
        key,
        label,
        value: overridden ? shown(override, '') : expectedValue,
        expectedValue,
        provenance: overridden ? 'Overridden' : expectedProvenance,
        evidence,
        overridden,
        advanced,
        warning,
    };
}

export function parserOptionsFor(
    metadata: FileMetadata | null,
    overrides: ParserOverrides = {},
): readonly ParserOptionState[] {
    if (!metadata) {
        return [];
    }
    const delimited = DELIMITED.has(metadata.file_type);
    const encodingProvenance: Provenance =
        metadata.encoding_confidence >= 1 ? 'Detected' : 'Inferred';
    return [
        option(
            'format',
            'Format',
            metadata.file_type,
            'Inferred',
            'File signature, extension, and parser validation.',
            overrides,
            false,
        ),
        option(
            'firstRow',
            'Header / FIRSTROW',
            String(metadata.has_header ? 2 : 1),
            delimited ? 'Inferred' : 'Unavailable',
            delimited
                ? 'Header shape and sampled column values.'
                : 'FIRSTROW applies only to delimited readers.',
            overrides,
            false,
        ),
        option(
            'fieldDelimiter',
            'Field delimiter',
            shown(metadata.delimiter),
            metadata.delimiter ? 'Inferred' : 'Unavailable',
            metadata.delimiter
                ? 'Consistent field counts in sampled rows.'
                : 'No delimiter applies to this format.',
            overrides,
            false,
        ),
        option(
            'codepage',
            'CODEPAGE',
            shown(metadata.codepage),
            metadata.codepage ? 'Mapped' : 'Platform default',
            `Mapped from file encoding ${metadata.encoding} (${Math.round(
                metadata.encoding_confidence * 100,
            )}% confidence). The file encoding fact does not change when CODEPAGE is overridden.`,
            overrides,
            true,
            metadata.encoding_warning ?? null,
        ),
        option(
            'rowTerminator',
            'Row terminator',
            '0x0a',
            delimited ? 'Assumed' : 'Unavailable',
            delimited
                ? 'Safe generator default; line-ending evidence is not retained by analysis.'
                : 'No row terminator applies to this format.',
            overrides,
            true,
        ),
        option(
            'quoteCharacter',
            'Quote character',
            '"',
            delimited ? 'Assumed' : 'Unavailable',
            delimited
                ? 'RFC 4180 parser default; quote usage is not retained as a detected fact.'
                : 'No quote character applies to this format.',
            overrides,
            true,
        ),
        option(
            'compression',
            'Compression',
            shown(metadata.compression),
            metadata.compression ? 'Detected' : 'Unavailable',
            metadata.compression
                ? 'Read from container metadata.'
                : 'No compression metadata was observed.',
            overrides,
            true,
        ),
        {
            key: 'format',
            label: 'File encoding',
            value: metadata.encoding,
            expectedValue: metadata.encoding,
            provenance: encodingProvenance,
            evidence: `${Math.round(metadata.encoding_confidence * 100)}% confidence from file bytes.`,
            overridden: false,
            advanced: true,
            warning: metadata.encoding_warning ?? null,
        },
    ];
}

function cleanName(value: string, fallback: string): string {
    const cleaned = value
        .replace(/[^A-Za-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');
    return (cleaned || fallback).slice(0, 128);
}

export interface SourceInputs {
    readonly sourceKind: SourceKind;
    readonly storageUrl: string;
    readonly fileName: string;
    readonly fileType: FileType;
    readonly dataSource: string;
    readonly credentialName: string;
    readonly formatName: string;
    readonly authMethod: string;
    readonly platform: TargetPlatform;
    readonly selectedStatement: StatementKind;
}

export function sourceReadiness(inputs: SourceInputs): SourceReadiness {
    const formatName = inputs.formatName || `ff_${inputs.fileType}_format`;
    if (inputs.sourceKind === 'local' || !inputs.storageUrl) {
        const direct = inputs.platform.startsWith('sql_server_');
        return {
            kind: 'local',
            baseLocation: null,
            relativePath: null,
            directLocalRead: direct,
            stagingRequired: !direct,
            detail: direct
                ? 'Direct local or UNC read is available when the SQL Server service account can access the path.'
                : 'Local client paths are unavailable to this target. Stage the file in supported cloud storage.',
            objects: [],
        };
    }

    let parsed: URL;
    try {
        parsed = new URL(inputs.storageUrl);
    } catch {
        return {
            kind: inputs.sourceKind,
            baseLocation: null,
            relativePath: null,
            directLocalRead: false,
            stagingRequired: true,
            detail: 'The source URL cannot be translated into a target-readable location.',
            objects: [],
        };
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    const azure = /\.blob\.core\.windows\.net$|\.dfs\.core\.windows\.net$/i.test(
        parsed.hostname,
    );
    const basePath = azure && parts.length > 0 ? `/${parts[0]}` : path.posix.dirname(parsed.pathname);
    const relativePath = azure ? parts.slice(1).join('/') : path.posix.basename(parsed.pathname);
    const baseLocation = `${parsed.protocol}//${parsed.host}${basePath === '/' ? '' : basePath}`;
    if (!azure) {
        return {
            kind: 'public_https',
            baseLocation,
            relativePath,
            directLocalRead: false,
            stagingRequired: true,
            detail: 'The parent public HTTPS URL is from source, but this target cannot create an external data source for an arbitrary host. Stage it in supported storage.',
            objects: [],
        };
    }

    const publicAccess = inputs.authMethod === 'public';
    const needsDataSource = new Set<StatementKind>([
        'bulk_insert',
        'openrowset',
        'create_external_table',
        'credential_setup',
        'json_functions',
    ]).has(inputs.selectedStatement);
    const needsFileFormat =
        inputs.selectedStatement === 'external_file_format' ||
        inputs.selectedStatement === 'create_external_table';
    if (!needsDataSource && !needsFileFormat) {
        return {
            kind: 'azure',
            baseLocation,
            relativePath,
            directLocalRead: false,
            stagingRequired: false,
            detail: 'This statement does not require external storage objects.',
            objects: [],
        };
    }
    const credential = cleanName(
        inputs.credentialName || `cred_${inputs.dataSource}`,
        'cred_storage',
    );
    return {
        kind: 'azure',
        baseLocation,
        relativePath,
        directLocalRead: false,
        stagingRequired: false,
        detail: 'Base LOCATION and relative file path are derived from the selected account and container.',
        objects: [
            ...(needsDataSource
                ? [{
                kind: 'credential',
                name: credential,
                required: !publicAccess,
                provenance: publicAccess ? 'Unavailable' : 'From source',
                detail: publicAccess
                    ? 'Anonymous public access needs no database scoped credential.'
                    : 'Required by the selected storage authentication.',
            } as const,
            {
                kind: 'data_source',
                name: cleanName(inputs.dataSource, 'ds_storage'),
                required: true,
                provenance: 'From source',
                detail: `LOCATION base: ${baseLocation}`,
            } as const]
                : []),
            ...(needsFileFormat
                ? [{
                kind: 'file_format',
                name: cleanName(formatName, 'ff_data_format'),
                required: true,
                provenance: 'Mapped',
                detail: `Mapped from ${inputs.fileType}; OPENROWSET/BULK parser options do not necessarily use this object.`,
            } as const]
                : []),
        ],
    };
}

export function suggestedObjectNames(
    storageUrl: string,
    fileType: FileType,
    authMethod: string,
): { dataSource: string; formatName: string; credentialName: string } {
    let source = 'storage';
    try {
        const url = new URL(storageUrl);
        const container = url.pathname.split('/').filter(Boolean)[0] ?? 'container';
        source = `${url.hostname.split('.')[0]}_${container}`;
    } catch {
        // A guarded fallback is a suggestion only; generation still validates the URL.
    }
    const dataSource = cleanName(`ds_${source}`, 'ds_storage');
    return {
        dataSource,
        formatName: cleanName(`ff_${fileType}_format`, 'ff_data_format'),
        credentialName:
            authMethod === 'public' ? '' : cleanName(`cred_${source}`, 'cred_storage'),
    };
}

function consensus(values: readonly string[]): { value: string; outliers: number } {
    const counts = new Map<string, number>();
    for (const value of values) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0) {
        return { value: 'Unavailable', outliers: 0 };
    }
    if (ranked.length > 1) {
        return { value: 'Mixed', outliers: values.length - ranked[0][1] };
    }
    return { value: ranked[0][0], outliers: 0 };
}

export function folderProfileFor(files: readonly FileMetadata[]): FolderProfile | null {
    if (files.length < 2) {
        return null;
    }
    const format = consensus(files.map((file) => file.file_type));
    const delimiter = consensus(files.map((file) => shown(file.delimiter)));
    const encoding = consensus(files.map((file) => file.encoding));
    const schema = consensus(
        files.map((file) => JSON.stringify(file.schema ?? [])),
    );
    return {
        fileCount: files.length,
        format: format.value,
        delimiter: delimiter.value,
        encoding: encoding.value,
        schema: schema.value === 'Mixed' ? 'Mixed' : 'Consistent',
        outlierCount: Math.max(
            format.outliers,
            delimiter.outliers,
            encoding.outliers,
            schema.outliers,
        ),
    };
}

export function polyBaseGuidance(
    platform: TargetPlatform,
    statement: StatementKind,
): PolyBaseGuidance {
    const requiresPolyBase =
        statement === 'create_external_table'
        && (platform === 'sql_server_2019' || platform === 'sql_server_2022');
    return {
        visible: requiresPolyBase,
        detail: requiresPolyBase
            ? "SQL Server Setup must first install 'PolyBase Query Service for External Data'. Then run sp_configure 'polybase enabled' to enable that installed feature; sp_configure does not install it."
            : null,
    };
}
