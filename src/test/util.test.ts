/** Unit tests for the extension's pure helpers. */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'path';

import {
    DEFAULT_PLATFORM,
    computeRoot,
    isSupportedFile,
    isWithinRoot,
    normalizePlatform,
    redact,
} from '../util';

test('the default platform is Azure SQL Database', () => {
    assert.equal(DEFAULT_PLATFORM, 'azure_sql_db');
    assert.equal(normalizePlatform(undefined), 'azure_sql_db');
    assert.equal(normalizePlatform(''), 'azure_sql_db');
    assert.equal(normalizePlatform('not-a-platform'), 'azure_sql_db');
});

test('an explicit platform selection is preserved', () => {
    assert.equal(normalizePlatform('sql_server_2019'), 'sql_server_2019');
    assert.equal(normalizePlatform('fabric_sql_db'), 'fabric_sql_db');
});

test('redact removes bearer tokens, JWTs, keys and SAS signatures', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcdefghij';
    assert.ok(!redact(`Authorization: Bearer ${jwt}`).includes(jwt));
    assert.ok(!redact(jwt).includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));

    const cs =
        'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=c2VjcmV0S2V5MTIz;EndpointSuffix=core.windows.net';
    const redacted = redact(cs);
    assert.ok(!redacted.includes('c2VjcmV0S2V5MTIz'));
    assert.ok(redacted.includes('AccountName=acct'));

    const sas =
        'https://acct.blob.core.windows.net/c/b.csv?sv=2022-11-02&sig=AbC%2Fd123&se=2030-01-01';
    const redactedSas = redact(sas);
    assert.ok(!redactedSas.includes('AbC%2Fd123'));
    assert.ok(redactedSas.includes('acct.blob.core.windows.net'));
});

test('redact tolerates non-string input', () => {
    assert.equal(redact(undefined), '');
    assert.equal(redact(null), '');
    assert.equal(redact(42), '42');
});

test('isSupportedFile recognises data files case-insensitively', () => {
    assert.ok(isSupportedFile('/tmp/a.CSV'));
    assert.ok(isSupportedFile('C:\\x\\y.parquet'));
    assert.ok(!isSupportedFile('/tmp/readme.md'));
    assert.ok(!isSupportedFile('/tmp/no-extension'));
});

// -- analysis root selection ------------------------------------------------
// Every local read is confined to a single root directory, so these helpers
// decide which root the native analysis service must use for a given target.

test('isWithinRoot accepts the root itself and its descendants', () => {
    const root = path.resolve('/projects/data');
    assert.equal(isWithinRoot(root, root), true);
    assert.equal(isWithinRoot(path.join(root, 'a', 'b.csv'), root), true);
});

test('isWithinRoot rejects siblings, parents and traversal', () => {
    const root = path.resolve('/projects/data');
    assert.equal(isWithinRoot(path.resolve('/projects/other/b.csv'), root), false);
    assert.equal(isWithinRoot(path.resolve('/projects'), root), false);
    assert.equal(isWithinRoot(path.join(root, '..', 'escape.csv'), root), false);
});

test('isWithinRoot is not fooled by a shared name prefix', () => {
    assert.equal(
        isWithinRoot(path.resolve('/projects/data-backup/x.csv'), path.resolve('/projects/data')),
        false,
    );
});

test('isWithinRoot rejects empty inputs', () => {
    assert.equal(isWithinRoot('', path.resolve('/projects')), false);
    assert.equal(isWithinRoot(path.resolve('/projects/a.csv'), ''), false);
});

test('computeRoot honours an explicit override above everything else', () => {
    const root = computeRoot({
        override: '/explicit/root',
        hint: path.resolve('/somewhere/else/file.csv'),
        workspaceFolders: [path.resolve('/ws')],
        home: path.resolve('/home/user'),
    });
    assert.equal(root, path.resolve('/explicit/root'));
});

test('computeRoot prefers the workspace folder containing the target', () => {
    const wsA = path.resolve('/ws/a');
    const wsB = path.resolve('/ws/b');
    const root = computeRoot({
        hint: path.join(wsB, 'nested', 'data.csv'),
        workspaceFolders: [wsA, wsB],
        home: path.resolve('/home/user'),
    });
    assert.equal(root, wsB);
});

test('computeRoot falls back to the parent directory of an outside file', () => {
    const target = path.resolve('/tmp/scratch/data.csv');
    const root = computeRoot({
        hint: target,
        workspaceFolders: [path.resolve('/ws/a')],
        home: path.resolve('/home/user'),
    });
    assert.equal(root, path.dirname(target));
    assert.equal(isWithinRoot(target, root), true);
});

test('computeRoot uses an outside directory target as its own root', () => {
    const target = path.resolve('/tmp/scratch');
    const root = computeRoot({
        hint: target,
        hintIsDirectory: true,
        workspaceFolders: [],
        home: path.resolve('/home/user'),
    });
    assert.equal(root, target);
    assert.equal(isWithinRoot(path.join(target, 'x.csv'), root), true);
});

test('computeRoot uses the first workspace folder when there is no target', () => {
    const wsA = path.resolve('/ws/a');
    const root = computeRoot({
        workspaceFolders: [wsA, path.resolve('/ws/b')],
        home: path.resolve('/home/user'),
    });
    assert.equal(root, wsA);
});

test('computeRoot falls back to the home directory with no workspace', () => {
    const home = path.resolve('/home/user');
    assert.equal(computeRoot({ workspaceFolders: [], home }), home);
    assert.equal(computeRoot({ home }), home);
});

test('computeRoot always returns a root that contains the requested target', () => {
    const cases: Array<[string, boolean]> = [
        [path.resolve('/ws/a/deep/nested/file.parquet'), false],
        [path.resolve('/elsewhere/file.csv'), false],
        [path.resolve('/elsewhere/folder'), true],
    ];
    for (const [hint, hintIsDirectory] of cases) {
        const root = computeRoot({
            hint,
            hintIsDirectory,
            workspaceFolders: [path.resolve('/ws/a')],
            home: path.resolve('/home/user'),
        });
        assert.equal(isWithinRoot(hint, root), true, `${hint} should be inside ${root}`);
    }
});
