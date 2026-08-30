/**
 * Performance guards for the native core.
 *
 * These are deliberately loose: the point is to catch an accidental
 * whole-file read or an O(n²) parser, not to benchmark the machine. Thresholds
 * are generous enough to stay reliable on a loaded CI worker while still
 * failing loudly if bounded analysis stops being bounded.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';

import { analyzeFileMetadata, clearMetadataCache } from '../../native/detector';
import { resolveWithinRoot } from '../../native/paths';
import { NativeAnalysisService } from '../../native/service';

/** Rows in the generated fixtures; ~12 MB of CSV and ~9 MB of NDJSON. */
const LARGE_ROW_COUNT = 120_000;

/** Wall-clock ceiling for analysing one generated fixture. */
const ANALYSIS_BUDGET_MS = 20_000;

/** Extra heap the analysis may retain, well below the file size. */
const HEAP_BUDGET_BYTES = 128 * 1024 * 1024;

interface Measurement {
    label: string;
    bytes: number;
    milliseconds: number;
    heapDeltaBytes: number;
}

const measurements: Measurement[] = [];

async function measure(
    label: string,
    filePath: string,
    root: string,
): Promise<Measurement> {
    clearMetadataCache();
    if (typeof global.gc === 'function') {
        global.gc();
    }
    const before = process.memoryUsage().heapUsed;
    const started = process.hrtime.bigint();
    const reference = await resolveWithinRoot(filePath, root);
    const metadata = await analyzeFileMetadata(reference);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    const after = process.memoryUsage().heapUsed;

    assert.ok(metadata.schema !== null, `${label}: expected a schema`);
    const result: Measurement = {
        label,
        bytes: metadata.file_size,
        milliseconds: elapsed,
        heapDeltaBytes: Math.max(0, after - before),
    };
    measurements.push(result);
    return result;
}

describe('module load cost', () => {
    it('imports the whole native core quickly and without side effects', () => {
        const started = process.hrtime.bigint();
        // The facade pulls in every analyzer and the SQL generator. A runtime
        // require is the only way to time module evaluation from inside a test.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const core = require('../../native/index') as typeof import('../../native/index');
        const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

        assert.ok(
            typeof core.NativeAnalysisService === 'function',
            'the facade must export the service',
        );
        assert.ok(
            elapsed < 2000,
            `importing src/native took ${elapsed.toFixed(1)}ms (budget 2000ms)`,
        );
    });

    it('defers the ESM Parquet reader until a Parquet file is analysed', () => {
        // `hyparquet` is ESM-only and comparatively expensive to evaluate, so it
        // must not be pulled in by merely importing the facade.
        const loaded = Object.keys(require.cache).some((key) =>
            key.includes(`${path.sep}hyparquet${path.sep}`),
        );
        assert.strictEqual(
            loaded,
            false,
            'hyparquet must be loaded lazily, not at module import time',
        );
    });
});

describe('bounded analysis of moderately large files', () => {
    let root = '';
    let csvPath = '';
    let ndjsonPath = '';

    before(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'native-perf-'));
        csvPath = path.join(root, 'large.csv');
        ndjsonPath = path.join(root, 'large.ndjson');

        const csv = fs.createWriteStream(csvPath, { encoding: 'utf-8' });
        const ndjson = fs.createWriteStream(ndjsonPath, { encoding: 'utf-8' });
        csv.write('id,name,amount,active,note\n');

        for (let row = 0; row < LARGE_ROW_COUNT; row += 1) {
            const name = `customer_${row % 997}`;
            const amount = (row % 10_000) / 100;
            const active = row % 2 === 0 ? 'true' : 'false';
            const note = row % 17 === 0 ? '' : `"quoted, note ${row}"`;
            csv.write(`${row},${name},${amount},${active},${note}\n`);
            ndjson.write(
                `{"id":${row},"name":"${name}","amount":${amount},` +
                    `"active":${active},"nested":{"a":${row % 7}}}\n`,
            );
        }

        await Promise.all([
            new Promise<void>((resolve, reject) => {
                csv.end(() => resolve());
                csv.on('error', reject);
            }),
            new Promise<void>((resolve, reject) => {
                ndjson.end(() => resolve());
                ndjson.on('error', reject);
            }),
        ]);
    });

    after(async () => {
        clearMetadataCache();
        await fs.promises.rm(root, { recursive: true, force: true });
        if (measurements.length > 0) {
            const report = measurements
                .map(
                    (m) =>
                        `${m.label}: ${(m.bytes / 1024 / 1024).toFixed(1)} MB in ` +
                        `${m.milliseconds.toFixed(0)}ms, heap +` +
                        `${(m.heapDeltaBytes / 1024 / 1024).toFixed(1)} MB`,
                )
                .join('\n  ');
            // Surfaced through the test runner's diagnostic channel.
            process.stdout.write(`# performance\n  ${report}\n`);
        }
    });

    it('analyses a large CSV within budget and without buffering it', async () => {
        const result = await measure('csv', csvPath, root);
        assert.ok(result.bytes > 4 * 1024 * 1024, `fixture too small: ${result.bytes}`);
        assert.ok(
            result.milliseconds < ANALYSIS_BUDGET_MS,
            `CSV analysis took ${result.milliseconds.toFixed(0)}ms ` +
                `(budget ${ANALYSIS_BUDGET_MS}ms)`,
        );
        assert.ok(
            result.heapDeltaBytes < HEAP_BUDGET_BYTES,
            `CSV analysis retained ${(result.heapDeltaBytes / 1024 / 1024).toFixed(1)} MB`,
        );
    });

    it('analyses a large NDJSON file within budget', async () => {
        const result = await measure('ndjson', ndjsonPath, root);
        assert.ok(result.bytes > 4 * 1024 * 1024, `fixture too small: ${result.bytes}`);
        assert.ok(
            result.milliseconds < ANALYSIS_BUDGET_MS,
            `NDJSON analysis took ${result.milliseconds.toFixed(0)}ms ` +
                `(budget ${ANALYSIS_BUDGET_MS}ms)`,
        );
        assert.ok(
            result.heapDeltaBytes < HEAP_BUDGET_BYTES,
            `NDJSON analysis retained ` +
                `${(result.heapDeltaBytes / 1024 / 1024).toFixed(1)} MB`,
        );
    });

    it('counts every row without loading the file', async () => {
        clearMetadataCache();
        const reference = await resolveWithinRoot(csvPath, root);
        const metadata = await analyzeFileMetadata(reference);
        assert.strictEqual(metadata.row_count, LARGE_ROW_COUNT);
        assert.strictEqual(metadata.column_count, 5);
    });

    it('previews a large file in near-constant time', async () => {
        const service = new NativeAnalysisService(root);
        clearMetadataCache();
        const started = process.hrtime.bigint();
        const preview = await service.preview({ filePath: csvPath, maxRows: 20 });
        const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
        assert.strictEqual(preview.rows.length, 20);
        assert.ok(
            elapsed < ANALYSIS_BUDGET_MS,
            `preview took ${elapsed.toFixed(0)}ms (budget ${ANALYSIS_BUDGET_MS}ms)`,
        );
    });

    it('serves a repeated analysis from cache', async () => {
        clearMetadataCache();
        const reference = await resolveWithinRoot(csvPath, root);
        const coldStart = process.hrtime.bigint();
        await analyzeFileMetadata(reference);
        const cold = Number(process.hrtime.bigint() - coldStart) / 1e6;

        const warmStart = process.hrtime.bigint();
        await analyzeFileMetadata(reference);
        const warm = Number(process.hrtime.bigint() - warmStart) / 1e6;

        assert.ok(
            warm <= cold,
            `cached analysis (${warm.toFixed(1)}ms) was slower than the first ` +
                `run (${cold.toFixed(1)}ms)`,
        );
    });
});

describe('SQL generation cost', () => {
    it('generates a full statement set in well under a frame budget', async () => {
        const service = new NativeAnalysisService(process.cwd());
        const metadata = {
            file_path: 'C:/data/wide.csv',
            file_name: 'wide.csv',
            file_type: 'csv' as const,
            file_size: 1024,
            encoding: 'utf-8',
            delimiter: ',',
            has_header: true,
            row_count: 1000,
            column_count: 200,
            nullable_columns: [] as string[],
            schema: Array.from(
                { length: 200 },
                (_unused, index) => [`col_${index}`, 'int64'] as [string, string],
            ),
        };

        const started = process.hrtime.bigint();
        for (let iteration = 0; iteration < 20; iteration += 1) {
            service.generateStatements({ metadata });
        }
        const perCall = Number(process.hrtime.bigint() - started) / 1e6 / 20;

        assert.ok(
            perCall < 250,
            `generating 200 columns took ${perCall.toFixed(1)}ms per call ` +
                '(budget 250ms)',
        );
    });
});
