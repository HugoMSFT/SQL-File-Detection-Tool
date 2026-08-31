/**
 * Path containment.
 *
 * Analysis is always performed relative to an explicit allowed root. Both the
 * root and the requested path are resolved through `fs.realpath` before being
 * compared, so a symlink that points outside the root is rejected even though
 * its lexical path looks contained. Directory walks re-validate every entry
 * for the same reason.
 */

import * as fs from 'fs';
import * as path from 'path';

import { NativeAnalysisError, PathContainmentError } from './errors';
import type { StorageReference } from './types';

/** Case-insensitive comparison is required on Windows and macOS defaults. */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function normaliseForCompare(value: string): string {
    const resolved = path.resolve(value);
    return CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved;
}

/**
 * True when `candidate` is `root` itself or lives beneath it.
 *
 * Both arguments must already be absolute; the comparison is purely lexical so
 * callers are responsible for having resolved symlinks first.
 */
export function isWithinRoot(candidate: string, root: string): boolean {
    const normalisedRoot = normaliseForCompare(root);
    const normalisedCandidate = normaliseForCompare(candidate);
    if (normalisedCandidate === normalisedRoot) {
        return true;
    }
    const withSeparator = normalisedRoot.endsWith(path.sep)
        ? normalisedRoot
        : normalisedRoot + path.sep;
    return normalisedCandidate.startsWith(withSeparator);
}

async function realpathOrThrow(target: string): Promise<string> {
    try {
        return await fs.promises.realpath(target);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            throw new NativeAnalysisError('path_not_found', `Path not found: ${target}`);
        }
        throw new NativeAnalysisError('internal', `Cannot resolve path: ${target}`, code);
    }
}

/**
 * Resolve `requestedPath` and prove it is contained by `allowedRoot`.
 *
 * The root is resolved too, so a root that is itself a symlink still works.
 */
export async function resolveWithinRoot(
    requestedPath: string,
    allowedRoot: string,
): Promise<StorageReference> {
    if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
        throw new NativeAnalysisError('malformed_input', 'A file path is required');
    }
    if (requestedPath.indexOf('\0') !== -1) {
        throw new NativeAnalysisError('malformed_input', 'Path contains a NUL byte');
    }

    const realRoot = await realpathOrThrow(allowedRoot);
    const lexical = path.resolve(realRoot, requestedPath);

    // Reject the obvious traversal before touching the filesystem so that a
    // hostile path never triggers a stat outside the root.
    if (!isWithinRoot(lexical, realRoot)) {
        throw new PathContainmentError(
            'Path resolves outside the allowed root',
            `${requestedPath} -> ${lexical}`,
        );
    }

    const realTarget = await realpathOrThrow(lexical);
    if (!isWithinRoot(realTarget, realRoot)) {
        // Reached only when a symlink inside the root points outside it.
        throw new PathContainmentError(
            'Path resolves outside the allowed root through a symbolic link',
            `${requestedPath} -> ${realTarget}`,
        );
    }

    const stats = await fs.promises.stat(realTarget);
    return {
        realPath: realTarget,
        requestedPath,
        allowedRoot: realRoot,
        isDirectory: stats.isDirectory(),
        sizeBytes: stats.isDirectory() ? 0 : stats.size,
    };
}

/**
 * Resolve a child of an already-contained directory, or return `null`.
 *
 * Table formats (Delta, Iceberg) read sidecar files by name from inside a
 * directory the caller has already proven contained. Joining a name lexically is
 * not enough: a symlink or a Windows directory junction planted inside an
 * otherwise legitimate table directory would redirect the read outside the
 * allowed root and echo the contents back in the analysis result. Resolving the
 * child through `realpath` and re-checking containment against the parent closes
 * that, and because the parent is itself inside the allowed root, containment
 * under the parent implies containment under the root.
 *
 * The converse does not hold, and that is deliberate: a link that stays inside
 * the allowed root but points outside the table directory is also rejected. A
 * table directory that reaches sideways is not something the analysers need to
 * support, and the stricter rule keeps this helper free of any dependency on
 * ambient root state.
 *
 * Returns `null` — rather than throwing — when the child is missing or escapes,
 * because every caller treats "not a usable table file" the same way.
 */
export async function containedRealPath(
    parentRealPath: string,
    ...segments: string[]
): Promise<string | null> {
    const joined = path.join(parentRealPath, ...segments);
    if (joined.includes('\0')) {
        return null;
    }
    let real: string;
    try {
        real = await fs.promises.realpath(joined);
    } catch {
        return null;
    }
    return isWithinRoot(real, parentRealPath) ? real : null;
}

/**
 * List the immediate children of a directory reference, dropping anything that
 * escapes the allowed root (dangling or outward-pointing symlinks included).
 */
export async function listContainedEntries(
    reference: StorageReference,
): Promise<StorageReference[]> {
    if (!reference.isDirectory) {
        throw new NativeAnalysisError('not_a_directory', `Not a directory: ${reference.realPath}`);
    }
    const names = await fs.promises.readdir(reference.realPath);
    names.sort();

    const entries: StorageReference[] = [];
    for (const name of names) {
        try {
            const child = await resolveWithinRoot(
                path.join(reference.realPath, name),
                reference.allowedRoot,
            );
            entries.push(child);
        } catch {
            // Unreadable, dangling or escaping entries are simply skipped;
            // a directory listing must not fail because of one bad child.
            continue;
        }
    }
    return entries;
}

/** Recursive byte size of a directory, bounded to entries inside the root. */
export async function directorySize(reference: StorageReference): Promise<number> {
    if (!reference.isDirectory) {
        return reference.sizeBytes;
    }
    let total = 0;
    const stack: StorageReference[] = [reference];
    const seen = new Set<string>();
    while (stack.length > 0) {
        const current = stack.pop() as StorageReference;
        if (seen.has(current.realPath)) {
            continue;
        }
        seen.add(current.realPath);
        const children = await listContainedEntries(current);
        for (const child of children) {
            if (child.isDirectory) {
                stack.push(child);
            } else {
                total += child.sizeBytes;
            }
        }
    }
    return total;
}

/**
 * The allowed root implied by a caller-supplied path when no explicit root was
 * configured: the file's own directory, or the directory itself.
 */
export async function impliedRoot(target: string): Promise<string> {
    const absolute = path.resolve(target);
    let stats: fs.Stats;
    try {
        stats = await fs.promises.stat(absolute);
    } catch {
        return path.dirname(absolute);
    }
    return stats.isDirectory() ? absolute : path.dirname(absolute);
}
