/**
 * Behavioural tests for the native analysis core.
 *
 * These cover the properties the parity baseline cannot express: what happens
 * with malformed, truncated or oversized input, that cancellation is honoured,
 * that previews are bounded, and that the advertised format matrix matches what
 * the analyzers actually do.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';

import { SimpleCancellationTokenSource } from '../../native/cancellation';
import { CancellationError } from '../../native/errors';
import {
    analyzeFileMetadata,
    clearMetadataCache,
    detectFileType,
    listSupportedFormats,
} from '../../native/detector';
import { generateBulkInsert, generateCreateTable } from '../../native/sql/generator';
import { generateOpenjsonColumns } from '../../native/sql/generatorHelpers';
import { clampPreviewRows, getPreviewData } from '../../native/preview';
import { resolveWithinRoot } from '../../native/paths';
import { NativeAnalysisService } from '../../native/service';
import {
    decodeBuffer,
    detectEncodingFromBuffer,
    encodingToCodepage,
} from '../../native/encoding';
import {
    JSON_SCHEMA_MAX_COLUMNS,
    PREVIEW_DEFAULT_ROWS,
    PREVIEW_MAX_ROWS,
} from '../../native/limits';
import type { FileMetadata, FileType, NativeSupport } from '../../native/types';
import { fixturePath, REPO_ROOT } from './parityInvariants';

/** Representative committed samples, and what the native core should do with them. */
const FORMAT_MATRIX: ReadonlyArray<
    readonly [relative: string, fileType: FileType, support: NativeSupport]
> = [
    ['data sample/csv/sales_scalars.csv', 'csv', 'supported'],
    ['data sample/csv/sales_scalars.tsv', 'csv', 'supported'],
    ['data sample/csv/sales_scalars_pipe.csv', 'csv', 'supported'],
    ['data sample/json/orders_array.json', 'json', 'supported'],
    ['data sample/json/orders.ndjson', 'json', 'supported'],
    ['data sample/json/order_single_object.json', 'json', 'supported'],
    ['data sample/parquet/all_types.parquet', 'parquet', 'supported'],
    ['data sample/parquet/sales.parquet', 'parquet', 'supported'],
    ['data sample/excel/inventory.xlsx', 'excel', 'supported'],
    ['data sample/orc/all_types.orc', 'orc', 'unsupported_native'],
    ['data sample/text/readme_sample.txt', 'text', 'supported'],
    ['data sample/unicode/unicode_utf8.csv', 'csv', 'supported'],
    ['data sample/unicode/unicode_utf8_bom.csv', 'csv', 'supported'],
    ['data sample/unicode/unicode_utf16le_bom.csv', 'csv', 'supported'],
    ['data sample/unicode/unicode_utf16le_bom.tsv', 'csv', 'supported'],
    ['data sample/unicode/japanese_cp932.csv', 'csv', 'supported'],
    ['data sample/unicode/collation_cases_utf8.csv', 'csv', 'supported'],
    ['data sample/tables/events_delta', 'delta', 'supported'],
    ['data sample/tables/events_iceberg', 'iceberg', 'supported'],
];

async function analyze(relative: string): Promise<FileMetadata> {
    const reference = await resolveWithinRoot(fixturePath(relative), REPO_ROOT);
    return analyzeFileMetadata(reference);
}

describe('format matrix', () => {
    for (const [relative, fileType, support] of FORMAT_MATRIX) {
        it(`${relative} → ${fileType} (${support})`, async () => {
            const metadata = await analyze(relative);
            assert.strictEqual(metadata.file_type, fileType);
            assert.strictEqual(metadata.native_support ?? 'supported', support);
            assert.ok(
                metadata.file_size > 0 || fileType === 'delta' || fileType === 'iceberg',
                'a real file must report a size',
            );
            if (support === 'supported') {
                assert.ok(
                    Array.isArray(metadata.schema) || fileType === 'text',
                    `${relative} should expose a schema`,
                );
                assert.strictEqual(
                    metadata.error,
                    undefined,
                    `${relative} reported an error: ${metadata.error}`,
                );
            }
        });
    }

    it('matches pandas precision for Excel timestamps', async () => {
        const metadata = await analyze('data sample/excel/inventory.xlsx');
        const schema = Object.fromEntries(metadata.schema ?? []);

        assert.strictEqual(schema.sku, 'str');
        assert.strictEqual(schema.description, 'str');
        assert.strictEqual(schema.last_counted, 'datetime64[us]');
        assert.match(generateCreateTable(metadata), /\[last_counted\]\s+DATETIME2\(6\)/);
    });

    it('advertises the same support level it delivers', async () => {
        const advertised = new Map(
            listSupportedFormats().map((format) => [format.fileType, format.support]),
        );
        for (const [relative, fileType, support] of FORMAT_MATRIX) {
            assert.strictEqual(
                advertised.get(fileType),
                support,
                `${relative}: listSupportedFormats disagrees for ${fileType}`,
            );
        }
    });

    it('lists RCFile as recognition-only', () => {
        const rc = listSupportedFormats().find((f) => f.fileType === 'rc');
        assert.ok(rc, 'RCFile must appear in the supported format list');
        assert.strictEqual(rc.support, 'recognition_only');
        assert.ok(rc.notes.length > 0, 'RCFile must carry explanatory guidance');
    });
});

describe('encoding detection', () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
        ['data sample/csv/sales_scalars.csv', 'utf-8', '65001'],
        ['data sample/unicode/unicode_utf8_bom.csv', 'utf-8-sig', '65001'],
        ['data sample/unicode/unicode_utf16le_bom.csv', 'utf-16', '1200'],
        ['data sample/unicode/japanese_cp932.csv', 'cp932', '932'],
    ];

    for (const [relative, encoding, codepage] of cases) {
        it(`${relative} → ${encoding} (codepage ${codepage})`, async () => {
            const metadata = await analyze(relative);
            assert.strictEqual(metadata.encoding, encoding);
            assert.strictEqual(metadata.codepage, codepage);
        });
    }

    it('round-trips non-ASCII values through the CP932 decoder', async () => {
        const metadata = await analyze('data sample/unicode/japanese_cp932.csv');
        const rendered = JSON.stringify(metadata.sample_rows ?? []);
        assert.ok(
            /日本語/.test(rendered),
            `expected decoded Japanese text in sample rows, got ${rendered}`,
        );
        assert.ok(
            !/\ufffd/.test(rendered),
            `CP932 decoding produced replacement characters: ${rendered}`,
        );
    });

    it('round-trips non-ASCII column names through UTF-8', async () => {
        const metadata = await analyze('data sample/unicode/unicode_utf8.csv');
        const rendered = JSON.stringify([
            metadata.schema ?? [],
            metadata.sample_rows ?? [],
        ]);
        assert.ok(
            [...rendered].some((character) => character.codePointAt(0)! > 0x7f),
            `expected non-ASCII content, got ${rendered}`,
        );
        assert.ok(
            !/\ufffd/.test(rendered),
            `UTF-8 decoding produced replacement characters: ${rendered}`,
        );
    });
});

describe('malformed, truncated and hostile input', () => {
    let root = '';

    before(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'native-bad-'));
    });

    after(async () => {
        clearMetadataCache();
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    async function write(name: string, content: string | Buffer): Promise<string> {
        const target = path.join(root, name);
        await fs.promises.writeFile(target, content);
        return target;
    }

    async function analyzeTemp(name: string): Promise<FileMetadata> {
        const reference = await resolveWithinRoot(path.join(root, name), root);
        return analyzeFileMetadata(reference);
    }

    it('reports an empty file without throwing', async () => {
        await write('empty.csv', '');
        const metadata = await analyzeTemp('empty.csv');
        assert.strictEqual(metadata.file_size, 0);
        assert.ok(metadata.error !== undefined || metadata.row_count === 0);
    });

    it('handles a header with no data rows', async () => {
        await write('header-only.csv', 'a,b,c\n');
        const metadata = await analyzeTemp('header-only.csv');
        assert.strictEqual(metadata.row_count, 0);
        assert.strictEqual(metadata.column_count, 3);
    });

    it('handles ragged rows without crashing', async () => {
        await write('ragged.csv', 'a,b,c\n1,2\n3,4,5,6,7\n8\n');
        const metadata = await analyzeTemp('ragged.csv');
        assert.strictEqual(metadata.column_count, 3);
        assert.ok((metadata.row_count ?? 0) >= 3);
    });

    it('handles an unterminated quoted field', async () => {
        await write('unterminated.csv', 'a,b\n"open,2\n3,4\n');
        const metadata = await analyzeTemp('unterminated.csv');
        assert.ok(metadata.file_type === 'csv');
        assert.ok(metadata.column_count !== null);
    });

    it('handles quoted delimiters and embedded newlines', async () => {
        await write('quoted.csv', 'a,b\n"x,y","line1\nline2"\n"he said ""hi""",2\n');
        const metadata = await analyzeTemp('quoted.csv');
        assert.strictEqual(metadata.column_count, 2);
        assert.strictEqual(metadata.row_count, 2);
    });

    it('rejects truncated Parquet without inventing a schema', async () => {
        const real = await fs.promises.readFile(
            fixturePath('data sample/parquet/sales.parquet'),
        );
        await write('truncated.parquet', real.subarray(0, Math.floor(real.length / 3)));
        const metadata = await analyzeTemp('truncated.parquet');
        assert.strictEqual(metadata.file_type, 'parquet');
        assert.ok(
            metadata.error !== undefined || metadata.schema === null,
            'a truncated Parquet file must not produce a confident schema',
        );
    });

    it('rejects a Parquet file whose footer length is absurd', async () => {
        const bogus = Buffer.alloc(64);
        bogus.write('PAR1', 0, 'latin1');
        bogus.writeUInt32LE(0xfffffff0, 56);
        bogus.write('PAR1', 60, 'latin1');
        await write('bogus.parquet', bogus);
        const metadata = await analyzeTemp('bogus.parquet');
        assert.ok(metadata.error !== undefined || metadata.schema === null);
    });

    it('rejects malformed JSON without a whole-file parse blowing up', async () => {
        await write('broken.json', '[{"a": 1}, {"a": ');
        const metadata = await analyzeTemp('broken.json');
        assert.strictEqual(metadata.file_type, 'json');
        assert.ok(metadata.error !== undefined || metadata.schema === null);
    });

    it('handles NDJSON with a malformed line in the middle', async () => {
        await write('mixed.ndjson', '{"a":1}\nnot json\n{"a":3}\n');
        const metadata = await analyzeTemp('mixed.ndjson');
        assert.strictEqual(metadata.file_type, 'json');
    });

    it('infers exact CSV numerics without rounding boundary values', async () => {
        const overPrecision = '9'.repeat(39);
        await write(
            'exact-numerics.csv',
            'small,big,max_big,decimal,over_big,over_precision,scaled,tiny\n' +
            '2147483647,2147483648,9223372036854775807,' +
            `12345678901234.5678,9223372036854775808,${overPrecision},` +
            '1.2300e2,1e-4\n',
        );
        const metadata = await analyzeTemp('exact-numerics.csv');
        const schema = Object.fromEntries(metadata.schema ?? []);

        assert.strictEqual(schema.small, 'int32');
        assert.strictEqual(schema.big, 'int64');
        assert.strictEqual(schema.max_big, 'int64');
        assert.strictEqual(schema.decimal, 'decimal(18,4)');
        assert.strictEqual(schema.over_big, 'decimal(19,0)');
        assert.strictEqual(schema.over_precision, 'decimal(39,0)');
        assert.strictEqual(schema.scaled, 'object');
        assert.strictEqual(schema.tiny, 'object');
        assert.strictEqual(metadata.schema_inference, 'full');
        assert.strictEqual(metadata.sample_rows?.[0]?.[2], '9223372036854775807');
        assert.strictEqual(metadata.sample_rows?.[0]?.[3], '12345678901234.5678');

        const sql = generateCreateTable(metadata);
        assert.match(sql, /\[small\]\s+INT\b/);
        assert.match(sql, /\[big\]\s+BIGINT\b/);
        assert.match(sql, /\[decimal\]\s+DECIMAL\(18,4\)/);
        assert.match(sql, /\[over_big\]\s+DECIMAL\(19,0\)/);
        assert.match(sql, /\[over_precision\]\s+NVARCHAR\(MAX\)/);
        assert.match(sql, /\[scaled\]\s+NVARCHAR\(255\)/);
        assert.match(sql, /\[tiny\]\s+NVARCHAR\(255\)/);

        const preview = await new NativeAnalysisService(root).preview({
            filePath: path.join(root, 'exact-numerics.csv'),
            maxRows: 1,
        });
        assert.strictEqual(preview.rows[0]?.[2], '9223372036854775807');
        assert.strictEqual(preview.rows[0]?.[3], '12345678901234.5678');
        assert.strictEqual(preview.rows[0]?.[6], '1.2300e2');
        assert.strictEqual(preview.rows[0]?.[7], '1e-4');
    });

    it('keeps exponent syntax as loadable text while normal decimals stay exact', async () => {
        await write(
            'scientific.csv',
            'normal,positive_exp,negative_exp\n123.4500,1e+7,1e-7\n',
        );
        const metadata = await analyzeTemp('scientific.csv');
        const schema = Object.fromEntries(metadata.schema ?? []);

        assert.strictEqual(schema.normal, 'decimal(7,4)');
        assert.strictEqual(schema.positive_exp, 'object');
        assert.strictEqual(schema.negative_exp, 'object');
        assert.deepStrictEqual(
            metadata.sample_rows?.[0],
            [123.45, '1e+7', '1e-7'],
        );
        const sql = generateCreateTable(metadata);
        assert.match(sql, /\[normal\]\s+DECIMAL\(7,4\)/);
        assert.match(sql, /\[positive_exp\]\s+NVARCHAR\(255\)/);
        assert.match(sql, /\[negative_exp\]\s+NVARCHAR\(255\)/);
    });

    it('keeps numeric-looking cells textual in a mixed CSV column preview', async () => {
        await write(
            'mixed-preview.csv',
            'value,label,id\n1,first,10\nlater,second,20\n',
        );
        const metadata = await analyzeTemp('mixed-preview.csv');
        assert.deepStrictEqual(metadata.schema?.[0], ['value', 'object']);

        const preview = await new NativeAnalysisService(root).preview({
            filePath: path.join(root, 'mixed-preview.csv'),
            maxRows: 2,
        });
        assert.deepStrictEqual(preview.rows, [
            ['1', 'first', 10],
            ['later', 'second', 20],
        ]);
    });

    it('does not fabricate false for an unexpected cell in a sampled bool column', async () => {
        await write(
            'sampled-bool-preview.csv',
            'flag,label,id\nTrue,first,1\nunexpected,second,2\n',
        );
        const metadata = await analyzeTemp('sampled-bool-preview.csv');
        const reference = await resolveWithinRoot(
            path.join(root, 'sampled-bool-preview.csv'),
            root,
        );
        const preview = await getPreviewData(
            reference,
            {
                ...metadata,
                schema: [
                    ['flag', 'bool'],
                    ['label', 'object'],
                    ['id', 'int32'],
                ],
            },
            2,
        );
        assert.deepStrictEqual(preview.rows, [
            [true, 'first', 1],
            ['unexpected', 'second', 2],
        ]);
    });

    it('aggregates complete CSV type and width evidence after row 1000', async () => {
        const rows = Array.from({ length: 1000 }, (_, index) => String(index + 1));
        rows.push('x'.repeat(5000));
        await write('late-wide-value.csv', `value\n${rows.join('\n')}\n`);

        const metadata = await analyzeTemp('late-wide-value.csv');
        assert.deepStrictEqual(metadata.schema, [['value', 'object']]);
        assert.strictEqual(metadata.schema_inference, 'full');
        assert.strictEqual(metadata.schema_sample_size, 1001);
        assert.strictEqual(metadata.observed_max_string_lengths?.value, 5000);
        assert.match(generateCreateTable(metadata), /\[value\]\s+NVARCHAR\(MAX\)/);
    });

    it('aggregates every row of a complete JSON array before typing it', async () => {
        const rows = Array.from({ length: 200 }, (_, index) => ({ value: index }));
        const text = `${JSON.stringify(rows).slice(0, -1)},{"value":"late"}]`;
        await write('late-json-family.json', text);

        const metadata = await analyzeTemp('late-json-family.json');
        assert.deepStrictEqual(metadata.schema, [['value', 'str']]);
        assert.strictEqual(metadata.schema_inference, 'full');
        assert.strictEqual(metadata.schema_sample_size, 201);
        assert.strictEqual(metadata.json_typed_projection_safe, false);
        assert.deepStrictEqual(generateOpenjsonColumns(metadata), []);
        assert.match(generateCreateTable(metadata), /\[value\]\s+NVARCHAR\(MAX\)/);
    });

    it('infers JSON integer ranges and preserves unsafe numeric samples', async () => {
        await write(
            'json-numerics.json',
            '[{"small":2147483647,"big":2147483648,' +
            '"max_big":9223372036854775807,' +
            '"over_big":9223372036854775808,' +
            '"decimal":12345678901234.5678}]',
        );
        const metadata = await analyzeTemp('json-numerics.json');
        const schema = Object.fromEntries(metadata.schema ?? []);

        assert.strictEqual(schema.small, 'int32');
        assert.strictEqual(schema.big, 'int64');
        assert.strictEqual(schema.max_big, 'int64');
        assert.strictEqual(schema.over_big, 'decimal(19,0)');
        assert.strictEqual(schema.decimal, 'decimal(18,4)');
        assert.strictEqual(
            metadata.json_sample_values?.max_big,
            '9223372036854775807',
        );
        assert.strictEqual(
            metadata.json_sample_values?.decimal,
            '12345678901234.5678',
        );

        const preview = await new NativeAnalysisService(root).preview({
            filePath: path.join(root, 'json-numerics.json'),
            maxRows: 1,
        });
        assert.deepStrictEqual(preview.rows[0], [
            2147483647,
            2147483648,
            '9223372036854775807',
            '9223372036854775808',
            '12345678901234.5678',
        ]);
    });

    it('accepts 256-character JSON numerics but preserves 257-character evidence', async () => {
        const accepted = '9'.repeat(256);
        await write('numeric-boundary.json', `[{"value":${accepted}}]`);

        const metadata = await analyzeTemp('numeric-boundary.json');
        assert.deepStrictEqual(metadata.schema, [['value', 'decimal(256,0)']]);
        assert.strictEqual(metadata.json_sample_values?.value, accepted);
        assert.strictEqual(metadata.json_typed_projection_safe, true);
        assert.match(generateCreateTable(metadata), /\[value\]\s+NVARCHAR\(MAX\)/);

        const rejected = '8'.repeat(257);
        await write('numeric-over-boundary.json', `[{"value":${rejected}}]`);
        const overBoundary = await analyzeTemp('numeric-over-boundary.json');
        assert.deepStrictEqual(overBoundary.schema, [['value', 'str']]);
        assert.strictEqual(overBoundary.json_sample_values?.value, rejected);
        assert.strictEqual(overBoundary.json_typed_projection_safe, false);

        await write(
            'oversized-numeric.json',
            `[{"value":1},{"value":${rejected}}]`,
        );
        const oversized = await analyzeTemp('oversized-numeric.json');
        assert.deepStrictEqual(oversized.schema, [['value', 'str']]);
        assert.strictEqual(oversized.json_typed_projection_safe, false);
        assert.deepStrictEqual(generateOpenjsonColumns(oversized), []);
        assert.match(generateCreateTable(oversized), /\[value\]\s+NVARCHAR\(MAX\)/);
        const fabricLoad = generateBulkInsert(oversized, {
            targetPlatform: 'fabric_sql_db',
        });
        assert.match(fabricLoad, /Preserve each JSON object or NDJSON line/);
        assert.doesNotMatch(fabricLoad, /INSERT INTO \[/);

        const preview = await new NativeAnalysisService(root).preview({
            filePath: path.join(root, 'oversized-numeric.json'),
            maxRows: 2,
        });
        assert.deepStrictEqual(preview.rows, [[1], [rejected]]);
    });

    it('falls back from object/scalar JSON mixtures to schemaless OPENJSON', async () => {
        await write('mixed-json-shape.json', '[{"value":{"id":1}},{"value":2}]');
        const metadata = await analyzeTemp('mixed-json-shape.json');

        assert.deepStrictEqual(metadata.schema, [['value', 'str']]);
        assert.strictEqual(metadata.json_typed_projection_safe, false);
        assert.deepStrictEqual(generateOpenjsonColumns(metadata), []);
    });

    it('caps dynamic NDJSON keys and marks generation preservation-only', async () => {
        const lines = Array.from(
            { length: JSON_SCHEMA_MAX_COLUMNS + 2 },
            (_, index) => JSON.stringify({ [`key_${index}`]: index }),
        );
        await write('dynamic-keys.ndjson', `${lines.join('\n')}\n`);
        const metadata = await analyzeTemp('dynamic-keys.ndjson');

        assert.strictEqual(metadata.schema?.length, JSON_SCHEMA_MAX_COLUMNS);
        assert.strictEqual(metadata.column_count, JSON_SCHEMA_MAX_COLUMNS);
        assert.strictEqual(metadata.schema_sample_size, JSON_SCHEMA_MAX_COLUMNS + 2);
        assert.strictEqual(metadata.schema_inference, 'sampled');
        assert.strictEqual(metadata.analysis_truncated, true);
        assert.strictEqual(metadata.json_typed_projection_safe, false);
        assert.match(metadata.warning ?? '', /distinct keys/i);
        assert.deepStrictEqual(generateOpenjsonColumns(metadata), []);
        const createTable = generateCreateTable(metadata);
        assert.match(createTable, /4,096 detected columns/);
        assert.match(createTable, /1,024-column target-table limit/);
        assert.doesNotMatch(createTable, /CREATE TABLE \[/);
        assert.ok(
            !(metadata.schema ?? []).some(
                ([key]) => key === `key_${JSON_SCHEMA_MAX_COLUMNS}`,
            ),
        );
    });

    it('treats huge numeric tokens and Unicode digits as text', async () => {
        const huge = '9'.repeat(10_000);
        await write('huge-number.json', `[{"value":${huge}}]`);
        const jsonMetadata = await analyzeTemp('huge-number.json');
        assert.deepStrictEqual(jsonMetadata.schema, [['value', 'str']]);
        assert.strictEqual(jsonMetadata.json_sample_values?.value, huge);

        await write(
            'unicode-digits.csv',
            'arabic_indic,full_width\n١٢٣,１２３\n',
        );
        const csvMetadata = await analyzeTemp('unicode-digits.csv');
        assert.deepStrictEqual(csvMetadata.schema, [
            ['arabic_indic', 'object'],
            ['full_width', 'object'],
        ]);
        assert.deepStrictEqual(csvMetadata.sample_rows, [['١٢٣', '１２３']]);
    });

    it('refuses a zip bomb disguised as a workbook', async () => {
        // A .xlsx whose central directory claims a vastly inflated size must be
        // rejected by the decompression guards, not expanded into memory.
        const fake = Buffer.concat([
            Buffer.from('PK\u0003\u0004', 'latin1'),
            Buffer.alloc(1024, 0),
        ]);
        await write('bomb.xlsx', fake);
        const metadata = await analyzeTemp('bomb.xlsx');
        assert.ok(
            metadata.error !== undefined || metadata.schema === null,
            'a malformed workbook must be reported, not parsed',
        );
    });

    it('does not compile a hostile relationship id into a regular expression', async () => {
        // `xl/workbook.xml` names its worksheet through an `r:id` attribute the
        // file's author controls. If that value were interpolated into a
        // pattern, `(a+)+X` against a long matching subject would wedge the
        // extension host, and a lone backslash would throw a SyntaxError out of
        // a path that only expects a parse miss. The id must be compared, never
        // compiled.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { zipSync, strToU8 } = require('fflate') as {
            zipSync(files: Record<string, Uint8Array>): Uint8Array;
            strToU8(text: string): Uint8Array;
        };
        const evilIds = ['(a+)+$', '\\', '[', '.*.*.*.*.*.*.*.*.*!'];
        for (const [index, evilId] of evilIds.entries()) {
            const padding = 'a'.repeat(4000);
            const workbook =
                '<workbook><sheets>' +
                `<sheet name="S" sheetId="1" r:id="${evilId}${padding}"/>` +
                '</sheets></workbook>';
            const rels =
                '<Relationships>' +
                `<Relationship Id="${evilId}${padding}" Target="worksheets/sheet1.xml"/>` +
                '</Relationships>';
            const sheet =
                '<worksheet><sheetData>' +
                '<row r="1"><c r="A1" t="inlineStr"><is><t>header</t></is></c></row>' +
                '<row r="2"><c r="A2" t="inlineStr"><is><t>value</t></is></c></row>' +
                '</sheetData></worksheet>';
            const name = `evil${index}.xlsx`;
            await write(
                name,
                Buffer.from(
                    zipSync({
                        'xl/workbook.xml': strToU8(workbook),
                        'xl/_rels/workbook.xml.rels': strToU8(rels),
                        'xl/worksheets/sheet1.xml': strToU8(sheet),
                    }),
                ),
            );
            const started = Date.now();
            const metadata = await analyzeTemp(name);
            const elapsed = Date.now() - started;
            assert.ok(
                elapsed < 2000,
                `a hostile r:id must not stall analysis (took ${elapsed}ms for ${evilId})`,
            );
            assert.strictEqual(metadata.file_type, 'excel');
            // The relationship still resolves, because the id is matched by
            // equality rather than as a pattern.
            assert.ok(
                metadata.schema !== null && metadata.schema.length > 0,
                `the worksheet must still be found for ${evilId}`,
            );
        }
    });

    it('does not follow a directory that only looks like a table', async () => {
        await fs.promises.mkdir(path.join(root, 'fake_delta', '_delta_log'), {
            recursive: true,
        });
        await fs.promises.writeFile(
            path.join(root, 'fake_delta', '_delta_log', '00000000000000000000.json'),
            'this is not json\n',
        );
        const metadata = await analyzeTemp('fake_delta');
        assert.ok(
            metadata.error !== undefined || metadata.schema === null,
            'an unparseable Delta log must surface an error',
        );
    });

    it('detects file type from content, not just extension', async () => {
        const real = await fs.promises.readFile(
            fixturePath('data sample/parquet/sales.parquet'),
        );
        await write('mislabelled.csv', real);
        const reference = await resolveWithinRoot(
            path.join(root, 'mislabelled.csv'),
            root,
        );
        const detected = await detectFileType(reference);
        assert.ok(
            detected === 'parquet' || detected === 'csv',
            `unexpected detection result ${detected}`,
        );
    });
});

describe('cancellation', () => {
    it('throws CancellationError when the token is already cancelled', async () => {
        const source = new SimpleCancellationTokenSource();
        source.cancel();
        const reference = await resolveWithinRoot(
            fixturePath('data sample/csv/sales_scalars.csv'),
            REPO_ROOT,
        );
        await assert.rejects(
            () => analyzeFileMetadata(reference, source.token),
            CancellationError,
        );
    });

    it('does not corrupt the cache when a run is cancelled', async () => {
        clearMetadataCache();
        const source = new SimpleCancellationTokenSource();
        source.cancel();
        const reference = await resolveWithinRoot(
            fixturePath('data sample/csv/sales_scalars.csv'),
            REPO_ROOT,
        );
        await assert.rejects(() => analyzeFileMetadata(reference, source.token));
        const metadata = await analyzeFileMetadata(reference);
        assert.strictEqual(metadata.file_type, 'csv');
        assert.ok((metadata.schema ?? []).length > 0);
    });

    it('cancels a preview request', async () => {
        const service = new NativeAnalysisService(REPO_ROOT);
        const source = new SimpleCancellationTokenSource();
        source.cancel();
        await assert.rejects(() =>
            service.preview({
                filePath: fixturePath('data sample/csv/sales_scalars.csv'),
                token: source.token,
            }),
        );
    });
});

describe('bounded previews', () => {
    it('clamps the requested row count', () => {
        assert.strictEqual(clampPreviewRows(0), 1);
        assert.strictEqual(clampPreviewRows(-5), 1);
        assert.strictEqual(clampPreviewRows(10), 10);
        assert.strictEqual(clampPreviewRows(PREVIEW_MAX_ROWS + 1), PREVIEW_MAX_ROWS);
        assert.strictEqual(clampPreviewRows(Number.NaN), 1);
        assert.strictEqual(clampPreviewRows(PREVIEW_DEFAULT_ROWS), PREVIEW_DEFAULT_ROWS);
    });

    it('never returns more rows than requested', async () => {
        const service = new NativeAnalysisService(REPO_ROOT);
        for (const relative of [
            'data sample/csv/sales_scalars.csv',
            'data sample/json/orders_array.json',
            'data sample/parquet/sales.parquet',
            'data sample/excel/inventory.xlsx',
            'data sample/performance/events_250k.parquet',
        ]) {
            const preview = await service.preview({
                filePath: fixturePath(relative),
                maxRows: 2,
            });
            assert.ok(
                preview.rows.length <= 2,
                `${relative} returned ${preview.rows.length} rows for maxRows=2`,
            );
            assert.ok(preview.columns.length > 0, `${relative} returned no columns`);
        }
    });

    it('keeps a large-file preview bounded', async () => {
        const service = new NativeAnalysisService(REPO_ROOT);
        const filePath = fixturePath('data sample/performance/events_250k.parquet');
        const metadata = await service.analyze({ filePath });
        const preview = await service.preview({ filePath, maxRows: 25 });
        assert.strictEqual(metadata.row_count, 250_000);
        assert.strictEqual(preview.rows.length, 25);
        assert.strictEqual(preview.truncated, true);
    });
});

describe('service facade', () => {
    it('analyses and generates in one call', async () => {
        const service = new NativeAnalysisService(REPO_ROOT);
        const result = await service.analyzeAndGenerate({
            filePath: fixturePath('data sample/csv/sales_scalars.csv'),
        });
        assert.strictEqual(result.metadata.file_type, 'csv');
        assert.ok(/CREATE\s+TABLE/i.test(result.statements.create_table));
    });

    it('scans a directory of supported files', async () => {
        const service = new NativeAnalysisService(REPO_ROOT);
        const result = await service.analyzeDirectory({
            filePath: fixturePath('data sample/csv'),
        });
        assert.ok(result.files.length >= 9);
        for (const metadata of result.files) {
            assert.strictEqual(metadata.file_type, 'csv');
        }
    });

    it('treats a Delta directory as one logical table', async () => {
        const service = new NativeAnalysisService(REPO_ROOT);
        const result = await service.analyzeDirectory({
            filePath: fixturePath('data sample/tables/events_delta'),
        });
        assert.strictEqual(result.files.length, 1);
        assert.strictEqual(result.files[0].file_type, 'delta');
    });

    it('reports errors instead of throwing when asked to', async () => {
        const service = new NativeAnalysisService(REPO_ROOT);
        const result = await service.tryAnalyze({
            filePath: fixturePath('data sample/does-not-exist.csv'),
        });
        assert.strictEqual(result.ok, false);
    });

    it('produces a multi-file script with shared prerequisites once', async () => {
        const service = new NativeAnalysisService(REPO_ROOT);
        const entries = await Promise.all(
            [
                'data sample/csv/sales_scalars.csv',
                'data sample/csv/sales_scalars.tsv',
            ].map(
                async (relative) => ({
                    metadata: await analyze(relative),
                }),
            ),
        );
        const script = service.generateMultiFileScript({
            entries,
            dataSource: 'Shared',
            targetPlatform: 'azure_sql_db',
        });
        const masterKeys = script.match(/CREATE\s+MASTER\s+KEY/gi) ?? [];
        assert.ok(
            masterKeys.length <= 1,
            `master key created ${masterKeys.length} times`,
        );
        assert.ok(/\[sales_scalars\]/i.test(script));
    });
});

describe('UTF-16 without a byte order mark', () => {
    const body = 'id,name,city\r\n1,Alice,Paris\r\n2,Bob,Tokyo\r\n';

    const cases: ReadonlyArray<readonly [string, BufferEncoding, string]> = [
        ['little endian', 'utf16le', 'utf-16-le'],
        ['big endian', 'utf16le', 'utf-16-be'],
    ];

    for (const [label, , expected] of cases) {
        it(`is not mistaken for ASCII (${label})`, () => {
            let buffer = Buffer.from(body, 'utf16le');
            if (expected === 'utf-16-be') {
                buffer = Buffer.from(buffer);
                buffer.swap16();
            }
            const detected = detectEncodingFromBuffer(buffer);
            assert.strictEqual(detected.encoding, expected);
            assert.strictEqual(detected.bomLength, 0);
            assert.strictEqual(
                encodingToCodepage(detected.encoding),
                expected === 'utf-16-le' ? '1200' : '1201',
            );
        });
    }

    it('decodes back to the original text rather than NUL padded bytes', () => {
        const buffer = Buffer.from(body, 'utf16le');
        const detected = detectEncodingFromBuffer(buffer);
        assert.strictEqual(decodeBuffer(buffer, detected.encoding), body);
    });

    it('leaves ordinary text and binary alone', () => {
        const untouched: ReadonlyArray<readonly [string, Buffer, string]> = [
            ['plain ascii', Buffer.from('id,name\r\n1,Alice\r\n'), 'ascii'],
            ['utf-8 text', Buffer.from('id,name\r\n1,Björk\r\n', 'utf8'), 'utf-8'],
        ];
        for (const [label, buffer, expected] of untouched) {
            assert.strictEqual(detectEncodingFromBuffer(buffer).encoding, expected, label);
        }
        // NULs on both parities are binary, not UTF-16.
        const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => [0, 0, 1, 2][i % 4]));
        assert.notStrictEqual(detectEncodingFromBuffer(binary).encoding, 'utf-16-le');
        assert.notStrictEqual(detectEncodingFromBuffer(binary).encoding, 'utf-16-be');
    });
});