/**
 * Python↔TypeScript parity for file analysis.
 *
 * Every fixture in `tests/native_parity/python_baseline.json` is re-analysed by
 * the native core and compared, key by key, against what the Python
 * implementation produced. Intentional differences are enumerated per fixture
 * so a regression cannot hide behind a blanket exclusion.
 */

import * as assert from 'assert';
import { describe, it } from 'node:test';

import { analyzeFileMetadata } from '../../native/detector';
import { resolveWithinRoot } from '../../native/paths';
import type { FileMetadata } from '../../native/types';
import {
    fixturePath,
    loadBaseline,
    normaliseMetadata,
    parityEqual,
    REPO_ROOT,
} from './parityInvariants';

/**
 * Metadata keys where the native core is *known* to differ from Python, with
 * the reason. Any key not listed here must match exactly.
 */
const INTENTIONAL_DIFFERENCES: Readonly<Record<string, readonly string[]>> = {
    // Python has no `deltalake` package installed, so it degrades to reading a
    // single underlying Parquet part file. The native core parses `_delta_log`
    // directly, which yields Delta type names, real Delta metadata and a
    // different schema-inference provenance.
    'demo/tables/events_delta': [
        'schema',
        'schema_inference',
        'delta_metadata',
        'warning',
        'nullable_columns',
        'parquet_metadata',
        'compression',
    ],
    // Python reads ORC through pyarrow. The native core has no portable ORC
    // reader (see docs/native-core.md) and reports an explicit
    // `unsupported_native` result instead of faking a schema.
    'demo/orc/all_types.orc': [
        'schema',
        'column_count',
        'row_count',
        'warning',
        'nullable_columns',
    ],
    // The native reader additionally reports `snapshot_count`, which the Python
    // implementation never surfaced. Every key Python *does* emit is asserted
    // to match in "keeps every Iceberg field Python reported" below.
    'demo/tables/events_iceberg': ['iceberg_metadata'],
};

/** Keys the native core adds that Python never emitted. */
const NATIVE_ONLY_KEYS: ReadonlySet<string> = new Set(['native_support']);

async function analyzeFixture(relative: string): Promise<FileMetadata> {
    const reference = await resolveWithinRoot(fixturePath(relative), REPO_ROOT);
    return analyzeFileMetadata(reference);
}

describe('native metadata parity with Python', () => {
    const baseline = loadBaseline();
    const fixtures = Object.keys(baseline.metadata).sort();

    it('covers every committed fixture', () => {
        assert.ok(fixtures.length >= 19, `only ${fixtures.length} fixtures in baseline`);
    });

    for (const fixture of fixtures) {
        it(`matches Python for ${fixture}`, async () => {
            const expected = baseline.metadata[fixture];
            const actual = normaliseMetadata(
                (await analyzeFixture(fixture)) as unknown as Record<string, unknown>,
            );

            const allowed = new Set(INTENTIONAL_DIFFERENCES[fixture] ?? []);
            const mismatches: string[] = [];

            for (const key of Object.keys(expected)) {
                if (allowed.has(key)) {
                    continue;
                }
                if (!(key in actual)) {
                    mismatches.push(`${key}: missing from native output`);
                    continue;
                }
                if (!parityEqual(actual[key], expected[key])) {
                    mismatches.push(
                        `${key}: native=${JSON.stringify(actual[key])} ` +
                            `python=${JSON.stringify(expected[key])}`,
                    );
                }
            }

            for (const key of Object.keys(actual)) {
                if (key in expected || NATIVE_ONLY_KEYS.has(key) || allowed.has(key)) {
                    continue;
                }
                mismatches.push(`${key}: present in native output only`);
            }

            assert.deepStrictEqual(mismatches, [], mismatches.join('\n'));
        });
    }

    it('records every allowed difference as a real difference', async () => {
        const stale: string[] = [];
        for (const [fixture, keys] of Object.entries(INTENTIONAL_DIFFERENCES)) {
            const expected = baseline.metadata[fixture];
            const actual = normaliseMetadata(
                (await analyzeFixture(fixture)) as unknown as Record<string, unknown>,
            );
            for (const key of keys) {
                if (parityEqual(actual[key], expected[key])) {
                    stale.push(`${fixture}.${key}`);
                }
            }
        }
        assert.deepStrictEqual(
            stale,
            [],
            `these keys are listed as intentional differences but now match ` +
                `Python; remove them from the allowlist: ${stale.join(', ')}`,
        );
    });
});

describe('documented native limitations', () => {
    it('reports ORC as explicitly unsupported rather than guessing', async () => {
        const metadata = await analyzeFixture('demo/orc/all_types.orc');
        assert.strictEqual(metadata.file_type, 'orc');
        assert.strictEqual(metadata.native_support, 'unsupported_native');
        assert.strictEqual(metadata.schema, null);
        assert.ok(
            /ORC/i.test(metadata.warning ?? ''),
            `expected an ORC warning, got ${JSON.stringify(metadata.warning)}`,
        );
    });

    it('reads ORC postscript facts even though the stripes are unsupported', async () => {
        const metadata = await analyzeFixture('demo/orc/all_types.orc');
        assert.ok(
            typeof metadata.compression === 'string' && metadata.compression.length > 0,
            'expected the ORC postscript compression codec to be reported',
        );
    });

    it('parses the Delta log natively instead of an underlying part file', async () => {
        const metadata = await analyzeFixture('demo/tables/events_delta');
        assert.strictEqual(metadata.file_type, 'delta');
        assert.strictEqual(metadata.native_support, 'supported');
        assert.strictEqual(metadata.schema_inference, 'delta_log');
        assert.ok(metadata.delta_metadata, 'expected delta_metadata to be populated');
        assert.strictEqual(metadata.delta_metadata?.version, 0);
        assert.strictEqual(metadata.delta_metadata?.name, 'events_delta');
    });

    it('selects the current Iceberg schema from table metadata', async () => {
        const metadata = await analyzeFixture('demo/tables/events_iceberg');
        assert.strictEqual(metadata.file_type, 'iceberg');
        assert.strictEqual(metadata.native_support, 'supported');
        assert.ok(Array.isArray(metadata.schema) && metadata.schema.length > 0);
    });

    it('keeps every Iceberg field Python reported, and adds snapshot_count', async () => {
        const metadata = await analyzeFixture('demo/tables/events_iceberg');
        const expected = loadBaseline().metadata['demo/tables/events_iceberg'][
            'iceberg_metadata'
        ] as Record<string, unknown>;
        const actual = metadata.iceberg_metadata as unknown as Record<string, unknown>;

        for (const [key, value] of Object.entries(expected)) {
            assert.ok(
                parityEqual(actual[key], value),
                `iceberg_metadata.${key}: native=${JSON.stringify(actual[key])} ` +
                    `python=${JSON.stringify(value)}`,
            );
        }

        const added = Object.keys(actual).filter((key) => !(key in expected));
        assert.deepStrictEqual(added, ['snapshot_count']);
        assert.strictEqual(actual['snapshot_count'], 1);
    });
});
