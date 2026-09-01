#!/usr/bin/env node
/**
 * Require every pull-request update to advance the extension version.
 *
 * The comparison ref is the previous PR head for synchronize events and the
 * target branch when a PR first opens. Keeping the check separate from the
 * workflow makes the policy reproducible locally.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const FIRST_MARKETPLACE_VERSION = '1.0.1';

function parseVersion(value, label) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) {
        throw new Error(`${label} must be a numeric semantic version, got "${value}".`);
    }
    return match.slice(1).map(Number);
}

function compareVersions(left, right) {
    const leftParts = parseVersion(left, 'Current extension version');
    const rightParts = parseVersion(right, 'Previous extension version');
    for (let index = 0; index < leftParts.length; index += 1) {
        if (leftParts[index] !== rightParts[index]) {
            return leftParts[index] > rightParts[index] ? 1 : -1;
        }
    }
    return 0;
}

function assertVersionBump(current, previous) {
    if (
        compareVersions(current, previous) <= 0
        && !isFirstMarketplaceReset(current, previous)
    ) {
        throw new Error(
            `Extension version ${current} must advance ${previous}. `
            + 'Run "npm version patch --no-git-tag-version" before pushing.',
        );
    }
}

function isFirstMarketplaceReset(current, previous) {
    return (
        current === FIRST_MARKETPLACE_VERSION
        && compareVersions(previous, '2.0.0') >= 0
    );
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function versionAt(ref) {
    const manifest = execFileSync(
        'git',
        ['show', `${ref}:package.json`],
        { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return JSON.parse(manifest).version;
}

function main(argv = process.argv.slice(2)) {
    const comparisonRef = argv[0] || 'origin/main';
    const manifestVersion = readJson(path.join(REPO, 'package.json')).version;
    const lock = readJson(path.join(REPO, 'package-lock.json'));
    const lockVersions = [lock.version, lock.packages?.['']?.version];

    for (const lockVersion of lockVersions) {
        if (lockVersion !== manifestVersion) {
            throw new Error(
                `package-lock.json version ${lockVersion} does not match `
                + `package.json version ${manifestVersion}.`,
            );
        }
    }

    const previousVersion = versionAt(comparisonRef);
    assertVersionBump(manifestVersion, previousVersion);
    const transition = isFirstMarketplaceReset(manifestVersion, previousVersion)
        ? 'resets the unpublished preview line from'
        : 'advances';
    console.log(
        `Extension version ${manifestVersion} ${transition} ${previousVersion} `
        + `at ${comparisonRef}.`,
    );
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

module.exports = {
    assertVersionBump,
    compareVersions,
    isFirstMarketplaceReset,
    parseVersion,
};
