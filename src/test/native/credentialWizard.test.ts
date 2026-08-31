import assert from 'node:assert/strict';
import test from 'node:test';

import {
    credentialWizardState,
    dataSourceOptionsFor,
    effectiveStorageUrl,
    inferDataSourceType,
    normalizeDataSourceType,
    normalizeGuidedAuthMethod,
} from '../../native/sql/credentialWizard';

test('offers only platform-supported external data sources', () => {
    assert.deepEqual(
        dataSourceOptionsFor('sql_server_2019').map((option) => option.id),
        ['azure_blob', 'azure_data_lake'],
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
});

test('keeps Fabric SQL Database on OneLake, ABFSS and USER IDENTITY', () => {
    const state = credentialWizardState('fabric_sql_db', 'azure_blob', 'sas');
    assert.deepEqual(state.dataSourceOptions.map((option) => option.id), ['fabric_onelake']);
    assert.equal(state.dataSourceType, 'fabric_onelake');
    assert.equal(state.locationPrefix, 'ABFSS');
    assert.deepEqual(state.authOptions.map((option) => option.id), ['user_identity']);
    assert.equal(state.authMethod, 'user_identity');
});

test('maps OneLake to the ADLS connector outside Fabric SQL Database', () => {
    const state = credentialWizardState(
        'azure_sql_db',
        'fabric_onelake',
        'managed_identity',
    );
    assert.equal(state.locationPrefix, 'ADLS');
    assert.match(state.note, /ADLS connector/);
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
        /^s3:/,
    );
});
