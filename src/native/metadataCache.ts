import {
    CACHE_MAX_BYTES,
    CACHE_MAX_ENTRIES,
    CACHE_MAX_ENTRY_BYTES,
} from './limits';
import type { FileMetadata } from './types';

interface CacheEntry {
    signature: string;
    metadata: FileMetadata;
    bytes: number;
}

/**
 * Conservative JS retained-size accounting, without first serializing/cloning
 * an overweight value. Includes strings, keys, slots and container overhead.
 */
function retainedBytes(value: unknown, budget: number): number {
    if (typeof value === 'string') {
        return 48 + value.length * 2;
    }
    if (value === null || typeof value !== 'object') {
        return 16;
    }
    let bytes = 96;
    for (const [key, child] of Object.entries(value)) {
        bytes += 48 + key.length * 2 + retainedBytes(child, budget - bytes);
        if (bytes > budget) {
            break;
        }
    }
    return bytes;
}

/** Entry- and byte-bounded LRU. Results returned to callers never alias the cache. */
export class MetadataCache {
    private readonly entries = new Map<string, CacheEntry>();
    private bytes = 0;

    constructor(
        private readonly maxEntries = CACHE_MAX_ENTRIES,
        private readonly maxBytes = CACHE_MAX_BYTES,
        private readonly maxEntryBytes = CACHE_MAX_ENTRY_BYTES,
    ) {}

    get size(): number {
        return this.entries.size;
    }

    get retainedBytes(): number {
        return this.bytes;
    }

    delete(key: string): void {
        const entry = this.entries.get(key);
        if (entry) {
            this.bytes -= entry.bytes;
            this.entries.delete(key);
        }
    }

    get(key: string, signature: string): FileMetadata | null {
        const entry = this.entries.get(key);
        if (!entry) {
            return null;
        }
        if (entry.signature !== signature) {
            this.delete(key);
            return null;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return structuredClone(entry.metadata);
    }

    set(key: string, signature: string, metadata: FileMetadata): void {
        this.delete(key);
        if (metadata.analysis_stage === 'provisional' || metadata.error) {
            return;
        }
        const limit = Math.min(this.maxBytes, this.maxEntryBytes);
        const bytes = 192 + retainedBytes(key, limit) + retainedBytes(signature, limit)
            + retainedBytes(metadata, limit);
        if (bytes > limit || this.maxEntries < 1) {
            return;
        }
        while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
            const oldest = this.entries.keys().next();
            if (oldest.done) {
                break;
            }
            this.delete(oldest.value);
        }
        this.entries.set(key, { signature, metadata: structuredClone(metadata), bytes });
        this.bytes += bytes;
    }

    clear(): void {
        this.entries.clear();
        this.bytes = 0;
    }
}
