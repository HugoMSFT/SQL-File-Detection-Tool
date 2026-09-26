import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
    CancellationError,
    FileChangedError,
    NativeAnalysisService,
    SimpleCancellationTokenSource,
    clearMetadataCache,
    type AnalysisPreview,
    type AnalysisRequest,
} from '../../native';
import { parseJson, parseJsonCooperatively } from '../../native/analysis/jsonValue';
import {
    ENCODING_DETECTION_BYTES,
    FAST_PREVIEW_MAX_BYTES,
    FAST_PREVIEW_MAX_COLUMNS,
    FAST_PREVIEW_MAX_RECORD_CHARS,
    FAST_PREVIEW_MAX_ROWS,
} from '../../native/limits';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function fixture(t: TestContext, name: string, content: string | Buffer): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-progressive-')));
    t.after(() => {
        clearMetadataCache();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const file = path.join(root, name);
    fs.writeFileSync(file, content);
    clearMetadataCache();
    return file;
}

/** Measure actual file-handle reads, independently of the sampler's counters. */
function observeReads(t: TestContext, file: string) {
    let bytes = 0;
    let furthest = 0;
    const open = fs.promises.open.bind(fs.promises);
    t.mock.method(fs.promises, 'open', async (input: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
        const handle = await open(input, flags, mode);
        if (String(input) === file) {
            const read = handle.read.bind(handle);
            t.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
                const result = await read(buffer, offset, length, position);
                bytes += result.bytesRead;
                furthest = Math.max(furthest, position + result.bytesRead);
                return result;
            });
        }
        return handle;
    });
    return { get bytes() { return bytes; }, get furthest() { return furthest; } };
}

class BlockedAnalysis extends NativeAnalysisService {
    readonly started = deferred<void>();
    readonly release = deferred<void>();
    analyses = 0;

    override async analyze(request: AnalysisRequest) {
        this.analyses += 1;
        this.started.resolve();
        await this.release.promise;
        return super.analyze(request);
    }
}

test('first preview reads a bounded sample before blocked full analysis, then refines exact types', { timeout: 30_000 }, async (t) => {
    const row = `1,9007199254740993,1,"${'\u00e9\u{1f600}'.repeat(12)}, ""q""\n${'x'.repeat(60)}"\n`;
    const count = 85_000;
    const file = fixture(t, 'large.csv',
        'id,exact,amount,note\n' + row.repeat(count)
        + '2,9007199254740993,0.00000000000000000001,late\n');
    const bytes = fs.statSync(file).size;
    assert.ok(bytes >= 10 * 1024 * 1024);
    const reads = observeReads(t, file);
    const service = new BlockedAnalysis();
    const seen = deferred<AnalysisPreview>();
    const published = deferred<void>();
    let settled = false;
    const started = performance.now();
    const pending = service.analyzeProgressively({
        filePath: file,
        maxRows: 25,
        onPreview: async (sample) => {
            seen.resolve(sample);
            await published.promise;
        },
    }).then((value) => { settled = true; return value; });
    t.after(() => { published.resolve(); service.release.resolve(); });
    const sample = await seen.promise;
    const firstMs = performance.now() - started;
    assert.equal(service.analyses, 0, 'complete work starts only after sample publication');
    assert.equal(settled, false);
    assert.equal(sample.preview.rows.length, 25);
    assert.equal(sample.metadata.analysis_stage, 'provisional');
    assert.equal(sample.metadata.schema_inference, 'sampled');
    assert.equal(sample.metadata.row_count, null);
    assert.equal(sample.preview.total_rows, null);
    assert.equal(sample.preview.rows[0][1], '9007199254740993');
    assert.match(String(sample.preview.rows[0][3]), /\u00e9\u{1f600}/u);
    assert.equal(sample.metadata.preview_sample?.bytes_read, reads.bytes);
    assert.ok(reads.bytes <= FAST_PREVIEW_MAX_BYTES);
    assert.ok(reads.furthest < bytes);
    assert.equal(sample.metadata.preview_sample?.logical_rows, 26);
    assert.match(service.generateStatements({ metadata: sample.metadata }).create_table, /^-- SAMPLE ONLY:/);
    assert.match(service.generateStatements({ metadata: sample.metadata }).create_table, /\[amount\]\s+NVARCHAR\(MAX\)/);

    published.resolve();
    await service.started.promise;
    assert.equal(settled, false, 'the preview remains available while refinement is blocked');
    service.release.resolve();
    const final = await pending;
    const finalMs = performance.now() - started;
    assert.equal(service.analyses, 1);
    assert.equal(final.metadata.analysis_stage, undefined);
    assert.equal(final.metadata.schema_inference, 'full');
    assert.equal(final.metadata.row_count, count + 1);
    assert.equal(final.preview.total_rows, count + 1);
    assert.equal(final.preview.rows.length, 25);
    assert.equal(final.preview.rows[0][1], '9007199254740993');
    assert.equal(new Map(final.metadata.schema ?? []).get('amount'), 'decimal(21,20)');
    assert.doesNotMatch(service.generateStatements({ metadata: final.metadata }).create_table, /SAMPLE ONLY/);
    const complete = await new NativeAnalysisService().analyze({ filePath: file });
    assert.equal(complete.schema_inference, 'full', 'a sample must never poison the complete cache');
    assert.equal(complete.source_revision, undefined, 'the complete API shape is unchanged');
    t.diagnostic(`${(bytes / 1024 / 1024).toFixed(2)} MiB CSV: first preview ${firstMs.toFixed(1)} ms; full refinement ${finalMs.toFixed(1)} ms; first read ${sample.metadata.preview_sample?.bytes_read} bytes / 25 rows`);
});

test('byte and logical-row ceilings are enforced without emitting a partial CSV record', async (t) => {
    const row = `9007199254740993,"${'x'.repeat(4000)}"\n`;
    const file = fixture(t, 'bounded.dat', 'id,note\n' + row.repeat(150));
    const reads = observeReads(t, file);
    const sample = await new NativeAnalysisService().samplePreview({ filePath: file, maxRows: 10_000 });
    assert.equal(reads.bytes, FAST_PREVIEW_MAX_BYTES);
    assert.equal(sample.metadata.preview_sample?.bytes_read, reads.bytes);
    assert.equal(sample.metadata.preview_sample?.stopped_by, 'bytes');
    assert.ok(sample.preview.rows.length > 0 && sample.preview.rows.length < FAST_PREVIEW_MAX_ROWS);
    assert.ok((sample.metadata.preview_sample?.logical_rows ?? Infinity) <= FAST_PREVIEW_MAX_ROWS + 1);
    for (const row of sample.preview.rows) {
        assert.equal(row[0], '9007199254740993');
        assert.equal(String(row[1]).length, 4000);
    }
    assert.equal(sample.metadata.row_count_lower_bound, sample.preview.rows.length);
});

for (const encoding of ['utf8', 'utf16le'] as const) {
    test(`multiline quotes and Unicode survive a ${encoding} read boundary`, async (t) => {
        const prefix = (encoding === 'utf16le' ? '\ufeff' : '') + 'id,note\r\n1,"';
        let note: string;
        if (encoding === 'utf8') {
            const japanese = '\u3042'.repeat(21_000);
            const pad = ENCODING_DETECTION_BYTES - Buffer.byteLength(prefix + japanese, encoding) - 1;
            note = japanese + 'x'.repeat(pad) + '"end\n\u6771\u4eac\u{1f600}';
        } else {
            const pad = (ENCODING_DETECTION_BYTES - Buffer.byteLength(prefix, encoding)) / 2 - 1;
            note = 'x'.repeat(pad) + '\u{1f600}"end\n\u6771\u4eac';
        }
        const file = fixture(t, 'unicode.csv', Buffer.from(prefix + note.replace(/"/g, '""') + '"\r\n', encoding));
        const sample = await new NativeAnalysisService().samplePreview({ filePath: file, maxRows: 1 });
        assert.equal(sample.preview.error, undefined);
        assert.deepEqual(sample.preview.rows, [[1, note]]);
    });
}

for (const [name, content] of [
    ['rows.tsv', 'id\tamount\n9007199254740993\t123.12345678901234567890\n'],
    ['rows.ndjson', '{"id":9007199254740993,"amount":123.12345678901234567890}\n'],
    ['rows.json', '[{"id":9007199254740993,"amount":123.12345678901234567890}]'],
] as const) {
    test(`${name} samples retain exact numerics with conservative provenance`, async (t) => {
        const file = fixture(t, name, content);
        const service = new NativeAnalysisService();
        const sample = await service.samplePreview({ filePath: file });
        assert.deepEqual(sample.preview.rows, [['9007199254740993', '123.12345678901234567890']]);
        assert.equal(sample.metadata.schema_inference, 'sampled');
        assert.equal(sample.metadata.row_count, null);
        assert.equal(sample.preview.total_rows, null);
        assert.match(service.generateCompleteDocument({ metadata: sample.metadata }), /^-- SAMPLE ONLY:/);
        if (name.endsWith('json')) {
            assert.equal(sample.metadata.json_typed_projection_safe, false);
        }
    });
}

test('a giant JSON document is not read in full for its first row', async (t) => {
    const file = fixture(t, 'giant.json',
        '[{"id":9007199254740993,"text":"\u6771\u4eac"},'
        + '{"huge":"' + 'x'.repeat(34 * 1024 * 1024) + '"}]');
    const reads = observeReads(t, file);
    const token = new SimpleCancellationTokenSource();
    let sample: AnalysisPreview | undefined;
    await assert.rejects(new NativeAnalysisService().analyzeProgressively({
        filePath: file,
        maxRows: 1,
        token: token.token,
        onPreview: (value) => { sample = value; token.cancel(); },
    }), CancellationError);
    assert.ok(sample);
    assert.equal(sample.preview.error, undefined);
    assert.deepEqual(sample.preview.rows, [['9007199254740993', '\u6771\u4eac']]);
    assert.equal(sample.metadata.preview_sample?.bytes_read, reads.bytes);
    assert.ok(reads.bytes <= FAST_PREVIEW_MAX_BYTES);
    assert.ok(reads.furthest < fs.statSync(file).size);
});

test('plain text uses complete universal-newline records and unknown totals', async (t) => {
    const file = fixture(t, 'lines.txt', '\u6771\u4eac\r\nsecond\rthird\n' + 'later\n'.repeat(20_000));
    const reads = observeReads(t, file);
    const sample = await new NativeAnalysisService().samplePreview({ filePath: file, maxRows: 3 });
    assert.deepEqual(sample.preview.rows, [['\u6771\u4eac'], ['second'], ['third']]);
    assert.equal(sample.preview.total_rows, null);
    assert.equal(sample.metadata.preview_sample?.logical_rows, 3);
    assert.equal(reads.bytes, sample.metadata.preview_sample?.bytes_read);
});

test('JSON refinement discovers keys beyond the provisional rows without narrowing their samples', async (t) => {
    const file = fixture(t, 'late-keys.json',
        '[' + '{"id":9007199254740993},'.repeat(150)
        + '{"id":9007199254740993,"later":123.12345678901234567890}]');
    let sample: AnalysisPreview | undefined;
    const final = await new NativeAnalysisService().analyzeProgressively({
        filePath: file,
        maxRows: 25,
        onPreview: (value) => { sample = value; },
    });
    assert.ok(sample);
    assert.deepEqual(sample.preview.columns.map((column) => column.name), ['id']);
    assert.equal(sample.metadata.json_typed_projection_safe, false);
    assert.equal(final.metadata.schema_inference, 'full');
    assert.equal(final.metadata.row_count, 151);
    assert.equal(final.metadata.json_typed_projection_safe, true);
    assert.equal(new Map(final.metadata.schema ?? []).get('later'), 'decimal(23,20)');
    assert.equal(final.preview.rows[0][0], '9007199254740993');
});

for (const kind of ['csv-columns', 'json-columns', 'csv-record', 'json-record', 'text-record']) {
    test(`an oversized ${kind} is explicit in the sample but retains final preview capability`, async (t) => {
        const width = FAST_PREVIEW_MAX_COLUMNS + 1;
        const text = 'x'.repeat(FAST_PREVIEW_MAX_RECORD_CHARS + 100);
        const content = kind === 'csv-columns'
            ? Array.from({ length: width }, (_, i) => `col${i}`).join(',') + '\n' + Array(width).fill('1').join(',') + '\n'
            : kind === 'json-columns'
                ? JSON.stringify(Object.fromEntries(Array.from({ length: width }, (_, i) => [`col${i}`, i])))
                : kind === 'csv-record'
                    ? `id,note\n1,"${text}"\n`
                    : kind === 'json-record'
                        ? JSON.stringify({ note: text })
                        : text;
        const extension = kind.startsWith('json') ? 'json' : kind.startsWith('csv') ? 'csv' : 'txt';
        const file = fixture(t, `wide.${extension}`, content);
        let sampled: AnalysisPreview | undefined;
        const service = new NativeAnalysisService();
        const final = await service.analyzeProgressively({
            filePath: file,
            onPreview: (sample) => { sampled = sample; },
        });
        assert.ok(sampled?.preview.error);
        assert.equal(sampled.metadata.preview_sample?.stopped_by, 'record_limit');
        assert.equal(sampled.metadata.schema_inference, 'sampled');
        assert.equal(final.preview.error, undefined);
        assert.equal(final.preview.rows.length, 1);
        if (kind.endsWith('columns')) {
            assert.equal(final.preview.columns.length, width);
        } else {
            assert.ok(final.preview.rows[0].some((value) => value === text));
        }
    });
}

test('malformed and incomplete sample JSON errors are not silently suppressed', async (t) => {
    const file = fixture(t, 'invalid.json', '[{"id":1},{"id": }');
    const service = new NativeAnalysisService();
    const samples: AnalysisPreview[] = [];
    await assert.rejects(service.analyzeProgressively({
        filePath: file,
        onPreview: (sample) => { samples.push(sample); },
    }));
    assert.equal(samples.length, 1);
    assert.ok(samples[0].metadata.error);
    assert.ok(samples[0].preview.error);
    assert.equal(samples[0].metadata.analysis_stage, 'provisional');
});

test('canceling after sample publication prevents complete work and allows an unpoisoned retry', async (t) => {
    const file = fixture(t, 'cancel.csv', 'id,amount\n1,2\n3,4.5\n');
    const token = new SimpleCancellationTokenSource();
    const service = new NativeAnalysisService();
    const analyze = t.mock.method(service, 'analyze');
    await assert.rejects(service.analyzeProgressively({
        filePath: file,
        token: token.token,
        onPreview: () => token.cancel(),
    }), CancellationError);
    assert.equal(analyze.mock.callCount(), 0);
    const final = await service.analyzeProgressively({ filePath: file, onPreview: () => undefined });
    assert.equal(final.metadata.schema_inference, 'full');
    assert.equal(final.metadata.row_count, 2);
    await assert.rejects(service.analyze({ filePath: file, token: token.token }), CancellationError);
});

test('editing a file during refinement rejects mixed revisions, and retry reads the edit', async (t) => {
    const file = fixture(t, 'edited.csv', 'id,amount\n1,2\n');
    const service = new BlockedAnalysis();
    const pending = service.analyzeProgressively({ filePath: file, onPreview: () => undefined });
    await service.started.promise;
    fs.appendFileSync(file, '2,4.5\n');
    service.release.resolve();
    await assert.rejects(pending, FileChangedError);
    const final = await service.analyzeProgressively({ filePath: file, onPreview: () => undefined });
    assert.equal(final.metadata.row_count, 2);
    fs.appendFileSync(file, '3,5\n');
    await assert.rejects(service.previewAnalyzed({ filePath: file, metadata: final.metadata }), FileChangedError);
});

test('final preview retains the original requested row limit instead of the provisional cap', async (t) => {
    const file = fixture(t, 'rows.csv', 'id\n' + '1\n'.repeat(11_000));
    let sampledRows = 0;
    const result = await new NativeAnalysisService().analyzeProgressively({
        filePath: file,
        maxRows: 10_000,
        onPreview: (sample) => { sampledRows = sample.preview.rows.length; },
    });
    assert.equal(sampledRows, FAST_PREVIEW_MAX_ROWS);
    assert.equal(result.preview.rows.length, 10_000);
    assert.equal(result.metadata.row_count, 11_000);
});

test('normal large-file sampling remains explicitly sampled and estimated after refinement', async (t) => {
    const file = fixture(t, 'very-large.csv', 'id\n' + '1\n'.repeat(2000));
    fs.truncateSync(file, 101 * 1024 * 1024);
    const result = await new NativeAnalysisService().analyzeProgressively({
        filePath: file,
        maxRows: 25,
        onPreview: () => undefined,
    });
    assert.equal(result.metadata.analysis_stage, undefined);
    assert.equal(result.metadata.schema_inference, 'sampled');
    assert.equal(result.metadata.row_count_estimated, true);
    assert.equal(result.preview.total_rows_estimated, true);
    assert.match(new NativeAnalysisService().generateStatements({ metadata: result.metadata }).create_table, /NVARCHAR\(MAX\)/);
});

test('cooperative JSON decoding preserves exact semantics and admits cancellation during CPU work', async () => {
    const document = '[{"int":9007199254740993,"float":123.12345678901234567890,"nested":[true,null,"\\u6771\\u4eac"]}]';
    assert.deepEqual(await parseJsonCooperatively(document), parseJson(document));
    for (const large of [
        '[' + '{"n":9007199254740993},'.repeat(20_000) + '{"n":1}]',
        '{"text":"' + 'x'.repeat(256 * 1024) + '"}',
    ]) {
        const token = new SimpleCancellationTokenSource();
        const pending = parseJsonCooperatively(large, token.token);
        setImmediate(() => token.cancel());
        await assert.rejects(pending, CancellationError);
    }
});
