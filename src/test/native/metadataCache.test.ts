import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { MetadataCache } from '../../native/metadataCache';
import { baseMetadata, analyzeFileMetadata, clearMetadataCache } from '../../native/detector';
import { NativeAnalysisService, SimpleCancellationTokenSource, CancellationError } from '../../native';
import { resolveWithinRoot } from '../../native/paths';
import type { FileMetadata } from '../../native/types';
import { fixturePath } from './parityInvariants';

function metadata(): FileMetadata {
    return {
        ...baseMetadata({
            realPath: '/data/input.csv', requestedPath: '/data/input.csv',
            allowedRoot: '/data', isDirectory: false, sizeBytes: 10,
        }, 'csv', 'utf-8', 1),
        schema: [['id', 'int64']],
        sample_rows: [[1]],
        row_count: 1,
        schema_inference: 'full',
    };
}

test('metadata LRU enforces both byte and entry ceilings, including access recency', () => {
    const probe = new MetadataCache(10, 1_000_000, 1_000_000);
    probe.set('one', 'sig', metadata());
    const bytes = probe.retainedBytes;
    const cache = new MetadataCache(10, bytes * 2, bytes);
    cache.set('one', 'sig', metadata());
    cache.set('two', 'sig', metadata());
    assert.equal(cache.size, 2);
    assert.ok(cache.get('one', 'sig'));
    cache.set('tri', 'sig', metadata());
    assert.equal(cache.size, 2);
    assert.equal(cache.get('two', 'sig'), null);
    assert.ok(cache.get('one', 'sig'));
    assert.ok(cache.retainedBytes <= bytes * 2);

    const entries = new MetadataCache(1, bytes * 10, bytes);
    entries.set('one', 'sig', metadata());
    entries.set('two', 'sig', metadata());
    assert.equal(entries.size, 1);
    assert.equal(entries.get('one', 'sig'), null);
});

test('overweight metadata is refused before cloning; stale signatures release retained bytes', (t) => {
    const cache = new MetadataCache(4, 10_000, 5000);
    const clone = t.mock.method(globalThis, 'structuredClone');
    cache.set('huge', 'sig', { ...metadata(), sample_rows: [['x'.repeat(10_000)]] });
    assert.equal(clone.mock.callCount(), 0);
    assert.equal(cache.size, 0);
    cache.set('small', 'old', metadata());
    assert.ok(cache.retainedBytes > 0);
    assert.equal(cache.get('small', 'new'), null);
    assert.equal(cache.retainedBytes, 0);
});

test('cache clones isolate both insertion and retrieval and never retain samples or errors', () => {
    const cache = new MetadataCache();
    const value = metadata();
    cache.set('key', 'sig', value);
    value.schema![0][0] = 'changed';
    const first = cache.get('key', 'sig')!;
    assert.equal(first.schema![0][0], 'id');
    first.sample_rows![0][0] = 999;
    assert.equal(cache.get('key', 'sig')!.sample_rows![0][0], 1);
    cache.set('sample', 'sig', { ...metadata(), analysis_stage: 'provisional', schema_inference: 'sampled' });
    cache.set('error', 'sig', { ...metadata(), error: 'Retry required' });
    assert.equal(cache.size, 1);
    cache.clear();
    assert.equal(cache.retainedBytes, 0);
});

test('deep Delta commits, Iceberg metadata and part-file changes cannot hit a stale directory cache', async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-cache-')));
    t.after(() => { clearMetadataCache(); fs.rmSync(root, { recursive: true, force: true }); });
    const delta = path.join(root, 'delta');
    const log = path.join(delta, '_delta_log');
    const nested = path.join(delta, 'year=2026', 'month=09');
    fs.mkdirSync(log, { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    const commit = (name: string, records: number) => JSON.stringify({
        metaData: { name, schemaString: JSON.stringify({ type: 'struct', fields: [{ name, type: 'long', nullable: true }] }) },
    }) + '\n' + JSON.stringify({ add: { path: 'part.parquet', stats: JSON.stringify({ numRecords: records }) } }) + '\n';
    fs.writeFileSync(path.join(log, '00000000000000000000.json'), commit('before', 1));
    const reference = await resolveWithinRoot(delta, root);
    const original = await analyzeFileMetadata(reference);
    const rootMtime = fs.statSync(delta).mtimeMs;
    fs.writeFileSync(path.join(log, '00000000000000000001.json'), commit('after', 7));
    fs.writeFileSync(path.join(nested, 'part.bin'), Buffer.alloc(4096));
    assert.equal(fs.statSync(delta).mtimeMs, rootMtime, 'only nested contents changed');
    const fresh = await analyzeFileMetadata(reference);
    assert.equal(original.delta_metadata?.version, 0);
    assert.equal(fresh.delta_metadata?.version, 1);
    assert.equal(fresh.schema?.[0][0], 'after');
    assert.equal(fresh.row_count, 7);
    assert.ok(fresh.file_size > original.file_size);

    const iceberg = path.join(root, 'iceberg');
    const metadataDir = path.join(iceberg, 'metadata');
    fs.mkdirSync(metadataDir, { recursive: true });
    const version = (name: string, count: number) => JSON.stringify({
        'format-version': 2,
        schema: { fields: [{ id: 1, name, type: 'long', required: false }] },
        'current-snapshot-id': 1,
        snapshots: [{ 'snapshot-id': 1, summary: { 'total-records': String(count) } }],
    });
    fs.writeFileSync(path.join(metadataDir, 'v1.metadata.json'), version('old', 1));
    const iceRef = await resolveWithinRoot(iceberg, root);
    assert.equal((await analyzeFileMetadata(iceRef)).row_count, 1);
    const iceMtime = fs.statSync(iceberg).mtimeMs;
    fs.writeFileSync(path.join(metadataDir, 'v2.metadata.json'), version('new', 8));
    assert.equal(fs.statSync(iceberg).mtimeMs, iceMtime);
    const iceFresh = await analyzeFileMetadata(iceRef);
    assert.equal(iceFresh.row_count, 8);
    assert.equal(iceFresh.schema?.[0][0], 'new');
});

test('cancellation after a cache-signature operation wins over a cache hit', async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-cache-cancel-')));
    t.after(() => { clearMetadataCache(); fs.rmSync(root, { recursive: true, force: true }); });
    const file = path.join(root, 'rows.csv');
    fs.writeFileSync(file, 'id\n1\n2\n');
    const reference = await resolveWithinRoot(file, root);
    await analyzeFileMetadata(reference);
    let polls = 0;
    await assert.rejects(analyzeFileMetadata(reference, {
        get isCancellationRequested() { polls += 1; return polls >= 2; },
    }), CancellationError);
    const source = new SimpleCancellationTokenSource();
    source.cancel();
    await assert.rejects(new NativeAnalysisService().preview({
        filePath: file, token: source.token,
    }), CancellationError);
    assert.equal((await analyzeFileMetadata(reference)).row_count, 2);
});

test('final table preview reuses returned metadata even though directories are never cached', async (t) => {
    const directory = fixturePath('data sample/tables/events_delta');
    const open = fs.promises.open.bind(fs.promises);
    let logReads = 0;
    t.mock.method(fs.promises, 'open', async (file: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
        if (String(file).includes('_delta_log') && String(file).endsWith('.json')) {
            logReads += 1;
        }
        return open(file, flags, mode);
    });
    const expected = fs.readdirSync(path.join(directory, '_delta_log')).filter((name) => /^\d{20}\.json$/.test(name)).length;
    const result = await new NativeAnalysisService().analyzeProgressively({
        filePath: directory,
        onPreview: () => assert.fail('table footer path must not start a text sample'),
    });
    assert.equal(logReads, expected, 'transaction logs must not be replayed again just to preview rows');
    assert.ok(result.preview.rows.length > 0);
});
