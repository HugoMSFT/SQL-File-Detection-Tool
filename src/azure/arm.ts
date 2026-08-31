/**
 * Minimal Azure Resource Manager discovery.
 *
 * Only two questions are asked — "which subscriptions can I see?" and "which
 * storage accounts are in this subscription?" — so this uses the REST API
 * directly rather than pulling in `@azure/arm-storage`. Everything else the
 * extension needs comes from the data plane.
 *
 * ARM is strictly optional. A user who knows their account name can attach to
 * it without an ARM token at all, which matters because many tenants do not
 * grant delegated ARM access to arbitrary clients.
 *
 * The token is a parameter, never a field, and never appears in a URL, a log
 * or an error. `fetch` is injectable so this is testable offline.
 */

import { redactAzure } from './storageUrl';

export const ARM_ENDPOINT = 'https://management.azure.com';
const SUBSCRIPTIONS_API = '2020-01-01';
const STORAGE_API = '2023-05-01';

/** Never walk more than this many pages, however many ARM offers. */
export const MAX_ARM_PAGES = 10;
/** Never return more than this many items to the UI. */
export const MAX_ARM_ITEMS = 200;

export type FetchLike = (
    input: string,
    init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
}>;

export interface ArmDeps {
    readonly fetchImpl?: FetchLike;
    readonly signal?: AbortSignal;
}

export class ArmError extends Error {
    constructor(message: string, readonly status: number) {
        super(redactAzure(message));
        this.name = 'ArmError';
    }
}

interface ArmPage {
    value?: unknown[];
    nextLink?: unknown;
}

function assertArmUrl(url: string): string {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new ArmError('Azure Resource Manager returned an unusable next link.', 502);
    }
    // `nextLink` is server-supplied, so it is treated as untrusted input: the
    // bearer token must only ever be sent to ARM itself.
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'management.azure.com') {
        throw new ArmError('Azure Resource Manager returned an unexpected next link.', 502);
    }
    return parsed.toString();
}

async function getPages(
    firstUrl: string,
    token: string,
    deps: ArmDeps,
): Promise<unknown[]> {
    const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (typeof fetchImpl !== 'function') {
        throw new ArmError('No HTTP client is available in this runtime.', 500);
    }
    const items: unknown[] = [];
    let url: string | null = assertArmUrl(firstUrl);
    for (let page = 0; page < MAX_ARM_PAGES && url && items.length < MAX_ARM_ITEMS; page += 1) {
        const response = await fetchImpl(url, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
            },
            signal: deps.signal,
        });
        if (!response.ok) {
            throw new ArmError(
                response.status === 401 || response.status === 403
                    ? 'Azure denied the request. Your account may not have access to this subscription.'
                    : `Azure Resource Manager returned ${response.status}.`,
                response.status,
            );
        }
        const body = (await response.json()) as ArmPage;
        for (const item of body?.value ?? []) {
            if (items.length >= MAX_ARM_ITEMS) {
                break;
            }
            items.push(item);
        }
        url = typeof body?.nextLink === 'string' ? assertArmUrl(body.nextLink) : null;
    }
    return items;
}

export interface Subscription {
    readonly id: string;
    readonly name: string;
}

/** List the subscriptions the signed-in account can see. */
export async function listSubscriptions(
    token: string,
    deps: ArmDeps = {},
): Promise<Subscription[]> {
    const raw = await getPages(
        `${ARM_ENDPOINT}/subscriptions?api-version=${SUBSCRIPTIONS_API}`,
        token,
        deps,
    );
    const subscriptions: Subscription[] = [];
    for (const item of raw) {
        const record = item as { subscriptionId?: unknown; displayName?: unknown };
        if (typeof record.subscriptionId !== 'string') {
            continue;
        }
        if (!/^[0-9a-fA-F-]{36}$/.test(record.subscriptionId)) {
            continue;
        }
        subscriptions.push({
            id: record.subscriptionId,
            name:
                typeof record.displayName === 'string' && record.displayName
                    ? record.displayName
                    : record.subscriptionId,
        });
    }
    return subscriptions;
}

/** List the storage account names in *subscriptionId*. */
export async function listStorageAccounts(
    token: string,
    subscriptionId: string,
    deps: ArmDeps = {},
): Promise<string[]> {
    if (!/^[0-9a-fA-F-]{36}$/.test(subscriptionId)) {
        throw new ArmError('That is not a valid subscription id.', 400);
    }
    const raw = await getPages(
        `${ARM_ENDPOINT}/subscriptions/${subscriptionId}` +
            `/providers/Microsoft.Storage/storageAccounts?api-version=${STORAGE_API}`,
        token,
        deps,
    );
    const names: string[] = [];
    for (const item of raw) {
        const record = item as { name?: unknown };
        if (typeof record.name === 'string' && /^[a-z0-9]{3,24}$/.test(record.name)) {
            names.push(record.name);
        }
    }
    return names;
}
