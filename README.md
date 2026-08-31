# SQL File Detection Tool

SQL File Detection Tool analyzes data files and generates platform-aware
T-SQL loading and external-table guidance. It supports local files, Amazon S3,
and Azure Blob Storage through a CLI, a local web interface, and a VS Code
extension.

This is a personal, independent open-source project. It is not sponsored,
endorsed, certified, or approved by Microsoft. Microsoft, Azure, SQL Server,
Fabric, and Visual Studio Code are trademarks of Microsoft Corporation; their
names are used only to identify compatible products and services.

**Azure SQL Database is the default target platform.** Every entry point - CLI,
web UI, Python API, and VS Code extension - generates Azure SQL Database output
unless another platform is selected explicitly.

## See it in action

![Walkthrough of the native VS Code extension: selecting the SQL File Detection
Tool icon in the Activity Bar, the Power Studio interface opening immediately in
an editor tab, a Parquet file analyzed in the Preview tab, the guided external
storage credential setup, generated T-SQL, and the Azure Storage browser.](media/sql-file-detection-tool-walkthrough.gif)

The walkthrough above, in text:

1. Select the **SQL File Detection Tool** icon in the VS Code Activity Bar. The
   full interface opens immediately in an editor tab, rendered natively — no
   Python, no server and no browser tab. There is no install or setup step to
   sit through.
2. Point it at any supported SQL source - Parquet, ORC, CSV, TSV, DAT, JSON, or
   a Delta or Iceberg table directory. Hudi folders expose their underlying
   Parquet data files without interpreting Hudi metadata. The walkthrough analyses
   `demo/parquet/sales.parquet` from this repository.
3. **Preview** is the first and default tab, showing real rows from the selected
   file. **Metadata** and **Schema** keep detection details and recommended,
   editable SQL type mappings
   nearby without crowding the initial experience.
4. The **Target platform** selector is preset to **Azure SQL Database**. Switch
   to SQL Server 2019-2025, Azure SQL Managed Instance, or Fabric SQL Database
   at any time.
5. **CREATE TABLE**, **BULK INSERT**, **OPENROWSET**, and **EXT TABLE** tabs
   hold the generated T-SQL. Azure SQL output for a local file includes an
   explicit "stage the data in Azure Storage first" prerequisite block.
6. **Credential setup** guides the platform, storage service, authentication,
   object names, and location. It offers only compatible choices and generates
   placeholders rather than collecting SAS tokens, S3 keys, or passwords.
7. **Azure & URLs** offers four explicit extension sign-in modes - VS Code
   Microsoft sign-in, SAS, connection string, or anonymous - with no silent
   fallback between them, plus a **Public dataset or HTTPS URL** box that
   analyzes any `https://` data file directly. The Python web application keeps
   its wider set, including managed identity.
8. The whole surface follows the active VS Code theme.

Every panel in the recording is the real native webview, driven by the real
analysis engine: the column types, the row values and the T-SQL are what the
shipped code produces for that file. The Azure connection shown is a synthetic
`contoso.example` identity with no token, SAS or account key. Regenerate the
recording with `npm run capture:gif` (see
[`scripts/capture-walkthrough.js`](scripts/capture-walkthrough.js)).

## Names and compatibility

The project was previously called *SQL External File Detector*. The rename is
deliberately non-breaking:

| Thing | Current name | Still accepted |
| --- | --- | --- |
| Product | SQL File Detection Tool | - |
| Repository | `HugoMSFT/SQL-File-Detection-Tool` | old URL redirects |
| Python distribution | `sql-file-detection-tool` | - |
| Import package | `external_file_detection` | unchanged, no migration needed |
| Console script | `sql-file-detection-tool` | `external-file-detector` |
| Application class | `SQLFileDetectionApp` | `ExternalFileDetectorApp` |
| Web GUI class | `SQLFileDetectionWebGUI` | `ExternalFileDetectionWebGUI` |

Existing scripts, imports and automation continue to work unchanged.

## Features

- Detects file formats and extracts schemas without loading whole tabular files.
- Samples CSV and JSON conservatively for SQL type inference; the optional
  Python API also retains bounded Excel analysis.
- Reads Parquet metadata and bounded record batches.
- Reads Delta Lake metadata when the optional Delta dependency is installed.
- Selects current Apache Iceberg schemas and partition specs from table metadata.
- Generates `CREATE TABLE`, `BULK INSERT`, `OPENROWSET`, external-table,
  file-format, and guided credential/data-source scripts where supported.
- Keeps generated SQL aligned with SQL Server, Azure SQL, and Fabric SQL
  Database feature differences.
- Provides local, S3, and Azure Blob storage handlers.
- Signs in to Azure Storage the way Azure Storage Explorer does: Microsoft Entra
  ID, managed identity, SAS, connection string, or account key. The VS Code
  extension offers the four of those that are meaningful on the desktop.
- Ships as an installable VS Code extension that runs entirely natively — no
  Python interpreter, virtual environment, server or port.

Generated SQL is a starting point. Review data types, credentials, paths, and
platform requirements before running it in a database.

## Supported inputs

| Input | Analysis | Extension | Python CLI |
| --- | --- | --- | --- |
| CSV, TSV, and DAT | Delimiter, encoding, sampled schema, logical row count | yes | yes |
| JSON, JSONL, and NDJSON | Bounded schema sample, nesting, row count where available | yes | yes |
| Parquet | Arrow schema, row groups, compression, row count | yes | yes |
| Delta Lake directories | Delta metadata, or a bounded Parquet schema fallback | yes | yes |
| Apache Iceberg directories | Current schema, partition spec, snapshot row count | yes | yes |
| Apache Hudi directories | Underlying Parquet data files; Hudi metadata is not interpreted | yes | yes |
| Excel | Bounded worksheet sample | no - intentionally excluded from SQL source scans | yes |
| Text | Encoding and streamed line count | yes | yes |
| ORC and RCFile | Format recognition and SQL format guidance | recognition only | recognition only |

That table is not a description; it is a test. `src/test/native/demoMatrix.test.ts` walks
every fixture committed under `demo/`, analyses it through the shipped native
service, and asserts the detected format, the recovered column count, and whether
the file was genuinely parsed or only recognised. Adding a demo fixture without
adding its row fails the suite, so the matrix cannot quietly drift away from what
the code actually does.

### The ORC limitation, stated plainly

ORC and RCFile are **recognised, not parsed**. The extension identifies the
format, reports it, and generates the correct external file format and
`OPENROWSET`/external-table guidance for it - but it cannot read an ORC file's
embedded schema, so it cannot tell you the column names and types the way it can
for Parquet or CSV. There is no pure-JavaScript ORC reader worth shipping, and
bundling a native one would reintroduce exactly the platform-specific install
step version 2.0 exists to remove.

The optional Python CLI has the same limitation by default. If you need ORC
schema extraction, use the CLI with `pip install ".[spark]"`, which reads ORC
through PySpark.

The SQL generator targets:

- SQL Server 2019, 2022, and 2025
- Azure SQL Database
- Azure SQL Managed Instance
- Microsoft Fabric SQL Database

Unsupported statements are returned as explanatory SQL comments with practical
alternatives. For example, exposed targets do not support a JSON external file
format, so JSON output recommends `OPENROWSET` with `OPENJSON` instead.

SQL Server 2019 does not generate Parquet or Delta file access. SQL Server 2022
and later generate Parquet and Delta `OPENROWSET`/external-table scripts against
supported object storage. Azure data sources use `abs://` for Blob Storage or
`adls://` for ADLS Gen2 without the retired `TYPE = HADOOP` option.
`REJECT_TYPE`/`REJECT_VALUE` are emitted only for SQL Server 2019 `TYPE = HADOOP`
sources, because modern `abs://`, `adls://`, and Fabric sources reject them.

### Azure SQL Database and Managed Instance

Azure SQL Database and Azure SQL Managed Instance support data virtualization
over Azure Blob Storage and ADLS Gen2: `CREATE EXTERNAL DATA SOURCE`,
`CREATE EXTERNAL FILE FORMAT`, `CREATE EXTERNAL TABLE`, and `OPENROWSET` for CSV
and Parquet. Delta external file format is available on Azure SQL Database and
not on Managed Instance.

`BULK INSERT` on these targets requires a separate `TYPE = BLOB_STORAGE`
external data source, so generated scripts create a companion
`<data_source>_Bulk` source and use a container-relative `FROM` path plus
`DATA_SOURCE`. An absolute `https://` URL is never emitted as the `FROM` value.

### Microsoft Fabric SQL Database

Fabric SQL Database data virtualization is in preview. It supports
`CREATE EXTERNAL DATA SOURCE`, `CREATE EXTERNAL FILE FORMAT`,
`CREATE EXTERNAL TABLE`, and `OPENROWSET` over a **Fabric Lakehouse `Files`
path** using an explicit `IDENTITY = 'USER IDENTITY'` database scoped
credential for **Microsoft Entra passthrough**. No embedded secret or database
master key is created.

Constraints reflected in generated output:

- Sources must resolve to a Lakehouse `Files` path, for example
  `abfss://<workspace_id>@<tenant>.dfs.fabric.microsoft.com/<lakehouse_id>/Files`.
- CSV and Parquet external tables are supported. JSON is indirect: read as CSV
  and shred with `OPENJSON`.
- Delta is not supported by Fabric SQL Database `OPENROWSET`.
- `BULK INSERT` and `COPY INTO` are unavailable; `OPENROWSET` with
  `SELECT ... INTO` or `INSERT ... SELECT` is generated instead.
- OneLake shortcuts can bring external storage into the Lakehouse `Files` area,
  but the external data source still points at the Lakehouse path.
- Fabric guidance never recommends Synapse-only syntax such as
  `PARSER_VERSION` or `HEADER_ROW`.

## Installation

### VS Code extension (no Python required)

The extension is self-contained. Installing it does not create a virtual
environment, install a package, start a server, choose a port or open a browser
tab. Nothing outside the `.vsix` is downloaded or executed.

```bash
npm install
npm run package     # writes dist/sql-file-detection-tool-2.1.0.vsix
code --install-extension dist/sql-file-detection-tool-2.1.0.vsix --force
```

The package contains a single bundled JavaScript file, the webview assets, the
icons and the documentation. It contains no `.py` file, no `pyproject.toml`, no
wheel, no `node_modules` and no test fixture, and this is asserted mechanically
on every test run rather than left to review:

```bash
npm run audit:vsix
```

### Optional Python CLI

The CLI and the local web application are **separate, optional compatibility
tooling**. Install them only if you want to script analysis outside VS Code or
need one of the Python-only integrations (managed identity, ORC, Spark). The
extension never installs, launches or requires any of this.

Python 3.9 or newer is required.

```bash
python -m pip install .
```

For development and tests:

```bash
python -m pip install -e ".[test]"
```

Optional integrations:

```bash
python -m pip install ".[s3]"
python -m pip install ".[azure]"
python -m pip install ".[delta]"
python -m pip install ".[spark]"
python -m pip install ".[all]"
```

`all` installs every optional runtime integration. Test dependencies are kept
in the separate `test` extra.

## CLI

The primary console script is `sql-file-detection-tool`. `external-file-detector`
remains as an alias for existing automation; both accept identical arguments.

Analyze a local directory:

```bash
sql-file-detection-tool analyze C:\data --data-source MyDataSource
```

That command targets Azure SQL Database, the default. Pass
`--target-platform sql_server_2022` to select something else:

```bash
sql-file-detection-tool analyze C:\data --data-source MyDataSource \
  --target-platform sql_server_2022
```

Analyze selected local or remote files:

```bash
sql-file-detection-tool analyze-files orders.csv events.ndjson --format json
sql-file-detection-tool analyze-files s3://my-bucket/data/orders.csv \
  --target-platform sql_server_2025
```

`--target-platform` is available on `analyze`, `analyze-files`, and
`generate-data-source`. Accepted values are `sql_server_2019`,
`sql_server_2022`, `sql_server_2025`, `azure_sql_db`, `azure_sql_mi`, and
`fabric_sql_db`. **The default is `azure_sql_db`.**

Because Azure SQL Database cannot read a local path, analyzing a local file with
the default platform adds an explicit "stage the data in Azure Storage first"
prerequisite block to the generated script instead of presenting the local path
as directly runnable.

Generated SQL output is now complete rather than a single statement. Each file
produces one script containing every applicable section - prerequisite
credential/data source setup, external file format, external table, regular
table, `BULK INSERT`, and `OPENROWSET` - joined in dependency order with `GO`
batch separators. JSON-specific reading help appears inside `OPENROWSET` only
for JSON input. The regular table and the external table are given distinct
names (for example `orders` and `ext_orders`) so the whole script can run
without object-name collisions.

### Generated-script contract

Treat a generated script as **a reviewable, ordered document**, not as
something to run unread. Sections whose prerequisites cannot be known from the
file alone contain placeholders - `<SAS_token_without_leading_?>`,
`<storage_account>`, `<master_key_password>` and similar. Replace every
placeholder and delete the sections you do not want before executing anything.
Sections that are unavailable on the selected platform are emitted as comments
explaining why, so the ordering stays stable across platforms.

Behaviour worth knowing when you consume `generate_complete_ddl` or the
`/api/sql_ddl` endpoint:

- **JSON help is contextual.** `OPENJSON` guidance appears in the `OPENROWSET`
  output only when the selected file is JSON. JSON-only and `FOR JSON` sections
  are not added to the complete loading document.
- **Multi-file export deduplicates shared prerequisites.** When several files
  are exported into one `.sql` file, master keys, database scoped credentials,
  external data sources and external file formats are created once. Later
  repeats are replaced with a comment naming the file that already created
  them, so file 2 onwards no longer fails with "already exists".
- **Remote CSV bulk loads never use an absolute URL as a local path.** For
  Azure Blob / ADLS input the script creates a dedicated
  `TYPE = BLOB_STORAGE` data source named `<data_source>_Bulk` and emits a
  relative `FROM 'container-relative/path.csv'` plus `DATA_SOURCE`. The
  `abs://`/`adls://` source is kept separately for external tables, which
  cannot be backed by a `BLOB_STORAGE` source. S3 bulk access is emitted only
  for SQL Server 2022/2025.
- **`storage_url` is what the SQL engine sees.** Pass the full location
  (`abs://`, `adls://`, `abfss://`, `wasbs://`, `s3://` or an `https://`
  storage URL). Omit it for local input; Azure SQL and Fabric cannot read a
  local path, so the file must be staged in reachable storage first.
- **`resolve_table_name(metadata, table_name)`** returns the regular table name
  a call will actually use: blank derives it from the file name, a supplied
  value is cleaned but preserved. `/api/sql_ddl` returns both
  `resolved_table_name` and `derived_table_name` alongside the statements.
- **`FIRST_ROW` in `CREATE EXTERNAL FILE FORMAT`** is emitted for SQL Server
  2022/2025, Azure SQL Database and Fabric SQL Database. For SQL Server 2019 and
  Azure SQL Managed Instance a comment explains that it is not a valid
  `FORMAT_OPTIONS` entry there. `FIRSTROW` (no underscore) in `OPENROWSET` and
  `BULK INSERT` is unaffected.
- **`USE_TYPE_DEFAULT` is `FALSE` and always stated.** The default the engine
  would otherwise apply replaces a missing value with `0` or an empty string,
  which silently destroys the difference between "no value" and "zero". The
  generator writes the option out explicitly so the choice is visible in the
  script rather than inherited.
- **Storage paths are reproduced with their original case.** Blob and ADLS
  paths are case sensitive: asking for `Yellow/` when the container holds
  `yellow/` fails with error 13807, "the directory cannot be listed". Nothing in
  the generator normalises the case of a path you pass in.
- **Whole-file reads pick the single-LOB keyword from the encoding.** A UTF-16
  file read with `SINGLE_CLOB` fails with error 4806 because that keyword wants
  a DBCS file; the generated script uses `SINGLE_NCLOB` for UTF-16 input.

#### Naming and authentication

Every generated object name is caller-controlled, on both the CLI and the
extension. This matters more than it sounds: without an explicit schema, a file
called `orders.csv` produces a table called `dbo.orders`, and on a warehouse
that is very likely an existing table.

| CLI option | Extension field | Effect |
| --- | --- | --- |
| `--schema` | **Schema** | Schema every generated object is created in. Set it to keep output out of `dbo`. |
| `--table` | **Table name** | Explicit table name instead of one derived from the file name. |
| `--credential-name` | **Credential name** | Name for the generated database scoped credential. |
| `--auth-method` | **Storage authentication** | `managed_identity` (default where supported), `sas`, `storage_key`, or `public`. |

The default is unchanged: with no `--schema`/`--table`, `orders.csv` still
produces `dbo.orders`. The overrides exist so you can avoid that, and both the
CLI and the extension propagate them through every generated statement,
including a multi-file export.

`managed_identity` is the default on Azure SQL Database, Azure SQL Managed
Instance and SQL Server 2022/2025 because it stores no secret. A credential
created with `IDENTITY = 'MANAGED IDENTITY'` needs no database master key, so
there is no master key password to invent, store or rotate, and the generated
script does not create one. Choose `sas` only when a managed identity is not
available; the master key section returns when you do. Grant the identity
**Storage Blob Data Reader** on the container.

### Verified by this project against live engines

This is project-run compatibility testing, **not Microsoft certification**.
Rules marked `live` in `tests/certification/expected-matrix.json` are not
inferred from documentation. They were run against a live Azure SQL Database
(12.0.2000.8) and a live SQL Server 2025 instance (17.0.1000.7), and the
findings are recorded there as machine-readable rules. Rules marked `static`
describe generator behaviour that the suites pin but that no live engine run
settled. Both test suites read that file, so neither the TypeScript nor the
Python generator can drift away from what the engines actually did.

What the live runs settled:

- **Whole-document JSON** reads through a `TYPE = BLOB_STORAGE` data source with
  `SINGLE_CLOB`. The widely repeated claim that `SINGLE_CLOB` cannot be combined
  with `DATA_SOURCE` is wrong on both engines.
- **NDJSON** does not. An `https` `BLOB_STORAGE` source rejects row-framing
  options with error 5369, so newline-delimited JSON is read through an `abs://`
  virtualization source with CSV row framing instead. The generator picks the
  source by the shape of the JSON.
- **ORC**: `CREATE EXTERNAL FILE FORMAT ... FORMAT_TYPE = ORC` is accepted and
  dropped cleanly. The canonical ORC fixture is published, but the production
  path does not execute ORC row reads, so that data path is **not verified**.
  This is separate from the native reader, which recognises ORC without parsing
  it.
- **RCFile** is rejected outright (error 46506), and there is no JSON external
  file format (error 102) - both as expected.
- **Excel and Iceberg** never fall through to a `DELIMITEDTEXT` format. They
  produce explicit guidance instead of a statement that would misread the file.
- **`DATETIMEOFFSET` fidelity holds**: an offset survives round-tripping and
  `DATEPART(TZOFFSET)` returns it. A test that reads it back with `CONVERT`
  style 127 will disagree, because style 127 normalises to UTC - use style 121.
- **UTF-16 `BULK INSERT` with `CODEPAGE = '1200'` preserves content**, so the
  generator does not force `DATAFILETYPE = 'widechar'`. Exact UTF-16 CSV and
  TSV fixtures both passed against the canonical public bytes.
- **Flat Parquet external tables** pass against the canonical public fixture,
  while nested list/struct/map fields produce explicit flattening guidance
  instead of broken scalar columns.

Earlier exact-fixture VM attempts returned SQL Server error 16560 for Parquet
nanosecond and timezone timestamp columns. Those errors informed
statement-specific `BIGINT` and `DATETIME2` mappings, respectively. The mapping
branches are pinned by Python/native parity and focused tests; they are not
claimed as successful live execution because the nested all-types fixture is
rejected before an external table is emitted.

The harness that produced this evidence lives in `scripts/certification/` and is
not part of the published package. See its
[README](scripts/certification/README.md) for the safety model.

Final run, both engines, no failures:

| | SQL Server 2025 | Azure SQL Database |
| --- | --- | --- |
| PASS | 24 | 29 |
| FAIL | 0 | 0 |
| NOT_EXECUTABLE | 7 | 6 |
| BLOCKED (negative control) | 1 | 1 |
| Accepted verdicts | 31 | 36 |
| Confirmed defects | 0 | 0 |
| Cleanup statements succeeded | 48 / 48 | 63 / 63 |

Cleanup was verified independently after both runs: zero residual certification
schemas, objects, credentials, data sources, file formats, databases or agent
jobs on either engine, and the pre-existing external object counts were
unchanged. Every individual cleanup statement is recorded with its outcome, and
in the final runs every one of them succeeded.

`NOT_EXECUTABLE` is honest coverage rather than a failure. Remaining cases are
engine-local reads unavailable to Azure SQL, nested Parquet external tables,
and formats without an executable external-file-format construct (Excel,
Iceberg, and JSON). A `BLOCKED` cell on each engine is the deliberate negative
control: a statement the safety gate is supposed to refuse, proving the gate was
live for the whole run.

Export generated output:

```bash
sql-file-detection-tool analyze C:\data --output analysis.sql
sql-file-detection-tool analyze C:\data --format json --output analysis.json
```

Point the generated SQL at a cloud location with `--storage-url`:

```bash
sql-file-detection-tool analyze-files C:\data\orders.csv \
  --storage-url "abs://data@acct.blob.core.windows.net/raw/orders.csv"
```

List a location or inspect supported types:

```bash
sql-file-detection-tool list-files C:\data
sql-file-detection-tool supported-types
```

Generate an external data source statement:

```bash
sql-file-detection-tool generate-data-source MyDataSource azure \
  "https://account.blob.core.windows.net/container"
```

Cloud credential options are available on `analyze`, `analyze-files`, and
`list-files`. Prefer their environment-variable equivalents:

| Provider | Environment variables |
| --- | --- |
| AWS | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION` |
| Azure | `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_KEY`, `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_SAS_TOKEN` |

`--azure-auth-mode` selects the sign-in explicitly - `entra_default`,
`entra_interactive`, `managed_identity`, `sas`, `connection_string`,
`account_key` or `anonymous`. See
[Azure Storage authentication](#azure-storage-authentication).

Run `sql-file-detection-tool COMMAND --help` for complete command options.

## Azure Storage authentication

This section describes the **Python** package (CLI and web application). The VS
Code extension's own four native modes are described under
[VS Code extension](#vs-code-extension).

The tool attaches to Azure Storage the same way Azure Storage Explorer does.
Every mode is chosen explicitly; a failed Microsoft Entra ID sign-in is **never**
silently downgraded to anonymous or shared-key access.

| Mode | Id | Use it for |
| --- | --- | --- |
| Microsoft Entra ID (recommended) | `entra_default` | Reuses an existing Azure CLI, Azure PowerShell or VS Code developer sign-in |
| Microsoft Entra ID (interactive) | `entra_interactive` | Opens a browser sign-in; the refresh token is cached in the OS-protected store where the platform supports it |
| Managed identity | `managed_identity` | **The production choice.** Selects `ManagedIdentityCredential` explicitly, optionally user-assigned via `AZURE_CLIENT_ID` |
| VS Code sign-in | `vscode_token` | The extension brokers a token from VS Code's Microsoft auth provider |
| Shared access signature | `sas` | A SAS URL or bare SAS token |
| Connection string | `connection_string` | A full storage connection string |
| Account key | `account_key` | Least preferred; use only when nothing else is possible |
| Anonymous | `anonymous` | Public read-only containers |

### Recommended: Azure RBAC

Grant the signed-in identity **Storage Blob Data Reader** on the storage account
or container. That is the minimum required for read-only browsing and analysis.
Owner/Contributor on the *control plane* does not grant data-plane access.

```bash
az role assignment create \
  --role "Storage Blob Data Reader" \
  --assignee "<object-id>" \
  --scope "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<account>"
```

### Production guidance

`entra_default` is intentionally limited to local and developer use: an
unpredictable credential chain is not acceptable in production. In an Azure-hosted
deployment select `managed_identity`, which builds `ManagedIdentityCredential`
directly:

```bash
export AZURE_CLIENT_ID="<user-assigned-identity-client-id>"   # omit for system-assigned
sql-file-detection-tool analyze abs://data@acct.blob.core.windows.net/raw \
  --azure-auth-mode managed_identity
```

### How secrets are handled

- SAS tokens, connection strings and account keys are held **in memory only**,
  scoped to one browser session, and dropped on disconnect or when the
  connection's TTL expires.
- Nothing secret is written to a setting, a log line, a URL, a response body,
  `localStorage`, a file, or Git.
- SAS query strings and connection strings are redacted from every displayed
  path, error message and generated diagnostic.
- Access tokens are never placed in a URL, an environment variable, or a
  command-line argument.
- Credential inputs in the web UI are password fields, and the connection status
  shows only a masked hint such as `****3f9c`.

No Microsoft Entra application registration is created. The tool uses VS Code's
built-in Microsoft authentication provider and the Azure Identity public-client
developer flows, so there is no client secret anywhere in this project.

### Azure explorer in the web UI

The **Azure Storage** button opens an explorer showing the current sign-in and
identity, connect/disconnect, a subscription picker (when an ARM token is
available), a storage-account picker, containers, prefix/folder navigation,
blobs, and an **Analyze** action. Listing is bounded and paged.

Subscription enumeration needs an ARM token. When it is unavailable - a SAS,
connection string or account-key attachment, for example - the picker is hidden
and you can still browse a known account by name.

## VS Code extension

The repository root is also a VS Code extension, version **2.1.0**. See
[Installation](#vs-code-extension-no-python-required) to build and install it.

The extension is **fully native**. It does not create a virtual environment,
install a package, start a server, choose a port or open a browser. Everything
runs in the extension host in TypeScript. Python is not required, and is never
installed or launched on your behalf.

### Startup and analysis cost

Measured against the packaged bundle, with `PATH` emptied and `child_process`,
`http`, `https`, `net` and `dns` all sabotaged, so nothing can be attributed to
a subprocess or the network. These are the numbers from the reference machine
(Windows, Node 20); they are also asserted as regression guards with enough
slack for a shared CI runner.

| Step | Measured | Guard |
| --- | --- | --- |
| Load the bundle (cold `require`) | 86 ms | < 1500 ms |
| `activate()` | 0.8 ms | < 500 ms |
| Activity Bar click to editor panel | 0.8 ms | < 400 ms |
| Subsequent Activity Bar click | 0.2 ms | < 100 ms |
| First analysis of a 5-column CSV | 30 ms | < 8000 ms |
| Re-analysis of the same file | 4 ms | < 2000 ms |
| Heap retained after 20 repeat analyses | 3.0 MiB | < 96 MiB |
| Packaged `.vsix` | 619 KiB (17 files) | < 5 MB |

There is no setup step to measure, because there is no setup step. Activation
is triggered by the Activity Bar view, a command or a context-menu action -
never at VS Code startup.

Commands (Command Palette, prefix **SQL File Detection Tool**):

| Command | Purpose |
| --- | --- |
| `Open` | Opens the native interface in an editor tab by default |
| `Open in Editor` | Opens or focuses the editor tab explicitly |
| `Analyze Current File` | Analyzes the active editor's file |
| `Analyze with SQL File Detection Tool` | Explorer / editor context menu, on the exact target |
| `Connect to Azure Storage` | Signs in through VS Code |
| `Disconnect Azure Storage` | Clears every credential, in memory and in secret storage |

### Editor panel and Activity Bar

Selecting the **SQL File Detection Tool** container opens the complete interface
in an editor tab and closes the temporary sidebar. **Preview** is the first and
default tab, with a persistent source/file navigator and real rows from the
selected file. Metadata, Schema, focused loading-statement tabs, the guided
credential/data-source setup, public HTTPS URLs, and the Azure Storage browser
remain available. Set `sqlFileDetectionTool.defaultView` to `sidebar` to keep the interface in the
Activity Bar instead. There is no loading state to wait through and nothing to install; see
[Startup and analysis cost](#startup-and-analysis-cost) for the measurements.

Folder detection remains per file. The folder profile reports **Mixed** and an
outlier count when formats, delimiters, encodings, or schemas differ; it never
applies the selected file's parser facts to every file. Local paths expose direct
SQL Server/UNC reads where supported and otherwise say that staging is required,
rather than inventing a cloud external source.

- The webview has a strict, nonce-bound Content Security Policy with
  `default-src 'none'` and no `connect-src`, so the renderer has no network
  access at all. There is one local nonced script, no inline handlers and no
  remote assets.
- The webview can never name a file. It sends an opaque, host-minted random id;
  the extension host resolves it to a path and its own allowed root and
  re-applies a realpath containment check on every read. File paths shown in the
  UI are rewritten to be root-relative first, though an operating-system error
  message surfaced after a failed read can still quote the full path back to the
  same user in the same window.
- No token, account key or SAS signature ever reaches the webview, the output
  channel, a setting, a URL or generated SQL.

The editor panel and sidebar share one state store, so they always agree.

### Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `sqlFileDetectionTool.defaultPlatform` | `azure_sql_db` | Target platform the UI preselects |
| `sqlFileDetectionTool.defaultView` | `editor` | Primary interface surface (`editor` or `sidebar`) |

The platform, the selected tab and the appearance preference are remembered in
workspace and global state. File contents and credentials are never persisted
there.

### Guided SQL credential setup

The **Credential setup** tab asks for the target SQL platform, storage service,
authentication method, and object names. Each choice immediately constrains the
next one:

| Target | Storage choices | Guided authentication |
| --- | --- | --- |
| SQL Server 2019 | Azure Blob, ADLS Gen2 | SAS |
| SQL Server 2022 | Azure Blob, ADLS Gen2, OneLake through ADLS, S3 | SAS; S3 access key for S3 |
| SQL Server 2025 | Azure Blob, ADLS Gen2, OneLake through ADLS, S3 | SAS or user-assigned managed identity; S3 access key for S3 |
| Azure SQL Database | Azure Blob, ADLS Gen2, OneLake through ADLS | Managed identity, Microsoft Entra `USER IDENTITY`, or SAS |
| Azure SQL Managed Instance | Azure Blob, ADLS Gen2, OneLake through ADLS | Managed identity or SAS |
| Fabric SQL Database | Fabric OneLake only, using ABFSS | Microsoft Entra `USER IDENTITY` |

SQL Server 2025 managed identity requires an Azure Arc-enabled instance with the
selected user-assigned identity configured. The wizard never asks for or stores
a SAS token, S3 access key, or master-key password. It emits clearly marked
placeholders for secret-bearing methods so the values can be supplied later in
a secure SQL editor.

### Azure Storage in the extension

Four authentication modes, all handled in the extension host:

| Mode | Credential | Notes |
| --- | --- | --- |
| VS Code sign-in (recommended) | Microsoft account token via `vscode.authentication` | Refreshed before expiry; enables subscription and account discovery |
| SAS URL | SAS token | Signature is split off immediately and never displayed |
| Connection string | Account key | Entered through a masked input box; endpoint pinned from the string |
| Anonymous | none | Public containers only |

Remembering a credential in VS Code `SecretStorage` is opt-in and defaults to
no. Disconnecting, and deactivating the extension, clear memory *and* delete the
stored secret. Managed identity is deliberately **not** offered as an extension-host sign-in,
because a desktop extension does not have one. The separate **Credential setup**
wizard can still generate `MANAGED IDENTITY` T-SQL for database platforms that
support it; it never attempts to authenticate the desktop extension that way.

### Relationship to the Python CLI

The CLI and the Flask web application documented elsewhere in this README still
work and are still tested, but they are **optional compatibility tooling**, not
part of the extension. No command, view or menu in the extension reaches them,
and version 2.0.0 removed the last of the backend-lifecycle code: there is no
`backend.ts`, no `pythonEnv.ts`, no `process.ts` and no port or health-check
module left in the extension sources.

The two distributions version independently. The extension is at 2.1.0; the
Python distribution keeps its own version line, because nothing about the CLI
changed when the extension stopped using it.

For the full design - message flow, CSP, file-identity model, Azure threat model
and SSRF policy - see [`docs/native-ui.md`](docs/native-ui.md).

## Web interface

The Flask web application below is **optional legacy compatibility**. It is not
used by the VS Code extension and is never started by it.

```bash
sql-file-detection-tool gui --root-dir C:\data
```

Open `http://127.0.0.1:5000`. The built-in Flask server is intentionally
loopback-only because its filesystem APIs do not provide authentication.
`--root-dir` limits browsing and analysis to one directory tree.

State-changing and Azure endpoints additionally require a per-browser-session
token sent in the `X-SQLFDT-Session` header. The token is rendered into the page
and available from `GET /api/session`; CORS stays closed.

### Web UI controls

- **Theme.** The header carries a light/dark toggle. The first visit follows
  the operating system's `prefers-color-scheme`; an explicit choice is stored
  in `localStorage` under `efd-theme` and applied before first paint so the
  page never flashes the wrong theme. All colours come from CSS custom
  properties, so both themes stay coherent.
- **Target table (optional).** Leave it blank to derive the table name from the
  selected file's name; the derived name is shown next to the field. Typing a
  value overrides it everywhere - `CREATE TABLE`, `BULK INSERT`, `OPENROWSET`
  and the validation queries. The override is cleared when you select a
  different file.
- **Data URL / storage location.** One field takes the complete location the
  SQL engine will use (`abs://`, `adls://`, `abfss://`, `wasbs://`, `s3://`,
  `azure://` or an `https://` storage URL) and is passed through as
  `storage_url`. The parsed scheme, host, container and relative path are shown
  as feedback. It is filled in automatically for remotely analysed files and
  left blank for local ones, with a reminder that cloud SQL needs the file
  staged in reachable storage.
- **Public dataset URL.** See below.
- **Target platform.** The selector lists Azure SQL Database first and
  preselects it. Compatibility indicators reflect the selected platform.
- **Azure Storage.** Opens the Azure explorer described above.

### Deep links

The UI accepts query parameters so the VS Code commands can open it on a
specific target:

| Parameter | Effect |
| --- | --- |
| `?path=<file>` | Selects and analyses that file |
| `?folder=<dir>` | Browses and analyses that folder |
| `?azure=1` | Opens the Azure Storage explorer on load |

### Public dataset URL workflow

The **Public dataset URL** button accepts either a direct `https://` data file
or an Azure Open Datasets page on `learn.microsoft.com`.

- A **direct data URL** (`.csv`, `.tsv`, `.dat`, `.json`, `.jsonl`, `.ndjson`,
  `.parquet`, `.snappy`, `.orc`, `.rc`, `.txt`) is streamed into the current
  session's temporary upload area, analysed and previewed like an upload. The
  original URL is retained for SQL generation.
- A **catalog page** such as
  `https://learn.microsoft.com/en-us/azure/open-datasets/dataset-catalog`
  lists many datasets, so nothing is chosen for you: the catalog is resolved
  into a searchable list of dataset detail pages.
- A **dataset detail page** is parsed for the storage locations it documents.
  If exactly one downloadable file is documented it is used directly;
  otherwise the candidates are listed for you to choose. Folder and wildcard
  candidates such as `abs://container@account.blob.core.windows.net/x/*.parquet`
  are resolved through a bounded anonymous Azure Blob listing to one
  representative file for metadata, while the documented location is what ends
  up in the generated SQL.
- HTML pages are never analysed as data, and catalog resolution is kept
  separate from data analysis.

Limits and safeguards, all enforced on every request including each redirect:
HTTPS only; URLs containing credentials are rejected; host names are resolved
and any loopback, private, link-local, multicast, reserved or unspecified
IPv4/IPv6 answer is refused; at most five redirects; `Content-Length` and the
actual streamed byte count are both capped at 200 MB (4 MB for HTML); separate
connect/read timeouts; catalog HTML discovery is restricted to the
`learn.microsoft.com/.../azure/open-datasets/` path; downloaded names are
sanitised and written only inside the session's temporary directory; partial
downloads are removed on failure.

Generated SQL only claims a URL is directly readable when it really is. Azure
Blob and ADLS URLs keep their storage semantics; a file fetched from an
arbitrary public web server is reported as needing staging, because no SQL
Server, Azure SQL or Fabric engine can read it in place.

API routes: `POST /api/public_dataset/resolve`,
`POST /api/public_dataset/candidate`, `POST /api/public_dataset/fetch`. All
three return `{"success": false, "error": ..., "code": ...}` with a meaningful
HTTP status on failure.

For remote access, use `external_file_detection.web_ui.create_app()` behind an
authenticated production WSGI server and reverse proxy. Do not expose the
built-in development server.

Production WSGI guidance:

- **Run exactly one worker process.** Analysis sessions and uploaded files are
  stored in process-local memory and process-local temporary directories, so
  multiple workers will serve inconsistent results and leak upload directories.
  Use `gunicorn --workers 1` (threads are fine) or `waitress-serve` with a
  single process.
- **Set a stable random `FLASK_SECRET_KEY`.** Without it a new key is generated
  per process start, which invalidates every existing session cookie on restart.
  Generate one once with `python -c "import secrets; print(secrets.token_hex(32))"`
  and supply it through the environment or your secret store.
- **Use `managed_identity` for Azure Storage**, not `entra_default`.

## Python API

```python
from external_file_detection import (
    DEFAULT_TARGET_PLATFORM, FileDetector, SQLGenerator,
)

assert DEFAULT_TARGET_PLATFORM == "azure_sql_db"

detector = FileDetector()
metadata = detector.analyze_file_metadata("orders.parquet")

generator = SQLGenerator()

# Azure SQL Database by default.
statements = generator.generate_all_statements(
    metadata,
    table_name="orders",
    data_source="MyDataSource",
)

# Another platform, selected explicitly.
statements = generator.generate_all_statements(
    metadata,
    table_name="orders",
    data_source="MyDataSource",
    target_platform="sql_server_2022",
)

print(statements["create_external_table"])
```

For location-level analysis:

```python
from external_file_detection import SQLFileDetectionApp

app = SQLFileDetectionApp()  # ExternalFileDetectorApp still works
result = app.analyze_location(r"C:\data", data_source="MyDataSource")
```

Attach to Azure Storage programmatically:

```python
from external_file_detection import azure_auth

connection = azure_auth.connect(azure_auth.AUTH_ENTRA_DEFAULT)
containers = azure_auth.list_containers(connection, account_name="myaccount")
```

## Analysis behavior

- Metadata and encoding caches are thread-safe, signature-based LRU caches.
- CSV and text row counts stream records instead of retaining file contents.
- NDJSON retains only a bounded schema sample while counting valid rows.
- Large JSON arrays use a bounded prefix sample; their row count is reported as
  unknown rather than guessed.
- Inferred CSV, JSON, and Excel columns default to nullable because a sample
  cannot prove future values are required.
- Sampled string lengths include sizing headroom before SQL types are generated.
- Parquet previews read bounded record batches rather than complete row groups.
- Iceberg row counts come from the current snapshot summary, not every Parquet
  file in the data directory.

## Development

Run the Python test suite:

```bash
python -m pytest -q
```

Build the VS Code extension and run its tests:

```bash
npm install
npm run typecheck
npm run lint
npm test               # compiles, bundles, then runs the node --test suites
npm run notices -- --check   # THIRD_PARTY_NOTICES.md matches the real bundle
npm audit --omit=dev         # production dependency tree
npm run package        # writes dist/sql-file-detection-tool-2.0.0.vsix
npm run audit:vsix     # mechanical content audit of that .vsix
```

`npm test` runs the bundle step first on purpose: `src/test/bundleRuntime.test.ts`
loads and activates `dist/extension.js` itself, so the artifact that ships is the
artifact that is tested, not just the `tsc` output beside it.

Build distributable packages:

```bash
python -m pip install build
python -m build
```

CI runs the tests on Linux and Windows and builds the wheel from
`pyproject.toml`.

### Native TypeScript core

`src/native/` holds the in-process TypeScript analysis and T-SQL generation
engine. It is the only engine the extension uses, and it is verified against the
Python implementation by a parity baseline - a golden-file comparison over the
committed fixtures, which is strong evidence of agreement rather than a proof of
equivalence:

```bash
python scripts/generate_parity_baselines.py --check   # baseline still matches Python
npm test                                              # Node suites compare against it
```

See [`docs/native-core.md`](docs/native-core.md) for the module layout, the
service API, the dependency and license choices, the format matrix, and the one
explicit limitation (ORC), and [`docs/native-ui.md`](docs/native-ui.md) for the
webview message flow, the CSP, and the Azure and SSRF threat models.

## Project layout

```text
package.json                 VS Code extension manifest
media/webview/               bundled renderer (main.js, main.css)
src/                         extension TypeScript sources
|-- extension.ts             activation and commands
|-- nativeView.ts            WebviewView/Panel provider and UiHost (vscode)
|-- protocol.ts              webview message contract and validation
|-- appState.ts              shared state store and opaque file registry
|-- azureScopes.ts           token scopes and expiry math
|-- util.ts                  pure helpers (no network, no process)
|-- ui/                      vscode-free UI layer
|   |-- controller.ts        all product logic
|   |-- host.ts              UiHost / AzureBridge seam
|   `-- webviewShell.ts      HTML shell, CSP, nonce
|-- azure/                   storage URLs, blob browsing, auth modes
|-- net/                     SSRF-hardened HTTPS, IP guard, public datasets
|-- native/                  native analysis + SQL generation core (see docs/)
|   |-- index.ts             public barrel
|   |-- service.ts           NativeAnalysisService facade
|   |-- analysis/            per-format analyzers
|   `-- sql/                 platform-aware T-SQL generator
`-- test/                    node --test suites
scripts/
|-- build.js                 esbuild bundle + shipped-artifact verification
|-- generate-notices.js      THIRD_PARTY_NOTICES.md from the real bundle
|-- audit-vsix.js            mechanical VSIX content audit
`-- certification/           live-engine certification harness (not shipped)
docs/
|-- native-core.md           native core architecture and parity notes
`-- native-ui.md             native UI, message flow, and threat models
external_file_detection/
|-- azure_auth.py
|-- cli.py
|-- external_file_detector.py
|-- file_detector.py
|-- public_data.py
|-- sql_generator.py
|-- storage_handlers.py
|-- web_gui.py
|-- web_ui.py
`-- templates/
demo/
|-- README.md
|-- generate_samples.py
|-- collation_samples.sql
`-- csv/ json/ parquet/ orc/ excel/ text/ tables/ unicode/
```

## Demo samples

`demo/` holds small, deterministic fixtures covering every supported input type
plus Unicode-encoding and SQL-collation cases. Regenerate them with:

```bash
python demo/generate_samples.py
```

See [`demo/README.md`](demo/README.md) for the full inventory, the Parquet to
SQL type mapping, encoding/codepage notes, and ready-to-run CLI commands per
platform.

## License

Licensed under the [MIT License](LICENSE).
