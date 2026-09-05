# Changelog

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

- Moved the Marketplace publication to the personal **Hugo Queiroz**
  publisher under `hvbqueiroz.sql-file-detection` so its independent
  ownership is unambiguous.
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
