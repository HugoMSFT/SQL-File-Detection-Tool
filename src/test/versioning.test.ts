import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const versioning = require(path.join(
    __dirname,
    '..',
    '..',
    'scripts',
    'check-extension-version.js',
)) as {
    assertVersionBump(current: string, previous: string): void;
    compareVersions(left: string, right: string): number;
    parseVersion(value: string, label: string): number[];
};

test('extension versions use numeric semantic versioning', () => {
    assert.deepEqual(versioning.parseVersion('2.1.11', 'Version'), [2, 1, 11]);
    assert.throws(
        () => versioning.parseVersion('2.1.x', 'Version'),
        /must be a numeric semantic version/,
    );
});

test('each PR update requires a higher extension version', () => {
    assert.equal(versioning.compareVersions('2.1.1', '2.1.0'), 1);
    assert.equal(versioning.compareVersions('2.2.0', '2.1.99'), 1);
    assert.throws(
        () => versioning.assertVersionBump('2.1.0', '2.1.0'),
        /must advance/,
    );
    assert.throws(
        () => versioning.assertVersionBump('2.0.9', '2.1.0'),
        /must advance/,
    );
});
