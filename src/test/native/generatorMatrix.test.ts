/**
 * Semantic invariants for the ported SQL generator.
 *
 * The parity suite proves the port agrees with Python. This suite pins the
 * behaviours the product depends on directly, so a future refactor of *both*
 * implementations cannot quietly regress them. Assertions target structure
 * (statement present, option present, identifier escaped) rather than exact
 * whitespace.
 */

import * as assert from 'assert';
import { describe, it } from 'node:test';

import {
    deduplicateSharedPrerequisites,
    generateAllStatements,
    generateBestPractices,
    generateCredentialSetup,
    generateBulkInsert,
    generateCompleteDdl,
    generateCreateTable,
    generateExternalFileFormat,
    generateExternalTable,
    resolveTableName,
} from '../../native/sql/generator';
import {
    DEFAULT_TARGET_PLATFORM,
    PLATFORMS,
    normalizePlatform,
} from '../../native/sql/typeMapping';
import type { GeneratorMetadata, TargetPlatform } from '../../native/types';

const STORAGE_URLS: Readonly<Record<string, string | null>> = {
    local: null,
    azure_blob: 'https://acct.blob.core.windows.net/container/folder/file.csv',
    adls: 'abfss://container@acct.dfs.core.windows.net/folder/file.csv',
    s3: 's3://bucket/folder/file.csv',
    onelake: 'abfss://ws@onelake.dfs.fabric.microsoft.com/lh/Files/f',
};

function csvMetadata(): GeneratorMetadata {
    return {
        file_path: 'C:/data/sales.csv',
        file_name: 'sales.csv',
        file_type: 'csv',
        file_size: 4096,
        encoding: 'utf-8',
        delimiter: ',',
        has_header: true,
        row_count: 100,
        column_count: 3,
        nullable_columns: ['note'],
        schema: [
            ['id', 'int64'],
            ['amount', 'float64'],
            ['note', 'object'],
        ],
    };
}

function parquetMetadata(): GeneratorMetadata {
    return {
        file_path: 'C:/data/sales.parquet',
        file_name: 'sales.parquet',
        file_type: 'parquet',
        file_size: 8192,
        encoding: 'binary',
        row_count: 50,
        column_count: 2,
        nullable_columns: [],
        compression: 'SNAPPY',
        schema: [
            ['id', 'int32'],
            ['ts', 'timestamp[us, tz=UTC]'],
        ],
    };
}

function jsonMetadata(): GeneratorMetadata {
    return {
        file_path: 'C:/data/orders.json',
        file_name: 'orders.json',
        file_type: 'json',
        file_size: 2048,
        encoding: 'utf-8',
        row_count: 10,
        column_count: 2,
        nullable_columns: [],
        json_format: 'array',
        schema: [
            ['order_id', 'int64'],
            ['customer', 'object'],
        ],
    };
}

function deltaMetadata(): GeneratorMetadata {
    return {
        file_path: 'C:/data/events_delta',
        file_name: 'events_delta',
        file_type: 'delta',
        file_size: 16384,
        encoding: 'binary',
        row_count: null,
        column_count: 2,
        nullable_columns: ['event_name'],
        schema: [
            ['event_id', 'long'],
            ['event_name', 'string'],
        ],
    };
}

const FIXTURES: Readonly<Record<string, () => GeneratorMetadata>> = {
    csv: csvMetadata,
    parquet: parquetMetadata,
    json: jsonMetadata,
    delta: deltaMetadata,
};

describe('generator matrix: 6 targets x 4 formats x local/remote', () => {
    for (const platform of PLATFORMS) {
        for (const [format, build] of Object.entries(FIXTURES)) {
            for (const [label, storageUrl] of Object.entries(STORAGE_URLS)) {
                it(`${platform} / ${format} / ${label} produces every tab`, () => {
                    const statements = generateAllStatements(build(), {
                        targetPlatform: platform,
                        dataSource: 'MyDataSource',
                        schemaName: 'dbo',
                        storageUrl,
                    });

                    for (const [name, sql] of Object.entries(statements)) {
                        assert.strictEqual(
                            typeof sql,
                            'string',
                            `${name} must always be a string`,
                        );
                        assert.ok(
                            sql.length > 0,
                            `${name} must never be empty; use an explanatory ` +
                                'comment instead',
                        );
                        assert.ok(
                            !sql.includes('undefined') && !sql.includes('[object Object]'),
                            `${name} leaked a JavaScript value: ${sql.slice(0, 200)}`,
                        );
                        assert.ok(
                            !/\bNaN\b/.test(sql),
                            `${name} emitted NaN: ${sql.slice(0, 200)}`,
                        );
                    }
                });
            }
        }
    }
});

describe('target platform capabilities', () => {
    it('defaults to Azure SQL Database', () => {
        assert.strictEqual(DEFAULT_TARGET_PLATFORM, 'azure_sql_db');
        const fallback = generateAllStatements(csvMetadata(), {});
        const explicit = generateAllStatements(csvMetadata(), {
            targetPlatform: 'azure_sql_db',
        });
        assert.deepStrictEqual(fallback, explicit);
    });

    it('falls back to the default for unknown platform strings', () => {
        assert.strictEqual(normalizePlatform('not-a-platform'), DEFAULT_TARGET_PLATFORM);
        assert.strictEqual(normalizePlatform(null), DEFAULT_TARGET_PLATFORM);
        assert.strictEqual(normalizePlatform(''), DEFAULT_TARGET_PLATFORM);
    });

    it('uses FIRST_ROW on platforms that speak external file formats', () => {
        const format = generateExternalFileFormat(csvMetadata(), {
            targetPlatform: 'sql_server_2022',
        });
        assert.ok(/FIRST_ROW\s*=\s*2/.test(format), format);
        assert.ok(!/FIRSTROW/.test(format), format);
    });

    it('uses FIRSTROW in BULK INSERT, which is a different keyword', () => {
        const bulk = generateBulkInsert(csvMetadata(), {
            targetPlatform: 'azure_sql_db',
        });
        assert.ok(/FIRSTROW\s*=\s*2/.test(bulk), bulk);
    });

    it('emits REJECT_TYPE only for the Hadoop-style external source platform', () => {
        const hadoop = generateExternalTable(csvMetadata(), {
            targetPlatform: 'sql_server_2019',
            storageUrl: STORAGE_URLS['azure_blob'],
        });
        assert.ok(/REJECT_TYPE\s*=/.test(hadoop), hadoop);

        for (const platform of PLATFORMS.filter((p) => p !== 'sql_server_2019')) {
            const other = generateExternalTable(csvMetadata(), {
                targetPlatform: platform,
                storageUrl: STORAGE_URLS['azure_blob'],
            });
            assert.ok(
                !/REJECT_TYPE\s*=/.test(other),
                `${platform} must not emit REJECT_TYPE`,
            );
        }
    });

    it('only offers a single-LOB read through a BLOB_STORAGE data source', () => {
        // Live certification (Azure SQL Database 12.0.2000.8 and SQL Server 2025
        // 17.0.4065.4) proved SINGLE_CLOB works with DATA_SOURCE when that
        // source is TYPE = BLOB_STORAGE. The restriction applies to the abs:// /
        // adls:// virtualization connectors, so a single-LOB read must always be
        // paired with the dedicated "_Bulk" source.
        for (const platform of PLATFORMS) {
            for (const [label, url] of Object.entries(STORAGE_URLS)) {
                if (url === null) {
                    continue;
                }
                const statements = generateAllStatements(csvMetadata(), {
                    targetPlatform: platform,
                    storageUrl: url,
                });
                const code = Object.values(statements)
                    .join('\n')
                    .split('\n')
                    .filter((line) => !line.trim().startsWith('--'))
                    .join('\n');
                for (const statement of code.split(/\bGO\b/)) {
                    if (!/\bSINGLE_N?CLOB\b/.test(statement)) {
                        continue;
                    }
                    assert.ok(
                        /_Bulk/.test(statement),
                        `${platform}/${label} used a single-LOB read without the `
                            + 'BLOB_STORAGE data source',
                    );
                }
            }
        }
    });

    it('points a Delta external table at the table directory, not a part file', () => {
        // Delta external tables exist on SQL Server 2022+ and Azure SQL Database.
        for (const platform of ['sql_server_2022', 'azure_sql_db'] as const) {
            const external = generateExternalTable(deltaMetadata(), {
                targetPlatform: platform,
                storageUrl:
                    'https://acct.blob.core.windows.net/container/folder/events_delta',
            });
            const location = /LOCATION\s*=\s*'([^']*)'/.exec(external);
            assert.ok(location, `${platform}: no LOCATION in:\n${external}`);
            assert.ok(
                location[1].replace(/\/$/, '').endsWith('events_delta'),
                `${platform}: Delta LOCATION must be the table directory, ` +
                    `got '${location[1]}'`,
            );
            assert.ok(
                !/\.parquet$/i.test(location[1]),
                `${platform}: Delta LOCATION must not be a part file, ` +
                    `got '${location[1]}'`,
            );
            assert.ok(
                /FORMAT_TYPE\s*=\s*DELTA/i.test(external) ||
                    /\[ff_delta[^\]]*\]/i.test(external),
                `${platform}: Delta external table must use the Delta file format`,
            );
        }
    });

    it('declares Delta unavailable on platforms without a Delta file format', () => {
        for (const platform of ['azure_sql_mi', 'fabric_sql_db'] as const) {
            const external = generateExternalTable(deltaMetadata(), {
                targetPlatform: platform,
                storageUrl:
                    'https://acct.blob.core.windows.net/container/folder/events_delta',
            });

            assert.ok(
                /NOT\s+AVAILABLE\s+on/i.test(external),
                `${platform} must state Delta is unavailable:\n${external}`,
            );
        }
    });

    it('maps Parquet TIMESTAMP(NANOS) INT64 only for external tables', () => {
        const metadata: GeneratorMetadata = {
            ...parquetMetadata(),
            schema: [
                ['id', 'int32'],
                ['event_ns', 'timestamp[ns]'],
                ['event_utc', 'timestamp[us, tz=UTC]'],
            ],
            parquet_physical_types: {
                id: 'INT32',
                event_ns: 'INT64',
                event_utc: 'INT64',
            },
        };

        const table = generateCreateTable(metadata, {
            targetPlatform: 'sql_server_2025',
        });

        it('refuses nested Parquet external tables instead of emitting scalar mappings', () => {
            const sql = generateExternalTable({
                ...parquetMetadata(),
                schema: [
                    ['id', 'int32'],
                    ['items', 'list<element: int32>'],
                ],
            }, {
                targetPlatform: 'sql_server_2025',
            });

            assert.match(sql, /NOT AVAILABLE/);
            assert.match(sql, /Flatten or remove nested columns first: items/);
            assert.doesNotMatch(sql, /CREATE EXTERNAL TABLE \[/);
        });
        const external = generateExternalTable(metadata, {
            targetPlatform: 'sql_server_2025',
        });

        assert.match(table, /\[event_ns\]\s+DATETIME2\(7\)/);
        assert.match(table, /\[event_utc\]\s+DATETIMEOFFSET\(6\)/);
        assert.match(external, /\[event_ns\]\s+BIGINT/);
        assert.match(external, /\[event_utc\]\s+DATETIME2\(6\)/);
        assert.match(external, /Mapped: Parquet TIMESTAMP\(NANOS\).*INT64/);
        assert.match(external, /Mapped: Parquet timezone timestamp.*INT64/);
    });
});

describe('type mapping edge cases', () => {
    function columnsFor(schema: [string, string][]): string {
        return generateCreateTable(
            { ...csvMetadata(), schema, column_count: schema.length },
            { targetPlatform: 'azure_sql_db' },
        );
    }

    it('maps signed 8-bit integers without losing the sign', () => {
        const sql = columnsFor([['c', 'int8']]);
        // TINYINT is unsigned in T-SQL, so a signed int8 must widen.
        assert.ok(/\[c\]\s+SMALLINT/i.test(sql), sql);
    });

    it('maps unsigned 8-bit integers to TINYINT', () => {
        assert.ok(/\[c\]\s+TINYINT/i.test(columnsFor([['c', 'uint8']])));
    });

    it('widens unsigned 64-bit integers beyond BIGINT', () => {
        const sql = columnsFor([['c', 'uint64']]);
        assert.ok(/\[c\]\s+DECIMAL\(20,\s*0\)/i.test(sql), sql);
    });

    it('preserves decimal precision and scale', () => {
        const sql = columnsFor([['c', 'decimal128(18, 4)']]);
        assert.ok(/\[c\]\s+DECIMAL\(18,\s*4\)/i.test(sql), sql);
    });

    it('handles negative decimal scale without emitting invalid SQL', () => {
        const sql = columnsFor([['c', 'decimal128(10, -2)']]);
        assert.ok(/\[c\]\s+DECIMAL\(/i.test(sql), sql);
        assert.ok(!/DECIMAL\(\s*-/.test(sql), sql);
        assert.ok(!/,\s*-\d/.test(sql.split('\n').find((l) => l.includes('[c]')) ?? ''));
    });

    it('maps timezone-aware timestamps to DATETIMEOFFSET', () => {
        const sql = columnsFor([['c', 'timestamp[us, tz=UTC]']]);
        assert.ok(/\[c\]\s+DATETIMEOFFSET/i.test(sql), sql);
    });

    it('maps naive timestamps to DATETIME2', () => {
        const sql = columnsFor([['c', 'timestamp[us]']]);
        assert.ok(/\[c\]\s+DATETIME2/i.test(sql), sql);
    });

    it('does not silently coerce nested types to a scalar', () => {
        for (const nested of ['list<item: int32>', 'struct<a: int32>', 'map<string, int32>']) {
            const sql = columnsFor([['c', nested]]);
            assert.ok(
                /NVARCHAR\(MAX\)/i.test(sql),
                `${nested} should surface as NVARCHAR(MAX): ${sql}`,
            );
            assert.ok(
                !/\[c\]\s+(INT|BIGINT|FLOAT)\b/i.test(sql),
                `${nested} must not be flattened to a scalar: ${sql}`,
            );
        }
    });
});

describe('table name resolution', () => {
    it('derives a table name from the file name when none is supplied', () => {
        assert.strictEqual(resolveTableName(csvMetadata(), null), 'sales');
    });

    it('honours an explicit table name, cleaned into a legal identifier', () => {
        assert.strictEqual(resolveTableName(csvMetadata(), 'Custom Name'), 'Custom_Name');
        assert.strictEqual(resolveTableName(csvMetadata(), 'Orders'), 'Orders');
    });

    it('falls back for a file name that cleans away entirely', () => {
        const name = resolveTableName(
            { ...csvMetadata(), file_name: '###.csv', file_path: '###.csv' },
            null,
        );
        assert.ok(name.length > 0, 'a usable table name must always be produced');
    });
});

describe('multi-file export deduplication', () => {
    it('creates shared prerequisites once across files', () => {
        const first = generateCompleteDdl(csvMetadata(), {
            targetPlatform: 'azure_sql_db',
            dataSource: 'Shared',
            storageUrl: STORAGE_URLS['azure_blob'],
        });
        const second = generateCompleteDdl(
            { ...csvMetadata(), file_name: 'other.csv', file_path: 'C:/data/other.csv' },
            {
                targetPlatform: 'azure_sql_db',
                dataSource: 'Shared',
                storageUrl:
                    'https://acct.blob.core.windows.net/container/folder/other.csv',
            },
        );

        const seen = new Set<string>();
        const combined = [
            deduplicateSharedPrerequisites(first, seen),
            deduplicateSharedPrerequisites(second, seen),
        ].join('\n\n');

        // Every shared object must be created exactly once *by name*. The
        // bulk data source is a distinct object from the virtualization one,
        // so both legitimately appear — but neither may appear twice.
        const counts = new Map<string, number>();
        const objectPattern =
            /CREATE\s+(MASTER\s+KEY|DATABASE\s+SCOPED\s+CREDENTIAL\s+\[[^\]]*\]|EXTERNAL\s+DATA\s+SOURCE\s+\[[^\]]*\]|EXTERNAL\s+FILE\s+FORMAT\s+\[[^\]]*\])/gi;
        for (const match of combined.matchAll(objectPattern)) {
            const key = match[1].replace(/\s+/g, ' ').toUpperCase();
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        assert.ok(counts.size > 0, `no shared objects found in:\n${combined}`);
        for (const [key, count] of counts) {
            assert.strictEqual(count, 1, `${key} was created ${count} times after dedup`);
        }

        // Both tables must still be created.
        assert.ok(/CREATE\s+TABLE\s+\[dbo\]\.\[sales\]/i.test(combined), combined);
        assert.ok(/CREATE\s+TABLE\s+\[dbo\]\.\[other\]/i.test(combined), combined);
    });

    it('keeps per-file objects even when they share a prefix', () => {
        const seen = new Set<string>();
        const scripts = ['a.csv', 'b.csv'].map((name) =>
            deduplicateSharedPrerequisites(
                generateCompleteDdl(
                    { ...csvMetadata(), file_name: name, file_path: `C:/data/${name}` },
                    { targetPlatform: 'sql_server_2022', dataSource: 'Shared' },
                ),
                seen,
            ),
        );
        const combined = scripts.join('\n\n');
        assert.ok(/\[dbo\]\.\[a\]/i.test(combined), combined);
        assert.ok(/\[dbo\]\.\[b\]/i.test(combined), combined);
    });
});

describe('complete document assembly', () => {
    it('separates batches with GO and ends with a newline', () => {
        const ddl = generateCompleteDdl(csvMetadata(), {
            targetPlatform: 'azure_sql_db',
            storageUrl: STORAGE_URLS['azure_blob'],
        });
        assert.ok(ddl.endsWith('\n'), 'document must end with a newline');
        assert.ok(/\nGO\n/.test(ddl), 'document must contain GO batch separators');
        assert.ok(!/\nGO\s*\nGO\b/.test(ddl), 'document must not contain doubled GO');
    });

    it('includes the OPENJSON helper tab only for JSON sources', () => {
        const jsonTabs = generateAllStatements(jsonMetadata(), {
            targetPlatform: 'azure_sql_db',
        });
        const csvTabs = generateAllStatements(csvMetadata(), {
            targetPlatform: 'azure_sql_db',
        });
        assert.ok(
            /OPENJSON/i.test(jsonTabs.json_functions),
            'JSON source must produce OPENJSON helpers',
        );
        assert.ok(
            !/^\s*OPENJSON/im.test(
                csvTabs.json_functions
                    .split('\n')
                    .filter((line) => !line.trim().startsWith('--'))
                    .join('\n'),
            ),
            `CSV source must not produce runnable OPENJSON helpers:\n${csvTabs.json_functions}`,
        );

        const jsonDdl = generateCompleteDdl(jsonMetadata(), {
            targetPlatform: 'azure_sql_db',
        });
        const csvDdl = generateCompleteDdl(csvMetadata(), {
            targetPlatform: 'azure_sql_db',
        });
        assert.ok(jsonDdl.length > 0 && csvDdl.length > 0);
        // The json_functions section is spliced into the document for JSON only.
        assert.ok(
            jsonDdl.includes(jsonTabs.json_functions.trim()),
            'JSON document must embed the json_functions section',
        );
        assert.ok(
            !csvDdl.includes(csvTabs.json_functions.trim()),
            'CSV document must omit the json_functions section',
        );
    });

    it('produces a document for every platform', () => {
        for (const platform of PLATFORMS as readonly TargetPlatform[]) {
            const ddl = generateCompleteDdl(parquetMetadata(), {
                targetPlatform: platform,
                storageUrl: STORAGE_URLS['adls'],
            });
            assert.ok(ddl.trim().length > 0, `${platform} produced an empty document`);
        }
    });
});

describe('storage authentication and object naming', () => {
    const csvMeta = (): GeneratorMetadata => csvMetadata();

    it('defaults to managed identity and emits no master key', () => {
        // Live evidence (Azure SQL Database): creating a database scoped
        // credential with IDENTITY = 'MANAGED IDENTITY' left the database
        // master key count at 0 before, during and after. No secret and no
        // master key password have to exist for private storage access.
        const setup = generateCredentialSetup({
            dataSource: 'TestDS',
            metadata: csvMeta(),
            targetPlatform: 'azure_sql_db',
        });
        assert.match(setup, /IDENTITY = 'MANAGED IDENTITY'/);
        assert.ok(!setup.includes('CREATE MASTER KEY'));
        assert.ok(!setup.includes('SECRET'));
    });

    it('restores the master key when a SAS token is requested', () => {
        const setup = generateCredentialSetup({
            dataSource: 'TestDS',
            metadata: csvMeta(),
            targetPlatform: 'azure_sql_db',
            authMethod: 'sas',
        });
        assert.match(setup, /IDENTITY = 'SHARED ACCESS SIGNATURE'/);
        assert.match(setup, /CREATE MASTER KEY/);
    });

    it('creates no credential at all for a public container', () => {
        const setup = generateCredentialSetup({
            dataSource: 'TestDS',
            metadata: csvMeta(),
            targetPlatform: 'azure_sql_db',
            authMethod: 'public',
        });
        assert.ok(!setup.includes('CREATE DATABASE SCOPED CREDENTIAL'));
        assert.ok(!setup.includes('CREATE MASTER KEY'));
        assert.ok(!setup.includes('SECRET'));
        assert.ok(!setup.includes('CREDENTIAL = ['));
        assert.match(setup, /CREATE EXTERNAL DATA SOURCE \[TestDS\]/);
    });

    it('propagates every object name override', () => {
        // Without overrides a file called orders.csv generates dbo.orders,
        // which collides with a real table in any TPC-H style database.
        const statements = generateAllStatements(
            { ...csvMeta(), file_name: 'orders.csv', file_path: 'C:/data/orders.csv' },
            {
                tableName: 'sqlfdt_cert_abc_tbl',
                schemaName: 'sqlfdt_cert_abc',
                dataSource: 'sqlfdt_cert_abc_ds',
                formatName: 'sqlfdt_cert_abc_fmt',
                externalTableName: 'sqlfdt_cert_abc_ext',
                credentialName: 'sqlfdt_cert_abc_cred',
                targetPlatform: 'azure_sql_db',
                storageUrl: 'https://acct.blob.core.windows.net/raw/orders.csv',
            },
        );
        const code = Object.values(statements)
            .join('\n')
            .split('\n')
            .filter((line) => !line.trim().startsWith('--'))
            .join('\n');

        assert.ok(!code.includes('ff_csv_format'), 'derived format name leaked');
        assert.ok(!code.includes('ext_orders'), 'derived external table leaked');
        assert.ok(
            !code.includes('cred_sqlfdt_cert_abc_ds'),
            'derived credential name leaked',
        );
        assert.ok(!code.includes('[dbo]'), 'dbo leaked into generated code');
        assert.match(statements.external_file_format, /sqlfdt_cert_abc_fmt/);
        assert.match(statements.create_external_table, /sqlfdt_cert_abc_ext/);
        assert.match(statements.credential_setup, /sqlfdt_cert_abc_cred/);
    });

    it('keeps the complete script free of dbo when a schema is given', () => {
        const script = generateCompleteDdl(
            { ...csvMeta(), file_name: 'orders.csv', file_path: 'C:/data/orders.csv' },
            {
                tableName: 'orders_import',
                schemaName: 'staging',
                targetPlatform: 'azure_sql_db',
                storageUrl: 'https://acct.blob.core.windows.net/raw/orders.csv',
            },
        );
        const code = script
            .split('\n')
            .filter((line) => !line.trim().startsWith('--'))
            .join('\n');
        assert.ok(!code.includes('[dbo]'));
        assert.match(code, /\[staging\]/);
    });
});

// -- absent metadata ----------------------------------------------------------

/**
 * Keys the generator actually reads and treats as text. The detector seeds all
 * of them empty and only fills them in when the per-format analyser succeeds,
 * so any of them can arrive `null` on a real analysis.
 *
 * The schema is supplied for a reason: with no columns every platform produces
 * the same degenerate single-`NVARCHAR(MAX)` script, and the matrix would then
 * exercise one trivial path instead of the typed column definitions where the
 * remaining optional fields are read.
 */
const OPTIONAL_TEXT_FIELDS = [
    'file_name', 'file_type', 'encoding', 'delimiter', 'has_header',
    'file_size', 'row_count', 'compression', 'json_format', 'schema',
    'codepage', 'file_path',
] as const;

function completeMetadata(): Record<string, unknown> {
    return {
        file_path: 'C:/data/sample.csv',
        file_name: 'sample.csv',
        file_type: 'csv',
        encoding: 'utf-8',
        codepage: '65001',
        delimiter: ',',
        has_header: true,
        file_size: 1024,
        row_count: 10,
        compression: null,
        schema: [
            ['id', 'int64'],
            ['name', 'object'],
            ['amount', 'float64'],
        ],
        nullable_columns: ['name'],
    };
}

describe('absent metadata', () => {
    for (const field of OPTIONAL_TEXT_FIELDS) {
        for (const mode of ['null', 'absent', 'empty'] as const) {
            it(`generates a whole script with ${field} ${mode}`, () => {
                const meta = completeMetadata();
                if (mode === 'null') {
                    meta[field] = null;
                } else if (mode === 'empty') {
                    meta[field] = '';
                } else {
                    delete meta[field];
                }
                for (const targetPlatform of PLATFORMS) {
                    const metadata = meta as unknown as GeneratorMetadata;
                    const statements = generateAllStatements(metadata, { targetPlatform });
                    assert.ok(statements.create_table);
                    assert.ok(generateCompleteDdl(metadata, { targetPlatform }));
                    assert.ok(generateBestPractices(metadata, { targetPlatform }));
                }
            });
        }
    }

    // The Python generator crashed here during the live certification plan:
    // `metadata.get('delimiter', ',')` returns None for a key that is present
    // and None, and that None reached an iteration.
    for (const value of [null, '', ','] as const) {
        it(`treats delimiter ${JSON.stringify(value)} as a comma`, () => {
            const meta = completeMetadata();
            meta.delimiter = value;
            const metadata = meta as unknown as GeneratorMetadata;

            const detected = generateBestPractices(metadata)
                .split('\n')
                .filter((line) => line.includes('Detected:'));
            assert.ok(detected.length > 0);
            for (const line of detected) {
                assert.ok(!line.includes('null'), line);
            }
            assert.ok(detected.some((line) => line.includes('comma-delimited')));

            const scripts = [
                generateCompleteDdl(metadata),
                Object.values(generateAllStatements(metadata)).join('\n'),
            ];
            for (const script of scripts) {
                assert.ok(script.includes("FIELDTERMINATOR = ','"));
            }
        });
    }
});

// ---------------------------------------------------------------------------
// Rerun safety
// ---------------------------------------------------------------------------

const CREATE_LINE =
    /^[ \t]*CREATE\s+(?:EXTERNAL\s+DATA\s+SOURCE|EXTERNAL\s+FILE\s+FORMAT|DATABASE\s+SCOPED\s+CREDENTIAL|EXTERNAL\s+TABLE|TABLE)\b/i;

/** Every CREATE in *document* that nothing checked for first. */
function unguardedCreates(document: string): string[] {
    const lines = document.split('\n');
    const offenders: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        if (!CREATE_LINE.test(lines[index])) {
            continue;
        }
        const preceding = lines
            .slice(Math.max(0, index - 3), index)
            .map((line) => line.trim().toUpperCase())
            .filter((line) => line.length > 0);
        if (
            !preceding.some(
                (line) => line.startsWith('IF NOT EXISTS') || line.startsWith('IF OBJECT_ID'),
            )
        ) {
            offenders.push(lines[index].trim());
        }
    }
    return offenders;
}

function completeDocument(
    metadata: GeneratorMetadata = csvMetadata(),
    options: Record<string, unknown> = {},
): string {
    return generateCompleteDdl(metadata, {
        tableName: 'cert_iris',
        schemaName: 'cert_schema',
        dataSource: 'cert_src',
        targetPlatform: 'sql_server_2025',
        storageUrl: 'abs://datasets@example.blob.core.windows.net',
        ...options,
    });
}

describe('the complete document survives being run twice', () => {
    it('guards every CREATE', () => {
        assert.deepStrictEqual(unguardedCreates(completeDocument()), []);
    });

    it('guards against the right catalog', () => {
        const document = completeDocument();
        assert.ok(
            document.includes(
                "IF NOT EXISTS (SELECT 1 FROM sys.external_data_sources WHERE name = N'cert_src')",
            ),
            'external data source guard missing',
        );
        assert.ok(
            document.includes("IF OBJECT_ID(N'[cert_schema].[cert_iris]', N'U') IS NULL"),
            'table guard missing',
        );
    });

    it('looks the catalog name up unbracketed', () => {
        // sys.external_data_sources.name holds cert_src, not [cert_src]. A guard
        // comparing the bracketed form never matches, so the CREATE runs every
        // time - which is the bug the guard exists to prevent.
        assert.ok(!completeDocument().includes("WHERE name = N'[cert_src]'"));
    });

    it('empties the load target before loading it', () => {
        const document = completeDocument();
        const truncate = document.indexOf('TRUNCATE TABLE [cert_schema].[cert_iris];');
        const load = document.indexOf('BULK INSERT [cert_schema].[cert_iris]');
        assert.ok(truncate >= 0 && load >= 0, 'expected a truncate and a load');
        assert.ok(truncate < load, 'the truncate must come first');
    });

    it('guards the truncate, because the table may genuinely be absent', () => {
        assert.ok(
            completeDocument().includes(
                "IF OBJECT_ID(N'[cert_schema].[cert_iris]', N'U') IS NOT NULL",
            ),
        );
    });

    it('does not count a commented-out load as a load', () => {
        const document = completeDocument();
        assert.ok(document.indexOf('TRUNCATE TABLE') > document.indexOf('QUICK LOAD'));
    });

    it('adds no truncate to a document that loads nothing', () => {
        assert.ok(!completeDocument(parquetMetadata()).includes('TRUNCATE TABLE'));
    });

    it('does not mistake a semicolon inside a literal for the end of a statement', () => {
        const document = completeDocument({ ...csvMetadata(), delimiter: ';' });
        assert.ok(document.includes("FIELD_TERMINATOR = ';'"));
        const body = document.slice(document.indexOf('CREATE EXTERNAL FILE FORMAT'));
        assert.ok(
            !body.slice(0, body.indexOf(');')).includes('END'),
            'END landed inside the statement',
        );
        assert.deepStrictEqual(unguardedCreates(document), []);
    });

    it('balances every BEGIN with an END', () => {
        for (const delimiter of [',', ';', '|', '\t']) {
            const document = completeDocument({ ...csvMetadata(), delimiter });
            const begins = (document.match(/^\s*BEGIN\s*$/gm) || []).length;
            const ends = (document.match(/^\s*END\s*$/gm) || []).length;
            assert.strictEqual(begins, ends, `unbalanced for delimiter ${delimiter}`);
            assert.ok(begins > 0);
        }
    });

    it('leaves no bare CREATE on any platform', () => {
        for (const platform of PLATFORMS as readonly TargetPlatform[]) {
            assert.deepStrictEqual(
                unguardedCreates(completeDocument(csvMetadata(), { targetPlatform: platform })),
                [],
                `${platform} left a bare CREATE`,
            );
        }
    });
});

describe('individual statement tabs stay bare', () => {
    it('gives the CREATE TABLE tab no guard', () => {
        const statements = generateAllStatements(csvMetadata(), {
            tableName: 'cert_iris',
            schemaName: 'cert_schema',
            targetPlatform: 'sql_server_2025',
        });
        assert.ok(statements.create_table.includes('CREATE TABLE'));
        assert.ok(!statements.create_table.includes('IF OBJECT_ID'));
    });

    it('gives the prerequisite setup tab no guard', () => {
        const statements = generateAllStatements(csvMetadata(), {
            dataSource: 'cert_src',
            targetPlatform: 'sql_server_2025',
            storageUrl: 'abs://datasets@example.blob.core.windows.net',
        });
        assert.ok(statements.credential_setup.includes('CREATE EXTERNAL DATA SOURCE'));
        assert.ok(!statements.credential_setup.includes('sys.external_data_sources'));
    });
});
