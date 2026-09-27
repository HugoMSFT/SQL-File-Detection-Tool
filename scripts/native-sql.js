#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { sha256, containedPath, redact } = require('./tooling-support');
const { writeFixtures, fixtureRows } = require('./regression-fixtures');

const REPO = path.resolve(__dirname, '..');
const ENGINES = Object.freeze({
    '2022': 'mcr.microsoft.com/mssql/server:2022-latest',
    '2025': 'mcr.microsoft.com/mssql/server:2025-latest',
});

function validateIdentity(engine, runId) {
    assert.ok(Object.hasOwn(ENGINES, engine), 'Only official SQL Server 2022/2025 Developer containers are supported');
    assert.ok(typeof runId === 'string' && runId.length === 8, 'Run ID must be exactly eight lowercase hexadecimal characters');
    assert.match(runId, /^[0-9a-f]{8}$/, 'Run ID must be exactly eight lowercase hexadecimal characters');
    return { schema: `sqlfdt_cert_${runId}`, prefix: `sqlfdt_cert_${runId}_`, database: `sqlfdt_cert_${runId}` };
}

function treeFingerprint(directory, suffix) {
    const files = {};
    function visit(relative) {
        for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
            const name = path.posix.join(relative, entry.name);
            assert.ok(!entry.isSymbolicLink(), 'Generator trees must not contain symlinks');
            if (entry.isDirectory()) { visit(name); }
            else if (entry.isFile() && name.endsWith(suffix)) {
                files[name] = sha256(fs.readFileSync(path.join(directory, name)));
            }
        }
    }
    visit('');
    assert.ok(Object.keys(files).length > 0, 'Missing compiled native core; run npm run compile');
    return { sha256: sha256(JSON.stringify(Object.entries(files).sort())), files };
}

async function createPlan(output, { engine = '2022', runId = crypto.randomBytes(4).toString('hex') } = {}) {
    const identity = validateIdentity(engine, runId);
    const compiled = path.join(REPO, 'out/native');
    const sources = path.join(REPO, 'src/native');
    const sourceTree = treeFingerprint(sources, '.ts');
    const compiledTree = treeFingerprint(compiled, '.js');
    for (const name of Object.keys(sourceTree.files)) {
        const js = path.join(compiled, name.replace(/\.ts$/, '.js'));
        assert.ok(fs.existsSync(js) && fs.statSync(js).mtimeMs >= fs.statSync(path.join(sources, name)).mtimeMs,
            'Compiled native core is stale; run npm run compile');
    }
    const { NativeAnalysisService } = require('../out/native/service');
    fs.mkdirSync(output, { recursive: true });
    assert.ok(!fs.existsSync(path.join(output, 'plan.json')), 'Refusing to overwrite an existing certification plan');
    const fixturesDirectory = containedPath(output, 'fixtures');
    const fixtureFiles = writeFixtures(fixturesDirectory);
    const service = new NativeAnalysisService(fixturesDirectory);
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    assert.match(sourceSha, /^[0-9a-f]{40}$/);
    const plan = {
        schemaVersion: 1, generator: 'native-typescript', entryPoint: 'out/native/service.js',
        sourceSha, extensionVersion: require('../package.json').version,
        sourceTree, compiledTree, engine, image: ENGINES[engine], runId, ...identity,
        fixtureRows: 100, verificationLimit: 100,
        prerequisites: [
            'Native Linux x86_64 host and local x86_64 Docker daemon (no emulation)',
            'Official SQL Server Developer image; exact image digest and server version recorded at execution',
            'One new network-isolated container; no published port, user database, external storage or cloud subscription',
            'The exact hash-verified fixture bytes are bind-mounted read-only for the SQL service account',
            'No credentials in arguments, plans or evidence; random password supplied only through environment',
        ],
        executionTransforms: [
            'Server-local file_path mapping is applied to native metadata BEFORE generation and recorded per fixture',
            'GO batch splitting and an explicitly recorded SET NOCOUNT ON session preamble only',
            'No CODEPAGE removal, LASTROW insertion, SQL rewriting or external fixture substitution',
        ],
        fixtures: [], cells: [],
        unavailableEngines: ['Azure SQL Database', 'Azure SQL Managed Instance', 'Fabric SQL Database'],
        liveExecuted: false,
    };
    fs.mkdirSync(containedPath(output, 'sql'));
    const addCell = (fixture, kind, sql, extra = {}) => {
        const id = `${fixture.id}-${extra.source || 'local'}-${kind}`;
        const relative = `sql/${id}.sql`;
        fs.writeFileSync(containedPath(output, relative), sql);
        const cell = {
            id, fixtureId: fixture.id, kind,
            phase: ['create_table', 'external_file_format', 'create_external_table'].includes(kind) ? 'DDL' : 'READ',
            availability: 'ready', prerequisites: [],
            sqlFile: relative, sqlSha256: sha256(sql), substitutions: [],
            ...extra,
        };
        plan.cells.push(cell);
        return cell;
    };
    for (const [name, bytes] of Object.entries(fixtureFiles)) {
        const raw = await service.analyze({ filePath: path.join(fixturesDirectory, name) });
        assert.equal(raw.native_support, 'supported');
        assert.equal(raw.row_count, 100, 'Native metadata must describe all 100 exact fixture rows');
        assert.equal(raw.column_count, 3);
        assert.equal(raw.error, undefined);
        const serverPath = `/var/opt/mssql/sqlfdt/${runId}/${name}`;
        const metadata = { ...raw, file_path: serverPath };
        const id = name.replace(/[^a-z0-9]/g, '_');
        const table = `${identity.prefix}${id}`;
        const fixture = {
            id, file: `fixtures/${name}`, sha256: sha256(bytes), bytes: bytes.length,
            rows: 100, nativeSupport: raw.native_support, metadata,
            pathMapping: { analyzed: `fixtures/${name}`, generated: serverPath },
            expected: fixtureRows(),
        };
        plan.fixtures.push(fixture);
        const statements = service.generateStatements({
            metadata, schemaName: identity.schema, tableName: table,
            dataSource: `${identity.prefix}source`, formatName: `${identity.prefix}format`,
            targetPlatform: `sql_server_${engine}`,
        });
        const ddl = addCell(fixture, 'create_table', statements.create_table);
        if (name.endsWith('.csv')) {
            addCell(fixture, 'bulk_insert', statements.bulk_insert, {
                prerequisites: [ddl.id],
                knownIssue: 'Linux may reject the emitted CODEPAGE (16202). A live error remains FAIL; never rewrite it to RAW or remove it.',
                rowCountSql: `SELECT COUNT_BIG(*) FROM [${identity.schema}].[${table}];`,
                verificationSql: `SELECT TOP (100) [id], [label], [amount] FROM [${identity.schema}].[${table}] ORDER BY [id];`,
            });
        }
        addCell(fixture, 'openrowset', statements.openrowset, {
            outputContract: name.endsWith('.csv') ? 'typed-rows-and-exact-whole-csv' : 'typed-rows',
            knownIssue: name.endsWith('.csv')
                ? 'The full native CSV document is executed, including its whole-file alternative. Linux syntax/CODEPAGE errors remain FAIL.'
                : null,
        });
        if (name === 'sample.csv') {
            for (const [source, storageUrl] of [
                ['azure', 'abs://samples@sqlfdtdemo.blob.core.windows.net/sample.csv'],
                ['s3', 's3://sqlfdt-fixtures.invalid:443/samples/sample.csv'],
            ]) {
                const external = service.generateStatements({
                    metadata, schemaName: identity.schema, tableName: `${table}_${source}`,
                    dataSource: `${identity.prefix}${source}`, formatName: `${identity.prefix}${source}_format`,
                    credentialName: `${identity.prefix}${source}_credential`, authMethod: 'public',
                    storageUrl, targetPlatform: `sql_server_${engine}`,
                });
                for (const kind of ['external_file_format', 'create_external_table', 'openrowset']) {
                    addCell(fixture, kind, external[kind], {
                        source, availability: 'unavailable',
                        reason: source === 'azure'
                            ? 'No Azure service is provisioned. Azurite HTTP endpoints cannot satisfy the shipped HTTPS Azure host boundary, and this container has no network.'
                            : 'No owned TLS S3-compatible endpoint is provisioned, and this container has no network. Native object-storage capability is not live-certified; no public dataset is substituted.',
                    });
                }
            }
        }
        if (name === 'sample.json') {
            addCell(fixture, 'external_file_format', statements.external_file_format, {
                availability: 'native-unavailable',
                reason: 'Native generator emits guidance instead of a JSON external file format on this SQL platform.',
            });
        }
    }
    const serialized = JSON.stringify(plan, null, 2) + '\n';
    fs.writeFileSync(containedPath(output, 'plan.json'), serialized);
    return { plan, sha256: sha256(serialized) };
}

if (require.main === module) {
    const { values } = parseArgs({ options: {
        output: { type: 'string' }, engine: { type: 'string', default: '2022' }, 'run-id': { type: 'string' },
    } });
    const runId = values['run-id'] || crypto.randomBytes(4).toString('hex');
    createPlan(path.resolve(values.output || `.artifacts/native-sql-${runId}`), { engine: values.engine, runId })
        .then(({ plan, sha256: hash }) => console.log(JSON.stringify({
            plan: values.output || `.artifacts/native-sql-${runId}`, planSha256: hash,
            generator: plan.generator, cells: plan.cells.length, liveExecuted: false,
        })))
        .catch((error) => { console.error(redact(error.message)); process.exitCode = 1; });
}

module.exports = { createPlan, treeFingerprint, validateIdentity, ENGINES };
