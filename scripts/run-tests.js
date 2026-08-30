#!/usr/bin/env node
/**
 * Run the compiled extension unit tests with `node --test`.
 *
 * Node's test runner only expands glob patterns itself from v21 onward, and a
 * bare directory argument is resolved as a module (which fails). Neither `cmd`
 * nor `sh` expands the pattern for us when it is quoted in an npm script, so we
 * discover the files here and hand the runner an explicit list. This behaves
 * identically on every supported Node version and on both Windows and POSIX.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const testDir = path.join(__dirname, '..', 'out', 'test');

if (!fs.existsSync(testDir)) {
    console.error(`No compiled tests found at ${testDir}. Run "npm run compile" first.`);
    process.exit(1);
}

const files = fs
    .readdirSync(testDir)
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => path.join(testDir, name));

if (files.length === 0) {
    console.error(`No *.test.js files in ${testDir}.`);
    process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
    stdio: 'inherit',
    shell: false,
});

if (result.error) {
    console.error(result.error.message);
    process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
