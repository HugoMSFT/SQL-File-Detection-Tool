/**
 * Tests for Azure Storage identifier parsing.
 *
 * The security-relevant properties are that a credential-bearing input is only
 * accepted when it genuinely points at Azure, that the secret part is returned
 * separately from the displayable part, and that redaction catches every shape
 * of credential the service or SDK might echo back.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AzureInputError,
    accountFromHost,
    describeAuthMode,
    isSafeBlobName,
    isValidAccountName,
    isValidContainerName,
    parseConnectionString,
    parsePublicContainerUrl,
    parseSasUrl,
    redactAzure,
    serviceUrlFor,
} from '../../azure/storageUrl';

test('account names follow the Azure rules', () => {
    for (const name of ['abc', 'azureopendatastorage', 'a1b2c3', 'x'.repeat(24)]) {
        assert.ok(isValidAccountName(name), name);
    }
    for (const name of ['ab', 'x'.repeat(25), 'Account', 'my-account', 'my_account', 'acct.', '']) {
        assert.ok(!isValidAccountName(name), name);
    }
});

test('container names follow the Azure rules', () => {
    for (const name of ['data', 'my-container', 'a1-b2-c3', 'x'.repeat(63)]) {
        assert.ok(isValidContainerName(name), name);
    }
    for (const name of ['ab', 'x'.repeat(64), '-lead', 'trail-', 'double--dash', 'Upper', 'a_b', '../etc']) {
        assert.ok(!isValidContainerName(name), name);
    }
});

test('blob names that could become traversal are refused', () => {
    for (const name of ['a.csv', 'year=2020/month=01/part-0.parquet', 'a b/c.json', '_delta_log/00.json']) {
        assert.ok(isSafeBlobName(name), name);
    }
    for (const name of [
        '',
        '/leading.csv',
        '..\\evil.csv',
        'a\\b.csv',
        '../secret.csv',
        'a/../../secret.csv',
        'a/./b.csv',
        'a\0.csv',
        'x'.repeat(1025),
    ]) {
        assert.ok(!isSafeBlobName(name), JSON.stringify(name));
    }
});

test('service URLs are built only from validated parts', () => {
    assert.equal(serviceUrlFor('myaccount'), 'https://myaccount.blob.core.windows.net');
    assert.equal(
        serviceUrlFor('myaccount', 'core.usgovcloudapi.net'),
        'https://myaccount.blob.core.usgovcloudapi.net',
    );
    assert.throws(() => serviceUrlFor('BAD NAME'), AzureInputError);
    assert.throws(() => serviceUrlFor('myaccount', 'evil.example/x'), AzureInputError);
    assert.throws(() => serviceUrlFor('myaccount', 'attacker.example'), AzureInputError);
    assert.throws(() => serviceUrlFor('myaccount', 'a'), AzureInputError);
});

test('account names are recovered only from genuine Azure endpoints', () => {
    assert.equal(accountFromHost('myaccount.blob.core.windows.net'), 'myaccount');
    assert.equal(accountFromHost('myaccount.dfs.core.windows.net'), 'myaccount');
    assert.equal(accountFromHost('MyAccount.Blob.Core.Windows.Net'), 'myaccount');
    assert.equal(accountFromHost('myaccount.blob.core.chinacloudapi.cn'), 'myaccount');
    assert.equal(accountFromHost('myaccount.blob.core.usgovcloudapi.net'), 'myaccount');
    for (const host of [
        'myaccount.blob.core.windows.net.evil.example',
        'evil.example',
        'blob.core.windows.net',
        'myaccount.queue.core.windows.net',
        'myaccount.blob.core.windows.net.',
    ]) {
        assert.equal(accountFromHost(host), null, host);
    }
});

test('a SAS URL is parsed with the signature kept out of the displayable parts', () => {
    const parsed = parseSasUrl(
        'https://myaccount.blob.core.windows.net/data/year=2020/?sv=2021-08-06&ss=b&sig=AbC%2Fdef%3D',
    );
    assert.equal(parsed.account, 'myaccount');
    assert.equal(parsed.serviceUrl, 'https://myaccount.blob.core.windows.net');
    assert.equal(parsed.container, 'data');
    assert.equal(parsed.prefix, 'year=2020/');
    assert.ok(parsed.sasToken.includes('sig='));
    assert.ok(!parsed.serviceUrl.includes('sig'), 'the displayable URL carries no signature');
});

test('a public container URL preserves its account, container and prefix', () => {
    const parsed = parsePublicContainerUrl(
        'https://azureopendatastorage.blob.core.windows.net/nyctlc/yellow/',
    );
    assert.deepEqual(parsed, {
        account: 'azureopendatastorage',
        serviceUrl: 'https://azureopendatastorage.blob.core.windows.net',
        container: 'nyctlc',
        prefix: 'yellow',
    });
});

test('public browsing requires a plain Azure container URL', () => {
    for (const candidate of [
        '',
        'not a url',
        'http://myaccount.blob.core.windows.net/data',
        'https://myaccount.blob.core.windows.net',
        'https://evil.example/data',
        'https://myaccount.blob.core.windows.net/data?sig=secret',
        'https://myaccount.blob.core.windows.net/data#fragment',
        'https://user:password@myaccount.blob.core.windows.net/data',
    ]) {
        assert.throws(() => parsePublicContainerUrl(candidate), AzureInputError, candidate);
    }
});

test('SAS URLs that are not credentials for Azure are refused', () => {
    for (const candidate of [
        '',
        '   ',
        'not a url',
        'http://myaccount.blob.core.windows.net/data?sig=x',
        'https://evil.example/data?sig=x',
        'https://myaccount.blob.core.windows.net.evil.example/data?sig=x',
        'https://myaccount.blob.core.windows.net/data?sv=2021-08-06',
        'https://myaccount.blob.core.windows.net/BAD_CONTAINER?sig=x',
    ]) {
        assert.throws(() => parseSasUrl(candidate), AzureInputError, candidate);
    }
});

test('a connection string yields the account and the secret separately', () => {
    const key = parseConnectionString(
        'DefaultEndpointsProtocol=https;AccountName=myaccount;AccountKey=c2VjcmV0a2V5==;EndpointSuffix=core.windows.net',
    );
    assert.equal(key.account, 'myaccount');
    assert.equal(key.serviceUrl, 'https://myaccount.blob.core.windows.net');
    assert.equal(key.accountKey, 'c2VjcmV0a2V5==');
    assert.equal(key.sasToken, null);

    const sas = parseConnectionString(
        'BlobEndpoint=https://myaccount.blob.core.windows.net;SharedAccessSignature=?sv=2021-08-06&sig=xyz;AccountName=myaccount',
    );
    assert.equal(sas.accountKey, null);
    assert.equal(sas.sasToken, 'sv=2021-08-06&sig=xyz');
    assert.equal(sas.serviceUrl, 'https://myaccount.blob.core.windows.net');
});

test('a connection string cannot redirect requests off Azure', () => {
    for (const candidate of [
        '',
        'garbage',
        'AccountName=myaccount',
        'AccountName=BAD NAME;AccountKey=k',
        'AccountName=myaccount;AccountKey=k;BlobEndpoint=http://myaccount.blob.core.windows.net',
        'AccountName=myaccount;AccountKey=k;BlobEndpoint=https://evil.example',
        'AccountName=myaccount;AccountKey=k;EndpointSuffix=attacker.example',
        'AccountName=myaccount;AccountKey=k;BlobEndpoint=https://otheraccount.blob.core.windows.net',
        'AccountName=myaccount;AccountKey=k;BlobEndpoint=not-a-url',
    ]) {
        assert.throws(() => parseConnectionString(candidate), AzureInputError, candidate);
    }
});

test('redaction removes every credential shape', () => {
    const sas = redactAzure(
        'GET https://a.blob.core.windows.net/c/b.csv?sv=2021-08-06&se=2030-01-01&sp=r&sig=AbC%2Fdef%3D failed',
    );
    assert.ok(!sas.includes('AbC'), sas);
    assert.ok(sas.includes('<redacted>'));

    const conn = redactAzure('AccountKey=c2VjcmV0;SharedAccessSignature=sv=1&sig=z');
    assert.ok(!conn.includes('c2VjcmV0'));
    assert.ok(!conn.includes('sig=z') || conn.includes('<redacted>'));

    const bearer = redactAzure('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature');
    assert.ok(!bearer.includes('eyJhbGci'), bearer);

    const jwt = redactAzure('token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 in body');
    assert.ok(!jwt.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), jwt);

    assert.equal(redactAzure(undefined), '');
    assert.equal(redactAzure('nothing sensitive here'), 'nothing sensitive here');
});

test('auth modes have non-secret human labels', () => {
    assert.equal(describeAuthMode('vscode'), 'Microsoft Entra work or school account');
    assert.equal(describeAuthMode('sas'), 'Shared access signature');
    assert.equal(describeAuthMode('connectionString'), 'Connection string');
    assert.equal(describeAuthMode('anonymous'), 'Anonymous public container');
    assert.equal(describeAuthMode('managedIdentity'), 'Not connected');
});
