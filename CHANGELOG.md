# Changelog

All notable changes to **SQL File Detection Tool** are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

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
