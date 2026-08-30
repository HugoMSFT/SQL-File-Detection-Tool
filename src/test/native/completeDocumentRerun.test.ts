/**
 * The complete document is the one artifact users run as-is, so its default
 * behaviour has to be safe against a database it knows nothing about.
 *
 * Two real defects are pinned here.
 *
 * The document used to open with an unconditional
 * `IF OBJECT_ID(...) IS NOT NULL TRUNCATE TABLE [dbo].[<file name>]`, so
 * analysing a file called `orders.csv` and running the result against a
 * warehouse emptied `dbo.orders`. Ownership is now opt-in: the truncate is
 * live only when the caller asks for it *and* the target is not the default
 * schema, which is the only situation where the script can know it created the
 * table it is about to empty.
 *
 * The batch scanner used to treat an apostrophe inside a bracketed identifier
 * as the start of a string literal. A source column called `Employee's ID`
 * therefore inverted quote parity for the rest of the guard, swallowed the
 * terminating semicolon, and dragged the following `GO` inside the
 * `IF ... BEGIN ... END` block - where sqlcmd still honours it as a batch
 * separator, leaving the first batch with an unterminated BEGIN.
 *
 * These mirror `tests/test_complete_document_rerun.py`; the parity suite proves
 * the two implementations still agree byte for byte.
 */

import * as assert from 'assert';
import { describe, it } from 'node:test';

import {
    DEFAULT_SCHEMA_NAME,
    generateCompleteDdl,
    ownsLoadTarget,
} from '../../native/sql/generator';
import type { GeneratorMetadata } from '../../native/types';

function ordersCsv(overrides: Partial<GeneratorMetadata> = {}): GeneratorMetadata {
    return {
        file_path: 'C:/warehouse/orders.csv',
        file_name: 'orders.csv',
        file_type: 'csv',
        file_size: 4096,
        encoding: 'utf-8',
        delimiter: ',',
        has_header: true,
        row_count: 100,
        column_count: 3,
        nullable_columns: [],
        schema: [
            ['o_orderkey', 'int64'],
            ['o_custkey', 'int64'],
            ['o_totalprice', 'float64'],
        ],
        ...overrides,
    };
}

/** Non-comment lines only: a commented TRUNCATE is guidance, not an action. */
function liveLines(document: string, needle: string): string[] {
    return document
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith('--'))
        .filter((line) => line.includes(needle));
}

describe('the default complete document is not destructive', () => {
    const document = () => generateCompleteDdl(ordersCsv(), {});

    it('never emits a live TRUNCATE', () => {
        assert.deepStrictEqual(liveLines(document(), 'TRUNCATE TABLE'), []);
    });

    it('never names dbo.orders in a live statement that removes rows', () => {
        assert.deepStrictEqual(liveLines(document(), 'DELETE FROM'), []);
        assert.deepStrictEqual(liveLines(document(), 'DROP TABLE'), []);
    });

    it('still offers the truncate as commented guidance', () => {
        const text = document();
        assert.ok(text.includes("-- IF OBJECT_ID(N'[dbo].[orders]', N'U') IS NOT NULL"));
        assert.ok(text.includes('--     TRUNCATE TABLE [dbo].[orders];'));
        assert.ok(text.includes('RERUN SAFETY'));
    });

    it('still creates the table it needs', () => {
        assert.ok(document().includes('CREATE TABLE [dbo].[orders]'));
    });
});

describe('the truncate is opt-in and refuses the default schema', () => {
    it('stays commented for the default schema even when asked for', () => {
        const document = generateCompleteDdl(ordersCsv(), { rerunTruncate: true });
        assert.deepStrictEqual(liveLines(document, 'TRUNCATE TABLE'), []);
    });

    it('goes live for a caller-owned schema', () => {
        const document = generateCompleteDdl(ordersCsv(), {
            rerunTruncate: true,
            schemaName: 'cert_run',
            tableName: 'cert_orders',
        });
        assert.deepStrictEqual(
            liveLines(document, 'TRUNCATE TABLE'),
            ['    TRUNCATE TABLE [cert_run].[cert_orders];'],
        );
    });

    it('decides ownership before anything is emptied', () => {
        assert.strictEqual(ownsLoadTarget('cert_orders', 'cert_run'), true);
        assert.strictEqual(ownsLoadTarget('orders', DEFAULT_SCHEMA_NAME), false);
        assert.strictEqual(ownsLoadTarget('orders', ''), false);
        assert.strictEqual(ownsLoadTarget('', 'cert_run'), false);
    });
});

describe('an apostrophe in a column name cannot break the batches', () => {
    const awkward = () => ordersCsv({
        schema: [
            ["Employee's ID", 'int64'],
            ['Amount', 'float64'],
        ],
        column_count: 2,
    });

    it('keeps BEGIN and END balanced', () => {
        // Standalone lines only: the document's prose says "END" in places, and
        // a word in a comment is not a block.
        const document = generateCompleteDdl(awkward(), {});
        const begins = (document.match(/^[ \t]*BEGIN[ \t]*$/gm) ?? []).length;
        const ends = (document.match(/^[ \t]*END[ \t]*$/gm) ?? []).length;
        assert.ok(begins > 0, 'the document has no guard blocks at all');
        assert.strictEqual(begins, ends, document);
    });

    it('never indents a GO into a guard block', () => {
        const document = generateCompleteDdl(awkward(), {});
        assert.ok(document.includes("[Employee's ID]"));
        const indented = document
            .split(/\r?\n/)
            .filter((line) => /^\s+GO\s*$/.test(line));
        assert.deepStrictEqual(indented, []);
    });
});
