/**
 * Tests for the public dataset / direct HTTPS workflow.
 *
 * These cover the two rules that decide whether the feature is safe and honest:
 * a download can only ever land inside the caller's directory under a flattened
 * name, and the generated SQL only claims a URL is directly queryable when the
 * target engine could actually read it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { SafeHttpError, type RawResponse, type SafeHttpDeps } from '../../net/safeHttp';
import {
    azureBlobParts,
    dataExtension,
    downloadDataFile,
    firstSupportedBlob,
    isAzureStorageUrl,
    isLearnOpenDatasetsUrl,
    listPublicBlobs,
    listablePrefix,
    nameFromContentDisposition,
    safeFileName,
    storageUrlFor,
} from '../../net/publicData';

const PUBLIC = ['93.184.216.34'];
const anyHost: SafeHttpDeps['resolve'] = async () => PUBLIC;

function respond(
    status: number,
    headers: Record<string, string>,
    body: string | Buffer,
): SafeHttpDeps {
    return {
        resolve: anyHost,
        request: async () => {
            const response: RawResponse = {
                statusCode: status,
                headers,
                body: Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]),
                destroy: () => undefined,
            };
            return response;
        },
    };
}

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sqlfd-public-'));
}

test('safeFileName flattens every separator and traversal form', () => {
    assert.equal(safeFileName('data.csv'), 'data.csv');
    assert.equal(safeFileName('/a/b/c/data.csv'), 'data.csv');
    assert.equal(safeFileName('..\\..\\windows\\system32\\evil.csv'), 'evil.csv');
    assert.equal(safeFileName('../../../etc/passwd'), 'passwd');
    assert.equal(safeFileName('%2e%2e%2f%2e%2e%2fetc%2fpasswd'), 'passwd');
    assert.equal(safeFileName('..%5c..%5cevil.csv'), 'evil.csv');
    assert.equal(safeFileName('.bashrc'), 'bashrc');
    assert.equal(safeFileName('..'), 'dataset');
    assert.equal(safeFileName(''), 'dataset');
    assert.equal(safeFileName('   '), 'dataset');
    assert.equal(safeFileName('C:\\Users\\me\\secret.csv'), 'secret.csv');
    assert.equal(safeFileName('a b;c|d.csv'), 'a_b_c_d.csv');
    assert.equal(safeFileName('naïve données.csv'), 'na_ve_donn_es.csv');
    assert.equal(safeFileName('%ZZ-bad-escape.csv'), 'ZZ-bad-escape.csv');
    assert.ok(safeFileName('x'.repeat(500)).length <= 120);
    for (const name of [
        '/a/b/c/data.csv',
        '..\\..\\evil.csv',
        '%2e%2e%2fpasswd',
        'con:aux.csv',
    ]) {
        const result = safeFileName(name);
        assert.ok(!result.includes('/') && !result.includes('\\'), result);
        assert.ok(!result.startsWith('.'), result);
    }
});

test('a Content-Disposition name cannot escape the download directory', () => {
    assert.equal(nameFromContentDisposition('attachment; filename="report.csv"'), 'report.csv');
    assert.equal(
        nameFromContentDisposition('attachment; filename="../../../etc/passwd"'),
        'passwd',
    );
    assert.equal(
        nameFromContentDisposition("attachment; filename*=UTF-8''%2e%2e%2fevil.csv"),
        'evil.csv',
    );
    assert.equal(nameFromContentDisposition('attachment; filename=".."'), null);
    assert.equal(nameFromContentDisposition('attachment'), null);
    assert.equal(nameFromContentDisposition(undefined), null);
});

test('only Learn Open Datasets pages are treated as catalog pages', () => {
    assert.ok(
        isLearnOpenDatasetsUrl(
            'https://learn.microsoft.com/en-us/azure/open-datasets/dataset-taxi-yellow',
        ),
    );
    assert.ok(isLearnOpenDatasetsUrl('https://LEARN.microsoft.com/AZURE/OPEN-DATASETS/x'));
    for (const url of [
        'http://learn.microsoft.com/azure/open-datasets/x',
        'https://learn.microsoft.com.evil.example/azure/open-datasets/x',
        'https://evil.example/azure/open-datasets/x',
        'https://learn.microsoft.com/azure/storage/blobs/overview',
        'not a url',
    ]) {
        assert.equal(isLearnOpenDatasetsUrl(url), false, url);
    }
});

test('only storage URLs are advertised as directly queryable', () => {
    assert.equal(
        storageUrlFor('https://azureopendatastorage.blob.core.windows.net/c/f.parquet'),
        'https://azureopendatastorage.blob.core.windows.net/c/f.parquet',
    );
    assert.equal(
        storageUrlFor('https://acct.dfs.core.windows.net/c/f.parquet'),
        'https://acct.dfs.core.windows.net/c/f.parquet',
    );
    assert.equal(storageUrlFor('abfss://c@acct.dfs.core.windows.net/f.parquet'), 'abfss://c@acct.dfs.core.windows.net/f.parquet');
    assert.equal(storageUrlFor('s3://bucket/key.parquet'), 's3://bucket/key.parquet');
    // A generic web server cannot be virtualised, so the honest answer is null.
    assert.equal(storageUrlFor('https://example.com/data.csv'), null);
    assert.equal(storageUrlFor('https://raw.githubusercontent.com/o/r/main/a.csv'), null);
    assert.equal(
        storageUrlFor('https://evil.example/x?u=acct.blob.core.windows.net'),
        null,
    );
    assert.equal(storageUrlFor('http://acct.blob.core.windows.net/c/f.csv'), null);
    assert.equal(storageUrlFor('nonsense'), null);
});

test('a pasted SAS signature never survives into the storage URL', () => {
    // This value reaches the state envelope and the generated T-SQL, so the
    // signature has to be stripped rather than echoed back.
    const signed =
        'https://acct.blob.core.windows.net/c/f.parquet' +
        '?sv=2022-11-02&ss=b&sig=aBcDeF%2Bsecret%3D&se=2030-01-01T00%3A00%3A00Z';
    const result = storageUrlFor(signed);
    assert.equal(result, 'https://acct.blob.core.windows.net/c/f.parquet');
    assert.equal(result?.includes('sig='), false);
    assert.equal(result?.includes('?'), false);

    // Fragments go too, and user-info on an https URL is never carried over.
    assert.equal(
        storageUrlFor('https://acct.dfs.core.windows.net/c/f.parquet#frag'),
        'https://acct.dfs.core.windows.net/c/f.parquet',
    );
    assert.equal(
        storageUrlFor('https://user:pw@acct.blob.core.windows.net/c/f.parquet'),
        'https://acct.blob.core.windows.net/c/f.parquet',
    );

    // On abfss the user-info is the container name, so it must be preserved.
    assert.equal(
        storageUrlFor('abfss://c@acct.dfs.core.windows.net/f.parquet?sig=nope'),
        'abfss://c@acct.dfs.core.windows.net/f.parquet',
    );
});

test('Azure URLs are split into account, container and prefix', () => {
    assert.deepEqual(
        azureBlobParts('https://azureopendatastorage.blob.core.windows.net/nyctlc/yellow/x.parquet'),
        {
            serviceUrl: 'https://azureopendatastorage.blob.core.windows.net',
            account: 'azureopendatastorage',
            container: 'nyctlc',
            prefix: 'yellow/x.parquet',
        },
    );
    assert.deepEqual(azureBlobParts('abfss://nyctlc@acct.dfs.core.windows.net/yellow/'), {
        serviceUrl: 'https://acct.blob.core.windows.net',
        account: 'acct',
        container: 'nyctlc',
        prefix: 'yellow/',
    });
    assert.equal(azureBlobParts('https://acct.blob.core.windows.net/'), null);
    assert.equal(azureBlobParts('https://example.com/c/f.csv'), null);
    assert.ok(isAzureStorageUrl('https://acct.blob.core.windows.net/c/f.csv'));
    assert.ok(!isAzureStorageUrl('https://example.com/c/f.csv'));
});

test('a wildcard prefix collapses to the literal directory above it', () => {
    assert.equal(listablePrefix('yellow/puYear=2018/*.parquet'), 'yellow/puYear=2018/');
    assert.equal(listablePrefix('yellow/*/x.parquet'), 'yellow/');
    assert.equal(listablePrefix('*.parquet'), '');
    assert.equal(listablePrefix('yellow/x.parquet'), 'yellow/x.parquet');
});

test('supported data extensions are recognised from URLs and names', () => {
    assert.equal(dataExtension('https://a.example/x/data.CSV?sv=2020'), '.csv');
    assert.equal(dataExtension('part-0000.snappy.parquet'), '.parquet');
    assert.equal(dataExtension('raw/events.dat'), '.dat');
    assert.equal(dataExtension('table.delta'), null);
    assert.equal(dataExtension('workbook.xlsx'), null);
    assert.equal(dataExtension('notes.md'), null);
    assert.equal(dataExtension('https://a.example/x/'), null);
});

const LISTING = `<?xml version="1.0" encoding="utf-8"?>
<EnumerationResults>
  <Blobs>
    <Blob><Name>yellow/_SUCCESS</Name><Properties><Content-Length>0</Content-Length></Properties></Blob>
    <Blob><Name>yellow/notes.md</Name><Properties><Content-Length>10</Content-Length></Properties></Blob>
    <Blob><Name>yellow/huge.parquet</Name><Properties><Content-Length>999999999</Content-Length></Properties></Blob>
    <Blob><Name>yellow/a &amp; b.parquet</Name><Properties><Content-Length>2048</Content-Length></Properties></Blob>
  </Blobs>
</EnumerationResults>`;

test('a container listing is parsed, entity-decoded and bounded', async () => {
    const blobs = await listPublicBlobs(
        'https://azureopendatastorage.blob.core.windows.net/nyctlc/yellow/',
        respond(200, { 'content-type': 'application/xml' }, LISTING),
    );
    assert.equal(blobs.length, 4);
    assert.equal(blobs[3].name, 'yellow/a & b.parquet');
    assert.equal(blobs[3].sizeBytes, 2048);
    assert.equal(blobs[3].extension, '.parquet');
    assert.equal(
        blobs[3].url,
        'https://azureopendatastorage.blob.core.windows.net/nyctlc/yellow/a%20%26%20b.parquet',
    );

    const capped = await listPublicBlobs(
        'https://azureopendatastorage.blob.core.windows.net/nyctlc/yellow/',
        { ...respond(200, {}, LISTING), maxResults: 2 },
    );
    assert.equal(capped.length, 2);
});

test('the first usable blob skips empty, oversized and unsupported entries', async () => {
    const blob = await firstSupportedBlob(
        'https://azureopendatastorage.blob.core.windows.net/nyctlc/yellow/',
        respond(200, {}, LISTING),
    );
    assert.equal(blob?.name, 'yellow/a & b.parquet');

    const none = await firstSupportedBlob(
        'https://azureopendatastorage.blob.core.windows.net/nyctlc/yellow/',
        { ...respond(200, {}, LISTING), maxBytes: 100 },
    );
    assert.equal(none, null);
});

test('listing refuses a non-Azure URL', async () => {
    await assert.rejects(
        listPublicBlobs('https://example.com/data/', respond(200, {}, LISTING)),
        (error: unknown) => error instanceof SafeHttpError && error.code === 'invalid_request',
    );
});

test('a download lands inside the destination directory under a safe name', async () => {
    const dir = tempDir();
    try {
        const result = await downloadDataFile(
            'https://example.com/downloads/city%20data.csv',
            dir,
            respond(200, {}, 'id,name\n1,a\n'),
        );
        assert.equal(result.fileName, 'city_data.csv');
        assert.equal(path.dirname(result.path), fs.realpathSync(dir));
        assert.equal(result.bytes, 12);
        assert.equal(fs.readFileSync(result.path, 'utf8'), 'id,name\n1,a\n');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a hostile Content-Disposition cannot write outside the directory', async () => {
    const dir = tempDir();
    const outside = path.join(path.dirname(dir), 'escaped.csv');
    try {
        const result = await downloadDataFile(
            'https://example.com/data.csv',
            dir,
            respond(
                200,
                { 'content-disposition': 'attachment; filename="../escaped.csv"' },
                'a,b\n',
            ),
        );
        assert.equal(result.fileName, 'escaped.csv');
        assert.equal(path.dirname(result.path), fs.realpathSync(dir));
        assert.ok(!fs.existsSync(outside), 'nothing may be written next to the directory');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(outside, { force: true });
    }
});

test('an unsupported extension is refused before any request is made', async () => {
    const dir = tempDir();
    try {
        await assert.rejects(
            downloadDataFile('https://example.com/setup.exe', dir, {
                resolve: anyHost,
                request: async () => assert.fail('no request should be made'),
            }),
            (error: unknown) => error instanceof SafeHttpError && error.code === 'unsupported_type',
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('an oversized or empty download leaves no partial file behind', async () => {
    const dir = tempDir();
    try {
        await assert.rejects(
            downloadDataFile('https://example.com/big.csv', dir, {
                ...respond(200, {}, 'x'.repeat(5000)),
                maxBytes: 100,
            }),
            (error: unknown) => error instanceof SafeHttpError && error.code === 'too_large',
        );
        assert.deepEqual(fs.readdirSync(dir), [], 'the partial file must be removed');

        await assert.rejects(
            downloadDataFile('https://example.com/declared.csv', dir, {
                ...respond(200, { 'content-length': '999999999' }, 'x'),
                maxBytes: 100,
            }),
            (error: unknown) => error instanceof SafeHttpError && error.code === 'too_large',
        );

        await assert.rejects(
            downloadDataFile('https://example.com/empty.csv', dir, respond(200, {}, '')),
            (error: unknown) => error instanceof SafeHttpError && error.code === 'empty_response',
        );
        assert.deepEqual(fs.readdirSync(dir), [], 'an empty download must be removed');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a download URL is still subject to the full SSRF policy', async () => {
    const dir = tempDir();
    try {
        await assert.rejects(
            downloadDataFile('http://169.254.169.254/latest.csv', dir, {
                resolve: anyHost,
                request: async () => assert.fail('no request should be made'),
            }),
            (error: unknown) => error instanceof SafeHttpError && error.code === 'scheme_not_allowed',
        );
        await assert.rejects(
            downloadDataFile('https://127.0.0.1/data.csv', dir, {
                resolve: anyHost,
                request: async () => assert.fail('no request should be made'),
            }),
            (error: unknown) => error instanceof SafeHttpError && error.code === 'host_not_allowed',
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
