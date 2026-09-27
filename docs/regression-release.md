# Installed regressions, native SQL evidence, and releases

All tooling here is development-only. The VSIX allowlist excludes `scripts/`,
the test-driver extension, fixtures, tests, and credentials.

## Commands

Use Node 20 and the lockfile (`npm ci`). SQL tooling additionally needs Python
3.9+; its adapter and tests use the standard library. The npm commands use
`python3` on macOS/Linux and `python` on Windows, or the executable path in
`PYTHON` when set. On POSIX, normalize the
temporary directory before testing:

```sh
export TMPDIR="$(realpath "${TMPDIR:-/tmp}")"
npm run typecheck
npm run lint
npm test
npm run test:certification
npm run package
npm run audit:vsix
npm run test:installed
```

`npm test` includes focused JS tooling tests after the existing native/controller/
renderer/bundle suites. `npm run test:tooling` can run them alone after compilation.
No workflow or command bumps the extension version automatically.

## Installed VSIX UI regressions

`test:installed` audits the current version's `dist/*.vsix`, installs those bytes
into a new extensions directory, downloads pinned VS Code **1.139.1** using
`@vscode/test-electron`, and drives its real window/webview with `playwright-core`.
CI downloads the Ubuntu package job's artifact, rather than building another
extension, on **windows-2022** and **macos-14**. Missing executables, missing
selectors, timeouts, unexpected authentication, and assertions fail the job.

To use an existing application binary without touching its normal profile:

```sh
npm run test:installed -- --code "/Applications/Visual Studio Code.app/Contents/MacOS/Code"
```

`--code` takes the Electron executable, not the shell launcher. The runner supports
both the old macOS `Electron` name and the newer `Code` name. On Windows it reads
the version directory from VS Code's CLI bootstrap without executing that script.
All user data,
extensions, settings, home/cache directories, IPC, fixtures, and temporary files
are run-owned. macOS uses a short `/private/tmp` root to fit Unix socket limits.
Cleanup inventories the launched process tree by PID and creation time, never
kills by executable name, checks for residue, and removes its marked directory.

The separate `scripts/smoke-driver/` extension only invokes existing commands and
observes forwarded state. It verifies the installed extension's path, version,
and bundle SHA against the audited VSIX. VS Code still activates the installed
bundle; this is not an import of `out/extension.js` or a replayed renderer.

**Exact fake boundary:** imports made by the installed bundle are adapted only
at VS Code authentication and Node network/process APIs. Attempts are recorded
and rejected. Webview creation/messages are forwarded to the real VS Code API
while a small state probe is observed. Local filesystem analysis, generation,
commands, DOM, and keyboard events are real. The Microsoft/GitHub authentication
extensions are disabled. This does **not** certify live OAuth, Entra, reconnect,
RBAC, Azure networking, or public-container access. Existing pure controller/
Azure tests cover simulated authentication/reconnect; `capture:gif` remains a
mock-host walkthrough, not installed-extension evidence.

The installed scenarios cover activation, source-tab keyboard navigation,
Azure open/Escape without sign-in, local CSV/JSON analysis, preview/metadata/
schema/SQL, type/name typing and caret retention, real SQL editor documents,
per-file Reset/Undo and profile Save/Apply/Delete across A/B/A file selection,
preview row/platform settings, unsent Storage SQL drafts, sidebar/editor
relocation, renderer/panel recreation, cancellation and the next selection.
Detected Metadata is read-only on the original baseline: edits here mean schema
type overrides and generation/settings controls, not fabricated metadata edits.
Parser overrides retain their existing controller tests.
Before typing, the runner observes the forwarded native `execCommand('selectAll')`
completion and polls for the active input's full selected range with a five-second
deadline. The original method/arguments/result are preserved and its descriptor is
restored, including on failure. No animation-frame wait is used: Electron can
pause those in background windows. This avoids delayed native selection
overwriting the first character without slowing the subsequent typing test.

`--progressive-preview` additionally requires the large-file
`metadata.analysis_stage === 'provisional'` while busy, followed by final metadata
with no stage marker. CI enables this check, and records the sample count before
selecting the large file so previews of earlier fixtures cannot satisfy it.

Reports and sanitized VS Code logs are written under
`.artifacts/installed-smoke/`; failures include a screenshot of the synthetic,
isolated window. The report lists completed checks rather than claiming later
scenarios ran after an early failure. A keyboard-value mismatch is retained as a
failing regression and screenshot; a labelled whole-field replacement then lets
independent scenarios run without turning that mismatch into a pass. A cleanup regression can be reproduced with
`--fail-after-activation --artifacts .artifacts/installed-failure-cleanup`: it must
exit nonzero and report zero remaining processes and `cleanupVerified: true`.
Never attach a normal user profile or private fixture to this runner.

## Native SQL: offline first, optional live

```sh
npm run certify:native:plan -- --engine 2022 --output .artifacts/plan-2022
python -m scripts.certification.native_live --validate-plan .artifacts/plan-2022
npm run certify:native:plan -- --engine 2025 --output .artifacts/plan-2025
python -m scripts.certification.native_live --validate-plan .artifacts/plan-2025
```

Use an empty output directory for each run. Plans use the current compiled
`out/native/service.js` (`NativeAnalysisService` from `src/native/service.ts`), **never the legacy
Python generator**. Compilation freshness, source SHA, source/compiled tree
hashes, native metadata, fixture hashes, and each exact generated SQL hash are
recorded. Three deterministic files contain exactly 100 records: UTF-8 BOM CSV,
JSON, and UTF-16 JSON. SQL-server path mapping is recorded and applied to native
metadata **before** generation; the mounted bytes remain identical.

The shared Python certification lexer/safety gate checks the native output.
The live adapter permits only its run schema/object prefix in a newly created
database, splits GO batches, and records each batch and wire hash plus its
`SET NOCOUNT ON` preamble. It does not remove CODEPAGE, add LASTROW, rewrite
statements, change fixtures, or claim transformed SQL succeeded unchanged.
Exactly 100 source records cap ingestion and reads; an independent COUNT_BIG
plus TOP (100) validates bulk ingestion, and every returned ID/label/amount is
checked against the fixture, including nonempty/null/bad-value checks.

| Plan surface | Evidence policy |
| --- | --- |
| Local CSV/JSON CREATE TABLE | DDL result, independent of read success |
| Local CSV BULK INSERT/OPENROWSET | Execute native output unchanged; Linux CODEPAGE/syntax errors remain **FAIL** and make the job fail |
| Local JSON/UTF-16 OPENROWSET | Exact 100-row values required, not just successful compilation |
| Azure/S3 external format/table/read | **UNAVAILABLE**: no compatible owned TLS endpoint is provisioned in this network-isolated run |
| JSON external file format | **native-unavailable** only when the generator actually emits non-executable guidance |
| Azure SQL DB/MI/Fabric | Not run; no container result is attributed to these engines |

Azurite's HTTP loopback endpoints do not satisfy the shipped Azure URL/HTTPS
boundary. An S3 service would need a deliberately configured compatible TLS
endpoint and engine prerequisites. These are not replaced with unrelated public
samples or labelled as passing tests. Capabilities are not inferred from an
unexecuted SQL Server 2025 container.

Only on a **native x86-64 Linux** host with a local Docker daemon:

```sh
npm run certify:native:live -- --live --engine 2022 --output .artifacts/live-2022
```

The adapter rejects macOS/ARM/emulation and explicit/remote Docker contexts
before provisioning. It runs one official `mcr.microsoft.com/mssql/server`
2022/2025 Developer image at a time, records its immutable image ID/repository
digest and actual engine version, limits it to 3 GiB/two CPUs, publishes no port,
and uses `--network none`. It never connects to an existing user database.
Random credentials travel only through environment variables; SQL uses stdin.
Raw SQL/Docker error bodies are not artifacts: only error numbers and fixed
diagnostics are retained. Timeout/cancellation runs label-checked cleanup; no
existing container, image cache, or user volume is removed. Forced host shutdown
cannot execute a finally block, so CI uses disposable GitHub-hosted runners.

`.github/workflows/native-sql.yml` is manual by default. Dispatch without
`run_live` produces offline evidence only. Its weekly schedule does nothing
unless an admin sets repository variable `SQLFDT_ENABLE_LIVE_SQL=true`. A live
failure (including known Linux limitations) stays red; inspect `evidence.json`
and the exact `input/` plan/SQL rather than changing expectations to green.

## Manual immutable Marketplace release

An administrator must configure **before dispatch**:

1. An environment named `marketplace` with at least one required reviewer and
   administrator bypass disabled. Self-review prevention is an optional stronger
   two-person policy, not required for a solo maintainer's explicit approval.
2. Selected deployment branches with **only the `main` branch** (no wildcard,
   tag, or additional protected branch). The workflow validates these settings
   using read-only GitHub metadata.
3. An **environment-scoped** secret `MARKETPLACE_VSCE_PAT` with Marketplace
   publishing rights for the intended publisher. Do not define an organization
   or repository secret with that name. GitHub's expression binding does not
   expose a secret's scope, and the read-only workflow token cannot be assumed to
   have secret-metadata permission; scope is an administrator prerequisite.

YAML cannot create reviewers/protection. A nonexistent/unprotected environment,
unreadable protection metadata, missing explicit approval, missing publisher
secret, or changed `main` head is a release blocker, not a reason to weaken
gates or add a broad fallback token.

Dispatch **Approved immutable Marketplace release** on `main`, supplying its
full current 40-character head SHA and the exact existing `package.json`
version. The build job checks those inputs and lockfile agreement, then
validates/builds/packages a VSIX **once**, audits it, and uploads a version/source/
hash-bound manifest beside it. No publisher credential is available to that job.

Windows and macOS then install and exercise that exact release artifact, including
profiles and progressive previews. Publishing depends on both platform checks.
After those checks and environment approval, the publish job downloads by immutable artifact ID,
checks GitHub's ID/digest/head metadata against build outputs, locally hashes the
manifest and VSIX, checks version/source and every inner file, and reruns the
VSIX audit. It never compiles, bundles, or packages. It invokes only
`vsce publish --packagePath <verified-vsix>` with an isolated credential store
and explicit environment credential, never a PAT in argv or cached/CLI/Entra
credential fallback. Pushes and PRs cannot trigger publishing.

The public Gallery is inspected before upload. An existing matching version is
verified, not republished; mismatched bytes fail. After an uncertain upload the
workflow retries **only read-only Gallery checks**, not publication. It requires
the version, corrected short description, and every inner extension file
(including packaged README and manifest) to match. A signing/repacking difference
in the outer archive is acceptable only with identical inner files.

The verifier reuses vsce's public query/serialization client with an adapted
transport and the HTTP client's supported `socketTimeout` constructor option.
It bounds response sizes/decompression, stream time, retries, and delays, handles
Gallery HTTP gzip before hashing, and never patches `node_modules`. An
`UNCONFIRMED` receipt means inspect Gallery and the immutable artifact before
another dispatch; never retry a version whose bytes differ.
