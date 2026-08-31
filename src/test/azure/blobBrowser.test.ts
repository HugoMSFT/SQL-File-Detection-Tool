/**
 * Tests for the blob browser's input validation and URL construction.
 *
 * The `@azure/storage-blob` client is real here but never used to reach the
 * network: every test either exercises validation, which happens before any
 * request, or `blobUrl`, which is pure. What matters is that a name the
 * extension would refuse to write to disk is also a name it refuses to address,
 * and that a URL destined for generated SQL never carries a signature.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AzureBlobBrowser } from '../../azure/blobBrowser';
import { AzureInputError } from '../../azure/storageUrl';

const SERVICE = 'https://myaccount.blob.core.windows.net';

function anonymous(): AzureBlobBrowser {
    return new AzureBlobBrowser('myaccount', SERVICE, { kind: 'anonymous' });
}

test('a blob URL is built by encoding each segment and is never signed', () => {
    const browser = anonymous();
    assert.equal(browser.blobUrl('data', 'a.csv'), `${SERVICE}/data/a.csv`);
    assert.equal(
        browser.blobUrl('data', 'year=2020/part 1.parquet'),
        `${SERVICE}/data/year%3D2020/part%201.parquet`,
    );
    assert.equal(browser.blobUrl('data', 'a&b.csv'), `${SERVICE}/data/a%26b.csv`);
    assert.ok(!browser.blobUrl('data', 'a.csv').includes('sig='));
});

test('a SAS credential does not leak into the URLs used in generated SQL', () => {
    const browser = new AzureBlobBrowser('myaccount', SERVICE, {
        kind: 'sas',
        sasToken: 'sv=2021-08-06&sig=SIGNATURE-VALUE',
    });
    const url = browser.blobUrl('data', 'a.csv');
    assert.equal(url, `${SERVICE}/data/a.csv`);
    assert.ok(!url.includes('SIGNATURE-VALUE'));
    assert.ok(!url.includes('?'));
});

test('a trailing slash on the service URL does not produce a double slash', () => {
    const browser = new AzureBlobBrowser('myaccount', `${SERVICE}//`, { kind: 'anonymous' });
    assert.equal(browser.blobUrl('data', 'a.csv'), `${SERVICE}/data/a.csv`);
});

test('invalid container and blob names are refused before any request', async () => {
    const browser = anonymous();
    for (const container of ['..', 'Bad', 'a', 'a_b', 'x'.repeat(64), '']) {
        assert.throws(() => browser.blobUrl(container, 'a.csv'), AzureInputError, container);
        await assert.rejects(browser.listBlobs(container), AzureInputError, container);
    }
    for (const blob of ['', '/a.csv', '../a.csv', 'a\\b.csv', 'a/../b.csv', 'a\0.csv']) {
        assert.throws(() => browser.blobUrl('data', blob), AzureInputError, JSON.stringify(blob));
    }
});

test('a hostile prefix is refused', async () => {
    const browser = anonymous();
    for (const prefix of ['../', 'a/../b', 'a\\b', 'a\0b', 'x'.repeat(1025)]) {
        await assert.rejects(
            browser.listBlobs('data', { prefix }),
            AzureInputError,
            JSON.stringify(prefix),
        );
    }
});

test('a download validates names and containment before contacting the service', async () => {
    const browser = anonymous();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlfd-blob-'));
    try {
        await assert.rejects(browser.downloadBlob('BAD', 'a.csv', dir), AzureInputError);
        await assert.rejects(browser.downloadBlob('data', '../a.csv', dir), AzureInputError);
        await assert.rejects(browser.downloadBlob('data', 'a\\b.csv', dir), AzureInputError);
        assert.deepEqual(fs.readdirSync(dir), [], 'nothing may be written for a refused name');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the browser exposes the account but no credential', () => {
    const browser = new AzureBlobBrowser('myaccount', SERVICE, {
        kind: 'accountKey',
        accountKey: 'U0VDUkVUS0VZ',
    });
    assert.equal(browser.account, 'myaccount');
    const visible = Object.keys(browser).join(',');
    assert.ok(!visible.includes('credential'), 'no credential field is retained on the instance');
    assert.ok(!JSON.stringify({ url: browser.blobUrl('data', 'a.csv') }).includes('U0VDUkVU'));
});
