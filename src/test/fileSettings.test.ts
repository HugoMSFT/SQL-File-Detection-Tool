import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_FILE_SETTINGS,
    FileSettingsHistory,
    MAX_COLUMN_OVERRIDES,
    MAX_FILE_HISTORY_BYTES,
    MAX_FILE_SETTINGS,
    MAX_IMPORT_PROFILE_BYTES,
    MAX_IMPORT_PROFILES,
    MAX_IMPORT_PROFILES_BYTES,
    SettingsValidationError,
    fileSettingsFrom,
    settingsBytes,
    validateFileSettings,
    validateImportProfile,
    validateImportProfiles,
    validatedSqlType,
} from '../fileSettings';

function profile(name = 'Orders') {
    return {
        version: 1,
        name,
        ...DEFAULT_FILE_SETTINGS,
        tableName: 'orders',
        schemaName: 'staging',
        credentialName: 'ImportCredential',
        parserOverrides: {
            format: 'csv',
            firstRow: 2,
            fieldDelimiter: '|',
            rowTerminator: '0x0a',
            codepage: '65001',
            compression: 'GZIP',
        },
        columnOverrides: {
            'Revenue / USD': 'DECIMAL(18,4)',
            'Key: value': 'INT',
            ' padded ': 'NVARCHAR(100)',
        },
    };
}

function largeSettings(suffix = '') {
    return {
        ...DEFAULT_FILE_SETTINGS,
        tableName: `large${suffix}`,
        columnOverrides: Object.fromEntries(Array.from({ length: 100 }, (_, i) =>
            [`${i}_${'\u754c'.repeat(90)}`, 'NVARCHAR(100)'])),
    };
}

test('profiles round-trip a strict typed schema without rewriting source column keys', () => {
    const original = profile();
    const decoded = validateImportProfile(JSON.parse(JSON.stringify(original)));
    assert.deepEqual(decoded, original);
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded.columnOverrides));
    assert.ok(Object.isFrozen(decoded.parserOverrides));
    assert.deepEqual(Object.keys(decoded.columnOverrides), ['Revenue / USD', 'Key: value', ' padded ']);
    assert.deepEqual(fileSettingsFrom(decoded), {
        ...DEFAULT_FILE_SETTINGS,
        tableName: original.tableName,
        schemaName: original.schemaName,
        credentialName: original.credentialName,
        parserOverrides: original.parserOverrides,
        columnOverrides: original.columnOverrides,
    });
});

test('profiles reject unknown fields at every level instead of serializing arbitrary state', () => {
    for (const field of [
        'storageUrl', 'remoteURL', 'platform', 'sourceMode', 'sourceKind', 'authMethod',
        'token', 'accessToken', 'accountKey', 'connectionString', 'sas', 'contents',
        'filePath', 'metadata', 'extra',
    ]) {
        assert.throws(() => validateImportProfile({ ...profile(), [field]: 'SECRET' }), SettingsValidationError, field);
        assert.throws(() => validateImportProfile({
            ...profile(), parserOverrides: { ...profile().parserOverrides, [field]: 'SECRET' },
        }), SettingsValidationError, field);
    }
    assert.throws(() => validateImportProfile({ ...profile(), version: 2 }), /version/);
    assert.throws(() => validateImportProfile({ ...profile(), name: undefined }), SettingsValidationError);
    assert.throws(() => validateImportProfile({ ...profile(), columnOverrides: [] }), SettingsValidationError);
    assert.throws(() => validateImportProfiles({ profiles: [profile()] }), SettingsValidationError);
});

test('prototype, inherited, accessor and array-extra fields cannot enter a saved profile', () => {
    for (const key of ['__proto__', 'prototype', 'constructor']) {
        for (const section of ['root', 'parserOverrides', 'columnOverrides']) {
            const source = profile();
            const polluted = JSON.parse(`{"${key}":"SECRET"}`);
            const candidate = section === 'root'
                ? { ...source, ...polluted }
                : { ...source, [section]: { ...polluted } };
            assert.throws(() => validateImportProfile(candidate), SettingsValidationError, `${section}.${key}`);
        }
    }
    const inherited = Object.assign(Object.create({ token: 'SECRET' }), profile());
    assert.throws(() => validateImportProfile(inherited), SettingsValidationError);
    let invoked = false;
    const accessor = Object.defineProperty(profile(), 'name', {
        enumerable: true,
        get: () => { invoked = true; return 'SECRET'; },
    });
    assert.throws(() => validateImportProfile(accessor), SettingsValidationError);
    const list = Object.defineProperty([profile()], '0', {
        enumerable: true,
        get: () => { invoked = true; return profile(); },
    });
    assert.throws(() => validateImportProfiles(list), SettingsValidationError);
    assert.equal(invoked, false);
    assert.throws(() => validateImportProfiles(Object.assign([profile()], { token: 'SECRET' })), SettingsValidationError);
    assert.throws(() => validateImportProfiles(new Array(1)), SettingsValidationError);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('names and parser fields reject secret-bearing text without echoing it in errors', () => {
    for (const value of [
        'https://account.blob.core.windows.net/data?sig=SECRET',
        'abs://data@account.blob.core.windows.net/x',
        'name?sig=SECRET',
        'AccountKey=SECRET',
        'SharedAccessSignature=SECRET',
        'Bearer SECRET',
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SECRET',
        'name\nSECRET',
        'name\u2028SECRET',
        '/home/user/file.csv',
        'C:\\private\\file.csv',
    ]) {
        for (const key of ['name', 'tableName', 'schemaName', 'dataSource', 'credentialName', 'formatName']) {
            assert.throws(() => validateImportProfile({ ...profile(), [key]: value }), (error: unknown) => {
                assert.ok(error instanceof SettingsValidationError);
                assert.ok(!error.message.includes('SECRET'));
                return true;
            });
        }
        assert.throws(() => validateImportProfile({
            ...profile(), columnOverrides: { [value]: 'INT' },
        }), SettingsValidationError, value);
    }
    for (const parserOverrides of [
        { firstRow: 0 }, { firstRow: 1_000_001 }, { firstRow: '2' },
        { format: 'bogus' }, { fieldDelimiter: 'SECRET' },
        { fieldDelimiter: '\n' }, { codepage: 'token=SECRET' },
        { codepage: '65536' }, { compression: 'AccountKey=SECRET' },
        { rowTerminator: 'sig=x' }, { rowTerminator: 'x'.repeat(129) },
    ]) {
        assert.throws(() => validateImportProfile({ ...profile(), parserOverrides }), SettingsValidationError);
    }
    assert.throws(() => validateImportProfile({
        ...profile(), columnOverrides: { 'name%3Fsig%3DSECRET': 'INT' },
    }), SettingsValidationError);
});

test('SQL override types use real names and inclusive argument bounds', () => {
    for (const value of [
        'INT', 'BIGINT', 'DATE', 'DECIMAL', 'DECIMAL(1,0)', 'NUMERIC(38,38)',
        'NVARCHAR(MAX)', 'NVARCHAR(4000)', 'VARCHAR(8000)', 'VARBINARY(MAX)',
        'NCHAR(1)', 'BINARY(8000)', 'TIME(0)', 'DATETIME2(7)', 'DATETIMEOFFSET(7)',
        'FLOAT(1)', 'FLOAT(53)', 'UNIQUEIDENTIFIER',
    ]) {
        assert.equal(validatedSqlType(value), value);
    }
    assert.equal(validatedSqlType(' decimal ( 18, 4 ) '), 'DECIMAL(18,4)');
    for (const value of [
        'BOGUS', 'VARCHAR(0)', 'VARCHAR(8001)', 'NVARCHAR(4001)', 'NCHAR(MAX)',
        'CHAR(MAX)', 'BINARY(MAX)', 'INT(1)', 'DECIMAL(0,0)', 'DECIMAL(39,0)',
        'DECIMAL(18,19)', 'NUMERIC(MAX)', 'TIME(8)', 'TIME(1,1)', 'DATETIME2(8)',
        'FLOAT(0)', 'FLOAT(54)', 'VARCHAR(MAX,1)', 'INT;DROP TABLE x', 'INT\n',
        'dbo.CustomType', 'NVARCHAR(10) COLLATE Latin1_General_CI_AS',
        'I NT', 'N VAR CHAR(20)', 'NVARCHAR(1 0)', 'DECIMAL(1 8,4)',
    ]) {
        assert.throws(() => validatedSqlType(value), SettingsValidationError, value);
    }
});

test('profile count, column count, per-profile bytes and collection bytes are independently bounded', () => {
    assert.equal(validateImportProfiles(Array.from({ length: MAX_IMPORT_PROFILES }, (_, i) => profile(String(i)))).length, MAX_IMPORT_PROFILES);
    assert.throws(() => validateImportProfiles(Array.from({ length: MAX_IMPORT_PROFILES + 1 }, (_, i) => profile(String(i)))), /at most/);
    assert.throws(() => validateImportProfiles([profile(), profile()]), /unique/);
    assert.throws(() => validateFileSettings({
        ...DEFAULT_FILE_SETTINGS,
        columnOverrides: Object.fromEntries(Array.from({ length: MAX_COLUMN_OVERRIDES + 1 }, (_, i) => [`col${i}`, 'INT'])),
    }), /At most/);
    assert.throws(() => validateImportProfile({
        ...profile(),
        columnOverrides: Object.fromEntries(Array.from({ length: MAX_COLUMN_OVERRIDES }, (_, i) =>
            [`${i}_${'\u754c'.repeat(120)}`, 'NVARCHAR(100)'])),
    }), /32 KiB/);
    const large = validateImportProfile({ version: 1, name: 'large', ...largeSettings() });
    assert.ok(settingsBytes(large) < MAX_IMPORT_PROFILE_BYTES);
    const count = Math.floor(MAX_IMPORT_PROFILES_BYTES / (settingsBytes(large) + 1));
    const within = Array.from({ length: count }, (_, i) => ({ ...large, name: `large${i}` }));
    assert.ok(Buffer.byteLength(JSON.stringify(within), 'utf8') <= MAX_IMPORT_PROFILES_BYTES);
    assert.equal(validateImportProfiles(within).length, count);
    assert.throws(() => validateImportProfiles([...within, { ...large, name: 'over' }]), /256 KiB/);
});

test('file history has one isolated undo per identity and no caller-owned references', () => {
    const history = new FileSettingsHistory();
    const first = { ...DEFAULT_FILE_SETTINGS, tableName: 'first', columnOverrides: { id: 'INT' } };
    history.write('a', first, false);
    history.write('b', { ...DEFAULT_FILE_SETTINGS, tableName: 'second' }, false);
    history.write('a', { ...first, tableName: 'changed' });
    first.columnOverrides.id = 'BIGINT';
    assert.equal(history.get('a').columnOverrides.id, 'INT');
    assert.equal(history.canUndo('a'), true);
    assert.equal(history.canUndo('b'), false);
    assert.equal(history.undo('a')?.tableName, 'first');
    assert.equal(history.canUndo('a'), false);
    assert.equal(history.undo('a'), undefined);
    assert.equal(history.get('b').tableName, 'second');
    history.clear();
    assert.equal(history.size, 0);
    assert.equal(history.byteSize, 0);
});

test('file history evicts the least recently used entries at its count limit', () => {
    const history = new FileSettingsHistory();
    for (let i = 0; i < MAX_FILE_SETTINGS; i += 1) {
        history.write(String(i), { ...DEFAULT_FILE_SETTINGS, tableName: `file${i}` }, false);
    }
    history.get('0');
    history.write('new', { ...DEFAULT_FILE_SETTINGS, tableName: 'new' });
    assert.equal(history.size, MAX_FILE_SETTINGS);
    assert.equal(history.get('0').tableName, 'file0');
    assert.deepEqual(history.get('1'), DEFAULT_FILE_SETTINGS);
    assert.equal(history.canUndo('1'), false);
});

test('file history byte accounting includes undo and evicts before crossing the budget', () => {
    const history = new FileSettingsHistory();
    history.write('first', largeSettings('a'), false);
    const beforeUndo = history.byteSize;
    history.write('first', largeSettings('b'));
    assert.ok(history.byteSize > beforeUndo + settingsBytes(largeSettings('a')));
    for (let i = 0; i < MAX_FILE_SETTINGS; i += 1) {
        history.write(String(i), largeSettings(`a${i}`), false);
        history.write(String(i), largeSettings(`b${i}`));
        assert.ok(history.byteSize <= MAX_FILE_HISTORY_BYTES);
        assert.ok(history.size <= MAX_FILE_SETTINGS);
    }
    assert.ok(history.size < MAX_FILE_SETTINGS, 'the byte bound is independently enforced');
    assert.equal(history.canUndo('first'), false);
    assert.equal(history.get(String(MAX_FILE_SETTINGS - 1)).tableName, `largeb${MAX_FILE_SETTINGS - 1}`);
    const retainedBytes = history.byteSize;
    assert.throws(() => history.write('invalid', { ...DEFAULT_FILE_SETTINGS, schemaName: 'x'.repeat(129) }), SettingsValidationError);
    assert.equal(history.byteSize, retainedBytes, 'rejected settings cannot displace valid history');
});
