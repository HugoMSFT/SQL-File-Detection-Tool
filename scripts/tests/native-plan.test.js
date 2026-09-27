'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createPlan, validateIdentity } = require('../native-sql');
const { temporaryRoot, sha256 } = require('../tooling-support');
const { fixtureBytes } = require('../regression-fixtures');

test('native plans reject unsupported engines and unowned run identifiers', () => {
    for (const [engine, runId] of [['2019', '1234abcd'], ['2022', 'dbo'], ['2025', "1234abcd'];DROP DATABASE x;--"]]) {
        assert.throws(() => validateIdentity(engine, runId));
    }
});

for (const engine of ['2022', '2025']) {
    test(`${engine}: exact compiled native metadata and SQL, not the legacy generator`, async () => {
        const owned = temporaryRoot('sqlfdt-native-plan-test-');
        const directory = path.join(owned.root, 'plan');
        try {
            const { plan, sha256: hash } = await createPlan(directory, { engine, runId: '1234abcd' });
            assert.equal(hash, sha256(fs.readFileSync(path.join(directory, 'plan.json'))));
            assert.equal(plan.generator, 'native-typescript');
            assert.equal(plan.entryPoint, 'out/native/service.js');
            assert.ok(plan.compiledTree.files['sql/generator.js']);
            assert.equal(plan.liveExecuted, false);
            assert.equal(plan.fixtureRows, 100);
            assert.equal(plan.verificationLimit, 100);
            assert.equal(plan.cells.filter((cell) => cell.availability === 'ready').length, 7);
            assert.equal(plan.cells.filter((cell) => cell.availability === 'unavailable').length, 6);
            assert.equal(plan.cells.filter((cell) => cell.availability === 'native-unavailable').length, 1);
            for (const fixture of plan.fixtures) {
                assert.equal(fixture.rows, 100);
                assert.equal(fixture.metadata.row_count, 100);
                assert.equal(fixture.nativeSupport, 'supported');
                assert.equal(fixture.sha256, sha256(fixtureBytes()[path.basename(fixture.file)]));
                assert.equal(fixture.metadata.file_path, fixture.pathMapping.generated);
                assert.equal(fixture.pathMapping.analyzed, fixture.file);
            }
            for (const cell of plan.cells) {
                const sql = fs.readFileSync(path.join(directory, cell.sqlFile), 'utf8');
                assert.equal(sha256(sql), cell.sqlSha256);
                assert.deepEqual(cell.substitutions, []);
                if (cell.kind === 'bulk_insert') {
                    assert.match(sql, /CODEPAGE\s*=\s*'65001'/);
                    assert.doesNotMatch(sql, /\bLASTROW\s*=/);
                    assert.match(cell.rowCountSql, /COUNT_BIG\(\*\)/);
                    assert.match(cell.verificationSql, /TOP \(100\)/);
                    assert.match(sql, /sqlfdt_cert_1234abcd/);
                }
                if (cell.id === 'sample_utf16_json-local-openrowset') {
                    assert.match(sql, /SINGLE_NCLOB/);
                }
            }
            await assert.rejects(createPlan(directory, { engine, runId: '1234abcd' }), /overwrite/);
        } finally { owned.cleanup(); }
    });
}
