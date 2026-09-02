import assert from 'node:assert/strict';
import test from 'node:test';

import {
    credentialWizardState,
    dataSourceOptionsFor,
    effectiveStorageUrl,
    inferDataSourceType,
    knownStorageLocation,
    normalizeDataSourceType,
    normalizeGuidedAuthMethod,
} from '../../native/sql/credentialWizard';

test('offers only platform-supported external data sources', () => {
    assert.deepEqual(
        dataSourceOptionsFor('sql_server_2019').map((option) => option.id),
        ['azure_blob'],
    );
    assert.deepEqual(
        dataSourceOptionsFor('fabric_sql_db').map((option) => option.id),
        ['fabric_onelake'],
    );
});

test('normalizes incompatible source and authentication selections', () => {
    assert.equal(normalizeDataSourceType('s3', 'azure_sql_db'), 'azure_blob');
    assert.equal(
        normalizeGuidedAuthMethod('managed_identity', 'sql_server_2022', 's3'),
        's3_access_key',
    );
    assert.equal(
        normalizeGuidedAuthMethod('sas', 'fabric_sql_db', 'fabric_onelake'),
        'user_identity',
    );
    assert.equal(
        normalizeGuidedAuthMethod('sas', 'sql_server_2019', 'azure_blob'),
        'storage_key',
    );
});

test('keeps Fabric SQL Database on OneLake, ABFSS and USER IDENTITY', () => {
    const state = credentialWizardState('fabric_sql_db', 'azure_blob', 'sas');
    assert.deepEqual(state.dataSourceOptions.map((option) => option.id), ['fabric_onelake']);
    assert.equal(state.dataSourceType, 'fabric_onelake');
    assert.equal(state.locationPrefix, 'ABFSS');
    assert.deepEqual(state.authOptions.map((option) => option.id), ['user_identity']);
    assert.equal(state.authMethod, 'user_identity');
});

test('keeps OneLake out of non-Fabric platform choices', () => {
    const state = credentialWizardState(
        'azure_sql_db',
        'fabric_onelake',
        'managed_identity',
    );
    assert.equal(state.dataSourceType, 'azure_blob');
    assert.ok(!state.dataSourceOptions.some((option) => option.id === 'fabric_onelake'));
});

test('restricts SQL Server 2022 S3 access to S3 access keys', () => {
    const state = credentialWizardState('sql_server_2022', 's3', 'sas');
    assert.deepEqual(state.authOptions.map((option) => option.id), ['s3_access_key']);
    assert.equal(state.authMethod, 's3_access_key');
});

test('states the SQL Server 2025 Arc requirement for managed identity', () => {
    const state = credentialWizardState(
        'sql_server_2025',
        'azure_data_lake',
        'managed_identity',
    );
    assert.equal(state.authMethod, 'managed_identity');
    assert.match(state.note, /Azure Arc-enabled/);
    assert.match(state.note, /user-assigned identity/);
});

test('infers source types and uses safe source-specific placeholders', () => {
    assert.equal(
        inferDataSourceType('https://acct.blob.core.windows.net/raw/data.csv'),
        'azure_blob',
    );
    assert.equal(
        inferDataSourceType('https://acct.dfs.core.windows.net/raw/data.csv'),
        'azure_data_lake',
    );
    assert.equal(inferDataSourceType('s3://bucket/data.csv'), 's3');
    assert.match(
        effectiveStorageUrl('fabric_sql_db', 'fabric_onelake', '', 'data.csv'),
        /^abfss:/,
    );
    assert.match(
        effectiveStorageUrl('sql_server_2022', 's3', '', 'data.csv'),
        /^s3:\/\/<s3_endpoint>\/<bucket>\//,
    );
});

test('normalizes known storage URLs before they reach generated SQL', () => {
    const blob = knownStorageLocation(
        'abs://raw@acct.blob.core.windows.net/orders.parquet',
    );
    assert.equal(blob.dataSourceType, 'azure_blob');
    assert.equal(blob.storageUrl, 'abs://raw@acct.blob.core.windows.net/orders.parquet');

    const lake = knownStorageLocation(
        'adls://raw@acct.dfs.core.windows.net/orders.parquet',
    );
    assert.equal(lake.dataSourceType, 'azure_data_lake');
    assert.equal(lake.storageUrl, 'adls://raw@acct.dfs.core.windows.net/orders.parquet');

    const signed = knownStorageLocation(
        'https://acct.blob.core.windows.net/raw/orders.parquet?sv=1&sig=secret#preview',
    );
    assert.deepEqual(signed, {
        storageUrl: 'https://acct.blob.core.windows.net/raw/orders.parquet',
        dataSourceType: 'azure_blob',
        removedSuffix: true,
        hadSasSignature: true,
    });

    const onelake = knownStorageLocation(
        'abfss://workspace@onelake.dfs.fabric.microsoft.com/lakehouse.Lakehouse/Files/orders',
    );
    assert.equal(onelake.dataSourceType, 'fabric_onelake');
    assert.equal(onelake.removedSuffix, false);
    assert.equal(
        knownStorageLocation(
            'https://onelake.dfs.fabric.microsoft.com/workspace/lakehouse.Lakehouse/Files/orders',
        ).dataSourceType,
        'fabric_onelake',
    );
    assert.equal(
        knownStorageLocation(
            'https://westus-onelake.dfs.fabric.microsoft.com/workspace/lakehouse.Lakehouse/Files/orders',
        ).dataSourceType,
        'fabric_onelake',
    );
    assert.equal(
        knownStorageLocation(
            'https://abcdef0123456789abcdef0123456789.zab.dfs.fabric.microsoft.com/lakehouse.Lakehouse/Files/orders',
        ).dataSourceType,
        'fabric_onelake',
    );

    const s3 = knownStorageLocation('s3://sales-data/year=2026/');
    assert.equal(s3.dataSourceType, 's3');

    assert.equal(
        knownStorageLocation(
            'https://acct.blob.core.windows.net/raw/orders.parquet?SIG=secret',
        ).hadSasSignature,
        true,
    );
});

test('known storage URLs reject incomplete and unsupported locations', () => {
    for (const candidate of [
        '',
        'not-a-url',
        'https://example.com/data.csv',
        'https://acct.blob.core.windows.net',
        'abs:///raw/orders.parquet',
        'adls:///raw/orders.parquet',
        'abfss:///workspace/lakehouse/Files/orders.parquet',
        'abfss://workspace@onelake.dfs.fabric.microsoft.com/lakehouse/data.parquet',
        'abfss://onelake.dfs.fabric.microsoft.com/lakehouse/Files/data.parquet',
        'https://onelake.dfs.fabric.microsoft.com/lakehouse/Files/data.parquet',
        'https://fabric.microsoft.com.attacker.example/workspace/lakehouse.Lakehouse/Files/data.parquet',
        'https://onelake.attacker.example/workspace/lakehouse.Lakehouse/Files/data.parquet',
        'abs://raw@attacker.example/data.csv',
        'adls://raw@attacker.example/data.parquet',
        'abs://raw@acct.blob.core.windows.net.attacker.example/data.csv',
        'adls://raw@acct.dfs.core.windows.net.attacker.example/data.parquet',
        's3:///sales-data/orders.parquet',
        's3a://s3.amazonaws.com/sales-data/orders.parquet',
        's3n://s3.amazonaws.com/sales-data/orders.parquet',
        'https://user:password@acct.blob.core.windows.net/raw/orders.parquet',
        's3://user:password@s3.amazonaws.com/bucket/orders.parquet',
        '******acct.blob.core.windows.net/raw',
        'ftp://example.com/data.csv',
    ]) {
        assert.throws(() => knownStorageLocation(candidate), Error, candidate);
    }
});
