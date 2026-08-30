/**
 * Python↔TypeScript parity for SQL generation.
 *
 * The baseline holds one entry per (fixture × target platform × storage URL)
 * combination — 570 in total — reduced to order-preserving semantic invariants.
 * Comparing markers rather than raw text lets the port normalise whitespace
 * while still proving it emits the same statements, options, identifiers and
 * platform gating.
 */

import * as assert from 'assert';
import { describe, it } from 'node:test';

import { analyzeFileMetadata } from '../../native/detector';
import { resolveWithinRoot } from '../../native/paths';
import { generateAllStatements } from '../../native/sql/generator';
import { DEFAULT_TARGET_PLATFORM, PLATFORMS } from '../../native/sql/typeMapping';
import type { FileMetadata, GeneratorMetadata, TargetPlatform } from '../../native/types';
import {
    fixturePath,
    loadBaseline,
    parityEqual,
    REPO_ROOT,
    statementInvariants,
    type StatementInvariants,
} from './parityInvariants';

/**
 * Fixtures whose *analysis* intentionally differs from Python, and therefore
 * whose generated SQL differs too. Their generator behaviour is asserted
 * separately in `generatorMatrix.test.ts` instead of against the baseline.
 */
const DIVERGENT_FIXTURES: ReadonlySet<string> = new Set([
    'demo/tables/events_delta',
    'demo/orc/all_types.orc',
]);

const baseline = loadBaseline();

async function portableMetadata(relative: string): Promise<GeneratorMetadata> {
    const reference = await resolveWithinRoot(fixturePath(relative), REPO_ROOT);
    const metadata: FileMetadata = await analyzeFileMetadata(reference);
    // The baseline records a repository-relative path so it stays portable; the
    // generator only uses it to derive a table name and a local BULK path.
    return { ...metadata, file_path: relative };
}

function describeDifference(
    name: string,
    actual: StatementInvariants,
    expected: StatementInvariants,
): string {
    const lines = [`statement "${name}" differs:`];
    if (!parityEqual(actual.markers, expected.markers)) {
        const extra = actual.markers.filter((m) => !expected.markers.includes(m));
        const missing = expected.markers.filter((m) => !actual.markers.includes(m));
        lines.push(`  native-only markers: ${JSON.stringify(extra)}`);
        lines.push(`  python-only markers: ${JSON.stringify(missing)}`);
    }
    if (!parityEqual(actual.columns, expected.columns)) {
        lines.push(`  native columns: ${JSON.stringify(actual.columns)}`);
        lines.push(`  python columns: ${JSON.stringify(expected.columns)}`);
    }
    if (actual.go_batches !== expected.go_batches) {
        lines.push(
            `  GO batches: native=${actual.go_batches} python=${expected.go_batches}`,
        );
    }
    if (actual.has_sql !== expected.has_sql) {
        lines.push(`  has_sql: native=${actual.has_sql} python=${expected.has_sql}`);
    }
    return lines.join('\n');
}

describe('generator parity with Python', () => {
    it('agrees on the default target platform', () => {
        assert.strictEqual(DEFAULT_TARGET_PLATFORM, baseline.default_target_platform);
        assert.strictEqual(DEFAULT_TARGET_PLATFORM, 'azure_sql_db');
    });

    it('supports exactly the same target platforms', () => {
        assert.deepStrictEqual([...PLATFORMS], baseline.platforms);
        assert.strictEqual(PLATFORMS.length, 6);
    });

    const fixtures = [
        ...new Set(Object.keys(baseline.statements).map((key) => key.split('|')[0])),
    ].sort();

    for (const fixture of fixtures) {
        if (DIVERGENT_FIXTURES.has(fixture)) {
            continue;
        }

        it(`emits the same statements for ${fixture}`, async () => {
            const metadata = await portableMetadata(fixture);
            const failures: string[] = [];

            for (const platform of baseline.platforms) {
                for (const [label, storageUrl] of Object.entries(
                    baseline.storage_urls,
                )) {
                    const key = `${fixture}|${platform}|${label}`;
                    const expected = baseline.statements[key];
                    assert.ok(expected, `baseline is missing ${key}`);

                    const statements = generateAllStatements(metadata, {
                        tableName: null,
                        dataSource: 'MyDataSource',
                        location: null,
                        schemaName: 'dbo',
                        targetPlatform: platform as TargetPlatform,
                        storageUrl,
                    });

                    const actualNames = Object.keys(statements).sort();
                    const expectedNames = Object.keys(expected).sort();
                    assert.deepStrictEqual(
                        actualNames,
                        expectedNames,
                        `${key}: statement tabs differ`,
                    );

                    for (const name of expectedNames) {
                        const actual = statementInvariants(
                            statements[name as keyof typeof statements],
                        );
                        if (!parityEqual(actual, expected[name])) {
                            failures.push(
                                `${key}\n${describeDifference(
                                    name,
                                    actual,
                                    expected[name],
                                )}`,
                            );
                        }
                    }
                }
            }

            assert.deepStrictEqual(
                failures,
                [],
                failures.slice(0, 4).join('\n\n') +
                    (failures.length > 4
                        ? `\n\n…and ${failures.length - 4} more`
                        : ''),
            );
        });
    }

    it('covers the full 6 platforms × 5 storage shapes matrix', () => {
        const combinations = new Set(
            Object.keys(baseline.statements).map((key) => {
                const [, platform, label] = key.split('|');
                return `${platform}|${label}`;
            }),
        );
        assert.strictEqual(combinations.size, 30);
        assert.strictEqual(Object.keys(baseline.statements).length, 570);
    });
});
