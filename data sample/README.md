# Data samples

This is the single home for every local dataset used to try and test SQL File
Detection Tool. It consolidates the former `demo/` and `test_data/` trees by
format. The canonical fixtures and the performance-scale Parquet files are
generated from constant values by [`generate_samples.py`](generate_samples.py);
additional business-shaped fixtures can be refreshed with
[`scripts/generate_additional_samples.py`](../scripts/generate_additional_samples.py).

Canonical public copies are mapped in
[`scripts/certification/public-demo-fixtures.json`](../scripts/certification/public-demo-fixtures.json).
The mapping preserves every relative path required by Delta and Iceberg. Its
`publication_status` and anonymous container status are authoritative. All 23
objects are published at the canonical base and were anonymously downloaded,
byte-counted, and SHA-256 verified. Local fixtures remain the deterministic offline source for tests.

```bash
python "data sample/generate_samples.py"            # regenerate canonical samples
python "data sample/generate_samples.py" --quiet    # no file listing
python "data sample/generate_samples.py" --output-dir /tmp/sql-file-samples
python scripts/generate_additional_samples.py       # refresh additional samples
```

The generator uses only dependencies the project already requires
(`pandas`, `pyarrow`, `openpyxl`, `fastavro`) plus the standard library.

---

## 1. Sample inventory

### Delimited text

| File | Format | Encoding | Covers |
| --- | --- | --- | --- |
| `csv/sales_scalars.csv` | CSV, comma | UTF-8 | signed ints (incl. `int32` min/max), floats (negative, zero, `1e-07`), booleans, strings with Unicode and embedded quotes/commas, NULLs (empty fields), ISO dates, ISO timestamps, ISO timestamps with `Z` |
| `csv/sales_scalars.tsv` | TSV, tab | UTF-8 | same values, tab delimited |
| `csv/sales_scalars_pipe.csv` | CSV, pipe | UTF-8 | same values, exercises delimiter sniffing |
| `csv/employees.csv` | CSV, comma | UTF-8 | 50 employee records |
| `csv/employees_wide.csv` | CSV, comma | UTF-8 | wider business schema |
| `csv/products_catalog.csv` | CSV, comma | UTF-8 | 75 product records |
| `csv/sales_orders.csv` | CSV, comma | UTF-8 | numeric and timestamp columns |
| `csv/sample.csv` | CSV, comma | UTF-8 | minimal five-column sample |
| `csv/web_access_logs.tsv` | TSV, tab | UTF-8 | 200 web access records |

### JSON

| File | Format | Covers |
| --- | --- | --- |
| `json/orders_array.json` | JSON array | scalars, `null`, nested object (`customer.address`), list of objects (`items`), list of strings (`tags`), booleans, ISO timestamps |
| `json/orders.ndjson` | NDJSON | identical records, one JSON object per line |
| `json/order_single_object.json` | single JSON object | the object (non-array) code path |
| `json/customers_nested.json` | JSON array | nested contacts and addresses |
| `json/events.jsonl` | JSON Lines | sparse event records |
| `json/sample.json` | JSON array | minimal mixed scalar sample |

### Columnar

| File | Format | Covers |
| --- | --- | --- |
| `parquet/all_types.parquet` | Parquet | every Arrow family the SQL mapper claims to support — see the table below |
| `parquet/sales.parquet` | Parquet | a narrow, business-shaped table for the everyday walkthrough |
| `parquet/sales_transactions.parquet` | Parquet | 500 transaction rows |
| `parquet/sensor_readings.parquet` | Parquet | 1,000 sensor rows |
| `parquet/sample.parquet` | Parquet | minimal six-column sample |
| `orc/all_types.orc` | ORC | the subset of the same columns the Arrow ORC writer accepts |

### Performance-scale files

| File | Rows | Approximate size | Purpose |
| --- | ---: | ---: | --- |
| `performance/events_25k.parquet` | 25,000 | 0.8 MB | medium-file analysis and preview |
| `performance/events_250k.parquet` | 250,000 | 8 MB | verify footer-only analysis and bounded preview behavior |

`parquet/all_types.parquet` column coverage and the SQL Server type the
generator produces:

| Column | Arrow type | Generated SQL type |
| --- | --- | --- |
| `c_int8` | `int8` | `SMALLINT` (Arrow `int8` is signed; `TINYINT` is not) |
| `c_int16` | `int16` | `SMALLINT` |
| `c_int32` | `int32` | `INT` |
| `c_int64` | `int64` | `BIGINT` |
| `c_uint8` | `uint8` | `TINYINT` |
| `c_uint16` | `uint16` | `INT` |
| `c_uint32` | `uint32` | `BIGINT` |
| `c_uint64` | `uint64` | `DECIMAL(20,0)` |
| `c_float32` | `float` | `FLOAT` |
| `c_float64` | `double` | `FLOAT` |
| `c_bool` | `bool` | `BIT` |
| `c_string` | `string` | `NVARCHAR(255)` |
| `c_large_string` | `large_string` | `NVARCHAR(MAX)` |
| `c_binary` | `binary` | `VARBINARY(MAX)` |
| `c_large_binary` | `large_binary` | `VARBINARY(MAX)` |
| `c_date32` | `date32[day]` | `DATE` |
| `c_time32_ms` | `time32[ms]` | `TIME(3)` |
| `c_time64_us` | `time64[us]` | `TIME(6)` |
| `c_timestamp_ms` | `timestamp[ms]` | `DATETIME2(3)` |
| `c_timestamp_us` | `timestamp[us]` | `DATETIME2(6)` |
| `c_timestamp_ns` | `timestamp[ns]` | `DATETIME2(7)` |
| `c_timestamp_utc` | `timestamp[us, tz=UTC]` | `DATETIMEOFFSET(6)` |
| `c_decimal` | `decimal128(18, 4)` | `DECIMAL(18,4)` |
| `c_list_int32` | `list<int32>` | `NVARCHAR(MAX)` (JSON serialised) |
| `c_struct` | `struct<id, label>` | `NVARCHAR(MAX)` (JSON serialised) |
| `c_map` | `map<string, int32>` | `NVARCHAR(MAX)` (JSON serialised) |

Every column carries a non-null low value, a boundary value, a high value
and a `NULL`, so nullability and range handling are both visible.

The table above describes ordinary `CREATE TABLE` mappings. For Parquet
external tables, SQL Server 2025 requires physical `INT64`
`TIMESTAMP(NANOS)` values to be exposed as `BIGINT` and timezone timestamps
as `DATETIME2`; generated SQL labels those target-specific translations as
Mapped. Parquet list, struct, and map fields cannot be represented by SQL
Server external-table columns, so the generator now returns explicit
flattening guidance instead of emitting a construct that fails at runtime.

### Table formats

| Path | Format | Covers |
| --- | --- | --- |
| `tables/events_delta/` | Delta Lake | `_delta_log/00000000000000000000.json` with `protocol`, `metaData`, `add` and `commitInfo` actions plus `part-00000-demo-c000.snappy.parquet` |
| `tables/events_iceberg/` | Apache Iceberg | `metadata/v1.metadata.json` (format-version 2, schema, partition spec, snapshot with `total-records`), `metadata/snap-1000000000000000001-1-demo.avro`, `metadata/demo-m0.avro`, and `data/00000-0-demo.parquet` |
| `tables/delta_table/` | Delta Lake | `_delta_log/00000000000000000000.json` plus `data/part-00000-00000.snappy.parquet` |
| `tables/iceberg_table/` | Apache Iceberg | `metadata/v1.metadata.json` plus `data/00000-0.parquet` |
| `tables/sample_orders.delta/` | Delta Lake | transaction log plus `part-00000-574bcd76-03d5-4e51-a574-aba75f6ac27c-c000.snappy.parquet` |

### Other

| File | Format | Covers |
| --- | --- | --- |
| `excel/inventory.xlsx` | Excel | mixed text/number/boolean/date cells, an empty cell, Unicode product names |
| `text/readme_sample.txt` | Plain text | ASCII plus composed/decomposed accents, CJK, Cyrillic and Greek |
| `text/sample.txt` | Plain text | five-line basic text sample |

---

## 2. Encoding samples

**File encoding and SQL collation are different things.** The encoding
decides which *bytes* on disk represent a character. The collation decides
how SQL Server *compares, sorts and groups* those characters once they are
inside an `NVARCHAR` column or expression.
A CSV, TSV or JSON file never carries a collation — you choose one when you
define the target column.
| File | Encoding | BOM | Detected codepage | Notes |
| --- | --- | --- | --- | --- |
| `unicode/unicode_utf8.csv` | UTF-8 | no | `65001` | the canonical modern choice |
| `unicode/unicode_utf8_bom.csv` | UTF-8 | yes (`EF BB BF`) | `65001` | what Excel for Windows writes; detected as `utf-8-sig` |
| `unicode/unicode_utf16le_bom.csv` | UTF-16LE | yes (`FF FE`) | `1200` | comma delimited |
| `unicode/unicode_utf16le_bom.tsv` | UTF-16LE | yes (`FF FE`) | `1200` | tab delimited |
| `unicode/japanese_cp932.csv` | CP932 / Shift-JIS | no | `932` | Japanese-only content; every character exists in the codepage |
| `unicode/collation_cases_utf8.csv` | UTF-8 | no | `65001` | collation-sensitive value pairs, see below |

The UTF-8/UTF-16 files contain: Latin with German `ß`, composed (`café`,
U+00E9) versus decomposed (`cafe` + U+0301) accents, Japanese kanji,
hiragana, full-width katakana and half-width katakana, simplified and
traditional Chinese, Korean hangul, Arabic and Hebrew (right-to-left),
Devanagari with combining marks, Cyrillic, Greek, BMP symbols,
supplementary-plane emoji (surrogate pairs in UTF-16), ZWJ emoji
sequences, a field with embedded quotes and a comma, a field with an
embedded newline, and an empty field that reads as `NULL`.

Notes and limits:

* **UTF-16BE is not included.** The detector reports `utf-16` for a
  LE-BOM file and maps it to codepage `1200`; a BE file would need
  codepage `1201` and the current detection path does not distinguish the
  two reliably enough to ship a fixture that would mislead you.
* **`CODEPAGE = '1200'` is not valid for `BULK INSERT`.** SQL Server reads
  UTF-16LE files through `DATAFILETYPE = 'widechar'`, not `CODEPAGE`. Use
  the UTF-8 fixtures for `BULK INSERT` / `OPENROWSET(BULK ...)`
  walkthroughs, or convert the UTF-16 file first.
* **CP932 needs `CODEPAGE = '932'`** and an `NVARCHAR` target column. The
  detector reports this automatically for `unicode/japanese_cp932.csv`.
* **No RCFile sample is shipped.** Neither `pyarrow` nor any other current
  project dependency can write a valid RCFile, and an invalid one would be
  worse than none. `.rc` is therefore *recognition-only*: the detector
  identifies the type, but cannot derive a schema.

---

## 3. Collation samples

`unicode/collation_cases_utf8.csv` holds 14 value pairs picked so that the
two sides compare *equal* under some collations and *different* under
others:

| Category | Left | Right | Separated by |
| --- | --- | --- | --- |
| `kana_type` | ひらがな | ヒラガナ | kana sensitivity (`_KS`) |
| `kana_width` | カタカナ | ｶﾀｶﾅ | width sensitivity (`_WS`) |
| `latin_width` | `ABC123` | `ＡＢＣ１２３` | width sensitivity (`_WS`) |
| `case` | `straße` | `STRASSE` | case sensitivity (`_CS`) |
| `sharp_s` | `straße` | `strasse` | German `ß` expansion |
| `accent` | `resume` | `résumé` | accent sensitivity (`_AS`) |
| `unicode_form` | `café` (NFC) | `cafe`+U+0301 (NFD) | binary collations only (`_BIN2`) |
| `turkish_i` | `ISTANBUL` | `istanbul` | `Turkish_100_CI_AS` dotless i |
| `turkish_dotted` | `İstanbul` | `Istanbul` | `Turkish_100_CI_AS` dotted I |
| `trailing_space` | `value` | `value   ` | `=` ignores trailing spaces, `DATALENGTH` does not |
| `lookalike` | `A` | `Α` (Greek) | binary distinct |
| `lookalike_cyrillic` | `A` | `А` (Cyrillic) | binary distinct |
| `kana_prolonged` | `コーヒー` | `コ－ヒ－` | prolonged sound mark vs full-width hyphen |
| `identical` | 😀 | 😀 | control row, equal everywhere |

[`collation_samples.sql`](collation_samples.sql) loads exactly those pairs
into a `#temp` table with `NVARCHAR` columns and `N'...'` literals, then
demonstrates comparison, ordering and grouping under:

* `Japanese_XJIS_140_CI_AS_KS_WS` — kana **and** width sensitive
* `Japanese_XJIS_140_CI_AI` — kana and width insensitive
* `Japanese_Bushu_Kakusu_140_CI_AS` — radical/stroke-count kanji ordering
* `Latin1_General_100_CI_AI`, `..._CI_AS`, `..._CS_AS`
* `Latin1_General_100_BIN2_UTF8` — the only one that separates NFC from NFD
* `Turkish_100_CI_AS`

Section 0 of the script queries `sys.fn_helpcollations()` for exactly those
names first, because collation availability depends on the SQL Server or
Azure SQL version. Run it before relying on the rest of the script. The
script creates nothing but a `#temp` table and drops it again, so it is
safe to run anywhere:

```bash
sqlcmd -S <server> -d <database> -i "data sample/collation_samples.sql"
```

---

## 4. Trying the tool

### Inspect what is here

```bash
python -m external_file_detection.cli list-files "data sample" --recursive
python -m external_file_detection.cli supported-types
```

### Analyse a single file

```bash
python -m external_file_detection.cli analyze "data sample/csv/sales_scalars.csv"
python -m external_file_detection.cli analyze "data sample/parquet/all_types.parquet"
python -m external_file_detection.cli analyze "data sample/tables/events_delta"
python -m external_file_detection.cli analyze "data sample/tables/events_iceberg"
```

### Generate SQL per platform

Azure SQL Database is the default, so it needs no `--target-platform`:

```bash
# Azure SQL Database - the default target platform
python -m external_file_detection.cli analyze "data sample/csv/sales_scalars.csv" \
    --storage-url abs://raw@myaccount.blob.core.windows.net/samples/sales_scalars.csv \
    --data-source LakeDS
```

Analysing a local sample file without `--storage-url` still targets Azure SQL
Database, and the generated script says so: the prerequisite section explains
that the file must be uploaded to Azure Storage first, because Azure SQL cannot
read a local path.

Every other platform is selected explicitly:

```bash
# SQL Server 2022 / 2025 - external table + OPENROWSET + BULK INSERT
python -m external_file_detection.cli analyze "data sample/parquet/sales.parquet" \
    --target-platform sql_server_2022 \
    --storage-url abfss://raw@myaccount.dfs.core.windows.net/samples/sales.parquet \
    --data-source LakeDS

# SQL Server 2019 - CSV only for bulk access, HADOOP source for external tables
python -m external_file_detection.cli analyze "data sample/csv/sales_scalars.csv" \
    --target-platform sql_server_2019 \
    --storage-url https://myaccount.blob.core.windows.net/raw/samples/sales_scalars.csv \
    --data-source LakeDS

# Azure SQL Managed Instance
python -m external_file_detection.cli analyze "data sample/csv/sales_scalars.csv" \
    --target-platform azure_sql_mi \
    --storage-url abs://raw@myaccount.blob.core.windows.net/samples/sales_scalars.csv \
    --data-source LakeDS

# Microsoft Fabric SQL database (OneLake)
python -m external_file_detection.cli analyze "data sample/parquet/sales.parquet" \
    --target-platform fabric_sql_db \
    --storage-url https://onelake.dfs.fabric.microsoft.com/<workspace>/<lakehouse>.Lakehouse/Files/samples/sales.parquet \
    --data-source LakeDS
```

### Multi-file export

```bash
python -m external_file_detection.cli analyze-files \
    "data sample/csv/sales_scalars.csv" "data sample/parquet/sales.parquet" \
    --target-platform sql_server_2022 \
    --data-source LakeDS \
    --output demo_export.sql --format sql
```
The exported script creates the master key, credential, external data
sources and external file formats **once**, then the per-file objects, so
it runs top to bottom without "already exists" failures.

### Web UI

```bash
python -m external_file_detection.cli gui
```

Then browse to the `data sample` folder from the file browser.

Useful controls once a file is selected:

* **Target table (optional)** — blank derives the table name from the file
  name (shown next to the field); a value overrides it everywhere.
* **Data URL / storage location** — one field for the complete location the
  SQL engine will use. Paste
  `abs://data@acct.blob.core.windows.net/samples/sales_scalars.csv` while a local
  sample file is selected to see exactly what the cloud script would look like.
* **Theme toggle** — light/dark, in the header.

### Public dataset URL

The **Public dataset URL** button lets you try the tool without staging
anything yourself. It accepts:

* a direct `https://` data file — `.csv`, `.tsv`, `.json`, `.jsonl`,
  `.ndjson`, `.parquet`, `.orc`, `.txt`, `.xlsx`, `.xls`. It is downloaded
  into the session's temporary area, analysed and previewed, and its original
  URL is kept for SQL generation.
* an Azure Open Datasets **catalog** page such as
  `https://learn.microsoft.com/en-us/azure/open-datasets/dataset-catalog`.
  A catalog lists many datasets, so none is picked for you — you get a list of
  dataset pages to choose from.
* an Azure Open Datasets **detail** page. The storage locations it documents
  are extracted; a folder or wildcard location like
  `abs://nyctlc@azureopendatastorage.blob.core.windows.net/yellow/*.parquet`
  is resolved through a bounded anonymous blob listing to one representative
  file for metadata, while the documented location is what appears in the SQL.

Limits: HTTPS only, no credentials in the URL, host names resolved and any
private/loopback/link-local/reserved address refused, every redirect
revalidated (max 5), 200 MB download cap and 4 MB HTML cap, connect/read
timeouts, and catalog HTML parsing restricted to
`learn.microsoft.com/.../azure/open-datasets/`. HTML pages are never analysed
as data.

An Azure Blob URL keeps correct storage semantics in the generated SQL. A file
from an arbitrary public web server is reported as needing staging, because no
SQL engine can read that URL in place.

---

## 5. Cloud SQL needs the data staged

Everything in this folder is a *local* file. SQL Server, Azure SQL Database,
Azure SQL Managed Instance and Fabric SQL database cannot read your laptop's
disk. To actually execute the generated `CREATE EXTERNAL TABLE`,
`OPENROWSET(BULK ...)` or `BULK INSERT` statements you must first put the
data where the engine can reach it:

| Target | Where to stage | Location form |
| --- | --- | --- |
| SQL Server (on-prem/VM) | local disk, UNC share, Azure Blob | `C:\data\...`, `\\server\share\...`, `https://acct.blob.core.windows.net/container` |
| SQL Server 2022/2025 external table | ADLS Gen2 / Blob / S3 | `abfss://`, `abs://`, `adls://`, `s3://` |
| Azure SQL Database / MI | Azure Blob or ADLS Gen2 | `abs://container@acct.blob.core.windows.net` |
| Fabric SQL database | OneLake | `https://onelake.dfs.fabric.microsoft.com/<workspace>/<lakehouse>.Lakehouse/Files/...` |

Pass the staged location with `--storage-url` (or the *Data URL / storage
location* field in the web UI) so that the generated SQL references the
real path rather than a placeholder.

Two details the generator handles for you:

* **`BULK INSERT` and `OPENROWSET(BULK ...)` cannot use an `abs://` or
  `adls://` data source.** For Azure Blob they need a second external data
  source with `TYPE = BLOB_STORAGE` and an `https://` `LOCATION`, and the
  `FROM` / `BULK` path is then *relative* to it. The generator emits that
  companion `<data_source>_Bulk` source automatically and never puts an
  absolute URL in the `FROM` clause.
* **`TYPE = BLOB_STORAGE` cannot back an external table.** That is why two
  data sources are generated when both paths apply.

---

## 6. Determinism

* Text based samples (CSV, TSV, JSON, NDJSON, `.txt`, `.sql` and the Iceberg
  metadata) are byte-for-byte identical on every run. Iceberg Avro sidecars are
  byte-for-byte identical on a given PyArrow and fastavro build; they record the
  generated Parquet and manifest byte lengths.
* The Delta log is byte-for-byte identical on every run **on a given PyArrow
  build**, and no further than that. It records the byte length of the Parquet
  file it describes in `add.size`, so a PyArrow upgrade that changes the
  encoded size by twenty bytes changes the log too. The invariant that actually
  holds across versions, and the one the tests assert, is that `add.size`
  equals the real length of the file it names.
* `data sample/.gitattributes` pins those files to LF and marks the UTF-16LE
  fixtures as binary, so `core.autocrlf` cannot rewrite them on checkout and
  regenerating after a fresh clone is a no-op.
* XLSX would normally embed the current time in every ZIP entry and in
  `dcterms:modified`. The generator rewrites the container with a pinned
  timestamp afterwards, so the workbook is byte-stable too.
* Parquet and ORC embed writer-version metadata from PyArrow. They are
  stable in **content** (schema, values, row count) across runs on the same
  PyArrow build; tests compare the decoded table rather than raw bytes so a
  library upgrade does not break them.
* No sample contains secrets, credentials, or personal data. The two files in
  `performance/` are intentionally larger; all other fixtures stay compact.
