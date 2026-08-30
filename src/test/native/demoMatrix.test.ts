/**
 * The exact supported/unsupported matrix, measured against the committed demo
 * fixtures rather than described in prose.
 *
 * The README and the Marketplace copy make specific claims about which formats
 * the extension reads and what it does with ORC. Those claims are only worth
 * something if they are checked against real files, so every fixture under
 * `demo/` is analysed through the shipped service and compared to an explicit
 * expectation here. Adding a fixture without adding a row fails the suite, so
 * the matrix cannot silently go stale.
 *
 * `native_support` is the field the UI uses to decide whether it can show a
 * schema, so it is the honest place to state the ORC limitation: ORC and
 * RCFile are recognised, never parsed.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { NativeAnalysisService } from '../../native';
import { PLATFORMS } from '../../native/sql/typeMapping';

const REPO = path.resolve(__dirname, '..', '..', '..');
const DEMO = path.join(REPO, 'demo');

interface Expectation {
    /** Detected `file_type`. */
    readonly type: string;
    /** Number of columns the analyzer must recover, or `0` for recognition-only. */
    readonly columns: number;
    /** Whether the native engine can read the file's own schema. */
    readonly parsed: boolean;
}

/**
 * Every committed fixture, keyed by its `demo/`-relative POSIX path.
 *
 * Directories that are table formats (Delta, Iceberg) are listed; directories
 * that are only containers are not analysed.
 */
const MATRIX: Readonly<Record<string, Expectation>> = {
    'csv/sales_scalars.csv': { type: 'csv', columns: 10, parsed: true },
    'csv/sales_scalars.tsv': { type: 'csv', columns: 10, parsed: true },
    'csv/sales_scalars_pipe.csv': { type: 'csv', columns: 10, parsed: true },
    'excel/inventory.xlsx': { type: 'excel', columns: 6, parsed: true },
    'json/orders.ndjson': { type: 'json', columns: 8, parsed: true },
    'json/orders_array.json': { type: 'json', columns: 8, parsed: true },
    'json/order_single_object.json': { type: 'json', columns: 8, parsed: true },
    // The one explicit limitation: recognised, never parsed.
    'orc/all_types.orc': { type: 'orc', columns: 0, parsed: false },
    'parquet/all_types.parquet': { type: 'parquet', columns: 26, parsed: true },
    'parquet/sales.parquet': { type: 'parquet', columns: 6, parsed: true },
    'tables/events_delta': { type: 'delta', columns: 5, parsed: true },
    'tables/events_iceberg': { type: 'iceberg', columns: 6, parsed: true },
    'text/readme_sample.txt': { type: 'text', columns: 0, parsed: true },
    'unicode/collation_cases_utf8.csv': { type: 'csv', columns: 5, parsed: true },
    'unicode/japanese_cp932.csv': { type: 'csv', columns: 4, parsed: true },
    'unicode/unicode_utf16le_bom.csv': { type: 'csv', columns: 5, parsed: true },
    'unicode/unicode_utf16le_bom.tsv': { type: 'csv', columns: 5, parsed: true },
    'unicode/unicode_utf8.csv': { type: 'csv', columns: 5, parsed: true },
    'unicode/unicode_utf8_bom.csv': { type: 'csv', columns: 5, parsed: true },
};

/** Fixture-adjacent files that are not themselves analysis inputs. */
const NOT_AN_INPUT = /(^|\/)(README\.md|generate_samples\.py|\.gitattributes|__pycache__|collation_samples\.sql)$/;

/**
 * Is this path a file living inside a table directory the matrix already lists?
 *
 * Membership in {@link MATRIX} is the test, deliberately, rather than a
 * `tables/` prefix. A prefix rule would swallow the contents of an *unlisted*
 * table directory too, so adding `demo/tables/events_hudi/...` would yield no
 * fixture paths at all and the coverage assertion would still pass — silently
 * exempting exactly the directory-shaped formats this matrix exists to police.
 */
function insideAListedTable(relative: string): boolean {
    return Object.keys(MATRIX).some((listed) => relative.startsWith(`${listed}/`));
}

function fixturePaths(): string[] {
    const found: string[] = [];
    const walk = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            const relative = path.relative(DEMO, absolute).split(path.sep).join('/');
            if (NOT_AN_INPUT.test(relative) || relative.includes('__pycache__')) {
                continue;
            }
            if (entry.isDirectory()) {
                if (relative in MATRIX) {
                    found.push(relative);
                    continue;
                }
                walk(absolute);
                continue;
            }
            if (insideAListedTable(relative)) {
                continue;
            }
            found.push(relative);
        }
    };
    walk(DEMO);
    return found.sort();
}

describe('demo fixture support matrix', () => {
    const service = new NativeAnalysisService(DEMO);

    it('covers every committed fixture, with no unlisted extras', () => {
        assert.deepEqual(fixturePaths(), Object.keys(MATRIX).sort());
    });

    for (const [relative, expected] of Object.entries(MATRIX)) {
        it(`${relative} is detected as ${expected.type}`, async () => {
            const metadata = await service.analyze({
                filePath: path.join(DEMO, ...relative.split('/')),
            });
            assert.equal(metadata.file_type, expected.type, 'detected format');
            assert.equal(
                metadata.schema?.length ?? 0,
                expected.columns,
                'recovered column count',
            );
            if (expected.parsed) {
                assert.equal(
                    metadata.native_support,
                    'supported',
                    `${relative} should be fully parsed, not merely recognised`,
                );
            } else {
                assert.equal(
                    metadata.native_support,
                    'unsupported_native',
                    `${relative} must stay recognition-only`,
                );
            }
        });

        it(`${relative} generates a whole script on every platform`, async () => {
            // Breadth, not the crash regression. The native generator never had
            // the Python defect - `stringOr` already treated null as absent -
            // so this pins that real detector output stays generable on every
            // platform rather than reproducing a bug this side never had.
            const metadata = await service.analyze({
                filePath: path.join(DEMO, ...relative.split('/')),
            });
            for (const targetPlatform of PLATFORMS) {
                const statements = service.generateStatements({
                    metadata,
                    targetPlatform,
                });
                assert.ok(statements.create_table, `${relative} ${targetPlatform}`);
                assert.ok(
                    service.generateCompleteDocument({ metadata, targetPlatform }),
                    `${relative} ${targetPlatform}`,
                );
            }
        });
    }
});
