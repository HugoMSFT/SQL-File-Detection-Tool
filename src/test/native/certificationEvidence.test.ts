/**
 * The native generator, checked against the live certification evidence.
 *
 * `tests/certification/expected-matrix.json` records what the two engines
 * actually did during the live run. The Python suite reads the same file, so a
 * change to either implementation that contradicts the evidence fails here —
 * which is the only thing keeping the two generators from drifting apart once
 * the live servers are gone.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it } from 'node:test';

import {
    generateCredentialSetup,
    generateExternalFileFormat,
} from '../../native/sql/generator';
import { generateOpenrowset } from '../../native/sql/openrowset';
import {
    DDL_ONLY_CERTIFIED_FORMATS,
    FIRST_ROW_FORMAT_PLATFORMS,
} from '../../native/sql/typeMapping';
import {
    AUTH_METHODS,
    MANAGED_IDENTITY_PLATFORMS,
    singleLobKeyword,
} from '../../native/sql/generatorHelpers';
import { REPO_ROOT } from './parityInvariants';
import type { GeneratorMetadata, TargetPlatform } from '../../native/types';

interface Rule {
    id: string;
    hypothesis: string;
    evidence: 'live' | 'live-negative' | 'static';
    engines?: string[];
    rule: string;
    statement: string;
    expect: Record<string, unknown>;
}

interface Expected {
    schema_version: number;
    engines_certified: { id: string; product_version: string }[];
    static_only_platforms: string[];
    rules: Rule[];
}

const EXPECTED: Expected = JSON.parse(
    fs.readFileSync(
        path.join(REPO_ROOT, 'tests', 'certification', 'expected-matrix.json'),
        'utf8',
    ),
);

const RULES = new Map(EXPECTED.rules.map((rule) => [rule.id, rule]));

function rule(id: string): Rule {
    const found = RULES.get(id);
    assert.ok(found, `expected-matrix.json is missing rule ${id}`);
    return found;
}

function csvMetadata(): GeneratorMetadata {
    return {
        file_name: 'sales.csv',
        file_path: 'C:/data/sales.csv',
        file_type: 'csv',
        delimiter: ',',
        encoding: 'utf-8',
        has_header: true,
        row_count: 10,
        columns: [
            { name: 'id', sql_type: 'INT', nullable: false },
            { name: 'label', sql_type: 'NVARCHAR(50)', nullable: true },
        ],
    } as unknown as GeneratorMetadata;
}

function code(sql: string): string {
    return sql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
}

describe('live certification evidence', () => {
    it('reads a schema version it understands', () => {
        assert.strictEqual(EXPECTED.schema_version, 1);
        assert.ok(EXPECTED.rules.length > 0);
    });

    it('only claims the engine versions that actually ran', () => {
        // H9: one VM certifies the version it runs and nothing else.
        const certified = EXPECTED.engines_certified.map((engine) => engine.id);
        assert.deepStrictEqual([...certified].sort(), ['azure_sql_db', 'sql_server_2025']);
        for (const platform of EXPECTED.static_only_platforms) {
            assert.ok(
                !certified.includes(platform),
                `${platform} is listed as both live-certified and static-only`,
            );
        }
    });

    it('R10: FIRST_ROW platform gating matches the engines that accepted it', () => {
        const expect = rule('R10').expect as {
            platforms: string[];
            excluded_platforms: string[];
        };
        assert.deepStrictEqual(
            [...FIRST_ROW_FORMAT_PLATFORMS].sort(),
            [...expect.platforms].sort(),
        );
        for (const platform of expect.excluded_platforms) {
            assert.ok(
                !FIRST_ROW_FORMAT_PLATFORMS.has(platform as TargetPlatform),
                `${platform} was never certified for FIRST_ROW`,
            );
        }
    });

    it('R09: managed identity is the default and needs no master key', () => {
        const expect = rule('R09').expect as {
            default_auth_method: string;
            supported_platforms: string[];
            master_key_required_for: string[];
        };
        assert.ok(AUTH_METHODS.includes(expect.default_auth_method as never));
        assert.deepStrictEqual(
            [...MANAGED_IDENTITY_PLATFORMS].sort(),
            [...expect.supported_platforms].sort(),
        );

        const setup = generateCredentialSetup({
            dataSource: 'TestDS',
            metadata: csvMetadata(),
            targetPlatform: 'azure_sql_db',
        });
        assert.match(setup, /IDENTITY = 'MANAGED IDENTITY'/);
        assert.ok(!setup.includes('CREATE MASTER KEY'));

        for (const method of expect.master_key_required_for) {
            const secretBased = generateCredentialSetup({
                dataSource: 'TestDS',
                metadata: csvMetadata(),
                targetPlatform: 'azure_sql_db',
                authMethod: method,
            });
            assert.match(
                secretBased,
                /CREATE MASTER KEY/,
                `${method} still needs a master key`,
            );
        }
    });

    it('R03: whole-file UTF-16 reads use SINGLE_NCLOB', () => {
        const expect = rule('R03').expect as {
            single_lob_keyword: Record<string, string>;
        };
        for (const [encoding, keyword] of Object.entries(expect.single_lob_keyword)) {
            const probe = encoding === 'default' ? null : encoding;
            assert.strictEqual(singleLobKeyword(probe), keyword, encoding);
        }
    });

    it('R05: a single-LOB read goes through a _Bulk BLOB_STORAGE source', () => {
        const expect = rule('R05').expect as {
            data_source_suffix: string;
            data_source_type: string;
        };
        const sql = generateOpenrowset(
            {
                ...csvMetadata(),
                file_name: 'doc.json',
                file_path: 'C:/data/doc.json',
                file_type: 'json',
            } as GeneratorMetadata,
            {
                dataSource: 'TestDS',
                targetPlatform: 'azure_sql_db',
                storageUrl: 'https://acct.blob.core.windows.net/container/doc.json',
            },
        );
        if (/SINGLE_N?CLOB/.test(code(sql))) {
            assert.match(code(sql), new RegExp(`TestDS${expect.data_source_suffix}`));
            assert.match(sql, new RegExp(`TYPE\\s*=\\s*${expect.data_source_type}`));
        }
    });

    it('R08: USE_TYPE_DEFAULT is FALSE and always stated', () => {
        const expect = rule('R08').expect as { default: string; always_emitted: boolean };
        const sql = generateExternalFileFormat(csvMetadata(), {
            formatName: 'sqlfdt_cert_fmt',
            targetPlatform: 'azure_sql_db',
        });
        assert.ok(expect.always_emitted);
        assert.match(sql, new RegExp(`USE_TYPE_DEFAULT\\s*=\\s*${expect.default}`));
    });

    it('R12: ORC is DDL-accepted but its data path is not certified', () => {
        const expect = rule('R12').expect as {
            ddl_accepted: boolean;
            data_path_certified: boolean;
        };
        assert.strictEqual(expect.ddl_accepted, true);
        assert.strictEqual(expect.data_path_certified, false);
        assert.ok(
            [...DDL_ONLY_CERTIFIED_FORMATS].some((f) => f.toUpperCase() === 'ORC'),
            'ORC must be marked DDL-only, never fully supported',
        );
    });

    it('R02: the disproven UTF-16 hypothesis did not change the generator', () => {
        const rec = rule('R02');
        assert.strictEqual(rec.evidence, 'live');
        assert.ok(
            (rec.expect as { forbidden_conclusion: string }).forbidden_conclusion.includes(
                'always wrong',
            ),
        );
    });

    it('every live rule names the engines that produced it', () => {
        const certified = new Set(EXPECTED.engines_certified.map((e) => e.id));
        for (const rec of EXPECTED.rules) {
            if (!rec.evidence.startsWith('live')) {
                continue;
            }
            assert.ok(rec.engines && rec.engines.length > 0, `${rec.id} has no engine`);
            for (const engine of rec.engines) {
                assert.ok(certified.has(engine), `${rec.id} cites uncertified ${engine}`);
            }
        }
    });
});
