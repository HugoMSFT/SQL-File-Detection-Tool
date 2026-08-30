# Changelog

All notable changes to **SQL File Detection Tool** are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Changed

- **The extension is now native by default. Python, Flask, `pip`, virtual
  environments, localhost and the Simple Browser are gone from the shipped
  runtime.** Clicking the Activity Bar icon renders a complete interface from
  bundled assets in about a millisecond. Nothing is downloaded, installed,
  started or listened on. On the reference machine activation takes under 1 ms,
  first render under 1 ms, and a first CSV analysis about 20 ms end to end.

### Added

- **A full `WebviewViewProvider` interface (`sqlFileDetectionTool.sidebar`).**
  The whole product workflow now lives in the sidebar rather than behind an
  external browser tab: browse or analyse the current file, a workspace folder,
  or a picked file/folder; a file list, bounded preview and metadata panel;
  every statement tab (CREATE TABLE, BULK INSERT, OPENROWSET, COPY INTO,
  external file format, external table, JSON functions, FOR JSON, credential
  setup, best practices); a schema override editor; export; the platform
  selector with Azure SQL Database still the default; public dataset URLs; and
  Azure Storage. **Open in Editor** opens the same interface as a
  `WebviewPanel` when more width helps — both surfaces render one shared store,
  so they cannot disagree.
- **Native Azure Storage integration**, replacing the backend's Azure
  endpoints with extension-host TypeScript. Four authentication modes: VS Code
  Microsoft sign-in (recommended, refreshed before expiry), SAS URL, connection
  string / account key entered through a masked input box, and anonymous public
  access. Storage account, container, prefix and blob navigation with bounded
  paging, cancellation, file-type filtering, and download-to-temp with byte
  caps. A known account can be attached directly without ARM enumeration.
- **A native public-dataset workflow** with SSRF protections stronger than the
  Python implementation it replaces, including per-redirect revalidation and a
  DNS guard installed as the socket's own `lookup` so a rebinding race cannot
  reach a private address.
- **Instrumentation.** The output channel records activation, activation-to-
  first-render and first-analysis timings, and the test suite asserts budgets
  for all three.
- **`docs/native-ui.md`** — the message flow, the CSP, the file-identity model,
  the Azure authentication threat model, the SSRF policy, and the cancellation
  and stale-result rules.
- Extensive new Node suites: message validation and fuzzing, CSP and renderer
  static analysis, secret non-exposure, cancellation and stale-result
  suppression, path containment, per-format fixtures, schema overrides, export
  deduplication, the ORC limitation, all four Azure modes with paging, expiry
  and disconnect, public-URL SSRF and size cases, state persistence, and an
  integration-style activation test that runs with `child_process` sabotaged and
  `PATH` emptied.

### Removed

- The Flask backend, the Simple Browser flow and the compact launcher sidebar
  are no longer reachable. `src/sidebar.ts`, `src/azureSignIn.ts` and
  `src/webviewHtml.ts` are deleted. No contributed command sets up, starts or
  stops a backend; the setup and stop-backend commands are gone.

### Security

- **The renderer can never name a file.** The webview cannot send a path, a root
  or a directory. It sends an opaque, host-minted random `fileId`; each registry
  entry carries its own allowed root, and every native call re-applies the Layer
  1 realpath containment check. A stale or forged id fails closed.
- **Strict CSP with a per-load nonce and no `connect-src`.** `default-src 'none'`
  means the renderer has no network access whatsoever, so it cannot be used as
  an SSRF pivot. One nonced local script, no inline handlers, no `eval`, no
  remote assets. A test statically fails the build on `innerHTML`, `fetch`,
  `localStorage`, a second script tag or a remote resource reference.
- **Every webview message passes one validator.** `parseWebviewRequest()`
  dispatches through a builder table rather than on a raw string, bounds every
  field, rejects control characters, and returns `undefined` — never a partial
  or defaulted request — for anything it does not fully understand. The handler
  never throws.
- **Credentials stay in the extension host.** No token, key or SAS signature
  reaches the webview, the output channel, a setting, a URL, a child process
  argument or generated SQL. Remembering a secret is opt-in and defaults to no;
  disconnect and deactivate clear memory *and* delete the stored secret.
  Managed identity is deliberately not offered as a desktop mode rather than
  faked.
- `ipGuard` now rejects leading-zero IPv4 octets, closing an `0177.0.0.1`
  octal-loopback bypass that depends on resolver behaviour.
- Public HTTPS fetches are restricted to the default port. A non-443 port is
  refused on the initial URL and on every redirect hop, so the client cannot be
  driven as a port scanner against a publicly routable host.
- `storageUrlFor()` strips the query string and fragment before the value
  reaches state or generated T-SQL. If a user pastes a SAS-signed blob URL, the
  `sig=` value is dropped rather than written into a script they might commit.
- Cancellation is real end to end: an `AbortSignal` reaches the HTTPS request
  and is re-checked per chunk, so a superseded or cancelled download stops
  transferring instead of merely having its result discarded.
- Port binding, loopback URL construction and health polling moved out of
  `src/util.ts` into `src/legacyBackendUrl.ts`, so no module reachable from
  activation can open a socket. A test walks the compiled module graph from
  `extension.js` and fails on `child_process`, `worker_threads`, a spawn call,
  or any server vocabulary.

### Notes

- The Python CLI and web application remain fully functional but are now
  **optional legacy compatibility**. `src/backend.ts`, `src/pythonEnv.ts`,
  `src/process.ts` and `src/legacyBackendUrl.ts` survive as deprecated,
  unreferenced transition code; Layer 3 removes them together with packaging
  and dependency pruning.
- Adds one runtime dependency, `@azure/storage-blob` (MIT), and one development
  dependency, `esbuild`, used to bundle the extension so the ESM-only
  `hyparquet` reader ships correctly.
- The version is unchanged at 1.1.1. Layer 3 owns the version bump, the demo
  GIF and the Marketplace copy.

### Added (Layer 1 — native analysis core)

- **Native TypeScript analysis core (`src/native/`).** A complete in-process
  port of the Python analysis and T-SQL generation logic, so the VS Code
  extension can eventually work without spawning a Python interpreter or a
  Flask server. It covers CSV/TSV/pipe-delimited text, plain text, JSON arrays,
  single JSON objects, NDJSON/JSONL, Parquet, XLSX, Delta (by reading
  `_delta_log` directly, with no `deltalake` requirement), and Iceberg table
  metadata, plus a full port of the platform-aware SQL generator for all six
  targets with `azure_sql_db` still the default.
- The core exposes a single `NativeAnalysisService` facade suitable for a future
  `WebviewView`: analyse a file or a table directory, read a bounded preview,
  generate every statement tab or a complete document, generate a multi-file
  script, and list supported formats and platforms. Every filesystem operation
  resolves symlinks and junctions before enforcing an allowed root, accepts a
  `vscode.CancellationToken`, reports progress, and reads within explicit byte
  and row bounds.
- Deterministic parity testing against the live Python implementation.
  `scripts/generate_parity_baselines.py` records normalised metadata and
  semantic statement invariants for the committed `demo/` fixtures into
  `tests/native_parity/python_baseline.json` (no absolute paths, no timings),
  and the Node suites compare against it marker for marker. The handful of
  intentional differences are allowlisted individually, with a guard test that
  fails if an allowlisted difference ever stops being one.
- New Node test suites for the format matrix, encodings, malformed and hostile
  input, cancellation, path containment (including a Windows junction escape),
  SQL injection across every platform, the 6 x 4 x 2 generator matrix, and
  performance guards.
- New contributor documentation: [`docs/native-core.md`](docs/native-core.md)
  covers the module layout, the service API, the safety properties, the
  dependency and license choices, the format matrix, and the parity method.

### Security

- The native escaping layer collapses control characters before escaping, so a
  line terminator smuggled into a column name, a JSON key, a file name, or a
  storage URL cannot introduce a line reading `GO` and split the generated
  script into an attacker-authored batch. `GO` is a client-side batch separator
  rather than a T-SQL keyword, so doubling `]` and `'` alone did not prevent
  this. The native `splitGoBatches` helper is independently hardened to track
  literals, bracketed identifiers, and line and block comments across lines.
- Delta and Iceberg now resolve every sidecar file they read by name
  (`_delta_log/…`, `metadata/…`) through the same realpath-based containment
  check used for caller-supplied paths, so a symlink or Windows junction planted
  inside a table directory cannot redirect the read outside the allowed root.
- The JSON section's on-premises `SINGLE_CLOB` branch escapes `file_path`
  through the central `quoteLiteral` helper instead of a hand-rolled quote
  double, closing the last path by which a control character could reach
  generated SQL. A test now fails the build on any hand-rolled SQL escaper
  outside `src/native/sql/escaping.ts`.
  Iceberg no longer surfaces raw `JSON.parse` messages, which embed a snippet of
  the file being parsed.
- Both issues were found by a security review of this branch, both had working
  proofs of concept, and both now have regression tests — including control
  tests that fail if the detection logic itself becomes vacuous.

### Known limitations
- **ORC is not analysed natively.** The native core recognises an ORC file and
  reports its size and compression codec, but returns a typed
  `unsupported_native` result instead of a schema, because there is no
  maintained pure-JavaScript or WASM ORC reader that avoids a platform-specific
  native binary. The extension now states this limitation in the UI and offers a
  manual, opt-in workaround using the separately installed Python CLI; it never
  installs or launches Python on your behalf. See
  [`docs/native-core.md`](docs/native-core.md) for the full rationale.

### Notes (Layer 1)

- At the time Layer 1 landed nothing user-facing had changed and no shipped code
  path imported the native core. The Layer 2 entries above supersede that: the
  native core is now the only analysis engine the extension uses.
- Adds four runtime dependencies, all MIT, all pure JavaScript, none with an
  install script or a native binary: `hyparquet`, `iconv-lite`, `chardet`, and
  `fflate`.

## [1.1.1]

### Added

- **Activity Bar entry point.** The extension now contributes a
  **SQL File Detection Tool** container to the VS Code Activity Bar, with an
  original monochrome icon (`media/activity-bar.svg`) that follows the active
  theme. Selecting it reveals a compact sidebar showing the product name and
  backend status, plus **Open Tool**, **Analyze Current File**, **Connect Azure
  Storage**, and **Stop Backend** actions.
- Revealing the container starts or reuses the managed Python backend and opens
  or focuses the interface. The extension activates on the view rather than at
  startup, and a startup grace period stops VS Code from opening the tool merely
  because it restored the container from the previous session. Repeated clicks
  focus the existing interface instead of spawning another backend or another
  browser tab.
- If the backend fails to start, the sidebar shows the failure and an actionable
  **Retry** button.
- New setting `sqlFileDetectionTool.openOnActivityBarClick` (default `true`).
  When it is disabled, the sidebar still offers **Open Tool**.
- **Marketplace walkthrough GIF** (`media/sql-file-detection-tool-walkthrough.gif`),
  captured from the real running interface, plus a **See it in action** section
  near the top of the README with an accessible text summary of every beat.

### Security

- The sidebar webview is served with a strict, nonce-bound Content Security
  Policy, is granted no local resource roots, and contains no URL, port, token,
  or other secret. Messages from the webview are dropped unless they match a
  fixed command allowlist.

## [1.1.0]

### Changed

- **Renamed the product to SQL File Detection Tool.** The Python distribution is
  now `sql-file-detection-tool` and the primary console script matches. The
  rename is non-breaking: the `external_file_detection` import package, the
  `external-file-detector` console script, `ExternalFileDetectorApp` and
  `ExternalFileDetectionWebGUI` all still work.
- **Azure SQL Database is now the default target platform.** One canonical
  `DEFAULT_TARGET_PLATFORM` constant drives `SQLGenerator`, the application
  class, the CLI `--target-platform` option, every Flask route, the web UI
  platform selector, the public-dataset flow, and the VS Code extension. Explicit
  platform selection behaves exactly as before.
- Generating Azure SQL output for a **local** file now emits an explicit
  "stage the data in Azure Storage first" prerequisite block instead of
  presenting a local path as directly runnable.
- The web UI platform selector lists Azure SQL Database first and preselects it.

### Added

- **Azure Storage authentication in the style of Azure Storage Explorer**, with
  explicit, typed modes: Microsoft Entra ID (developer chain), Microsoft Entra ID
  (interactive browser, with OS-protected token caching where supported),
  managed identity, a VS Code brokered token, shared access signature,
  connection string, account key, and anonymous.
  - A failed Entra sign-in is never downgraded to anonymous or shared-key access.
  - `managed_identity` selects `ManagedIdentityCredential` explicitly and is the
    documented production choice; `entra_default` is limited to local/developer
    use.
  - Secrets stay in memory, are scoped to one browser session, expire with a
    TTL, and are removed on disconnect. Nothing secret reaches a URL, a log line,
    a response body, a setting, a file, or Git.
  - SAS query strings and connection strings are redacted from every displayed
    path, error and diagnostic; credential inputs are password fields and status
    shows only a masked hint.
- **Azure explorer in the web UI**: sign-in status and identity,
  connect/disconnect, subscription picker (when an ARM token is available),
  storage-account picker, container list, prefix/folder navigation, bounded and
  paged blob listing, and an Analyze action. Direct browsing of a known account
  works even when subscription enumeration is not available.
- New `external_file_detection.azure_auth` module: auth modes, redaction
  helpers, an access-token record with expiry, a minimal `TokenCredential`
  adapter for VS Code tokens, SAS/connection-string parsing and validation, ARM
  REST subscription and storage-account listing, a per-session connection
  registry, and bounded blob browsing.
- CLI options `--azure-sas` (env `AZURE_STORAGE_SAS_TOKEN`) and
  `--azure-auth-mode` on `analyze`, `analyze-files` and `list-files`.
- **A real, installable VS Code extension** that bundles and manages the Python
  backend.
  - Commands: Open, Analyze Current File, Analyze Workspace Folder, Connect to
    Azure Storage, Disconnect Azure Storage, Stop Backend, Set Up Backend, and
    Show Output, plus an Explorer context-menu entry for supported files and
    Delta/Iceberg directories.
  - First use creates a managed virtual environment under the extension's global
    storage and installs the bundled project with the `[azure]` extra, with
    progress reporting and actionable failures. The workspace interpreter is
    never modified. An existing interpreter can be configured instead.
  - The backend starts on a dynamically selected free loopback port using spawn
    argument arrays, and the extension waits on `/api/health` before opening the
    UI through `vscode.env.asExternalUri` and the Simple Browser.
  - Azure sign-in uses `vscode.authentication.getSession('microsoft', ...)` and
    posts tokens to a control endpoint protected by a cryptographically random
    per-process token. Tokens stay in memory, refresh before expiry, and are
    cleared on sign-out and deactivate.
  - Setting `sqlFileDetectionTool.defaultPlatform` defaults to `azure_sql_db`.
- New backend endpoints: `GET /api/health`, `GET /api/session`, the protected
  `/api/control/*` control channel, and `/api/azure/*` for status, connect,
  disconnect, subscriptions, storage accounts, containers, blobs and analyze.
- Web UI deep links: `?path=`, `?folder=` and `?azure=1`, so the VS Code
  commands can open the UI on a specific target.

### Security

- State-changing and Azure endpoints require a per-browser-session token in the
  `X-SQLFDT-Session` header. CORS stays closed and the server stays bound to
  loopback.
- Control endpoints require `X-Control-Token`, compared with
  `hmac.compare_digest`. The value is read from the environment once at start-up
  and removed from `os.environ`.
- No Microsoft Entra application registration and no client secret are required:
  the tool uses VS Code's Microsoft authentication provider and Azure Identity
  public-client developer flows.
- Closing an Azure connection (disconnect, sign-out, TTL expiry or reconnecting
  from another tab) now hard-disables it. A closed connection raises
  `not_connected` instead of rebuilding a client with `credential=None`, which
  the Storage SDK treats as anonymous access — this removes a silent
  authenticated-to-anonymous downgrade.
- Every JSON error payload and every CLI error line is passed through the
  credential redactor, so a SAS query string or connection string embedded in an
  SDK exception cannot reach a response body, a terminal or a CI log.
- The VS Code extension starts the backend with an explicit `--root-dir`, so the
  server-side path guard is anchored to the folder being analyzed rather than to
  the extension's own install directory.

## [1.0.0]

- Initial release as *SQL External File Detector*: file format detection and
  schema extraction for CSV/TSV, JSON/JSONL/NDJSON, Parquet, ORC, Excel, text,
  Delta Lake and Apache Iceberg; platform-aware T-SQL generation for SQL Server
  2019/2022/2025, Azure SQL Database, Azure SQL Managed Instance and Microsoft
  Fabric SQL Database; local, Amazon S3 and Azure Blob storage handlers; a CLI
  and a loopback web interface.
