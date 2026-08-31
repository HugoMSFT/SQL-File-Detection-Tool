/**
 * Delta Lake analysis straight from the `_delta_log` transaction log.
 *
 * The Python backend needs the optional `deltalake` wheel for this and falls
 * back to reading one underlying Parquet file when it is missing. The native
 * core parses the log itself — it is line-delimited JSON — so schema, partition
 * columns, table version and (when the writer recorded statistics) an exact row
 * count are available with no extra dependency.
 */

import * as fs from 'fs';

import { throwIfCancelled, type CancellationToken } from '../cancellation';
import { NativeAnalysisError } from '../errors';
import { MAX_DELTA_LOG_FILES } from '../limits';
import { containedRealPath } from '../paths';
import type { DeltaMetadata, FileMetadata, SchemaField } from '../types';
import { readLines } from '../streams';
import { analyzeParquet } from './parquet';

/** Directory name holding the Delta transaction log. */
export const DELTA_LOG_DIR = '_delta_log';

/** Depth ceiling for the data-file search, so a deep tree cannot stall analysis. */
const MAX_DELTA_WALK_DEPTH = 32;

const COMMIT_PATTERN = /^(\d{20})\.json$/;

/**
 * Map a Delta type to the Arrow-style names the SQL type mapper understands.
 *
 * Keeping one vocabulary means Delta, Parquet and Iceberg columns all flow
 * through the same `TYPE_MAPPING`, so a `long` column becomes `BIGINT` no
 * matter which catalogue described it.
 */
export function deltaTypeName(raw: unknown): string {
    if (raw !== null && typeof raw === 'object') {
        const nested = raw as { type?: unknown; elementType?: unknown; fields?: unknown; keyType?: unknown; valueType?: unknown; };
        const kind = String(nested.type ?? 'string').toLowerCase();
        if (kind === 'array') {
            return `list<element: ${deltaTypeName(nested.elementType)}>`;
        }
        if (kind === 'map') {
            return `map<${deltaTypeName(nested.keyType)}, ${deltaTypeName(nested.valueType)}>`;
        }
        if (kind === 'struct') {
            const fields = Array.isArray(nested.fields) ? nested.fields : [];
            const rendered = fields
                .map((field) => {
                    const entry = field as { name?: unknown; type?: unknown; };
                    return `${String(entry.name ?? '')}: ${deltaTypeName(entry.type)}`;
                })
                .join(', ');
            return `struct<${rendered}>`;
        }
        return deltaTypeName(kind);
    }

    const normalized = String(raw ?? 'string').toLowerCase().trim();
    const decimal = /^decimal\s*\(\s*(\d+)\s*,\s*(-?\d+)\s*\)$/.exec(normalized);
    if (decimal) {
        return `decimal(${decimal[1]},${decimal[2]})`;
    }
    const mapping: Record<string, string> = {
        boolean: 'bool',
        byte: 'int8',
        tinyint: 'int8',
        short: 'int16',
        smallint: 'int16',
        integer: 'int32',
        int: 'int32',
        long: 'int64',
        bigint: 'int64',
        float: 'float32',
        double: 'float64',
        string: 'str',
        binary: 'binary',
        date: 'date32[day]',
        timestamp: 'timestamp[us, tz=UTC]',
        timestamp_ntz: 'timestamp[us]',
        decimal: 'decimal128',
    };
    return mapping[normalized] ?? 'str';
}

interface DeltaLogState {
    version: number | null;
    metaData: Record<string, unknown> | null;
    rowCounts: Map<string, number>;
    statsComplete: boolean;
    hasCheckpoint: boolean;
}

/**
 * List the JSON commit files in ascending version order.
 *
 * Names must match the exact Delta commit pattern *and* resolve back inside the
 * log directory, so a link masquerading as a commit file is never read.
 */
async function listCommits(logDir: string): Promise<Array<{ version: number; file: string; }>> {
    const entries = await fs.promises.readdir(logDir, { withFileTypes: true });
    const commits: Array<{ version: number; file: string; }> = [];
    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }
        const match = COMMIT_PATTERN.exec(entry.name);
        if (!match) {
            continue;
        }
        const file = await containedRealPath(logDir, entry.name);
        if (file !== null) {
            commits.push({ version: Number(match[1]), file });
        }
    }
    commits.sort((left, right) => left.version - right.version);
    return commits;
}

/** Replay the JSON commits, tracking the newest metadata and live data files. */
async function replayLog(
    logDir: string,
    token?: CancellationToken,
): Promise<DeltaLogState> {
    const state: DeltaLogState = {
        version: null,
        metaData: null,
        rowCounts: new Map(),
        statsComplete: true,
        hasCheckpoint: false,
    };

    const entries = await fs.promises.readdir(logDir);
    state.hasCheckpoint = entries.some((name) => name.includes('.checkpoint.'));

    const commits = await listCommits(logDir);
    if (commits.length > MAX_DELTA_LOG_FILES) {
        // Only the most recent commits are replayed; the schema still comes
        // from the newest `metaData` action seen, so this stays correct while
        // bounding the work for a very long-lived table.
        commits.splice(0, commits.length - MAX_DELTA_LOG_FILES);
        state.statsComplete = false;
    }

    for (const commit of commits) {
        throwIfCancelled(token);
        state.version = commit.version;
        for await (const line of readLines(commit.file, { encoding: 'utf-8', token })) {
            const trimmed = line.trim();
            if (trimmed.length === 0) {
                continue;
            }
            let action: Record<string, unknown>;
            try {
                action = JSON.parse(trimmed) as Record<string, unknown>;
            } catch {
                state.statsComplete = false;
                continue;
            }
            if (action.metaData && typeof action.metaData === 'object') {
                state.metaData = action.metaData as Record<string, unknown>;
            } else if (action.add && typeof action.add === 'object') {
                const add = action.add as { path?: unknown; stats?: unknown; };
                const key = String(add.path ?? '');
                const records = readNumRecords(add.stats);
                if (records === null) {
                    state.statsComplete = false;
                } else {
                    state.rowCounts.set(key, records);
                }
            } else if (action.remove && typeof action.remove === 'object') {
                const remove = action.remove as { path?: unknown; };
                state.rowCounts.delete(String(remove.path ?? ''));
            }
        }
    }
    return state;
}

function readNumRecords(stats: unknown): number | null {
    if (typeof stats !== 'string') {
        return null;
    }
    try {
        const parsed = JSON.parse(stats) as { numRecords?: unknown; };
        return typeof parsed.numRecords === 'number' ? parsed.numRecords : null;
    } catch {
        return null;
    }
}

/**
 * Locate the first Parquet data file, skipping Delta's own metadata folders.
 *
 * Every step is re-resolved against its parent so a link planted inside the
 * table directory cannot walk the search out of the allowed root.
 */
export async function firstParquetFile(directory: string): Promise<string | null> {
    const excluded = new Set([DELTA_LOG_DIR, '_change_data', '_symlink_format_manifest']);
    const walk = async (current: string, depth: number): Promise<string | null> => {
        if (depth > MAX_DELTA_WALK_DEPTH) {
            return null;
        }
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(current, { withFileTypes: true });
        } catch {
            return null;
        }
        const files = entries
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
            .sort();
        for (const name of files) {
            if (name.toLowerCase().endsWith('.parquet')) {
                const contained = await containedRealPath(current, name);
                if (contained !== null) {
                    return contained;
                }
            }
        }
        const directories = entries
            .filter((entry) => entry.isDirectory() && !excluded.has(entry.name))
            .map((entry) => entry.name)
            .sort();
        for (const name of directories) {
            const child = await containedRealPath(current, name);
            if (child === null) {
                continue;
            }
            const found = await walk(child, depth + 1);
            if (found !== null) {
                return found;
            }
        }
        return null;
    };
    return walk(directory, 0);
}

/** True when the directory carries a Delta transaction log. */
export async function isDeltaTableDirectory(directory: string): Promise<boolean> {
    try {
        const logDir = await containedRealPath(directory, DELTA_LOG_DIR);
        if (logDir === null) {
            return false;
        }
        const stats = await fs.promises.stat(logDir);
        return stats.isDirectory();
    } catch {
        return false;
    }
}

/** Analyse a Delta table directory from its transaction log. */
export async function analyzeDelta(
    directory: string,
    token?: CancellationToken,
): Promise<Partial<FileMetadata>> {
    try {
        const logDir = await containedRealPath(directory, DELTA_LOG_DIR);
        if (logDir === null) {
            return fallbackToParquet(
                directory,
                'Delta log is not readable inside the table directory; schema ' +
                    'derived from one underlying Parquet file.',
                token,
            );
        }
        const state = await replayLog(logDir, token);
        if (state.metaData === null) {
            return fallbackToParquet(
                directory,
                'Delta log contains no metaData action; schema derived from one ' +
                    'underlying Parquet file.',
                token,
            );
        }

        const meta = state.metaData;
        const schemaString = typeof meta.schemaString === 'string' ? meta.schemaString : '{}';
        const parsed = JSON.parse(schemaString) as { fields?: unknown; };
        const fields = Array.isArray(parsed.fields) ? parsed.fields : [];

        const schema: SchemaField[] = [];
        const nullableColumns: string[] = [];
        for (const raw of fields) {
            const field = raw as { name?: unknown; type?: unknown; nullable?: unknown; };
            const name = String(field.name ?? '');
            if (name.length === 0) {
                continue;
            }
            schema.push([name, deltaTypeName(field.type)]);
            if (field.nullable !== false) {
                nullableColumns.push(name);
            }
        }

        const partitionColumns = Array.isArray(meta.partitionColumns)
            ? meta.partitionColumns.map((value) => String(value))
            : [];
        const configuration: Record<string, string> = {};
        if (meta.configuration && typeof meta.configuration === 'object') {
            for (const [key, value] of Object.entries(meta.configuration as Record<string, unknown>)) {
                configuration[key] = String(value);
            }
        }

        const deltaMetadata: DeltaMetadata = {
            version: state.version,
            name: typeof meta.name === 'string' ? meta.name : null,
            description: typeof meta.description === 'string' ? meta.description : null,
            partition_columns: partitionColumns,
            created_time:
                typeof meta.createdTime === 'number' ? String(meta.createdTime) : null,
            configuration,
        };

        // A row count is only claimed when every live data file carried
        // `numRecords` statistics and no checkpoint hid earlier commits.
        const exactRowCount =
            state.statsComplete && !state.hasCheckpoint
                ? Array.from(state.rowCounts.values()).reduce((total, value) => total + value, 0)
                : null;

        return {
            schema,
            column_count: schema.length,
            row_count: exactRowCount,
            nullable_columns: nullableColumns,
            delta_metadata: deltaMetadata,
            schema_inference: 'delta_log',
            encoding: 'binary',
        };
    } catch (error) {
        if (error instanceof NativeAnalysisError && error.code === 'cancelled') {
            throw error;
        }
        const reason = error instanceof Error ? error.message : String(error);
        return fallbackToParquet(
            directory,
            `Delta log parsing failed (${reason}). Metadata derived from one underlying Parquet file.`,
            token,
        );
    }
}

async function fallbackToParquet(
    directory: string,
    warning: string,
    token?: CancellationToken,
): Promise<Partial<FileMetadata>> {
    const parquetFile = await firstParquetFile(directory);
    if (parquetFile === null) {
        return {
            error: 'No underlying Parquet data file found',
            warning,
            encoding: 'binary',
        };
    }
    const result = await analyzeParquet(parquetFile, token);
    return {
        ...result,
        row_count: null,
        warning,
        schema_inference: 'underlying_parquet_file',
    };
}
