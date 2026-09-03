export type AzureBrowserPhase = 'closed' | 'signedOut' | 'loading' | 'ready' | 'error';
export type AzureBrowserErrorKind =
    | 'controlAccess'
    | 'dataAccess'
    | 'signIn'
    | 'temporary'
    | 'invalidResponse';

export interface AzureIdentity {
    readonly id: string;
    readonly label: string;
}

export interface AzureTenant {
    readonly id: string;
    readonly label: string;
}

export interface AzureSubscription {
    readonly id: string;
    readonly tenantId: string;
    readonly label: string;
}

export interface AzureStorageAccount {
    readonly id: string;
    readonly name: string;
    readonly resourceGroup: string;
    readonly location: string;
    readonly kind: string;
    readonly hns: boolean;
    readonly blobHost: string;
    readonly dfsHost: string;
}

export type AzureEntryKind = 'container' | 'folder' | 'file';

export interface AzureBrowserEntry {
    readonly id: string;
    readonly kind: AzureEntryKind;
    readonly name: string;
    readonly format: string | null;
    readonly supported: boolean;
    readonly sizeBytes: number | null;
    readonly modifiedAt: string | null;
}

export interface AzureBrowserState {
    readonly open: boolean;
    readonly phase: AzureBrowserPhase;
    readonly identity: AzureIdentity | null;
    readonly tenants: readonly AzureTenant[];
    readonly selectedTenantId: string | null;
    readonly subscriptions: readonly AzureSubscription[];
    readonly selectedSubscriptionId: string | null;
    readonly accounts: readonly AzureStorageAccount[];
    readonly selectedAccountId: string | null;
    readonly path: readonly string[];
    readonly entries: readonly AzureBrowserEntry[];
    readonly selectedEntryId: string | null;
    readonly hasMore: boolean;
    readonly errorKind: AzureBrowserErrorKind | null;
    readonly message: string | null;
}

export const CLOSED_AZURE_BROWSER_STATE: AzureBrowserState = Object.freeze({
    open: false,
    phase: 'closed',
    identity: null,
    tenants: [],
    selectedTenantId: null,
    subscriptions: [],
    selectedSubscriptionId: null,
    accounts: [],
    selectedAccountId: null,
    path: [],
    entries: [],
    selectedEntryId: null,
    hasMore: false,
    errorKind: null,
    message: null,
});
