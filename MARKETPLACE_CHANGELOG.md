# Changelog

## Unreleased

## 1.1.14

### Fixed

- Made **Browse Azure** require an explicit Connect before using a VS Code
  Microsoft session, including after Disconnect or extension reload.
- Added Refresh, two-minute metadata expiry, and coalesced Connect requests.
- Combined file and folder selection into **Browse local**, paired with
  **Browse Azure** as exclusive source tabs. Choosing local disconnects Azure
  and restores local Preview state.
- Removed the **Current file** command and clarified Storage authorization
  versus Blob Data Reader failures.
- Added a retained **File location** display and redesigned **Storage SQL** with
  clearer runtime identities, readiness states, and context-aware goals.

## 1.1.13

### Added

- Added subscription search while retaining the native Azure subscription
  dropdown, with subscriptions displayed alphabetically.
- Added a goal-first Storage setup choice for External Table, OPENROWSET, or
  BULK INSERT.
- Added Azure folder selection for SQL setup, with a metadata-only Preview of
  the browsed files and folders.
- Added complete goal-specific T-SQL after choosing an Azure file or folder,
  including prerequisites and the selected operation.
- Added prominent copy and **Open in MSSQL editor** actions for the complete
  generated setup script.
- Added explicit format selection when an Azure folder contains multiple
  supported file types.

### Fixed

- Cleared metadata, preview, schema, and generated SQL from the previous file
  while a newly selected file is being analyzed, and added explicit cancellation
  feedback.
- Added a visible Close action to every Azure browser state, including signed
  out, plus Escape-to-close with focus restored to **Browse Azure**.
- Preserved safe setup drafts, filters, collapsed folders, and Azure search
  controls when VS Code recreates a webview; URL query strings and fragments are
  never persisted.
- Synchronized the Explorer filter between sidebar and editor surfaces.
- Kept result tabs in the first sidebar viewport by bounding the Explorer pane
  instead of stacking two 560 px minimum-height regions.
- Prevented Azure file-only setup from recommending an unrelated HTTPS
  `BLOB_STORAGE` source; Blob selections now keep the primary `ABS` setup.
- Kept HTTPS with `TYPE = BLOB_STORAGE` when BULK INSERT is the selected goal.
- Improved selected goal-card subtitle contrast.
- Preserved the selected Azure subscription, storage account, container, path,
  and file when reopening the Azure browser.
- Kept Azure browsing separate from Storage setup and moved both file and folder
  selections directly into the Credential setup tab.
- Prevented delimited `True`/`False` values from being read directly as `BIT`;
  generated readers now preserve them as `NVARCHAR(5)` for safe conversion.
- Blocked SQL generation for mixed or unknown Azure folders until a format is
  selected instead of guessing from the first file.
- Marked all remote schema-bound SQL as a template in both the UI and generated
  script because Azure file contents are not downloaded or analyzed.
- Reduced Credential setup to four focused stages and removed duplicate
  connector and object-flow summaries.

## 1.1.5

### Changed

- Removed the stale format name from packaged Marketplace and walkthrough copy.

## 1.1.4

### Changed

- Simplified the extension description.

## 1.1.3

### Fixed

- Distinguished required Azure Storage-scope consent from an actual Blob RBAC
  denial, with an explicit **Authorize storage access** action after Azure
  management connection succeeds.

## 1.1.2

### Fixed

- Kept every line of the optional `CREATE TABLE` quick-load example commented,
  preventing its column list from becoming stray executable T-SQL.

### Added

- Added read-only Azure Storage browsing across tenants, subscriptions, Storage
  accounts, containers, folders, and files using VS Code Microsoft
  authentication.
- Selected Blob and ADLS Gen2 files now feed canonical ABS/ABFSS locations into
  Credential Setup without downloading or analyzing remote content.

## 1.1.1

- Parquet, Delta, ORC and RCFile external tables now emit bounded column types
  on supported platforms instead of reporting `NOT AVAILABLE`.
- Complete scripts rerun cleanly for external tables and escaped bracket names.
- Short AWS S3 locations are converted to SQL Server's documented endpoint form.
- Unsupported legacy encodings and unverified ORC read paths produce guidance
  instead of SQL that looks runnable.
- Excel timestamp inference and text-column metadata stay consistent across
  platforms.

## 1.1.0

- Marked the extension as a **Preview/beta** release so its maturity is stated
  on the Marketplace rather than assumed.
- Folder scans now reach nested, partitioned layouts such as
  `year=2026/month=09/day=02/` instead of stopping at the first level, bounded
  by depth, file and directory ceilings that report when they withhold work.
- Added an Explorer filter over file name, folder and format.
- Added a keybinding for **Analyze Current File**.
- Recognised DNS-zone storage endpoints (`*.dfs.storage.azure.net`) and
  converted them correctly for generated `BLOB_STORAGE` SQL.

## 1.0.15

- Kept Excel text-column metadata consistent with the Python analyzer across
  platforms.

## 1.0.14

- Kept Excel timestamp inference and generated `DATETIME2(6)` columns
  consistent across platforms.

## 1.0.13

- Fixed complete-script reruns for external tables and escaped bracket names.
- Corrected short AWS S3 locations for SQL Server's endpoint grammar.
- Prevented unsupported legacy-encoding and unverified ORC external tables from
  being emitted as executable SQL.

## 1.0.9

- Replaced the walkthrough GIF with a current capture of the editor-first UI.
- Runtime behavior is unchanged from 1.0.8.

## 1.0.8

- UI fixes and improvement.
- Runtime behavior is unchanged from 1.0.7.

## 1.0.7

- Hardened storage host, platform, and authentication recommendations.
- Removed unsafe CSV fallbacks for ORC, RCFile, and Iceberg.
- Fixed SQL Server 2019, NDJSON, JSON projection, and complete-script SQL.

## 1.0.6

- Preserved oversized JSON numerics as raw text instead of unsafe INT
  projections.
- Replaced impossible 1,025-column typed targets with explicit raw NDJSON
  preservation guidance across all supported SQL platforms.

## 1.0.5

- Preserved exact numeric and unexpected sampled values in previews, and kept
  scientific notation loadable as text.
- Bounded dynamic NDJSON schemas and aligned CSV field-size safety across the
  extension and Python CLI.

## 1.0.4

- Preserved exact CSV and JSON numerics, aggregated complete inputs beyond the
  former sample caps, and used safe fallbacks for mixed or truncated data.
- Prevented unknown-width strings and unsupported external-table LOB columns
  from generating truncation-prone SQL.

## 1.0.3

- Added ETL, Data Engineering, Bulk Loading, Data Virtualization, and PolyBase
  discovery tags.

## 1.0.2

- Simplified the Marketplace description.
- Replaced the walkthrough GIF with the current URL-only interface.
- Clarified supported formats and the independent-project status.

## 1.0.1

- First Marketplace release.
- Added local file and folder analysis, bounded previews, SQL type mapping, and
  platform-aware T-SQL generation.
- Added URL-driven ABS, ADLS, and ABFSS credential setup.
