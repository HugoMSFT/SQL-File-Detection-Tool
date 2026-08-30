# SQL External File Detector

SQL External File Detector analyzes data files and generates platform-aware
T-SQL loading and external-table guidance. It supports local files, Amazon S3,
and Azure Blob Storage through a CLI and a local web interface.

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

Analyze a local directory:

```bash
external-file-detector analyze C:\data --data-source MyDataSource \
  --target-platform sql_server_2022
```

Analyze selected local or remote files:

```bash
external-file-detector analyze-files orders.csv events.ndjson --format json
external-file-detector analyze-files s3://my-bucket/data/orders.csv \
  --target-platform azure_sql_db
```

`--target-platform` is available on `analyze`, `analyze-files`, and
`generate-data-source`. Accepted values are `sql_server_2019`,
`sql_server_2022`, `sql_server_2025`, `azure_sql_db`, `azure_sql_mi`, and
`fabric_sql_db`. The default is `sql_server_2022`.

Generated SQL output is now complete rather than a single statement. Each file
produces one script containing every applicable section - prerequisite
credential/data source setup, external file format, external table, regular
table, `BULK INSERT`, `OPENROWSET`, JSON functions, `FOR JSON`, best practices,
and a `COPY INTO` availability section - joined in dependency order with `GO`
batch separators. The regular table and the external table are given distinct
names (for example `orders` and `ext_orders`) so the whole script can run
without object-name collisions.

Export generated output:

```bash
external-file-detector analyze C:\data --output analysis.sql
external-file-detector analyze C:\data --format json --output analysis.json
```

List a location or inspect supported types:

```bash
external-file-detector list-files C:\data
external-file-detector supported-types
```

Generate an external data source statement:

```bash
external-file-detector generate-data-source MyDataSource azure \
  "https://account.blob.core.windows.net/container"
```

Cloud credential options are available on `analyze`, `analyze-files`, and
`list-files`. Prefer their environment-variable equivalents:

| Provider | Environment variables |
| --- | --- |
| AWS | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION` |
| Azure | `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_KEY`, `AZURE_STORAGE_CONNECTION_STRING` |

Run `external-file-detector COMMAND --help` for complete command options.

## Web interface

```bash
external-file-detector gui --root-dir C:\data
```

Open `http://127.0.0.1:5000`. The built-in Flask server is intentionally
loopback-only because its filesystem APIs do not provide authentication.
`--root-dir` limits browsing and analysis to one directory tree.

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

## Python API

```python
from external_file_detection import FileDetector, SQLGenerator

detector = FileDetector()
metadata = detector.analyze_file_metadata("orders.parquet")

generator = SQLGenerator()
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
from external_file_detection import ExternalFileDetectorApp

app = ExternalFileDetectorApp()
result = app.analyze_location(r"C:\data", data_source="MyDataSource")
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

Run the test suite:

```bash
python -m pytest -q
```

Build distributable packages:

```bash
python -m pip install build
python -m build
```

CI runs the tests on Linux and Windows and builds the wheel from
`pyproject.toml`.

## Project layout

```text
external_file_detection/
|-- cli.py
|-- external_file_detector.py
|-- file_detector.py
|-- sql_generator.py
|-- storage_handlers.py
|-- web_gui.py
|-- web_ui.py
`-- templates/
```

## License

Licensed under the [MIT License](LICENSE).
