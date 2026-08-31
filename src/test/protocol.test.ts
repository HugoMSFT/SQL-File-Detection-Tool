/**
 * Tests for the webview -> host trust boundary.
 *
 * The renderer is untrusted. `parseWebviewRequest` is the single choke point
 * that decides what the extension host will act on, so it is fuzzed as well as
 * unit tested: anything it lets through becomes a capability.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    APPEARANCE_MODES,
    AZURE_AUTH_MODES,
    MAX_PREVIEW_ROWS,
    MAX_TEXT_LENGTH,
    MIN_PREVIEW_ROWS,
    STATEMENT_KINDS,
    UI_TABS,
    isStatementKind,
    parseWebviewRequest,
} from '../protocol';
import { DOCUMENTATION_IDS } from '../documentation';
import { EXTERNAL_DATA_SOURCE_TYPES, GUIDED_AUTH_METHODS } from '../native';

test('a well formed message is accepted and normalised', () => {
    const parsed = parseWebviewRequest({ type: 'setTab', tab: 'preview' });
    assert.deepEqual(parsed, { type: 'setTab', tab: 'preview' });
});

test('unknown message types are dropped', () => {
    for (const type of [
        'eval',
        'exec',
        'spawn',
        'setupBackend',
        'readFile',
        'toString',
        'constructor',
        'hasOwnProperty',
        '',
    ]) {
        assert.equal(parseWebviewRequest({ type }), undefined, type);
    }
});

test('non-object payloads are dropped', () => {
    for (const raw of [null, undefined, 0, 1, 'ready', true, [], [{ type: 'ready' }], () => 0]) {
        assert.equal(parseWebviewRequest(raw as unknown), undefined);
    }
});

test('prototype polluting keys are rejected outright', () => {
    const polluted = JSON.parse('{"type":"ready","__proto__":{"polluted":true}}');
    assert.equal(parseWebviewRequest(polluted), undefined);
    assert.equal(parseWebviewRequest({ type: 'ready', constructor: 1 }), undefined);
    assert.equal(parseWebviewRequest({ type: 'ready', prototype: 1 }), undefined);
    assert.equal(
        ({} as Record<string, unknown>).polluted,
        undefined,
        'nothing may leak onto Object.prototype',
    );
});

test('extra properties never survive into the parsed request', () => {
    const parsed = parseWebviewRequest({
        type: 'selectFile',
        fileId: 'abc123',
        filePath: 'C:/Windows/System32/config/SAM',
        allowedRoot: 'C:/',
    });
    assert.deepEqual(parsed, { type: 'selectFile', fileId: 'abc123' });
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed, 'filePath'));
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed, 'allowedRoot'));
});

test('the contract has no way to send a path or a root', () => {
    // Every field the renderer can populate, gathered from the builder table by
    // probing it with a value that would be a path if one were accepted.
    const attempts = [
        { type: 'selectFile', fileId: 'C:\\Windows\\win.ini' },
        { type: 'azureAnalyzeBlob', container: 'data', blob: '../../etc/passwd' },
        { type: 'azureListBlobs', container: 'data', prefix: '../..', continuation: '' },
    ];
    // A traversal-shaped id simply does not resolve to a registered file, and
    // the blob helpers reject the traversal at the Azure layer; what matters
    // here is that no request type carries a filesystem root at all.
    for (const attempt of attempts) {
        const parsed = parseWebviewRequest(attempt) as Record<string, unknown> | undefined;
        if (parsed) {
            assert.ok(!('allowedRoot' in parsed));
            assert.ok(!('root' in parsed));
            assert.ok(!('absolutePath' in parsed));
        }
    }
});

test('control characters are refused in free text', () => {
    for (const value of ['a\u0000b', 'a\u001fb', 'a\u007fb', '\u0008']) {
        assert.equal(
            parseWebviewRequest({ type: 'setTableName', value }),
            undefined,
            JSON.stringify(value),
        );
    }
    // A newline is legitimate in a pasted value and is therefore allowed.
    assert.deepEqual(parseWebviewRequest({ type: 'setTableName', value: 'a\nb' }), {
        type: 'setTableName',
        value: 'a\nb',
    });
});

test('over-long text is refused rather than truncated', () => {
    const long = 'x'.repeat(MAX_TEXT_LENGTH + 1);
    assert.equal(parseWebviewRequest({ type: 'setTableName', value: long }), undefined);
    assert.equal(parseWebviewRequest({ type: 'publicUrlAnalyze', url: long }), undefined);
});

test('enumerated fields accept only their own members', () => {
    for (const tab of UI_TABS) {
        assert.deepEqual(parseWebviewRequest({ type: 'setTab', tab }), { type: 'setTab', tab });
    }
    assert.equal(parseWebviewRequest({ type: 'setTab', tab: 'metadata ' }), undefined);
    for (const mode of AZURE_AUTH_MODES) {
        assert.deepEqual(parseWebviewRequest({ type: 'azureConnect', mode }), {
            type: 'azureConnect',
            mode,
        });
    }
    assert.equal(
        parseWebviewRequest({ type: 'azureConnect', mode: 'managedIdentity' }),
        undefined,
        'managed identity is not a desktop auth mode',
    );
    for (const value of EXTERNAL_DATA_SOURCE_TYPES) {
        assert.deepEqual(parseWebviewRequest({ type: 'setDataSourceType', value }), {
            type: 'setDataSourceType',
            value,
        });
    }
    assert.equal(
        parseWebviewRequest({ type: 'setDataSourceType', value: 'unsupported-source' }),
        undefined,
    );
    for (const value of [...GUIDED_AUTH_METHODS, 'public'] as const) {
        assert.deepEqual(parseWebviewRequest({ type: 'setAuthMethod', value }), {
            type: 'setAuthMethod',
            value,
        });
    }
    assert.equal(
        parseWebviewRequest({ type: 'setAuthMethod', value: 'connection-string' }),
        undefined,
    );
    for (const appearance of APPEARANCE_MODES) {
        assert.ok(parseWebviewRequest({ type: 'setPreference', appearance }));
    }
    for (const kind of STATEMENT_KINDS) {
        assert.deepEqual(parseWebviewRequest({ type: 'copyStatement', kind }), {
            type: 'copyStatement',
            kind,
        });
    }
    assert.equal(parseWebviewRequest({ type: 'copyStatement', kind: 'metadata' }), undefined);
    for (const id of DOCUMENTATION_IDS) {
        assert.deepEqual(parseWebviewRequest({ type: 'openDocumentation', id }), {
            type: 'openDocumentation',
            id,
        });
    }
    assert.equal(
        parseWebviewRequest({
            type: 'openDocumentation',
            id: 'https://example.com/steal',
        }),
        undefined,
    );
});

test('preview row counts are bounded', () => {
    assert.equal(parseWebviewRequest({ type: 'setPreviewRows', rows: 0 }), undefined);
    assert.equal(
        parseWebviewRequest({ type: 'setPreviewRows', rows: MAX_PREVIEW_ROWS + 1 }),
        undefined,
    );
    assert.equal(parseWebviewRequest({ type: 'setPreviewRows', rows: NaN }), undefined);
    assert.equal(parseWebviewRequest({ type: 'setPreviewRows', rows: Infinity }), undefined);
    assert.equal(parseWebviewRequest({ type: 'setPreviewRows', rows: -1 }), undefined);
    assert.equal(parseWebviewRequest({ type: 'setPreviewRows', rows: '25' }), undefined);
    assert.deepEqual(parseWebviewRequest({ type: 'setPreviewRows', rows: 25.9 }), {
        type: 'setPreviewRows',
        rows: 25,
    });
    assert.ok(parseWebviewRequest({ type: 'setPreviewRows', rows: MIN_PREVIEW_ROWS }));
});

test('requestId must look like a correlation id', () => {
    assert.deepEqual(parseWebviewRequest({ type: 'ready', requestId: 'abc-123_X' }), {
        type: 'ready',
        requestId: 'abc-123_X',
    });
    for (const requestId of ['', 'a'.repeat(65), 'has space', 'has/slash', 1, {}]) {
        assert.equal(parseWebviewRequest({ type: 'ready', requestId }), undefined);
    }
});

test('missing required fields are refused, not defaulted', () => {
    assert.equal(parseWebviewRequest({ type: 'selectFile' }), undefined);
    assert.equal(parseWebviewRequest({ type: 'setColumnOverride', column: 'a' }), undefined);
    assert.equal(parseWebviewRequest({ type: 'azureListBlobs', container: 'c' }), undefined);
    assert.equal(parseWebviewRequest({ type: 'publicUrlAnalyze', url: '' }), undefined);
});

test('clearing an override is expressed as an empty type, which is allowed', () => {
    assert.deepEqual(
        parseWebviewRequest({ type: 'setColumnOverride', column: 'id', sqlType: '' }),
        { type: 'setColumnOverride', column: 'id', sqlType: '' },
    );
});

test('parser override messages are allowlisted and bounded', () => {
    assert.deepEqual(
        parseWebviewRequest({
            type: 'setParserOverride',
            key: 'fieldDelimiter',
            value: '|',
        }),
        { type: 'setParserOverride', key: 'fieldDelimiter', value: '|' },
    );
    assert.deepEqual(
        parseWebviewRequest({ type: 'resetParserOverride', key: 'codepage' }),
        { type: 'resetParserOverride', key: 'codepage' },
    );
    assert.equal(
        parseWebviewRequest({ type: 'setStatementKind', kind: 'openrowset' }),
        undefined,
    );
    assert.equal(
        parseWebviewRequest({ type: 'setParserOverride', key: 'encoding', value: 'utf-8' }),
        undefined,
        'file encoding is a fact, not an override',
    );
    assert.equal(
        parseWebviewRequest({ type: 'setParserOverride', key: 'fieldDelimiter', value: 'x'.repeat(129) }),
        undefined,
    );
});

test('fuzzing never throws and never invents a request', () => {
    const types = [
        ...UI_TABS,
        ...STATEMENT_KINDS,
        'ready',
        'selectFile',
        'azureConnect',
        'setPreviewRows',
        'publicUrlAnalyze',
        '__proto__',
        'toString',
    ];
    const values: unknown[] = [
        undefined,
        null,
        0,
        -1,
        Number.POSITIVE_INFINITY,
        NaN,
        '',
        'x',
        'x'.repeat(5000),
        '\u0000',
        true,
        [],
        {},
        { toString: () => 'x' },
        Symbol.iterator.toString(),
    ];
    let seed = 12345;
    const next = (bound: number): number => {
        // A deterministic LCG keeps a failure reproducible.
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % bound;
    };
    for (let index = 0; index < 5000; index += 1) {
        const message: Record<string, unknown> = { type: types[next(types.length)] };
        const fields = ['fileId', 'tab', 'kind', 'rows', 'url', 'value', 'mode', 'column',
            'sqlType', 'container', 'blob', 'prefix', 'continuation', 'account',
            'subscriptionId', 'appearance', 'platform', 'requestId'];
        const count = next(4);
        for (let field = 0; field < count; field += 1) {
            message[fields[next(fields.length)]] = values[next(values.length)];
        }
        const parsed = parseWebviewRequest(message);
        if (parsed) {
            assert.equal(typeof parsed.type, 'string');
            assert.ok(
                types.includes(parsed.type),
                `parsed an unexpected type: ${parsed.type}`,
            );
            for (const [key, value] of Object.entries(parsed)) {
                assert.ok(
                    typeof value === 'string' || typeof value === 'number',
                    `${key} should be a scalar`,
                );
            }
        }
    }
});

test('isStatementKind only accepts generator outputs', () => {
    assert.ok(isStatementKind('create_table'));
    assert.ok(!isStatementKind('metadata'));
    assert.ok(!isStatementKind(undefined));
});
