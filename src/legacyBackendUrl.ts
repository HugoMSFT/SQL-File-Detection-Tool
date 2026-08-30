/**
 * Legacy helpers for the optional Python/Flask backend.
 *
 * Nothing on the native extension path imports this module. It exists only so
 * the deprecated `backend.ts` transition code keeps compiling until Layer 3
 * removes it, and it is kept separate precisely so port binding, loopback URL
 * construction and health polling cannot be reached from activation.
 *
 * @deprecated The default runtime is native. See `docs/native-ui.md`.
 */

import * as net from 'net';

import { redact } from './util';

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
