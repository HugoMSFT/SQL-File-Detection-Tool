# Native TypeScript analysis core

`src/native/` is a self-contained TypeScript port of the analysis and T-SQL
generation logic that has historically lived in `external_file_detection/`
(Python). It exists so the VS Code extension can eventually analyse files and
generate SQL in-process, without spawning a Python interpreter or a Flask
server.

> **Status: not yet on the shipped runtime path.** Nothing in `src/extension.ts`,
> `src/backend.ts`, or `src/sidebar.ts` imports `src/native/`. Installing this
> version of the extension behaves exactly like the previous one: the managed
> Python backend is still started, and the web UI is still what users see. This
> module is proven against the Python implementation by tests, and is wired into
> the UI in a later change.

The Python CLI, Python API, and Flask web app are unchanged and remain the
supported entry points for non-extension users.

---

## Why a native core

The Python backend requires a virtual environment, a `pip install` of pandas and
pyarrow (roughly 100 MB), a spawned process, a bound loopback port, and a
browser surface. That is a lot of moving parts for "tell me about this CSV". A
native core lets the extension:

- activate in milliseconds instead of waiting for an environment bootstrap,
- work on machines with no Python at all,
- render results in a `WebviewView` with structured messages rather than HTTP,
- cancel long analyses with a `vscode.CancellationToken`,
- and report progress into VS Code's own progress UI.

---

## Module map

```text
src/native/
|-- index.ts              public barrel — the only import surface consumers should use
|-- service.ts            NativeAnalysisService facade (analyze / preview / generate)
|-- types.ts              FileMetadata, SchemaField, StorageReference, platforms, ...
|-- errors.ts             typed NativeAnalysisError hierarchy + error codes
|-- cancellation.ts       CancellationToken contract, structurally compatible with vscode
|-- limits.ts             every byte/row/time bound in one place
|-- paths.ts              realpath-based containment, traversal rejection
|-- streams.ts            bounded chunk/line readers over fs.createReadStream
|-- encoding.ts           BOM sniffing, chardet fallback, iconv decode, codepage map
|-- detector.ts           extension + magic-byte dispatch to an analyzer
|-- preview.ts            bounded tabular previews for every supported format
|-- analysis/
|   |-- delimited.ts      shared delimiter/header/type/nullability inference
|   |-- csv.ts            CSV / TSV / pipe / other delimited text
|   |-- text.ts           unstructured text
|   |-- jsonValue.ts      allocation-bounded JSON scanner
|   |-- json.ts           JSON array, single object, and NDJSON/JSONL
|   |-- arrowSchema.ts    Arrow IPC schema decoding (FlatBuffers) for Parquet metadata
|   |-- parquet.ts        Parquet via hyparquet, incl. logical/nested type mapping
|   |-- excel.ts          XLSX first-sheet metadata and preview (internal reader)
|   |-- orc.ts            ORC recognition + explicit `unsupported_native` result
|   |-- delta.ts          _delta_log parsing, protocol/metadata/partitions/version
|   `-- iceberg.ts        table metadata JSON: current schema, partition spec, snapshots
`-- sql/
    |-- storage.ts        Azure Blob / ADLS Gen2 / S3 / OneLake / local path parsing
    |-- escaping.ts       identifier, literal, and URL escaping primitives
    |-- typeMapping.ts    source type -> T-SQL type, per platform
    |-- bestPractices.ts  the best-practices narrative tab
    |-- generatorHelpers.ts shared statement builders
    |-- openrowset.ts     OPENROWSET dispatch across all six targets
    `-- generator.ts      the platform-aware generator itself
```

### Layering rules

- `analysis/*` may import `types`, `errors`, `limits`, `streams`, `encoding`,
  `paths`, `cancellation`. It must not import `sql/*`.
- `sql/*` consumes a `GeneratorMetadata` shape and must not touch the file
  system. It is entirely pure and synchronous, which is what makes the parity
  tests cheap.
- `service.ts` is the only module that composes the two halves.
- Consumers import from `src/native/index.ts` and nothing deeper. Later layers
  can restructure internals freely as long as the barrel is stable.

---

## Service API

```ts
import { NativeAnalysisService } from './native';

const service = new NativeAnalysisService(workspaceRoot);

const metadata = await service.analyze({ filePath, token, progress });
const listing  = await service.analyzeDirectory({ filePath: folder, token });
const preview  = await service.preview({ filePath, maxRows: 50, token });

const statements = service.generateStatements({
    metadata,
    targetPlatform: 'azure_sql_db',
    storageUrl,
});
const document = service.generateCompleteDocument({ metadata, targetPlatform });
const script   = service.generateMultiFileScript({ entries, targetPlatform });

service.listFormats();
service.listPlatforms();
```

Every method that touches disk accepts an optional `allowedRoot`, a
`CancellationToken`, and a `ProgressReporter`. `tryAnalyze` returns a typed
result union instead of throwing, which suits a webview message handler.

### Errors

All failures are `NativeAnalysisError` with a discriminated `code`:
`path_outside_root`, `path_not_found`, `not_a_directory`, `unsupported_format`,
`limit_exceeded`, `malformed_input`, `cancelled`, `internal`. Hosts can map
codes to UI without string matching. A format the native core recognises but
cannot parse is *not* an error: it returns metadata with
`native_support: 'unsupported_native'` and an explanatory `warning`.

### Cancellation

`CancellationToken` is declared structurally (`{ isCancellationRequested }`), so
a `vscode.CancellationToken` satisfies it without importing `vscode` into the
core. Loops poll every `CANCELLATION_POLL_INTERVAL` records and throw a
`cancelled` error. `SimpleCancellationTokenSource` exists for tests and for
hosts that have no VS Code token to hand.

---

## Safety properties

**Path containment.** `resolveWithinRoot` resolves the requested path *and* the
allowed root through `fs.realpath` before comparing, so a symlink or a Windows
directory junction that points outside the root is rejected rather than
followed. Comparison is segment-aware, so `/root-evil` is not accepted for the
root `/root`. Both are covered by tests, including a junction escape that runs
without elevation on Windows.

**Bounded reads.** No analyzer calls `fs.readFile` on a user file without a size
check first. `limits.ts` holds every bound: sample bytes, maximum line length,
maximum JSON document size, preview rows, Parquet row-group caps, and the ZIP
entry ceilings used by the XLSX reader. Row counts stream; they never
materialise the file.

**Decompression bombs.** The XLSX reader inspects each ZIP member's declared
uncompressed size *before* inflating it and rejects three separate ways: an
entry larger than `MAX_ZIP_ENTRY_BYTES`, an implausible compression ratio
(`MAX_ZIP_RATIO`), and a running total above `MAX_ZIP_TOTAL_BYTES`. A small
archive therefore cannot expand into an unbounded buffer. Parquet reads are
capped by row group and by requested row count.

**Injection.** Identifier and literal escaping is centralised in
`sql/escaping.ts` and exercised by `security.test.ts`, which pushes a corpus of
hostile strings (quote/bracket breakouts, comment injection, `GO` batch
splitting, NUL bytes, RTL overrides) through every generated statement on every
platform and asserts, using a real T-SQL lexer that strips quoted and bracketed
regions, that no payload escapes into executable position.

**Batch separators.** `GO` is not a T-SQL keyword — it is a *client-side* batch
separator, so every tool that runs a script splits on a line whose only content
is `GO`. Doubling `]` and `'` is therefore not sufficient on its own: a payload
that smuggles a line break into `[an identifier]` or `'a literal'` produces SQL
the server parses happily but that sqlcmd, SSMS, or Azure Data Studio would cut
in half, running whatever follows as its own batch. `escapeIdentifier` and
`quoteLiteral` consequently collapse every control character
(`[\x00-\x1f\x7f\u2028\u2029]`) to a space before escaping. This is lossless in
practice — delimiters reach `quoteLiteral` already rendered by
`displayDelimiter`, and no legitimate identifier, path, or URL contains a
control character. `splitGoBatches` is independently hardened to track
literals, bracketed identifiers, and line and block comments across lines, so it
cannot split inside a quoted region even in a script it did not generate. The
tests assert the property the way a client sees it: the load-bearing check is
that no quoted or bracketed region in the output contains a line terminator;
splitting on real batch separators and scanning each batch is the secondary
check, because a payload that leaves a literal unterminated collapses the whole
script into a single batch.

Because that reasoning only holds if *every* value is escaped by those helpers,
a single hand-rolled `.split("'").join("''")` is enough to reopen the hole — one
survived the first pass in the JSON section's on-premises `SINGLE_CLOB` branch,
where `file_path` is interpolated directly. `security.test.ts` now fuzzes
`file_path` across every platform, both the CSV and JSON metadata shapes, and
with and without a storage URL, and a companion test walks `src/native/` and
fails the build on any hand-rolled escaper outside `sql/escaping.ts`.

**Containment of sidecar reads.** Delta and Iceberg read files *by name* from
inside a table directory (`_delta_log/…`, `metadata/…`). Joining those names
lexically would let a symlink or a Windows junction planted inside an otherwise
legitimate table directory redirect the read outside the allowed root — and the
contents come back in the analysis result. Every such read goes through
`containedRealPath`, which realpaths the child and re-checks containment against
its parent; because the parent is already inside the allowed root, that implies
containment under the root. The converse is deliberately not true: a link that
stays inside the allowed root but points outside the table directory is rejected
too. Analysers have no need to reach sideways, and the stricter rule keeps the
helper free of any dependency on ambient root state. Iceberg also refuses to
surface raw `JSON.parse` messages, which embed a snippet of the file being
parsed.

---

## Format support matrix

Representative results from the consolidated fixtures in `data sample/`:

| Fixture | Type | Native support | Columns | Rows | Encoding |
| --- | --- | --- | --- | --- | --- |
| `data sample/csv/sales_scalars.csv` | csv | supported | 10 | 6 | utf-8 |
| `data sample/csv/sales_scalars.tsv` | csv | supported | 10 | 6 | utf-8 |
| `data sample/csv/sales_scalars_pipe.csv` | csv | supported | 10 | 6 | utf-8 |
| `data sample/excel/inventory.xlsx` | excel | supported | 6 | 4 | binary |
| `data sample/json/orders.ndjson` | json (ndjson) | supported | 8 | 3 | utf-8 |
| `data sample/json/orders_array.json` | json (array) | supported | 8 | 3 | utf-8 |
| `data sample/json/order_single_object.json` | json (object) | supported | 8 | 1 | ascii |
| `data sample/orc/all_types.orc` | orc | **unsupported_native** | – | – | binary |
| `data sample/parquet/all_types.parquet` | parquet | supported | 26 | 4 | binary |
| `data sample/parquet/sales.parquet` | parquet | supported | 6 | 4 | binary |
| `data sample/performance/events_25k.parquet` | parquet | supported | 7 | 25,000 | binary |
| `data sample/performance/events_250k.parquet` | parquet | supported | 7 | 250,000 | binary |
| `data sample/tables/events_delta` | delta | supported | 5 | (null) | binary |
| `data sample/tables/events_iceberg` | iceberg | supported | 6 | 3 | binary |
| `data sample/text/readme_sample.txt` | text | supported | – | 10 | utf-8 |
| `data sample/unicode/collation_cases_utf8.csv` | csv | supported | 5 | 14 | utf-8 |
| `data sample/unicode/japanese_cp932.csv` | csv | supported | 4 | 6 | cp932 |
| `data sample/unicode/unicode_utf16le_bom.csv` | csv | supported | 5 | 20 | utf-16 |
| `data sample/unicode/unicode_utf16le_bom.tsv` | csv | supported | 5 | 20 | utf-16 |
| `data sample/unicode/unicode_utf8.csv` | csv | supported | 5 | 20 | utf-8 |
| `data sample/unicode/unicode_utf8_bom.csv` | csv | supported | 5 | 20 | utf-8-sig |

`row_count` is `null` for Delta in both implementations: neither counts rows
across every part file, because doing so would defeat the point of reading only
the log.

RCFile stays recognition-only with the same guidance text the Python
implementation emits, matching the documented behaviour.

`native_support` is a native-only additive field with three values:

- `supported` — full metadata, schema, and preview,
- `recognition_only` — the format is identified and explained, but not parsed
  (RCFile),
- `unsupported_native` — see below.

### The ORC limitation

ORC is the one format this layer cannot analyse natively, and it returns a
typed `unsupported_native` result rather than a guess.

What the native core *does* do: identify the file by its `ORC` magic bytes, read
the postscript, and report `file_type`, `file_size`, and the compression codec
(`compression` matches Python exactly, including the proto2 default of
`UNCOMPRESSED` for an absent field). What it does not do is decode the ORC type
tree, so `schema`, `column_count`, and `row_count` are absent and `warning`
explains why and what to do instead.

The evidence behind that decision:

- There is no maintained pure-JavaScript or WASM ORC reader on npm. The
  candidates are unmaintained partial implementations, or bindings that require
  a platform-specific native binary or a postinstall download — both explicitly
  ruled out for this extension.
- Writing a full ORC reader means implementing the protobuf footer, the type
  tree, run-length encodings v1 and v2, byte/boolean/integer/float/string/
  decimal/timestamp streams, dictionary encoding, and Zlib/Snappy/LZO/LZ4/Zstd
  decompression. That is a large, high-risk surface for one demo format, and it
  would take far more code than the rest of `analysis/` combined.
- ORC users are not stranded: the Python CLI and the Python backend still
  analyse ORC exactly as before, and a later layer can offer the Python path as
  an optional fallback for this one format.

Guessing a schema would be worse than saying so. The result is typed, explained
in `warning`, and asserted by a dedicated test so it cannot silently drift.

---

## Runtime dependencies

Chosen for portability: every one is pure JavaScript or portable WASM, none ship
a platform-specific native binary, and none run an install script.

| Package | Range | License | Why | Install script | Native binary |
| --- | --- | --- | --- | --- | --- |
| [`hyparquet`](https://www.npmjs.com/package/hyparquet) | `^1.29.2` | MIT | Parquet reader: schema, logical types, row groups, compression, bounded row reads. Actively maintained, dependency-free, works in Node and the browser. | no | no |
| [`iconv-lite`](https://www.npmjs.com/package/iconv-lite) | `^0.7.3` | MIT | Decoding for codepages Node's `Buffer` cannot do natively, notably CP932/Shift-JIS. Pure JS. | no | no |
| [`chardet`](https://www.npmjs.com/package/chardet) | `^2.2.0` | MIT | Encoding detection on a bounded prefix when there is no BOM. Mirrors the Python side, which also uses chardet. | no | no |
| [`fflate`](https://www.npmjs.com/package/fflate) | `^0.8.3` | MIT | Inflate for the XLSX container (an XLSX is a ZIP). Small, pure JS, and streaming so entry sizes can be bounded. | no | no |

All four are MIT, which is compatible with this project's MIT license.

### Rejected alternatives

| Package | Reason |
| --- | --- |
| `@dsnp/parquetjs` | Pulls in Thrift and a large transitive tree; slower and heavier than hyparquet for read-only metadata. |
| `parquetjs-lite` | Unmaintained; no logical-type coverage for the demo matrix. |
| `parquet-wasm` | Requires a bundled WASM artifact plus glue that assumes a bundler; awkward inside a plain CommonJS VS Code extension. |
| `exceljs` | Heavy, and the maintenance story has been uneven; more surface than a bounded first-sheet read needs. |
| `xlsx` (SheetJS) | The npm-published versions are stale and the current distribution is served from the vendor's own CDN rather than npm. |
| `node-xlsx`, `read-excel-file` | Wrappers over the above, inheriting the same problems. |
| CSV parsers (`csv-parse`, `papaparse`) | The internal parser is a few hundred lines, handles quoted delimiters/newlines/BOM, and streams with an explicit byte budget. Not worth a dependency. |
| ORC readers | See "The ORC limitation" above. |

`hyparquet` is ESM-only. It is loaded through a deferred dynamic `import()` so
the CommonJS extension bundle stays CommonJS and the cost is only paid when a
Parquet, Delta, or Iceberg file is actually analysed (measured at 0.14 ms to
*not* load it).

---

## SQL generator port

`sql/generator.ts` is a behavioural port of `external_file_detection/sql_generator.py`,
not a re-imagining. It never shells out to Python. It preserves:

- `DEFAULT_TARGET_PLATFORM = 'azure_sql_db'` and the per-platform capability
  tables, centralised so a later layer has one place to change,
- data source parsing for Azure Blob, ADLS Gen2, S3, OneLake, and local/UNC
  paths,
- type mapping, including signed `int8`, decimal precision and negative scale,
  timestamps with time zone, and nested list/struct/map handling,
- target-aware `CREATE TABLE`, `BULK INSERT`, `OPENROWSET`, external file
  formats, external tables, credential setup, JSON functions, `FOR JSON PATH`,
  and the best-practices narrative,
- dependency ordering, `GO` batch separation, and shared-prerequisite
  deduplication for multi-file exports,
- and the corrected edge cases: Azure `_Bulk` data-source contextual escaping,
  remote SQL Server paths, SQL Server 2019 Azure Blob versus S3, Delta directory
  trailing slashes, no remote `SINGLE_CLOB`, Fabric SQL Database capabilities,
  `FIRST_ROW` versus `FIRSTROW` gating, and exact target table/schema
  validation.

Supported targets: `sql_server_2019`, `sql_server_2022`, `sql_server_2025`,
`azure_sql_db` (default), `azure_sql_mi`, `fabric_sql_db`.

### One deliberate divergence from Python

`escapeIdentifier` and `quoteLiteral` collapse control characters, which their
Python counterparts (`_escape_identifier`, `_quote_literal`) do not. A security
review of this port found a working batch-injection proof of concept: a CSV
whose first header field is `"id\nGO\nDROP TABLE users;\nGO\n--"` — legal,
because a quoted CSV field may contain a newline — produced a `CREATE TABLE`
whose bracketed identifier spanned a line reading exactly `GO`, so splitting the
generated script the way sqlcmd does yielded batches containing
`DROP TABLE users;`.

The native core fixes this at the escaping layer. Generated output is unchanged
for every input that does not contain a control character, which is every
legitimate input and every committed fixture, so the parity suites are
unaffected. The Python implementation is out of scope for this layer and is left
untouched.

The same divergence applies to the JSON section's on-premises `SINGLE_CLOB`
branch, where `sql_generator.py:2269` hand-rolls `.replace("'", "''")` on
`file_path`. The native port routes that value through `quoteLiteral` instead,
so a newline in a file name — legal on macOS and Linux, and directly supplied by
the caller through `generateStatements({ metadata })` on any OS — cannot open a
new client-side batch.

---

## Parity testing

`scripts/generate_parity_baselines.py` runs the **live Python implementation**
over 19 committed fixtures and 5 storage URLs and writes
`tests/native_parity/python_baseline.json`. Run it with `--check` to verify the
committed baseline still matches the current Python code:

```bash
python scripts/generate_parity_baselines.py --check
```

The baseline is deterministic and portable by construction. It stores:

- **normalised metadata** with absolute paths, timing, and detector confidence
  removed, and
- **semantic statement invariants** rather than raw SQL. Each entry is keyed by
  the regular expression that produced it, so a marker records *what* the
  statement asserts (target table, format type, `FIRSTROW`/`FIRST_ROW`, data
  source name, credential identity, `GO` batch count, column count and each
  column's SQL type) rather than its whitespace.

`src/test/native/parityInvariants.ts` reimplements the same extraction in
TypeScript, so a comparison is marker-for-marker rather than string-for-string.
Formatting may differ; meaning may not.

### Intentional differences

`analysisParity.test.ts` holds an explicit allowlist, and a guard test fails if
an allowlisted difference stops being a difference — so the list cannot go
stale.

| Fixture | Differing keys | Why |
| --- | --- | --- |
| `data sample/tables/events_delta` | `schema`, `schema_inference`, `delta_metadata`, `warning`, `nullable_columns`, `parquet_metadata`, `compression` | The baseline environment has no `deltalake` package, so Python falls back to analysing one Parquet part. The native core parses `_delta_log` directly and reports the real table name, version, and partition columns. The native result is *better*; the difference is deliberate. |
| `data sample/orc/all_types.orc` | `schema`, `column_count`, `row_count`, `warning`, `nullable_columns` | The ORC limitation above. `compression` and `schema_inference` match. |
| `data sample/tables/events_iceberg` | `iceberg_metadata` | Native adds `snapshot_count`. A dedicated test asserts every Python key matches exactly and that `snapshot_count` is the only addition. |

`encoding_confidence`, `encoding_warning`, `file_path`, Parquet
`serialized_size`, and Delta `created_time` are excluded by the baseline
generator itself because they are environment-dependent or nondeterministic.
`native_support` is native-only and additive.

---

## Test suites

```bash
npm run typecheck
npm run lint
npm test
```

| Suite | What it covers |
| --- | --- |
| `analysis.test.ts` | Format matrix over `data sample/`, every encoding, CSV quoting, malformed/truncated/oversize input, cancellation, bounded previews, the service facade. |
| `analysisParity.test.ts` | Normalised metadata against the Python baseline, plus the explicit limitation tests and the allowlist staleness guard. |
| `generatorParity.test.ts` | Statement invariants against the Python baseline across every fixture, platform, and storage URL. |
| `generatorMatrix.test.ts` | 6 targets x CSV/Parquet/JSON/Delta x local/remote, plus multi-file export and the corrected edge cases. |
| `security.test.ts` | Hostile identifiers, URLs, delimiters, JSON keys, comments, SQL type overrides, credential names; path containment including symlink and junction escapes. |
| `performance.test.ts` | Module import cost, deferred Parquet loading, bounded analysis of generated large files, preview and cache costs. |

### Measurements

Recorded on a Windows developer machine with Node 20.18.1:

| Scenario | Result |
| --- | --- |
| Import the entire native core | 2.3 ms |
| Confirm the Parquet reader is *not* loaded | 0.14 ms |
| CSV, 5.7 MB, full analysis + row count | 85 ms, +9.9 MB heap |
| NDJSON, 9.3 MB, full analysis + row count | 346 ms, +75 MB allocated |
| NDJSON, 7.4 MB / 60,000 rows, heap retained after forced GC | **+0.3 MB** |
| Preview of a large file | 73 ms |
| Full statement set for one file | 19 ms |

The NDJSON figure is worth reading twice: the large number is transient
allocation from parsing each line to validate it, not retention. With
`--expose-gc` the retained heap after analysis is 0.3 MB, confirming the reader
is genuinely streaming.

The suites assert against generous ceilings rather than these exact numbers, so
CI stays reliable on slower machines.

---

## Packaging

This layer adds four runtime dependencies but does not change what ships to
users. The packaged VSIX is still version 1.1.1, still contains
`external_file_detection/`, and still activates the managed Python backend.
`out/native/**` is compiled into the VSIX but is inert: nothing requires it, so
its four dependencies are not needed at runtime and `.vscodeignore` correctly
still excludes `node_modules/**`.

The layer that wires the core into the UI must therefore also start shipping
those dependencies — either by narrowing the `node_modules` exclusion to
`hyparquet`, `iconv-lite`, `chardet`, and `fflate`, or by bundling `out/` with
esbuild.

Python files still ship in the VSIX and the extension version is unchanged,
because no shipped user behaviour changed here.

`npm audit` reports three advisories, all in the `@vscode/vsce` -> `markdown-it`
-> `linkify-it` devDependency chain that predates this work. `npm audit
--omit=dev` reports zero vulnerabilities, so nothing shipped is affected.
