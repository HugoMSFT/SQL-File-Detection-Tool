#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');
const { sha256, containedPath, temporaryRoot, isolatedEnvironment, runProcess, redact } = require('./tooling-support');

const REPO = path.resolve(__dirname, '..');
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const SECRET_NAME = 'MARKETPLACE_VSCE_PAT';

function validateIdentity(version, sourceSha, manifest, lock) {
    assert.ok(typeof version === 'string' && version.trim() === version && VERSION.test(version), 'Version must be an exact stable x.y.z');
    assert.ok(typeof sourceSha === 'string' && sourceSha.length === 40 && SHA.test(sourceSha), 'Commit must be a full lowercase 40-character SHA');
    assert.equal(manifest.version, version, 'Requested version differs from package.json');
    if (lock) {
        assert.equal(lock.version, version, 'Lockfile version differs');
        assert.equal(lock.packages[''].version, version, 'Lockfile root version differs');
    }
}

function validateDispatch(env, version, sourceSha) {
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Release is manual dispatch only');
    assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Release must run from main');
    assert.equal(env.GITHUB_SHA, sourceSha, 'Requested commit must equal the dispatch head');
    validateIdentity(version, sourceSha, require('../package.json'), require('../package-lock.json'));
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(), sourceSha,
        'Checked-out source differs from the requested commit');
}

function validateProtection(environment, policies) {
    assert.equal(environment.name, 'marketplace', 'Missing marketplace environment');
    const reviewers = environment.protection_rules?.find((rule) => rule.type === 'required_reviewers');
    assert.ok(reviewers && reviewers.reviewers?.length > 0, 'marketplace must have required reviewers');
    assert.equal(environment.can_admins_bypass, false, 'marketplace must disable administrator bypass');
    assert.equal(environment.deployment_branch_policy?.custom_branch_policies, true,
        'marketplace must restrict deployment to the main branch');
    assert.equal(environment.deployment_branch_policy?.protected_branches, false);
    assert.equal(policies.total_count, 1, 'marketplace must allow only main (no wildcard or tag policies)');
    assert.equal(policies.branch_policies?.[0]?.name, 'main');
    assert.equal(policies.branch_policies?.[0]?.type ?? 'branch', 'branch');
}

async function githubGet(route, env = process.env) {
    assert.match(env.GITHUB_REPOSITORY || '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    assert.ok(env.GITHUB_TOKEN, 'A read-only GitHub workflow token is required for release gates');
    const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${route}`, {
        headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    assert.ok(response.ok, `GitHub release gate failed (${response.status}); no credential fallback is allowed`);
    return response.json();
}

async function preflight(version, sourceSha, env = process.env, get = githubGet) {
    validateDispatch(env, version, sourceSha);
    const [environment, policies, main] = await Promise.all([
        get('environments/marketplace', env),
        get('environments/marketplace/deployment-branch-policies?per_page=100', env),
        get('git/ref/heads/main', env),
    ]);
    validateProtection(environment, policies);
    assert.equal(main.object?.sha, sourceSha, 'main advanced; dispatch again with its exact current head');
}

function readVsix(bytes) {
    assert.ok(bytes.length > 0 && bytes.length <= 5 * 1024 * 1024, 'VSIX size is outside the audit budget');
    let total = 0;
    const { unzipSync } = require('fflate');
    const entries = unzipSync(bytes, { filter(entry) {
        total += entry.originalSize;
        assert.ok(total <= 20 * 1024 * 1024 && entry.originalSize <= 8 * 1024 * 1024,
            'VSIX expanded size exceeds the audit budget');
        assert.ok(!entry.name.includes('\\') && !entry.name.startsWith('/') &&
            !entry.name.split('/').some((part) => part === '..' || part === '.') &&
            !/^[a-z]:/i.test(entry.name), 'Unsafe VSIX entry path');
        return true;
    } });
    assert.ok(entries['extension/package.json'], 'VSIX has no extension manifest');
    const manifest = JSON.parse(Buffer.from(entries['extension/package.json']).toString('utf8'));
    assert.match(manifest.publisher, /^[a-z0-9][a-z0-9-]*$/i);
    assert.match(manifest.name, /^[a-z0-9][a-z0-9-]*$/i);
    const files = Object.fromEntries(Object.keys(entries)
        .filter((name) => name.startsWith('extension/') && !name.endsWith('/'))
        .sort().map((name) => [name, sha256(entries[name])]));
    assert.ok(files['extension/dist/extension.js'] && files['extension/readme.md'], 'Missing packaged code/Marketplace description');
    return { manifest, files };
}

function prepareArtifact(vsix, output, version, sourceSha) {
    validateIdentity(version, sourceSha, require('../package.json'), require('../package-lock.json'));
    const bytes = fs.readFileSync(vsix);
    const archive = readVsix(bytes);
    const audit = require('./audit-vsix').auditVsix(vsix);
    assert.deepEqual(audit.problems, [], 'VSIX audit failed');
    assert.equal(archive.manifest.version, version);
    for (const key of ['name', 'publisher', 'description']) {
        assert.equal(archive.manifest[key], require('../package.json')[key], `Packaged ${key} differs from source`);
    }
    fs.mkdirSync(output, { recursive: true });
    assert.equal(fs.readdirSync(output).length, 0, 'Release artifact directory must be empty');
    const manifest = {
        schemaVersion: 1, filename: 'extension.vsix', version, sourceSha,
        name: archive.manifest.name, publisher: archive.manifest.publisher,
        description: archive.manifest.description,
        vsixSha256: sha256(bytes), vsixBytes: bytes.length, files: archive.files,
    };
    fs.writeFileSync(containedPath(output, manifest.filename), bytes);
    const serialized = JSON.stringify(manifest, null, 2) + '\n';
    fs.writeFileSync(containedPath(output, 'release.json'), serialized);
    return { manifest, manifestSha256: sha256(serialized) };
}

function verifyArtifact(directory, version, sourceSha, manifestHash, vsixHash) {
    assert.match(manifestHash || '', HASH, 'Expected manifest hash is required from the build job');
    assert.match(vsixHash || '', HASH, 'Expected VSIX hash is required from the build job');
    const bytes = fs.readFileSync(containedPath(directory, 'release.json'));
    assert.equal(sha256(bytes), manifestHash, 'Release manifest hash differs from the immutable build output');
    const manifest = JSON.parse(bytes);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.filename, 'extension.vsix');
    assert.equal(manifest.version, version);
    assert.equal(manifest.sourceSha, sourceSha);
    assert.equal(manifest.vsixSha256, vsixHash);
    validateIdentity(version, sourceSha, require('../package.json'), require('../package-lock.json'));
    const vsix = containedPath(directory, manifest.filename);
    const archiveBytes = fs.readFileSync(vsix);
    assert.equal(archiveBytes.length, manifest.vsixBytes);
    assert.equal(sha256(archiveBytes), vsixHash, 'Downloaded VSIX hash differs');
    const archive = readVsix(archiveBytes);
    for (const key of ['name', 'publisher', 'version', 'description']) {
        assert.equal(archive.manifest[key], manifest[key], `Downloaded ${key} differs`);
        assert.equal(manifest[key], require('../package.json')[key], `Source ${key} differs`);
    }
    assert.deepEqual(archive.files, manifest.files);
    assert.deepEqual(require('./audit-vsix').auditVsix(vsix).problems, [], 'Downloaded VSIX audit failed');
    return { manifest, vsix };
}

async function verifyArtifactId(id, artifactDigest, sourceSha, env = process.env, get = githubGet) {
    assert.match(id || '', /^[1-9]\d*$/, 'Build artifact ID is required');
    assert.match(artifactDigest || '', /^(sha256:)?[0-9a-f]{64}$/, 'Build artifact digest is required');
    const artifact = await get(`actions/artifacts/${id}`, env);
    assert.equal(String(artifact.id), id);
    assert.equal(artifact.expired, false);
    assert.equal(artifact.workflow_run?.head_sha, sourceSha);
    assert.equal(artifact.digest?.replace(/^sha256:/, ''), artifactDigest.replace(/^sha256:/, ''));
}

function decodeHttpBody(bytes, encoding, maximum) {
    const zlib = require('node:zlib');
    const decoder = {
        gzip: zlib.gunzipSync,
        deflate: zlib.inflateSync,
        br: zlib.brotliDecompressSync,
    }[String(encoding || 'identity').toLowerCase()];
    if (!encoding || encoding === 'identity') {
        assert.ok(bytes.length <= maximum, 'Gallery response exceeds its size budget');
        return bytes;
    }
    assert.ok(decoder, 'Unsupported Gallery HTTP content encoding');
    return decoder(bytes, { maxOutputLength: maximum });
}

function galleryClient() {
    const vsceRequire = createRequire(require.resolve('@vscode/vsce'));
    const { PublicGalleryAPI } = require('@vscode/vsce/out/publicgalleryapi');
    const { HttpClient } = vsceRequire('typed-rest-client/HttpClient');
    const { ExtensionQueryFlags } = vsceRequire('azure-devops-node-api/interfaces/GalleryInterfaces');
    const base = 'https://marketplace.visualstudio.com';
    const transport = new HttpClient('sqlfdt-release-verification', [], {
        socketTimeout: 15_000, allowRetries: false, maxRetries: 0,
        allowRedirects: true, maxRedirects: 3, allowRedirectDowngrade: false,
    });
    const body = async (response, maximum) => {
        const stream = response.message;
        const timer = setTimeout(() => stream.destroy(new Error('Gallery response deadline')), 30_000);
        const chunks = [];
        let total = 0;
        try {
            assert.equal(stream.statusCode, 200, 'Public Gallery returned an unsuccessful HTTP response');
            for await (const chunk of stream) {
                total += chunk.length;
                assert.ok(total <= maximum, 'Gallery response exceeds its size budget');
                chunks.push(Buffer.from(chunk));
            }
            return decodeHttpBody(Buffer.concat(chunks), stream.headers['content-encoding'], maximum);
        } finally {
            clearTimeout(timer);
            stream.destroy();
        }
    };
    // vsce's public query/serialization client has no timeout constructor.
    // Adapt only its transport method to HttpClient's supported requestOptions,
    // rather than altering private fields or patching anything in node_modules.
    class TimedPublicGallery extends PublicGalleryAPI {
        async post(url, data, headers) {
            const bytes = await body(await transport.post(`${base}/_apis/public${url}`, data, headers), 2 * 1024 * 1024);
            return { readBody: async () => bytes.toString('utf8') };
        }
    }
    const api = new TimedPublicGallery(base);
    return {
        async lookup(manifest) {
            try {
                return await api.getExtension(
                    `${manifest.publisher}.${manifest.name}`,
                    [ExtensionQueryFlags.IncludeVersions, ExtensionQueryFlags.IncludeFiles],
                );
            } catch {
                throw new Error('Public Gallery metadata request failed or timed out');
            }
        },
        async download(manifest) {
            const publisher = encodeURIComponent(manifest.publisher);
            const name = encodeURIComponent(manifest.name);
            const version = encodeURIComponent(manifest.version);
            const response = await transport.get(`${base}/_apis/public/gallery/publishers/${publisher}/vsextensions/${name}/${version}/vspackage`);
            return body(response, 5 * 1024 * 1024);
        },
    };
}

function publisherEnvironment(root, credential) {
    assert.ok(typeof credential === 'string' && credential.trim().length > 0 && !/[\r\n]/.test(credential),
        'Missing environment-scoped publisher secret; no credential fallback is allowed');
    return { ...isolatedEnvironment(root), VSCE_PAT: credential, VSCE_STORE: 'file' };
}

function verifyGalleryBytes(bytes, expected) {
    const archive = readVsix(bytes);
    for (const key of ['publisher', 'name', 'version', 'description']) {
        assert.equal(archive.manifest[key], expected[key], `Gallery ${key} mismatch`);
    }
    assert.deepEqual(archive.files, expected.files,
        'Gallery version exists with different extension bytes; never retry publication');
    return {
        galleryVsixSha256: sha256(bytes),
        exactArchiveHash: sha256(bytes) === expected.vsixSha256,
        allInnerFilesMatch: true, fileCount: Object.keys(archive.files).length,
    };
}

async function verifyGallery(manifest, client = galleryClient(), { attempts = 12, delay = 15_000, wait = sleep } = {}) {
    assert.ok(Number.isInteger(attempts) && attempts > 0 && attempts <= 12);
    let versionObserved = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
        let extension;
        try {
            extension = await client.lookup(manifest);
        } catch {
            // Metadata failure is not absence, and never authorizes an upload.
            if (attempt + 1 === attempts) { throw new Error('Gallery verification unavailable; do not retry publication blindly'); }
        }
        const version = extension?.versions?.find((item) => item.version === manifest.version);
        if (version) {
            versionObserved = true;
            let bytes;
            try {
                bytes = await client.download(manifest);
            } catch {
                if (attempt + 1 === attempts) { throw new Error('Gallery package download not confirmed; publication outcome is uncertain'); }
            }
            if (bytes) {
                const integrity = verifyGalleryBytes(bytes, manifest);
                if (extension.shortDescription === manifest.description) {
                    return { version: manifest.version, descriptionVerified: true, ...integrity };
                }
            }
        }
        if (attempt + 1 < attempts) { await wait(delay); }
    }
    throw new Error(versionObserved
        ? 'Gallery version exists but corrected description/integrity is not confirmed'
        : 'Gallery version is not visible within the deadline; no publish retry was attempted');
}

async function publishOnce(artifact, { client = galleryClient(), publish, waitOptions } = {}) {
    const before = await client.lookup(artifact.manifest);
    if (before?.versions?.some((item) => item.version === artifact.manifest.version)) {
        return { uploadAttempted: false, ...await verifyGallery(artifact.manifest, client, waitOptions) };
    }
    const result = await publish();
    // Even an HTTP/socket timeout can mean the Gallery accepted the upload.
    // Never retry vsce here: only public, read-only verification is retried.
    return {
        uploadAttempted: true, uploadExitCode: result.code,
        ...await verifyGallery(artifact.manifest, client, waitOptions),
    };
}

async function main() {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
        vsix: { type: 'string' }, directory: { type: 'string', default: '.artifacts/release' },
    } });
    const version = process.env.RELEASE_VERSION;
    const sourceSha = process.env.RELEASE_SHA;
    switch (positionals[0]) {
        case 'preflight':
            await preflight(version, sourceSha);
            console.log('Manual main/head/version and protected environment gates passed.');
            break;
        case 'prepare': {
            const result = prepareArtifact(values.vsix, values.directory, version, sourceSha);
            assert.ok(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is required for immutable job outputs');
            fs.appendFileSync(process.env.GITHUB_OUTPUT,
                `manifest_sha256=${result.manifestSha256}\nvsix_sha256=${result.manifest.vsixSha256}\n`);
            break;
        }
        case 'verify':
        case 'publish': {
            await preflight(version, sourceSha);
            await verifyArtifactId(process.env.RELEASE_ARTIFACT_ID, process.env.RELEASE_ARTIFACT_DIGEST, sourceSha);
            const artifact = verifyArtifact(
                values.directory, version, sourceSha, process.env.RELEASE_MANIFEST_SHA256, process.env.RELEASE_VSIX_SHA256,
            );
            if (positionals[0] === 'verify') {
                console.log('Immutable downloaded VSIX, source identity and audit verified.');
                break;
            }
            const credential = process.env[SECRET_NAME];
            const owned = temporaryRoot('sqlfdt-publish-');
            const receiptPath = containedPath(values.directory, 'gallery-verification.json');
            try {
                const publishEnv = publisherEnvironment(owned.root, credential);
                const result = await publishOnce(artifact, {
                    publish: () => runProcess(process.execPath, [
                        path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce'),
                        'publish', '--packagePath', artifact.vsix,
                    ], {
                        cwd: owned.root,
                        env: publishEnv,
                        timeout: 4 * 60_000,
                    }).catch(() => ({ code: null })),
                });
                fs.writeFileSync(receiptPath, JSON.stringify({
                    status: 'VERIFIED', sourceSha, vsixSha256: artifact.manifest.vsixSha256, ...result,
                }, null, 2) + '\n');
                console.log('Gallery version, corrected description and every extension file verified.');
            } catch (error) {
                fs.writeFileSync(receiptPath, JSON.stringify({
                    status: 'UNCONFIRMED', sourceSha, vsixSha256: artifact.manifest.vsixSha256,
                    error: redact(error.message, [credential, process.env.GITHUB_TOKEN]),
                    retryAttempted: false,
                }, null, 2) + '\n');
                throw error;
            } finally {
                owned.cleanup();
            }
            break;
        }
        default: throw new Error('Expected preflight, prepare, verify or publish');
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(redact(error.message, [process.env[SECRET_NAME], process.env.GITHUB_TOKEN]));
        process.exitCode = 1;
    });
}

module.exports = {
    validateIdentity, validateDispatch, validateProtection, preflight,
    readVsix, prepareArtifact, verifyArtifact, verifyArtifactId,
    galleryClient, verifyGalleryBytes, verifyGallery, publishOnce,
    publisherEnvironment,
    decodeHttpBody,
};
