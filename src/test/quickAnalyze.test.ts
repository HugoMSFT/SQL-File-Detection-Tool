import assert from 'node:assert/strict';
import test from 'node:test';

import type { FileMetadata } from '../native';
import { NativeAnalysisService } from '../native';
import {
    folderProfileFor,
    parserOptionsFor,
    polyBaseGuidance,
    sourceReadiness,
    suggestedObjectNames,
} from '../quickAnalyze';

function csv(overrides: Partial<FileMetadata> = {}): FileMetadata {
    return {
        file_path: 'C:\\data\\sales.csv',
        file_name: 'sales.csv',
        file_type: 'csv',
        file_size: 100,
        schema: [['id', 'int64']],
        row_count: 1,
        column_count: 1,
        delimiter: ',',
        encoding: 'utf-8',
        encoding_confidence: 0.91,
        codepage: '65001',
        has_header: true,
        compression: null,
        nullable_columns: [],
        parquet_metadata: null,
        delta_metadata: null,
        ...overrides,
    };
}

test('parser options distinguish inferred, mapped, assumed, and overridden facts', () => {
    const options = parserOptionsFor(csv(), {
        codepage: '1252',
        fieldDelimiter: '|',
    });
    assert.equal(options.find((option) => option.key === 'fieldDelimiter')?.provenance, 'Overridden');
    const codepage = options.find((option) => option.key === 'codepage');
    assert.equal(codepage?.provenance, 'Overridden');
    assert.equal(codepage?.expectedValue, '65001');
    assert.match(codepage?.evidence ?? '', /file encoding utf-8/i);
    assert.equal(
        options.find((option) => option.key === 'rowTerminator')?.provenance,
        'Assumed',
    );
    assert.equal(
        options.find((option) => option.label === 'File encoding')?.value,
        'utf-8',
        'CODEPAGE overrides never rewrite the file encoding fact',
    );
});

test('source readiness derives Azure base, relative path, names, and anonymous credential rules', () => {
    const names = suggestedObjectNames(
        'https://acct.blob.core.windows.net/raw/folder/sales.csv',
        'csv',
        'public',
    );
    assert.deepEqual(names, {
        dataSource: 'ds_acct_raw',
        formatName: 'ff_csv_format',
        credentialName: '',
    });
    const source = sourceReadiness({
        sourceKind: 'azure',
        storageUrl: 'https://acct.blob.core.windows.net/raw/folder/sales.csv',
        fileName: 'sales.csv',
        fileType: 'csv',
        dataSource: names.dataSource,
        credentialName: names.credentialName,
        formatName: names.formatName,
        authMethod: 'public',
        platform: 'azure_sql_db',
        selectedStatement: 'create_external_table',
    });
    assert.equal(source.baseLocation, 'https://acct.blob.core.windows.net/raw');
    assert.equal(source.relativePath, 'folder/sales.csv');
    assert.equal(source.stagingRequired, false);
    assert.equal(source.objects[0].required, false);
    assert.match(source.objects[0].detail, /needs no/i);
    assert.deepEqual(
        source.objects.map((object) => object.documentation.id),
        [
            'create_database_scoped_credential',
            'create_external_data_source',
            'create_external_file_format',
        ],
    );
});

test('local sources never invent cloud external objects', () => {
    const localInput = {
        sourceKind: 'local',
        storageUrl: '',
        fileName: 'sales.csv',
        fileType: 'csv',
        dataSource: 'MyDataSource',
        credentialName: '',
        formatName: '',
        authMethod: '',
        platform: 'sql_server_2025',
        selectedStatement: 'openrowset',
    } as const;
    const localServer = sourceReadiness(localInput);
    assert.equal(localServer.directLocalRead, true);
    assert.deepEqual(localServer.objects, []);

    const localAzure = { ...localInput, platform: 'azure_sql_db' as const };
    const guarded = sourceReadiness(localAzure);
    assert.equal(guarded.stagingRequired, true);
    assert.match(guarded.detail, /Stage the file/);
    assert.deepEqual(guarded.objects, []);
});

test('folder profiles report mixed facts and outliers instead of applying one file to all', () => {
    const profile = folderProfileFor([
        csv(),
        csv({ file_name: 'b.csv', file_path: 'b.csv' }),
        csv({
            file_name: 'c.tsv',
            file_path: 'c.tsv',
            delimiter: '\t',
            encoding: 'utf-16le',
        }),
    ]);
    assert.ok(profile);
    assert.equal(profile.delimiter, 'Mixed');
    assert.equal(profile.encoding, 'Mixed');
    assert.equal(profile.outlierCount, 1);
});

test('PolyBase guidance is visible only for a construct that requires it', () => {
    for (const platform of [
        'azure_sql_db',
        'azure_sql_mi',
        'sql_server_2025',
        'fabric_sql_db',
    ] as const) {
        assert.equal(polyBaseGuidance(platform, 'create_external_table').visible, false);
    }
    for (const platform of ['sql_server_2019', 'sql_server_2022'] as const) {
        assert.equal(polyBaseGuidance(platform, 'openrowset').visible, false);
        assert.equal(polyBaseGuidance(platform, 'bulk_insert').visible, false);
        const guidance = polyBaseGuidance(platform, 'create_external_table');
        assert.equal(guidance.visible, true);
        assert.deepEqual(
            guidance.documentation.map((link) => link.id),
            ['polybase_install', 'server_configuration'],
        );
        assert.match(guidance.detail ?? '', /SQL Server Setup/);
        assert.match(guidance.detail ?? '', /sp_configure does not install/i);
    }
    assert.deepEqual(
        polyBaseGuidance('sql_server_2022', 'openrowset').documentation,
        [],
    );
    assert.deepEqual(
        polyBaseGuidance('sql_server_2025', 'create_external_table').documentation,
        [],
    );
});

test('generator defaults are byte-identical while optional overrides reach production SQL', () => {
    const service = new NativeAnalysisService();
    const metadata = csv();
    const before = service.generateStatements({ metadata, targetPlatform: 'sql_server_2025' });
    const empty = service.generateStatements({
        metadata,
        targetPlatform: 'sql_server_2025',
        parserOverrides: {},
    });
    assert.deepEqual(empty, before);

    const changed = service.generateStatements({
        metadata,
        targetPlatform: 'sql_server_2025',
        parserOverrides: {
            firstRow: 3,
            fieldDelimiter: '|',
            rowTerminator: '0x0d0a',
            quoteCharacter: "'",
            codepage: '1252',
        },
    });
    assert.match(changed.bulk_insert, /FIRSTROW\s+= 3/);
    assert.match(changed.bulk_insert, /FIELDTERMINATOR\s+= '\|'/);
    assert.match(changed.bulk_insert, /ROWTERMINATOR\s+= '0x0d0a'/);
    assert.match(changed.bulk_insert, /FIELDQUOTE\s+= ''''/);
    assert.match(changed.bulk_insert, /CODEPAGE\s+= '1252'/);
    assert.match(changed.bulk_insert, /-- UTF-8/, 'encoding remains the analyzed fact');
});
