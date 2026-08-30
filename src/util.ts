/**
 * Pure helpers shared by the extension.
 *
 * These deliberately have no `vscode` import so they can be unit tested with
 * plain `node --test`.
 */

import * as net from 'net';
import * as path from 'path';

/** Platform ids accepted by the backend. Azure SQL Database is the default. */
export const DEFAULT_PLATFORM = 'azure_sql_db';

export const SUPPORTED_PLATFORMS = [
    'azure_sql_db',
    'azure_sql_mi',
    'sql_server_2025',
    'sql_server_2022',
    'sql_server_2019',
    'fabric_sql_db',
] as const;

export type Platform = (typeof SUPPORTED_PLATFORMS)[number];

/** Normalize an arbitrary setting value to a supported platform id. */
export function normalizePlatform(value: unknown): Platform {
    const candidate = String(value ?? '').trim();
    return (SUPPORTED_PLATFORMS as readonly string[]).includes(candidate)
        ? (candidate as Platform)
        : DEFAULT_PLATFORM;
}

/** Only loopback hosts are ever used; anything else falls back to 127.0.0.1. */
export function normalizeHost(value: unknown): string {
    const candidate = String(value ?? '').trim().toLowerCase();
    return candidate === 'localhost' ? 'localhost' : '127.0.0.1';
}

/**
 * Ask the OS for a free TCP port on *host*.
 *
 * Binding to port 0 and reading back the assigned port avoids the race-prone
 * "scan a range and hope" approach and keeps the backend on loopback only.
 */
export function findFreePort(host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen({ host, port: 0, exclusive: true }, () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('Could not determine a free port')));
                return;
            }
            const { port } = address;
            server.close((err) => (err ? reject(err) : resolve(port)));
        });
    });
}

export interface AppUrlOptions {
    host: string;
    port: number;
    /** Absolute file path to analyze on open. */
    path?: string;
    /** Absolute directory path to analyze on open. */
    folder?: string;
    /** Open the Azure Storage explorer immediately. */
    azure?: boolean;
}

/**
 * Build the backend URL.
 *
 * Paths are passed as query parameters and always percent-encoded. No token or
 * secret is ever placed in a URL.
 */
export function buildAppUrl(options: AppUrlOptions): string {
    const host = normalizeHost(options.host);
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${String(options.port)}`);
    }
    const params = new URLSearchParams();
    if (options.path) {
        params.set('path', options.path);
    } else if (options.folder) {
        params.set('folder', options.folder);
    }
    if (options.azure) {
        params.set('azure', '1');
    }
    const query = params.toString();
    return `http://${host}:${port}/${query ? `?${query}` : ''}`;
}

/** Build the health probe URL for a running backend. */
export function buildHealthUrl(host: string, port: number): string {
    return `http://${normalizeHost(host)}:${port}/api/health`;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
    // Bearer tokens and raw JWTs.
    [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer <redacted>'],
    [/\beyJ[A-Za-z0-9._-]{10,}/g, '<redacted-token>'],
    // Connection-string secrets.
    [/(AccountKey|SharedAccessSignature|SharedAccessKey)=[^;\s"']+/gi, '$1=<redacted>'],
    // SAS query parameters.
    [/([?&](?:sig|skoid|sktid|sks|si|se|st)=)[^&\s"']+/gi, '$1<redacted>'],
];

/**
 * Remove anything that looks like a credential from text bound for the output
 * channel, the status bar or an error message.
 */
export function redact(text: unknown): string {
    let value = String(text ?? '');
    for (const [pattern, replacement] of SECRET_PATTERNS) {
        value = value.replace(pattern, replacement);
    }
    return value;
}

/** File extensions the backend can analyze directly. */
export const SUPPORTED_EXTENSIONS = new Set([
    '.csv', '.tsv', '.txt', '.json', '.jsonl', '.ndjson',
    '.parquet', '.orc', '.avro', '.xlsx', '.xls',
]);

/** True when *fsPath* looks like a file the tool understands. */
export function isSupportedFile(fsPath: string): boolean {
    const lower = fsPath.toLowerCase();
    const dot = lower.lastIndexOf('.');
    if (dot < 0) {
        return false;
    }
    return SUPPORTED_EXTENSIONS.has(lower.slice(dot));
}

/**
 * True when *target* is inside *root* (or is *root* itself).
 *
 * Mirrors the backend's `_is_within_root` guard so the extension can predict a
 * rejection before it happens instead of surfacing an opaque server error.
 */
export function isWithinRoot(target: string, root: string): boolean {
    if (!target || !root) {
        return false;
    }
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(target);
    const relative = path.relative(resolvedRoot, resolvedTarget);
    if (relative === '') {
        return true;
    }
    return (
        !relative.startsWith(`..${path.sep}`) &&
        relative !== '..' &&
        !path.isAbsolute(relative)
    );
}

export interface RootOptions {
    /** `sqlFileDetectionTool.rootDirectory`; wins over everything when set. */
    override?: string;
    /** Path the user asked to analyze, if any. */
    hint?: string;
    /** True when *hint* is a directory rather than a file. */
    hintIsDirectory?: boolean;
    /** Absolute paths of the open workspace folders. */
    workspaceFolders?: string[];
    /** Fallback when nothing else applies. */
    home: string;
}

/**
 * Choose the directory the backend is allowed to read.
 *
 * The backend confines every local path to a single root, so the extension has
 * to pick one that actually contains what the user asked for. Preference order
 * is: the explicit setting, the workspace folder containing the target, the
 * target's own directory, the first workspace folder, then the home directory.
 */
export function computeRoot(options: RootOptions): string {
    const override = String(options.override ?? '').trim();
    if (override) {
        return path.resolve(override);
    }
    const folders = (options.workspaceFolders ?? []).filter(Boolean).map((f) => path.resolve(f));
    const hint = String(options.hint ?? '').trim();
    if (hint) {
        const resolved = path.resolve(hint);
        const containing = folders.find((folder) => isWithinRoot(resolved, folder));
        if (containing) {
            return containing;
        }
        return options.hintIsDirectory ? resolved : path.dirname(resolved);
    }
    if (folders.length > 0) {
        return folders[0];
    }
    return path.resolve(options.home);
}

/** Wait until the backend answers its health endpoint, or time out. */
export async function waitForHealth(
    url: string,
    timeoutMs: number,
    isCancelled: () => boolean = () => false,
    fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'backend did not start';
    while (Date.now() < deadline) {
        if (isCancelled()) {
            throw new Error('Cancelled');
        }
        try {
            const response = await fetchImpl(url);
            if (response.ok) {
                return (await response.json()) as Record<string, unknown>;
            }
            lastError = `health check returned ${response.status}`;
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Backend health check failed: ${redact(lastError)}`);
}

/**
 * Runs asynchronous work one item at a time, in the order it was requested.
 *
 * Unlike collapsing concurrent calls into a single shared promise, every caller
 * keeps its own arguments and its own result. That matters when the requests
 * are not interchangeable: opening the interface for a specific file must not
 * be satisfied by an unrelated request that happened to already be running.
 * A rejected item is contained so it cannot cancel the ones queued behind it.
 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(task: () => Promise<T>): Promise<T> => {
        const queued = tail.then(
            () => task(),
            () => task(),
        );
        tail = queued.catch(() => undefined);
        return queued;
    };
}
