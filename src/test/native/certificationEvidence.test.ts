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
    generateBulkInsert,
    generateCompleteDdl,
    generateCredentialSetup,
    generateExternalFileFormat,
    generateExternalTable,
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
        // Unconditional: a guarded assertion would pass silently if the
        // generator regressed to row framing for a whole document.
        assert.match(code(sql), /SINGLE_N?CLOB/);
        assert.match(code(sql), new RegExp(`TestDS${expect.data_source_suffix}`));
        assert.match(sql, new RegExp(`TYPE\\s*=\\s*${expect.data_source_type}`));
    });

    it('R05: NDJSON is row framed and never read as one document', () => {
        const sql = generateOpenrowset(
            {
                ...csvMetadata(),
                file_name: 'lines.jsonl',
                file_path: 'C:/data/lines.jsonl',
                file_type: 'json',
                json_format: 'ndjson',
            } as GeneratorMetadata,
            {
                dataSource: 'TestDS',
                targetPlatform: 'azure_sql_db',
                storageUrl: 'https://acct.blob.core.windows.net/container/lines.jsonl',
            },
        );
        assert.match(code(sql), /ROWTERMINATOR/);
        assert.doesNotMatch(
            code(sql),
            /SINGLE_N?CLOB/,
            'concatenated NDJSON is not one JSON document',
        );
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
        const expect = rule('R12').expect as { guidance_must_not_say: string };
        assert.ok(
            [...DDL_ONLY_CERTIFIED_FORMATS].some((f) => f.toUpperCase() === 'ORC'),
            'ORC must be marked DDL-only, never fully supported',
        );
        const sql = generateExternalFileFormat(
            { ...csvMetadata(), file_type: 'orc', file_name: 'part.orc' } as GeneratorMetadata,
            { formatName: 'sqlfdt_cert_fmt', targetPlatform: 'azure_sql_db' },
        );
        assert.match(sql, /FORMAT_TYPE\s*=\s*ORC/);
        assert.ok(
            !sql.toLowerCase().includes(expect.guidance_must_not_say),
            'ORC guidance must not claim the data path is fully supported',
        );
    });

    it('R07: Excel and Iceberg get guidance from both DDL entry points', () => {
        const expect = rule('R07').expect as {
            file_types: string[];
            generated_code_excludes: string[];
        };
        for (const fileType of expect.file_types) {
            const metadata = {
                ...csvMetadata(),
                file_type: fileType,
                file_name: `book.${fileType}`,
                file_path: `C:/data/book.${fileType}`,
            } as GeneratorMetadata;
            const outputs = {
                format: generateExternalFileFormat(metadata, {
                    formatName: 'sqlfdt_cert_fmt',
                    targetPlatform: 'azure_sql_db',
                }),
                table: generateExternalTable(metadata, {
                    tableName: 'sqlfdt_cert_t',
                    targetPlatform: 'azure_sql_db',
                }),
            };
            for (const [where, sql] of Object.entries(outputs)) {
                for (const banned of expect.generated_code_excludes) {
                    assert.ok(!sql.includes(banned), `${fileType}/${where}: ${banned}`);
                }
                // An empty format type must never reach the platform lookup and
                // produce "CREATE EXTERNAL ... ()" with a generic message.
                assert.doesNotMatch(sql, /EXTERNAL (FILE FORMAT|TABLE) \(\)/, `${fileType}/${where}`);
                assert.match(sql, /not available|not supported|unsupported/i);
            }
        }
    });

    it('R02: the disproven UTF-16 hypothesis did not change the generator', () => {
        const expect = rule('R02').expect as { generated_code_matches: string };
        const sql = generateBulkInsert(
            {
                ...csvMetadata(),
                encoding: 'utf-16-le',
                codepage: '1200',
                file_name: 'wide.csv',
                file_path: 'C:/data/wide.csv',
            } as GeneratorMetadata,
            { tableName: 'sqlfdt_cert_t', targetPlatform: 'sql_server_2025' },
        );
        // The static hypothesis said CODEPAGE 1200 always fails; live evidence
        // disproved it, so one of the two certified forms must still be emitted.
        assert.match(code(sql), new RegExp(expect.generated_code_matches));
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

    it('R17: a script with placeholders left in it says so', () => {
        // A local path cannot be read from Azure. The script therefore has to
        // carry placeholders, and it has to admit that, or someone pastes a
        // half-runnable script and finds out after the first object exists.
        const expect = rule('R17').expect as {
            placeholder_pattern: string;
            forbidden_when_placeholders_present: string[];
        };
        const script = generateCompleteDdl(csvMetadata(), {
            targetPlatform: 'azure_sql_db' as TargetPlatform,
        });
        const found = script.match(new RegExp(expect.placeholder_pattern, 'g'));
        assert.ok(found && found.length > 0, 'expected staging placeholders');
        assert.match(script, /STAGE THE DATA IN AZURE STORAGE FIRST/);
        assert.match(script, /Replace the placeholders/);
        const lowered = script.toLowerCase();
        for (const phrase of expect.forbidden_when_placeholders_present) {
            assert.ok(!lowered.includes(phrase), phrase);
        }
    });

    it('R17: a script pointed at real storage has nothing left to fill in', () => {
        const script = generateCompleteDdl(csvMetadata(), {
            targetPlatform: 'azure_sql_db' as TargetPlatform,
            storageUrl: 'https://acct.blob.core.windows.net/raw/sales.csv',
        });
        assert.ok(!script.includes('STAGE THE DATA IN AZURE STORAGE FIRST'));
        assert.ok(!script.includes('<storage_account>'));
        assert.ok(!script.includes('<container>'));
    });

    it('R14: blob paths keep the case they were given', () => {
        // Live negative: yellow/ -> Yellow/ returns 13807 on both engines,
        // so lower-casing a path in the generator would produce a script that
        // cannot list its own directory.
        const expected = rule('R14').expect as {
            paths_are_case_sensitive: boolean;
            error_number: number;
        };
        assert.strictEqual(expected.paths_are_case_sensitive, true);
        assert.strictEqual(expected.error_number, 13807);
        const script = generateCompleteDdl(csvMetadata(), {
            targetPlatform: 'azure_sql_db' as TargetPlatform,
            storageUrl:
                'https://acct.blob.core.windows.net/Raw/Yellow/Sales.csv',
        });
        assert.ok(script.includes('Yellow/Sales.csv'));
        assert.ok(!script.includes('yellow/sales.csv'));
    });
});
