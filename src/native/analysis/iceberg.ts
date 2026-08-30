/**
 * Apache Iceberg analysis from the table's current metadata JSON.
 *
 * This is a direct port of the Python implementation: the newest metadata file
 * is selected by numeric version, the schema identified by `current-schema-id`
 * is used, and the row count comes from the current snapshot's summary rather
 * than by scanning data files.
 */

import * as fs from 'fs';
import * as path from 'path';

import { throwIfCancelled, type CancellationToken } from '../cancellation';
import { NativeAnalysisError } from '../errors';
import { MAX_IN_MEMORY_BYTES } from '../limits';
import { containedRealPath } from '../paths';
import type { FileMetadata, IcebergMetadata, SchemaField } from '../types';

/** Directory holding Iceberg metadata files. */
export const ICEBERG_METADATA_DIR = 'metadata';

const VERSION_PATTERNS = [
    /^v(\d+)\.metadata\.json$/i,
    /^(\d+)(?:-[^.]+)?\.metadata\.json$/i,
];

/** Extract a numeric version from a metadata filename, if one is encoded. */
export function icebergMetadataVersion(metadataFile: string): number | null {
    const name = path.basename(metadataFile);
    for (const pattern of VERSION_PATTERNS) {
        const match = pattern.exec(name);
        if (match) {
            return Number(match[1]);
        }
    }
    return null;
}

/** True when the directory looks like an Iceberg table. */
export async function isIcebergTableDirectory(directory: string): Promise<boolean> {
    try {
        const metadataDir = await containedRealPath(directory, ICEBERG_METADATA_DIR);
        if (metadataDir === null) {
            return false;
        }
        const stats = await fs.promises.stat(metadataDir);
        if (!stats.isDirectory()) {
            return false;
        }
        const entries = await fs.promises.readdir(metadataDir);
        return entries.some((name) => name.toLowerCase().endsWith('.metadata.json'));
    } catch {
        return false;
    }
}

/**
 * Select the current metadata file.
 *
 * Ordering matches Python's `max((version, mtime, path))` so that two files
 * claiming the same version resolve identically in both backends.
 *
 * Every candidate is re-resolved against the table directory, so a metadata
 * directory or metadata file that is really a link out of the allowed root is
 * dropped rather than read.
 */
export async function latestIcebergMetadataFile(directory: string): Promise<string | null> {
    const metadataDir = await containedRealPath(directory, ICEBERG_METADATA_DIR);
    if (metadataDir === null) {
        return null;
    }
    let entries: string[];
    try {
        entries = await fs.promises.readdir(metadataDir);
    } catch {
        return null;
    }
    const candidates: string[] = [];
    for (const name of entries) {
        if (!name.toLowerCase().endsWith('.metadata.json')) {
            continue;
        }
        const candidate = await containedRealPath(metadataDir, name);
        if (candidate !== null) {
            candidates.push(candidate);
        }
    }
    if (candidates.length === 0) {
        return null;
    }

    const described: Array<{ version: number | null; mtime: number; file: string; }> = [];
    for (const candidate of candidates) {
        const stats = await fs.promises.stat(candidate);
        described.push({
            version: icebergMetadataVersion(candidate),
            mtime: stats.mtimeMs,
            file: candidate,
        });
    }

    const versioned = described.filter((entry) => entry.version !== null);
    const pool = versioned.length > 0 ? versioned : described;
    let best = pool[0];
    for (const entry of pool.slice(1)) {
        const betterVersion = (entry.version ?? 0) - (best.version ?? 0);
        if (versioned.length > 0 && betterVersion !== 0) {
            if (betterVersion > 0) {
                best = entry;
            }
            continue;
        }
        if (entry.mtime !== best.mtime) {
            if (entry.mtime > best.mtime) {
                best = entry;
            }
            continue;
        }
        if (entry.file > best.file) {
            best = entry;
        }
    }
    return best.file;
}

type JsonObject = Record<string, unknown>;

/** Return the schema identified by `current-schema-id`. */
export function currentIcebergSchema(metadata: JsonObject): JsonObject {
    const direct = metadata.schema;
    if (direct !== null && typeof direct === 'object' && !Array.isArray(direct)) {
        return direct as JsonObject;
    }
    const schemas = Array.isArray(metadata.schemas)
        ? (metadata.schemas.filter(
            (entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry),
        ) as JsonObject[])
        : [];
    const currentSchemaId = metadata['current-schema-id'];
    for (const schema of schemas) {
        if (schema['schema-id'] === currentSchemaId) {
            return schema;
        }
    }
    if (schemas.length > 0) {
        return schemas.reduce((best, schema) => {
            const bestId = typeof best['schema-id'] === 'number' ? (best['schema-id'] as number) : -1;
            const id = typeof schema['schema-id'] === 'number' ? (schema['schema-id'] as number) : -1;
            return id > bestId ? schema : best;
        });
    }
    return {};
}

/** Return the fields of the default partition spec. */
export function currentIcebergPartitionSpec(metadata: JsonObject): unknown[] {
    const direct = metadata['partition-spec'];
    if (Array.isArray(direct)) {
        return direct;
    }
    if (direct !== null && typeof direct === 'object') {
        const fields = (direct as JsonObject).fields;
        return Array.isArray(fields) ? fields : [];
    }
    const specs = Array.isArray(metadata['partition-specs'])
        ? ((metadata['partition-specs'] as unknown[]).filter(
            (entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry),
        ) as JsonObject[])
        : [];
    const defaultSpecId = metadata['default-spec-id'];
    for (const spec of specs) {
        if (spec['spec-id'] === defaultSpecId) {
            const fields = spec.fields;
            return Array.isArray(fields) ? fields : [];
        }
    }
    return [];
}

/** Read the authoritative row count from the current snapshot summary. */
export function icebergRowCount(metadata: JsonObject): number | null {
    const currentSnapshotId = metadata['current-snapshot-id'];
    if (currentSnapshotId === null || currentSnapshotId === undefined) {
        return 'current-snapshot-id' in metadata ? 0 : null;
    }
    const snapshots = Array.isArray(metadata.snapshots) ? metadata.snapshots : [];
    for (const raw of snapshots) {
        if (raw === null || typeof raw !== 'object') {
            continue;
        }
        const snapshot = raw as JsonObject;
        if (snapshot['snapshot-id'] !== currentSnapshotId) {
            continue;
        }
        const summary = (snapshot.summary ?? {}) as JsonObject;
        const totalRecords = summary['total-records'];
        const parsed =
            typeof totalRecords === 'number'
                ? Math.trunc(totalRecords)
                : typeof totalRecords === 'string' && /^-?\d+$/.test(totalRecords.trim())
                    ? Number(totalRecords.trim())
                    : null;
        return parsed === null ? null : Math.max(parsed, 0);
    }
    return null;
}

/** Map an Iceberg type to the internal type vocabulary. */
export function icebergType(raw: unknown): string {
    let value = raw;
    if (value !== null && typeof value === 'object') {
        const nested = String((value as JsonObject).type ?? 'string').toLowerCase();
        if (nested === 'list') {
            return 'list';
        }
        if (nested === 'struct' || nested === 'map') {
            return 'dict';
        }
        value = nested;
    }

    const normalized = String(value ?? 'string').toLowerCase().trim();
    const primitive = normalized.split(/[[(]/, 1)[0];

    if (primitive === 'decimal' || primitive === 'decimal128' || primitive === 'decimal256') {
        const match = /^decimal(?:128|256)?\s*\(\s*(\d+)\s*,\s*(-?\d+)\s*\)$/.exec(normalized);
        return match ? `decimal(${match[1]},${match[2]})` : 'decimal128';
    }

    const timestamps: Record<string, string> = {
        timestamp: 'timestamp[us]',
        timestamp_ntz: 'timestamp[us]',
        timestamptz: 'timestamp[us, tz=UTC]',
        timestamp_ns: 'timestamp[ns]',
        timestamptz_ns: 'timestamp[ns, tz=UTC]',
    };
    if (primitive in timestamps) {
        return timestamps[primitive];
    }

    const types: Record<string, string> = {
        boolean: 'bool',
        int: 'int32',
        long: 'int64',
        float: 'float32',
        double: 'float64',
        string: 'str',
        date: 'date',
        time: 'time64[us]',
        binary: 'binary',
        uuid: 'str',
        fixed: 'binary',
    };
    return types[primitive] ?? 'str';
}

/** Analyse an Iceberg table directory. */
export async function analyzeIceberg(
    directory: string,
    token?: CancellationToken,
): Promise<Partial<FileMetadata>> {
    try {
        throwIfCancelled(token);
        const metadataFile = await latestIcebergMetadataFile(directory);
        if (metadataFile === null) {
            return { error: 'No Iceberg metadata file found', encoding: 'binary' };
        }
        const stats = await fs.promises.stat(metadataFile);
        if (stats.size > MAX_IN_MEMORY_BYTES) {
            return { error: 'Iceberg metadata file is too large to read safely', encoding: 'binary' };
        }
        const text = await fs.promises.readFile(metadataFile, 'utf8');
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            // A parser message would embed a snippet of the file, which is a
            // content-disclosure channel for a file the caller cannot read.
            throw new NativeAnalysisError(
                'malformed_input',
                `Iceberg metadata file is not valid JSON: ${path.basename(metadataFile)}`,
            );
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new NativeAnalysisError(
                'malformed_input',
                'Iceberg metadata root must be a JSON object',
            );
        }
        const metadata = parsed as JsonObject;

        const schemaObject = currentIcebergSchema(metadata);
        const fields = schemaObject.fields;
        if (!Array.isArray(fields)) {
            throw new NativeAnalysisError(
                'malformed_input',
                'Iceberg schema fields must be a list',
            );
        }

        const schema: SchemaField[] = [];
        const nullableColumns: string[] = [];
        for (const raw of fields) {
            if (raw === null || typeof raw !== 'object') {
                continue;
            }
            const field = raw as JsonObject;
            const name = String(field.name ?? '');
            if (name.length === 0) {
                continue;
            }
            schema.push([name, icebergType(field.type)]);
            if (field.required !== true) {
                nullableColumns.push(name);
            }
        }

        const snapshots = Array.isArray(metadata.snapshots) ? metadata.snapshots : [];
        const icebergMetadata: IcebergMetadata = {
            format_version: numberOrNull(metadata['format-version']),
            table_uuid: stringOrNull(metadata['table-uuid']),
            location: stringOrNull(metadata.location),
            last_updated: numberOrNull(metadata['last-updated-ms']),
            current_schema_id: numberOrNull(metadata['current-schema-id']),
            default_spec_id: numberOrNull(metadata['default-spec-id']),
            partition_spec: currentIcebergPartitionSpec(metadata),
            metadata_file: path.basename(metadataFile),
            snapshot_count: snapshots.length,
        };

        return {
            schema,
            column_count: schema.length,
            row_count: icebergRowCount(metadata),
            nullable_columns: nullableColumns,
            iceberg_metadata: icebergMetadata,
            schema_inference: 'iceberg_metadata',
            encoding: 'binary',
        };
    } catch (error) {
        if (error instanceof NativeAnalysisError && error.code === 'cancelled') {
            throw error;
        }
        return { error: error instanceof Error ? error.message : String(error), encoding: 'binary' };
    }
}

function numberOrNull(value: unknown): number | null {
    return typeof value === 'number' ? value : null;
}

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}
