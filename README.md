# SQL File Detection Tool

SQL File Detection Tool analyzes data files and generates platform-aware
T-SQL loading and external-table guidance. It supports local files, Amazon S3,
and Azure Blob Storage through a CLI, a local web interface, and a VS Code
extension.

**Azure SQL Database is the default target platform.** Every entry point - CLI,
web UI, Python API, and VS Code extension - generates Azure SQL Database output
unless another platform is selected explicitly.

## See it in action

![A walkthrough of SQL File Detection Tool: opening it from the VS Code Activity
Bar, previewing a Parquet file, reviewing the detected column types, generating
Azure SQL Database T-SQL, and attaching Azure Storage.](media/sql-file-detection-tool-walkthrough.gif)

The walkthrough above, in text:

1. Select the **SQL File Detection Tool** icon in the VS Code Activity Bar. The
   sidebar starts the bundled Python backend and opens the full interface.
2. Drop in any supported file - Parquet, ORC, CSV, TSV, JSON, Excel, or a Delta
   or Iceberg table directory.
3. The **Preview** tab shows real rows read straight from the file. No import
   and no database connection are required.
4. The **Metadata** tab shows the detected column types, precision, nullability,
   encoding, and collation.
5. The **Platform** selector is preset to **Azure SQL Database**. Switch to SQL
   Server 2019-2025, Azure SQL Managed Instance, or Fabric SQL Database at any
   time.
6. **CREATE TABLE**, **BULK INSERT**, **OPENROWSET**, and **EXT TABLE** tabs hold
   the generated T-SQL. Azure SQL output for a local file includes an explicit
   "stage the data in Azure Storage first" prerequisite block.
7. **Azure Storage** offers eight explicit sign-in modes - Microsoft Entra ID,
   managed identity, SAS, connection string, account key, or anonymous - with no
   silent fallback between them.
8. **Public dataset URL** analyzes any `https://` data file directly.

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
- Samples CSV, JSON, and Excel data conservatively for SQL type inference.
- Reads Parquet metadata and bounded record batches.
- Reads Delta Lake metadata when the optional Delta dependency is installed.
- Selects current Apache Iceberg schemas and partition specs from table metadata.
- Generates `CREATE TABLE`, `BULK INSERT`, `OPENROWSET`, external-table,
  credential, JSON, and best-practice scripts where the target supports them.
- Keeps generated SQL aligned with SQL Server, Azure SQL, and Fabric SQL
  Database feature differences.
- Provides local, S3, and Azure Blob storage handlers.
- Signs in to Azure Storage the way Azure Storage Explorer does: Microsoft Entra
  ID, managed identity, SAS, connection string, or account key.
- Ships as an installable VS Code extension that bundles and manages the
  Python backend.

Generated SQL is a starting point. Review data types, credentials, paths, and
platform requirements before running it in a database.

## Supported inputs

| Input | Analysis |
| --- | --- |
| CSV and TSV | Delimiter, encoding, sampled schema, logical row count |
| JSON, JSONL, and NDJSON | Bounded schema sample, nesting, row count where available |
| Parquet | Arrow schema, row groups, compression, row count |
| Delta Lake directories | Delta metadata, or a bounded Parquet schema fallback |
| Apache Iceberg directories | Current schema, partition spec, snapshot row count |
| Excel | Bounded worksheet sample |
| Text | Encoding and streamed line count |
| ORC and RCFile | Format recognition and SQL format guidance |

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
path** using **Microsoft Entra passthrough** - no database scoped credential or
embedded secret is created.

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
table, `BULK INSERT`, `OPENROWSET`, JSON functions, `FOR JSON`, best practices,
and a `COPY INTO` availability section - joined in dependency order with `GO`
batch separators. The regular table and the external table are given distinct
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

- **JSON sections are gated to JSON input.** The `OPENJSON`/`JSON_VALUE` parse
  and DML section is emitted only when `metadata['file_type'] == 'json'`. It is
  no longer produced for CSV, Parquet, Delta or Excel input. `FOR JSON` is kept
  for every file type because it only describes exporting query results.
- **`@json` is declared at most once per `GO` batch**, so a complete script can
  be executed batch by batch without `Variable name '@json' has already been
  declared` errors.
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
- **`FIRST_ROW` in `CREATE EXTERNAL FILE FORMAT`** is emitted only for SQL
  Server 2022/2025 and Fabric SQL Database. For SQL Server 2019 and Azure SQL
  Database/Managed Instance a comment explains that it is not a valid
  `FORMAT_OPTIONS` entry there. `FIRSTROW` (no underscore) in `OPENROWSET` and
  `BULK INSERT` is unaffected.

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

The repository root is also a VS Code extension. Build and install it locally:

```bash
npm install
npm run package          # writes dist/sql-file-detection-tool-<version>.vsix
code --install-extension dist/sql-file-detection-tool-<version>.vsix
```

Commands (Command Palette, prefix **SQL File Detection Tool**):

| Command | Purpose |
| --- | --- |
| `Open` | Starts the backend and opens the UI |
| `Analyze Current File` | Opens the UI with the active editor's file analyzed |
| `Analyze Workspace Folder` | Analyzes a workspace folder |
| `Connect to Azure Storage` | Signs in through VS Code and brokers the token to the backend |
| `Disconnect Azure Storage` | Clears the brokered token and every connection |
| `Stop Backend` | Stops the Python process |
| `Set Up Backend` | Creates or repairs the managed Python environment |
| `Show Output` | Reveals the output channel |

Supported files and Delta/Iceberg directories also get an **Analyze with SQL File
Detection Tool** entry in the Explorer context menu.

### Activity Bar

The extension contributes a **SQL File Detection Tool** container to the VS Code
Activity Bar. Selecting it reveals a compact sidebar with the product name, the
current backend state, and buttons for **Open Tool**, **Analyze Current File**,
**Connect Azure Storage**, and **Stop Backend**. If the backend fails to start,
the sidebar shows the failure and a **Retry** button.

Revealing the container starts or reuses the managed backend and opens or focuses
the interface. A few details worth knowing:

- The extension activates on the view, not at VS Code startup, and it ignores a
  reveal that looks like VS Code restoring the previous layout — one that
  arrives while the window is still coming up or is not yet focused. Restoring
  the container from a previous session therefore does **not** launch a backend
  on its own; only a deliberate click does. Selecting the container at any later
  point is always treated as a click.
- Clicking again focuses the interface that is already open. It never starts a
  second backend process or opens a duplicate tab.
- Set `sqlFileDetectionTool.openOnActivityBarClick` to `false` to keep the
  sidebar passive. The **Open Tool** button still works.
- The sidebar webview has a strict, nonce-bound Content Security Policy, no local
  resource roots, and carries no URL, port, or token. It can only send a fixed
  allowlist of command messages to the extension.

### Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `sqlFileDetectionTool.defaultPlatform` | `azure_sql_db` | Target platform the UI preselects |
| `sqlFileDetectionTool.openOnActivityBarClick` | `true` | Open the interface when the Activity Bar container is revealed |
| `sqlFileDetectionTool.pythonPath` | `""` | Interpreter used to *create* the managed environment |
| `sqlFileDetectionTool.backendInterpreter` | `""` | Escape hatch: run the backend with an existing interpreter instead of the managed one |
| `sqlFileDetectionTool.installAzureExtras` | `true` | Install the `[azure]` extra into the managed environment |
| `sqlFileDetectionTool.host` | `127.0.0.1` | Loopback bind address |
| `sqlFileDetectionTool.rootDirectory` | `""` | Directory the backend may read local files from. Empty means "pick automatically" (see below) |
| `sqlFileDetectionTool.openIn` | `simpleBrowser` | `simpleBrowser` or `externalBrowser` |

### How the extension works

- On first use it creates a virtual environment under the extension's
  `globalStorageUri` and installs the bundled project with the `[azure]` extra.
  Your workspace interpreter is never modified.
- The backend is spawned with an argument array (never a shell string) on a
  dynamically chosen free loopback port, and the extension waits on
  `/api/health` before opening anything.
- The backend confines every local read to one **analysis root**, passed as
  `--root-dir`. When `sqlFileDetectionTool.rootDirectory` is empty the extension
  picks the workspace folder containing the file you asked about, falling back to
  the first workspace folder and then your home directory. Analyzing a file
  outside the current root restarts the backend with a root that contains it.
- A cryptographically random per-process control token is passed to the backend
  through its environment, read once at start-up and removed from the
  environment. Control endpoints compare it with `hmac.compare_digest`.
- `Connect to Azure Storage` acquires Microsoft tokens through
  `vscode.authentication.getSession('microsoft', ...)` and posts them to the
  protected control endpoint over loopback. Tokens live in memory, are refreshed
  before expiry, and are cleared on sign-out and on deactivate.
- The status bar and output channel report backend state with every secret
  redacted.

## Web interface

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

- A **direct data URL** (`.csv`, `.tsv`, `.json`, `.jsonl`, `.ndjson`,
  `.parquet`, `.orc`, `.txt`, `.xlsx`, `.xls`) is streamed into the current
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
npm test
npm run package
```

Build distributable packages:

```bash
python -m pip install build
python -m build
```

CI runs the tests on Linux and Windows and builds the wheel from
`pyproject.toml`.

### Native TypeScript core

`src/native/` holds an in-process TypeScript port of the analysis and T-SQL
generation logic, built so the extension can eventually drop its Python backend.
It is not on the shipped runtime path yet — no extension source imports it — but
it is proven against the Python implementation by a parity baseline:

```bash
python scripts/generate_parity_baselines.py --check   # baseline still matches Python
npm test                                              # Node suites compare against it
```

See [`docs/native-core.md`](docs/native-core.md) for the module layout, the
service API, the dependency and license choices, the format matrix, and the one
explicit limitation (ORC).

## Project layout

```text
package.json                 VS Code extension manifest
src/                         extension TypeScript sources
|-- extension.ts             activation and commands
|-- backend.ts               Python backend lifecycle
|-- pythonEnv.ts             managed virtual environment
|-- azureSignIn.ts           VS Code Microsoft token brokering
|-- process.ts               spawn helpers (no vscode import)
|-- azureScopes.ts           token scopes and expiry math
|-- util.ts                  ports, URLs, redaction
|-- native/                  native analysis + SQL generation core (see docs/)
|   |-- index.ts             public barrel
|   |-- service.ts           NativeAnalysisService facade
|   |-- analysis/            per-format analyzers
|   `-- sql/                 platform-aware T-SQL generator
`-- test/                    node --test suites
docs/
`-- native-core.md           native core architecture and parity notes
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
