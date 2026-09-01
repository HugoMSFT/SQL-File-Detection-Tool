import type { TargetPlatform } from '../types';
import { storageUrlKind, urlparse } from './storage';

export const EXTERNAL_DATA_SOURCE_TYPES = [
    'azure_blob',
    'azure_data_lake',
    'fabric_onelake',
    's3',
] as const;

export type ExternalDataSourceType = (typeof EXTERNAL_DATA_SOURCE_TYPES)[number];

export const GUIDED_AUTH_METHODS = [
    'sas',
    's3_access_key',
    'user_identity',
    'managed_identity',
] as const;

export type GuidedAuthMethod = (typeof GUIDED_AUTH_METHODS)[number];

export interface CredentialWizardOption<T extends string> {
    readonly id: T;
    readonly label: string;
    readonly detail: string;
}

export interface CredentialWizardState {
    readonly dataSourceType: ExternalDataSourceType;
    readonly dataSourceOptions: readonly CredentialWizardOption<ExternalDataSourceType>[];
    readonly authMethod: GuidedAuthMethod | 'public';
    readonly authOptions: readonly CredentialWizardOption<GuidedAuthMethod | 'public'>[];
    readonly locationPrefix: string;
    readonly note: string;
}

export interface KnownStorageLocation {
    /** Normalized location safe to retain in renderer state and generated SQL. */
    readonly storageUrl: string;
    readonly dataSourceType: ExternalDataSourceType;
    /** True when a secret-bearing query or a fragment was removed. */
    readonly removedSuffix: boolean;
    /** True when the removed query contained a SAS signature. */
    readonly hadSasSignature: boolean;
}

const KNOWN_STORAGE_SCHEMES = new Set([
    'https:',
    'abs:',
    'wasb:',
    'wasbs:',
    'adls:',
    'abfs:',
    'abfss:',
    's3:',
    's3a:',
    's3n:',
]);

/**
 * Validate a user-known storage location and remove anything that must not
 * reach generated SQL. This path configures SQL only; it never fetches the URL.
 */
export function knownStorageLocation(value: string): KnownStorageLocation {
    const candidate = String(value ?? '').trim();
    if (!candidate) {
        throw new Error('Enter an Azure Blob, ADLS, OneLake, or s3:// location.');
    }
    if ([...candidate].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
    })) {
        throw new Error('The storage URL contains unsupported control characters.');
    }

    let parsed: URL;
    try {
        parsed = new URL(candidate);
    } catch {
        throw new Error('Enter a complete storage URL, including its scheme.');
    }
    if (!KNOWN_STORAGE_SCHEMES.has(parsed.protocol)) {
        throw new Error('Use an Azure Blob, ADLS, OneLake, or s3:// URL.');
    }
    if (!parsed.hostname) {
        throw new Error('The storage URL must include an account or bucket host.');
    }
    if (parsed.password || (
        (parsed.protocol === 'https:' || parsed.protocol.startsWith('s3'))
        && parsed.username
    )) {
        throw new Error('Storage URLs must not contain embedded user credentials.');
    }

    const hadSasSignature = [...parsed.searchParams.keys()]
        .some((key) => key.toLowerCase() === 'sig');
    const removedSuffix = Boolean(parsed.search || parsed.hash);
    parsed.search = '';
    parsed.hash = '';
    const storageUrl = parsed.toString();
    const dataSourceType = inferDataSourceType(storageUrl);
    if (!dataSourceType) {
        throw new Error('That URL is not a supported Azure Blob, ADLS, OneLake, or S3 location.');
    }
    if (
        (dataSourceType === 'azure_blob' || dataSourceType === 'azure_data_lake')
        && !parsed.username
        && parsed.pathname.split('/').filter(Boolean).length === 0
    ) {
        throw new Error('The Azure storage URL must include a container or file system.');
    }
    if (dataSourceType === 'fabric_onelake') {
        const segments = parsed.pathname.split('/').filter(Boolean);
        const filesIndex = segments.findIndex(
            (segment) => segment.toLowerCase() === 'files',
        );
        const requiredRootSegments = parsed.protocol === 'https:' ? 2 : 1;
        if (
            filesIndex < requiredRootSegments
            || (parsed.protocol !== 'https:' && !parsed.username)
        ) {
            throw new Error(
                'The OneLake URL must include a workspace, item, and Files location.',
            );
        }
    }

    return { storageUrl, dataSourceType, removedSuffix, hadSasSignature };
}

const SOURCE_OPTIONS: Readonly<
    Record<ExternalDataSourceType, CredentialWizardOption<ExternalDataSourceType>>
> = {
    azure_blob: {
        id: 'azure_blob',
        label: 'Azure Blob Storage',
        detail: 'Uses the ABS connector on modern SQL platforms.',
    },
    azure_data_lake: {
        id: 'azure_data_lake',
        label: 'Azure Data Lake Storage',
        detail: 'Uses the ADLS connector for ADLS Gen2.',
    },
    fabric_onelake: {
        id: 'fabric_onelake',
        label: 'Fabric OneLake',
        detail: 'Uses ABFSS on Fabric SQL Database and ADLS elsewhere.',
    },
    s3: {
        id: 's3',
        label: 'Amazon S3 / S3-compatible',
        detail: 'Uses the S3 connector on SQL Server 2022 or later.',
    },
};

const AUTH_OPTIONS: Readonly<
    Record<GuidedAuthMethod, CredentialWizardOption<GuidedAuthMethod>>
> = {
    sas: {
        id: 'sas',
        label: 'SAS token',
        detail: "Generates IDENTITY = 'SHARED ACCESS SIGNATURE' with a safe placeholder.",
    },
    s3_access_key: {
        id: 's3_access_key',
        label: 'S3 access key',
        detail: "Generates IDENTITY = 'S3 ACCESS KEY' with access-key placeholders.",
    },
    user_identity: {
        id: 'user_identity',
        label: 'Microsoft Entra ID',
        detail: "Uses the signed-in caller through IDENTITY = 'USER IDENTITY'.",
    },
    managed_identity: {
        id: 'managed_identity',
        label: 'User-assigned managed identity',
        detail: "Generates IDENTITY = 'MANAGED IDENTITY' without storing a secret.",
    },
};

const SOURCE_IDS: Readonly<Record<TargetPlatform, readonly ExternalDataSourceType[]>> = {
    sql_server_2019: ['azure_blob', 'azure_data_lake'],
    sql_server_2022: ['azure_blob', 'azure_data_lake', 'fabric_onelake', 's3'],
    sql_server_2025: ['azure_blob', 'azure_data_lake', 'fabric_onelake', 's3'],
    azure_sql_db: ['azure_blob', 'azure_data_lake', 'fabric_onelake'],
    azure_sql_mi: ['azure_blob', 'azure_data_lake', 'fabric_onelake'],
    fabric_sql_db: ['fabric_onelake'],
};

/** Return data sources supported by a target platform. */
export function dataSourceOptionsFor(
    platform: TargetPlatform,
): readonly CredentialWizardOption<ExternalDataSourceType>[] {
    return SOURCE_IDS[platform].map((id) => SOURCE_OPTIONS[id]);
}

/** Keep a selected source valid when the SQL platform changes. */
export function normalizeDataSourceType(
    value: string | null | undefined,
    platform: TargetPlatform,
): ExternalDataSourceType {
    const allowed = SOURCE_IDS[platform];
    return value && allowed.includes(value as ExternalDataSourceType)
        ? (value as ExternalDataSourceType)
        : platform === 'fabric_sql_db'
            ? 'fabric_onelake'
            : 'azure_blob';
}

function authIdsFor(
    platform: TargetPlatform,
    dataSourceType: ExternalDataSourceType,
): readonly GuidedAuthMethod[] {
    if (platform === 'fabric_sql_db') {
        return ['user_identity'];
    }
    if (dataSourceType === 's3') {
        return ['s3_access_key'];
    }
    switch (platform) {
        case 'sql_server_2019':
        case 'sql_server_2022':
            return ['sas'];
        case 'sql_server_2025':
            return ['sas', 'managed_identity'];
        case 'azure_sql_db':
            return ['managed_identity', 'user_identity', 'sas'];
        case 'azure_sql_mi':
            return ['managed_identity', 'sas'];
    }
}

/** Keep an authentication choice compatible with the selected platform and source. */
export function normalizeGuidedAuthMethod(
    value: string | null | undefined,
    platform: TargetPlatform,
    dataSourceType: ExternalDataSourceType,
): GuidedAuthMethod {
    const allowed = authIdsFor(platform, dataSourceType);
    return value && allowed.includes(value as GuidedAuthMethod)
        ? (value as GuidedAuthMethod)
        : allowed[0];
}

function locationPrefix(
    platform: TargetPlatform,
    dataSourceType: ExternalDataSourceType,
): string {
    if (platform === 'fabric_sql_db') {
        return 'ABFSS';
    }
    if (platform === 'sql_server_2019') {
        return dataSourceType === 'azure_blob' ? 'WASBS' : 'ABFSS';
    }
    if (dataSourceType === 'azure_blob') {
        return 'ABS';
    }
    if (dataSourceType === 's3') {
        return 'S3';
    }
    return 'ADLS';
}

function platformNote(
    platform: TargetPlatform,
    dataSourceType: ExternalDataSourceType,
    authMethod: GuidedAuthMethod | 'public',
): string {
    if (platform === 'fabric_sql_db') {
        return 'Fabric SQL Database supports only Fabric OneLake. The data source uses ABFSS and Microsoft Entra passthrough.';
    }
    if (platform === 'sql_server_2019') {
        return 'SQL Server 2019 uses legacy WASBS/ABFSS PolyBase locations and requires TYPE = HADOOP.';
    }
    if (dataSourceType === 'fabric_onelake') {
        return 'For this platform, Fabric OneLake is reached through the ADLS connector and emitted with an ADLS prefix.';
    }
    if (platform === 'sql_server_2025' && authMethod === 'managed_identity') {
        return 'Managed identity on SQL Server 2025 requires an Azure Arc-enabled instance with the selected user-assigned identity configured.';
    }
    if (authMethod === 'public') {
        return 'The selected source allows anonymous reads, so no database scoped credential is generated.';
    }
    return 'Secrets are never collected here. Generated SQL uses placeholders for SAS tokens and access keys.';
}

/** Build the non-secret, platform-aware model rendered by the setup wizard. */
export function credentialWizardState(
    platform: TargetPlatform,
    sourceValue: string | null | undefined,
    authValue: string | null | undefined,
): CredentialWizardState {
    const dataSourceType = normalizeDataSourceType(sourceValue, platform);
    const authIds = authIdsFor(platform, dataSourceType);
    const selectedAuth =
        authValue === 'public'
            ? 'public'
            : normalizeGuidedAuthMethod(authValue, platform, dataSourceType);
    const authOptions: CredentialWizardOption<GuidedAuthMethod | 'public'>[] =
        authIds.map((id) => AUTH_OPTIONS[id]);
    if (selectedAuth === 'public') {
        authOptions.unshift({
            id: 'public',
            label: 'Public / anonymous',
            detail: 'Source-derived anonymous access; no credential or secret is required.',
        });
    }
    return {
        dataSourceType,
        dataSourceOptions: dataSourceOptionsFor(platform),
        authMethod: selectedAuth,
        authOptions,
        locationPrefix: locationPrefix(platform, dataSourceType),
        note: platformNote(platform, dataSourceType, selectedAuth),
    };
}

/** Infer a guided source choice from a real storage URL when one is available. */
export function inferDataSourceType(
    storageUrl: string | null | undefined,
): ExternalDataSourceType | null {
    const kind = storageUrlKind(storageUrl);
    if (kind === 's3') {
        return 's3';
    }
    if (kind === 'onelake') {
        return 'fabric_onelake';
    }
    if (kind !== 'azure') {
        return null;
    }
    const parsed = urlparse(String(storageUrl).trim().replace(/\\/g, '/'));
    const host = parsed.netloc.toLowerCase();
    return ['adls', 'abfs', 'abfss'].includes(parsed.scheme)
        || host.endsWith('.dfs.core.windows.net')
        ? 'azure_data_lake'
        : 'azure_blob';
}

/**
 * Resolve the URL passed to SQL generation.
 *
 * A compatible real URL wins. Otherwise a non-secret placeholder makes the
 * wizard's source choice visible in the generated connector and URI prefix.
 */
export function effectiveStorageUrl(
    _platform: TargetPlatform,
    dataSourceType: ExternalDataSourceType,
    storageUrl: string | null | undefined,
    fileName: string,
): string {
    const inferred = inferDataSourceType(storageUrl);
    if (
        inferred === dataSourceType
        || (
            dataSourceType === 'fabric_onelake'
            && inferred === 'azure_data_lake'
            && String(storageUrl).includes('fabric.microsoft.com')
        )
    ) {
        return String(storageUrl);
    }
    const file = fileName || '<file>';
    switch (dataSourceType) {
        case 'azure_blob':
            return `https://<storage_account>.blob.core.windows.net/<container>/${file}`;
        case 'azure_data_lake':
            return `https://<storage_account>.dfs.core.windows.net/<container>/${file}`;
        case 'fabric_onelake':
            return `abfss://<workspace_id>@onelake.dfs.fabric.microsoft.com/<lakehouse_id>/Files/${file}`;
        case 's3':
            return `s3://<bucket>/${file}`;
    }
}
