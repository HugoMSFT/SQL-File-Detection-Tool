'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');
const { zipSync } = require('fflate');
const { manifestAssets } = require('../audit-vsix');
const { temporaryRoot, sha256 } = require('../tooling-support');
const {
    validateIdentity, validateProtection, readVsix, prepareArtifact, verifyArtifact, verifyArtifactId,
    verifyGalleryBytes, verifyGallery, publishOnce,
    publisherEnvironment,
    decodeHttpBody,
} = require('../release');
const MANIFEST = require('../../package.json');
const SOURCE = 'a'.repeat(40);

function archive() {
    const entries = {};
    for (const name of [...manifestAssets(), 'extension/media/webview/main.js',
        'extension/media/webview/main.css', 'extension/readme.md', 'extension/changelog.md',
        'extension/LICENSE.txt', 'extension/THIRD_PARTY_NOTICES.md']) {
        entries[name] = Buffer.from('fixture');
    }
    entries['extension/dist/extension.js'] = Buffer.from('require("vscode");');
    entries['extension/package.json'] = Buffer.from(JSON.stringify(MANIFEST));
    return entries;
}

function artifact() {
    const owned = temporaryRoot('sqlfdt-release-test-');
    const vsix = path.join(owned.root, 'input.vsix');
    const bytes = zipSync(archive());
    fs.writeFileSync(vsix, bytes);
    const directory = path.join(owned.root, 'artifact');
    const prepared = prepareArtifact(vsix, directory, MANIFEST.version, SOURCE);
    return { owned, directory, bytes, ...prepared };
}

test('exact release version and source hash validation rejects ambiguous or injectable inputs', () => {
    validateIdentity(MANIFEST.version, SOURCE, MANIFEST);
    for (const value of ['v1.2.3', '1.2', '01.2.3', '1.2.3-beta', '1.2.3\n', '$(id)', '']) {
        assert.throws(() => validateIdentity(value, SOURCE, MANIFEST));
    }
    for (const value of ['main', 'abc123', '../main', 'A'.repeat(40), 'b'.repeat(41), SOURCE + '\n']) {
        assert.throws(() => validateIdentity(MANIFEST.version, value, MANIFEST));
    }
    assert.throws(() => validateIdentity(MANIFEST.version, SOURCE, MANIFEST,
        { version: MANIFEST.version, packages: { '': { version: '0.0.0' } } }));
});

test('publisher secret is explicit, environment-only, and cannot fall back to cached credentials', () => {
    const owned = temporaryRoot('sqlfdt-publisher-test-');
    try {
        for (const value of [undefined, '', ' ', '\r\n']) {
            assert.throws(() => publisherEnvironment(owned.root, value), /no credential fallback/);
        }
        const env = publisherEnvironment(owned.root, 'synthetic-publisher-token');
        assert.equal(env.VSCE_PAT, 'synthetic-publisher-token');
        assert.equal(env.VSCE_STORE, 'file');
        assert.equal(env.HOME, path.join(owned.root, 'home'));
        assert.equal(env.GITHUB_TOKEN, undefined);
    } finally { owned.cleanup(); }
});

test('required review protection and exact main branch restriction fail closed', () => {
    const environment = {
        name: 'marketplace', can_admins_bypass: false,
        protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 1 } }] }],
        deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
    };
    const policies = { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] };
    validateProtection(environment, policies);
    assert.throws(() => validateProtection({ ...environment, protection_rules: [] }, policies), /reviewers/);
    assert.throws(() => validateProtection({ ...environment, can_admins_bypass: true }, policies), /bypass/);
    assert.throws(() => validateProtection(environment, { total_count: 2 }), /only main/);
    assert.throws(() => validateProtection(environment, { total_count: 1, branch_policies: [{ name: 'main', type: 'tag' }] }));
});

test('immutable artifact ID, digest and head must all match GitHub metadata', async () => {
    const get = async () => ({ id: 42, expired: false, digest: `sha256:${'b'.repeat(64)}`, workflow_run: { head_sha: SOURCE } });
    await verifyArtifactId('42', 'b'.repeat(64), SOURCE, {}, get);
    await assert.rejects(verifyArtifactId('../42', 'b'.repeat(64), SOURCE, {}, get));
    await assert.rejects(verifyArtifactId('42', 'c'.repeat(64), SOURCE, {}, get));
    await assert.rejects(verifyArtifactId('42', 'b'.repeat(64), 'f'.repeat(40), {}, get));
});

test('VSIX validation rejects zip traversal paths and oversized archives', () => {
    assert.throws(() => readVsix(zipSync({ ...archive(), '../escape': Buffer.from('bad') })), /Unsafe/);
    assert.throws(() => readVsix(Buffer.alloc(5 * 1024 * 1024 + 1)), /size/);
});

test('Gallery HTTP gzip is decoded before VSIX hashing with a decompression ceiling', () => {
    const { gzipSync } = require('node:zlib');
    const bytes = zipSync(archive());
    assert.deepEqual(decodeHttpBody(gzipSync(bytes), 'gzip', 5 * 1024 * 1024), Buffer.from(bytes));
    assert.throws(() => decodeHttpBody(gzipSync(Buffer.alloc(1024)), 'gzip', 100));
    assert.throws(() => decodeHttpBody(bytes, 'unknown', 5 * 1024 * 1024), /Unsupported/);
});

test('downloaded artifact verifies manifest, version, source, actual file hash and VSIX audit', () => {
    const item = artifact();
    try {
        const verified = verifyArtifact(item.directory, MANIFEST.version, SOURCE, item.manifestSha256, item.manifest.vsixSha256);
        assert.deepEqual(verified.manifest, item.manifest);
        assert.throws(() => verifyArtifact(item.directory, MANIFEST.version, 'f'.repeat(40), item.manifestSha256, item.manifest.vsixSha256));
        assert.throws(() => verifyArtifact(item.directory, MANIFEST.version, SOURCE, '0'.repeat(64), item.manifest.vsixSha256));
        fs.appendFileSync(path.join(item.directory, 'extension.vsix'), 'tampered');
        assert.throws(() => verifyArtifact(item.directory, MANIFEST.version, SOURCE, item.manifestSha256, item.manifest.vsixSha256));
    } finally { item.owned.cleanup(); }
});

test('Gallery repacking is accepted only if every inner extension file matches exactly', () => {
    const item = artifact();
    try {
        const repacked = zipSync({ ...archive(), 'Signature.fixture': Buffer.from('synthetic signing envelope') }, { level: 0 });
        assert.notEqual(sha256(repacked), item.manifest.vsixSha256);
        assert.equal(verifyGalleryBytes(repacked, item.manifest).allInnerFilesMatch, true);
        const changed = archive();
        changed['extension/dist/extension.js'] = Buffer.from('require("vscode"); /* changed */');
        assert.throws(() => verifyGalleryBytes(zipSync(changed), item.manifest), /different extension bytes/);
        const extra = { ...archive(), 'extension/unexpected.js': Buffer.from('extra') };
        assert.throws(() => verifyGalleryBytes(zipSync(extra), item.manifest), /different extension bytes/);
    } finally { item.owned.cleanup(); }
});

test('uncertain upload is attempted exactly once, then verified through public Gallery', async () => {
    const item = artifact();
    let uploads = 0;
    let lookups = 0;
    const client = {
        lookup: async () => ++lookups === 1 ? null :
            { versions: [{ version: MANIFEST.version }], shortDescription: MANIFEST.description },
        download: async () => item.bytes,
    };
    try {
        const result = await publishOnce({ manifest: item.manifest }, {
            client, publish: async () => { uploads++; return { code: null }; },
            waitOptions: { attempts: 2, delay: 0 },
        });
        assert.equal(uploads, 1);
        assert.equal(result.uploadExitCode, null);
        assert.equal(result.descriptionVerified, true);
        assert.equal(result.exactArchiveHash, true);
    } finally { item.owned.cleanup(); }
});

test('already-published matching version is inspected, not republished', async () => {
    const item = artifact();
    try {
        const result = await publishOnce({ manifest: item.manifest }, {
            client: {
                lookup: async () => ({ versions: [{ version: MANIFEST.version }], shortDescription: MANIFEST.description }),
                download: async () => item.bytes,
            },
            publish: async () => assert.fail('Duplicate upload must not happen'),
            waitOptions: { attempts: 1 },
        });
        assert.equal(result.uploadAttempted, false);
    } finally { item.owned.cleanup(); }
});

test('missing version or stale public description exhausts bounded checks and fails', async () => {
    const item = artifact();
    try {
        let lookups = 0;
        await assert.rejects(verifyGallery(item.manifest, {
            lookup: async () => { lookups++; return null; },
        }, { attempts: 3, delay: 0 }), /not visible/);
        assert.equal(lookups, 3);
        await assert.rejects(verifyGallery(item.manifest, {
            lookup: async () => ({ versions: [{ version: MANIFEST.version }], shortDescription: 'stale' }),
            download: async () => item.bytes,
        }, { attempts: 1 }), /description/);
    } finally { item.owned.cleanup(); }
});

test('public metadata failure is not absence and never authorizes publication', async () => {
    await assert.rejects(publishOnce({ manifest: MANIFEST }, {
        client: { lookup: async () => { throw new Error('network unavailable'); } },
        publish: async () => assert.fail('Cannot upload without a Gallery check'),
    }), /unavailable/);
});

test('release and optional live workflows retain their trigger, secret and immutable boundaries', () => {
    const yaml = createRequire(require.resolve('eslint/package.json'))('js-yaml');
    const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../../.github/workflows/release.yml'), 'utf8'));
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
    assert.equal(workflow.jobs.publish.environment.name, 'marketplace');
    assert.match(workflow.jobs.publish.if, /refs\/heads\/main/);
    const publishSteps = workflow.jobs.publish.steps;
    const download = publishSteps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
    assert.match(download.with['artifact-ids'], /needs\.build\.outputs\.artifact_id/);
    assert.ok(!publishSteps.some((step) => /\bnpm run (?:package|bundle|compile)\b/.test(step.run || '')));
    assert.ok(!JSON.stringify(workflow.jobs.build).includes('secrets.'));
    const credentialSteps = publishSteps.filter((step) => step.env?.MARKETPLACE_VSCE_PAT);
    assert.equal(credentialSteps.length, 1);
    assert.equal(credentialSteps[0].env.MARKETPLACE_VSCE_PAT, '${{ secrets.MARKETPLACE_VSCE_PAT }}');
    const sql = yaml.load(fs.readFileSync(path.join(__dirname, '../../.github/workflows/native-sql.yml'), 'utf8'));
    assert.deepEqual(Object.keys(sql.on).sort(), ['schedule', 'workflow_dispatch']);
    assert.equal(sql.on.workflow_dispatch.inputs.run_live.default, false);
    assert.equal(sql.jobs['native-sql']['runs-on'], 'ubuntu-24.04');
});
