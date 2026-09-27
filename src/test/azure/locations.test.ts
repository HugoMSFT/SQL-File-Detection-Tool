import assert from 'node:assert/strict';
import test from 'node:test';

import { azureStorageUrl } from '../../azure/browser';
import { AzureBrowserError } from '../../azure/errors';
import {
    MAX_BLOB_PATH_LENGTH,
    MAX_PUBLIC_CONTAINER_URL_LENGTH,
    parsePublicContainerUrl,
} from '../../azure/locations';

const HOST = 'blob001.blob.core.windows.net';

test('public container URLs preserve decoded Unicode, spaces, and the container boundary', () => {
    for (const url of [`https://${HOST}/raw`, `abs://raw@${HOST}/`]) {
        assert.deepEqual(parsePublicContainerUrl(url), {
            accountName: 'blob001', blobHost: HOST, container: 'raw', prefix: '',
        });
    }
    const parsed = parsePublicContainerUrl(
        'https://BLOB001.z19.blob.storage.azure.net/raw/2026/',
        'sales%20data/caf%C3%A9/',
    );
    assert.deepEqual(parsed, {
        accountName: 'blob001',
        blobHost: 'blob001.z19.blob.storage.azure.net',
        container: 'raw',
        prefix: '2026/sales data/caf\u00e9/',
    });
    assert.equal(
        azureStorageUrl({ name: parsed.accountName, hns: false, blobHost: parsed.blobHost }, parsed.container, parsed.prefix),
        'abs://raw@blob001.z19.blob.storage.azure.net/2026/sales%20data/caf%C3%A9/',
    );
    for (const container of ['$root', '$web']) {
        assert.equal(parsePublicContainerUrl(`https://${HOST}/${container}/`).container, container);
        assert.equal(parsePublicContainerUrl(`abs://${encodeURIComponent(container)}@${HOST}/`).container, container);
    }
});

test('public URL validation rejects lookalikes, rebinding hosts, credentials, secrets, and non-public endpoints', () => {
    const invalid = [
        '', `http://${HOST}/raw`, `file://${HOST}/raw`, `abfss://raw@${HOST}/`,
        `https://${HOST}`, `https://${HOST}/ra`, `https://${HOST}/Raw`,
        `https://${HOST}/a--b`, `https://${HOST}/-raw`, `https://${HOST}/${'a'.repeat(64)}`,
        `https://${HOST}/$logs`, `https://${HOST}/raw%2Fother`,
        `https://${HOST}:443/raw`, `https://${HOST}:8443/raw`,
        `https://user:password@${HOST}/raw`, `https://user@${HOST}/raw`,
        `abs://raw:password@${HOST}/`, `abs://raw@user@${HOST}/`,
        `https://${HOST}/raw?sig=secret`, `https://${HOST}/raw?`, `https://${HOST}/raw#`,
        `https://${HOST}.attacker.test/raw`, `https://${HOST}.127.0.0.1.nip.io/raw`,
        'https://localhost/raw', 'https://127.0.0.1/raw', 'https://2130706433/raw',
        'https://[::1]/raw', 'https://169.254.169.254/raw', 'https://10.0.0.1/raw',
        'https://blob001.privatelink.blob.core.windows.net/raw',
        'https://blob001.dfs.core.windows.net/raw',
        'https://blob001.blob.core.usgovcloudapi.net/raw',
        'https://extra.blob001.blob.core.windows.net/raw',
        `https://${HOST}./raw`, 'https://blob001.z-1.blob.storage.azure.net/raw',
        `https://blob001.z${'1'.repeat(64)}.blob.storage.azure.net/raw`,
        'https://blob001%2eblob.core.windows.net/raw',
        'https://blob001.blob.core.windows.n\u0435t/raw',
        `https://${HOST}/raw\\folder`, `https://${HOST}/raw\n`,
        'x'.repeat(MAX_PUBLIC_CONTAINER_URL_LENGTH + 1),
    ];
    for (const value of invalid) {
        assert.throws(() => parsePublicContainerUrl(value), AzureBrowserError, value);
    }
});

test('public paths reject traversal and decoded controls before URL normalization', () => {
    for (const prefix of [
        '..', '.', 'a/../b', 'a/%2e%2e/b', '%2e', '%2F..%2F',
        '../raw', '/folder', 'folder//child', 'folder//', 'folder\\child',
        'folder%5Cchild', 'a%00b', 'a%0Ab', 'a%0Db', 'a%7Fb',
        'a%C2%85b', 'a%E2%80%A8b', '%', '%ZZ',
        'a'.repeat(MAX_BLOB_PATH_LENGTH + 1),
    ]) {
        assert.throws(() => parsePublicContainerUrl(`https://${HOST}/raw/`, prefix), AzureBrowserError, prefix);
        assert.throws(() => parsePublicContainerUrl(`https://${HOST}/raw/${prefix}`), AzureBrowserError, prefix);
    }
    assert.equal(
        parsePublicContainerUrl(`https://${HOST}/raw/`, 'a'.repeat(MAX_BLOB_PATH_LENGTH - 1)).prefix.length,
        MAX_BLOB_PATH_LENGTH,
    );
    assert.throws(() =>
        parsePublicContainerUrl(`https://${HOST}/raw/a/`, 'b'.repeat(MAX_BLOB_PATH_LENGTH - 1)));
});
