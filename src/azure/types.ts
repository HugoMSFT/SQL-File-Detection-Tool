export interface AzureIdentity {
    readonly label: string;
}

export interface AzureTenant {
    readonly id: string;
    readonly label: string;
}

export type AzureBrowserPhase = 'closed' | 'signedOut' | 'loading' | 'ready' | 'error';
export type AzureBrowserErrorKind =
    | 'controlAccess'
    | 'storageConsent'
    | 'storageAuthentication'
    | 'dataAccess'
    | 'publicAccess'
    | 'accountDisabled'
    | 'network'
    | 'notFound'
    | 'rateLimited'
    | 'timeout'
    | 'signIn'
    | 'temporary'
    | 'invalidResponse';

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
    readonly dfsHost: string | null;
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

export interface AzurePublicContainer {
    readonly accountName: string;
    readonly blobHost: string;
    readonly container: string;
}

/** Minted by the browser, never accepted from the renderer. */
export interface AzureStorageSelection {
    readonly url: string;
    readonly access: 'authenticated' | 'public';
}

interface AzureBrowserCommonState {
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

export type AzureBrowserState = AzureBrowserCommonState & (
    | { readonly mode: 'authenticated'; readonly publicContainer: null }
    | { readonly mode: 'public'; readonly publicContainer: AzurePublicContainer | null }
);

export const CLOSED_AZURE_BROWSER_STATE: AzureBrowserState = Object.freeze({
    mode: 'authenticated',
    publicContainer: null,
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
