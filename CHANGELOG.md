# Changelog

All notable changes to **SQL File Detection Tool** are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

## [2.1.1]

### Added

- Added 25,000-row and 250,000-row Parquet samples for larger-file analysis and
  bounded-preview testing.
- Pull-request updates now require the extension version to advance by at least
  one patch.

### Changed

- Consolidated `demo/` and `test_data/` into the format-organized
  `data sample/` directory and updated all test, generator, certification, and
  documentation paths.

### Fixed

- The initial Preview page now asks users to select a file, folder, or URL
  instead of showing file-specific preview controls before a source is selected.

## [2.1.0]

Generated SQL was verified by this project against live engines - an Azure SQL Database
(12.0.2000.8) and a SQL Server 2025 instance (17.0.1000.7) - and this release
fixes everything the runs found wrong. Both the native TypeScript generator and
the optional Python generator carry every fix; neither can drift because both
test suites read the same machine-readable evidence file. These are independent
project test results, not Microsoft certification.

### Added

- **Credential setup is now a guided, platform-aware workflow.** It constrains
  storage and authentication choices by SQL platform, generates safe
  placeholders for SAS and S3 credentials, supports `USER IDENTITY` and managed
  identity where available, maps Blob/ADLS/OneLake/S3 connector locations, and
  explains the SQL Server 2025 Azure Arc requirement.
- **Public certification evidence omits all engine timing data.** JSON no longer
  serializes batch/cell elapsed times, JUnit carries no `time` attributes, and
  Markdown carries no run timestamps. This preserves functional compatibility
  evidence without publishing benchmark-like results.
- **The Marketplace-facing README now identifies this as a personal,
  independent project** and explicitly disclaims Microsoft sponsorship,
  endorsement, approval, or certification.

### Changed

- **The full editor tab is now the default extension surface.** Selecting the
  Activity Bar icon, running **Open**, analyzing a file or folder, or connecting
  Azure Storage opens or focuses the editor panel instead of keeping the
  workflow in the narrow sidebar. Set `sqlFileDetectionTool.defaultView` to
  `sidebar` to retain the previous layout; both surfaces still share one state.
- **Preview is now the first and default tab.** The previous Quick Analyze,
  Formats, Best Practices, COPY INTO, JSON, and FOR JSON tabs were removed to
  keep the workflow focused. JSON guidance remains contextual inside
  `OPENROWSET` and external-table output.
- **The native interface now uses the Power Studio visual language** recovered
  from the original design mockup, while continuing to use VS Code theme
  variables for dark, light, and high-contrast compatibility.
- **Sources now use an Explorer-style folder tree.** The selected folder and one
  child level are shown without exposing absolute paths or running an unbounded
  recursive scan, while source actions live together in the top toolbar.
  Filenames use their own row so type and size details no longer truncate them.
- **Storage and credential setup are one workflow.** Paste a known Azure Blob,
  ADLS, OneLake, or S3 location to generate the external data source, or sign in
  with Microsoft Entra to browse a storage account and fetch a file for analysis.
  Credential SQL is available even before a file is analyzed.
- **Appearance follows VS Code directly.** The extra Appearance control and
  density modes were removed.
- **The Schema tab now shows recommended `SQL Type` values** instead of empty
  override boxes. Recommendations use the same length-aware mapping as generated
  SQL and remain editable.
- **Generated BULK INSERT, EXT TABLE, and credential scripts are more concise.**
  Detailed guidance moved to platform-specific Microsoft Learn links in each
  panel, while required platform caveats remain beside the SQL.
- **EXT TABLE now follows OPENROWSET** in the statement tab order.

### Fixed

- **Unsupported files are filtered before analysis.** Folder scans and direct
  selection now ignore Python, Office, archive, and other non-SQL sources instead
  of opening them for content sniffing. SQL-readable data files and
  Delta/Iceberg tables remain available; Hudi folders expose Parquet data files.
- **Credential inputs now retain focus and caret position** when regenerated SQL
  pushes a new shared-state snapshot into the webview.
- **Selecting a supported Explorer file now analyzes it immediately** and opens
  Preview so JSON, Parquet, and other results are visible without another action.
- **Microsoft storage browsing no longer dead-ends after sign-in.** Microsoft Entra access can
  be pinned to the storage directory, clears stale VS Code account preferences,
  offers explicit subscription discovery, and accepts a storage account name
  directly. Tenant mismatch errors now explain the corrective action.
- **Scoped storage credentials stay in scope.** Container/prefix SAS URLs and
  public container URLs browse that location directly instead of attempting an
  account-wide container listing that Azure rejects.
- **Failed replacement sign-ins preserve the working storage connection.** A
  cancelled account picker or tenant mismatch no longer discards the current
  browser session or remembered credential.

- **A BOM, pure ASCII and valid UTF-8 now settle the encoding before `chardet`
  is consulted.** `chardet` is a statistical guess, and on some builds it scores
  the demo UTF-8 fixtures as Windows-1254 with roughly 0.46 confidence. Reading
  them back through that charmap codec failed on byte `0x81`, so the file
  arrived with an `error` in its metadata and a codepage of `ACP`. What the
  bytes *are* is now established first - the byte order mark, then a
  pure-ASCII check, then a strict UTF-8 decode - and `chardet` is left to do
  the one job only it can do, which is naming a legacy codepage such as CP932.
  A multi-byte character sliced in half by the 64 KiB read cap is tolerated
  rather than mistaken for corruption. Files that are already detected as
  ASCII stay ASCII; this is not a reclassification.
- **UTF-16 that arrives without a byte order mark is no longer read as ASCII.**
  Latin text encoded as UTF-16 is a run of `XX 00` pairs, so every byte is
  below `0x80` and a plain ASCII test claims the whole file. Decoding it as a
  single-byte codepage then treats the NUL padding as data: a three-column,
  two-row CSV came back as six rows with a `CODEPAGE` of `1252` instead of
  `1200`. Both the TypeScript core and the Python library now look at *where*
  the NUL bytes sit before deciding - real text has none, binary scatters them
  across both parities, and only a sample whose NULs land on exactly one
  parity is called UTF-16.
- **A redirect verdict is no longer destroyed by closing a bodyless error.**
  On Python 3.9 `HTTPError` leaves `fp` as `None` when it is constructed
  without a body, and calling `close()` on it raises `KeyError: 'file'` from
  deep inside `tempfile`. That escaped the public-data fetcher and replaced the
  real "this redirect points somewhere private" error with an unrelated one.
  The body is now closed only when there is a body to close. Python 3.10 and
  later substitute an empty `BytesIO` and so never showed the bug.
- **The complete document survives being run twice, without emptying a table it
  did not create.** Every `CREATE` in the generated end-to-end script - table,
  external table, external data source, external file format, database scoped
  credential - is wrapped in a catalog-existence guard. Re-running the document
  used to stop at error 46502 on the second `CREATE EXTERNAL DATA SOURCE`.
  Guarding the DDL alone would have replaced that with a quieter and worse
  failure, a row count that went from 150 to 300 without saying anything, so the
  document also empties its load target in its own batch immediately before the
  first load.

  That emptying step was, for one release candidate, a live and unconditional
  `IF OBJECT_ID(N'[dbo].[<file name>]') IS NOT NULL TRUNCATE TABLE ...`. On a
  warehouse where `orders.csv` and `dbo.orders` are the same subject, running the
  script emptied the warehouse table. The truncate is now **opt-in**
  (`rerun_truncate=True`, `rerunTruncate: true`) and is never emitted live for
  the default schema even when asked for, because a script that did not choose
  the name cannot know it created the object. By default the document ships the
  truncate as commented guidance under a `RERUN SAFETY` heading. Callers that
  name their own schema - which is what the certification harness does, and what
  `--schema` exists for - get the live statement and idempotent reruns.
  Individual statement tabs are deliberately left bare: a tab is copied into an
  editor once, whereas the document is the thing people re-run. Mirrored in the
  native TypeScript generator and the Python generator, with the boundary pinned
  by tests in both, including one that proves a pre-existing `dbo.orders` is
  never touched.

- **An apostrophe in a column name no longer swallows a batch.** Identifier
  escaping doubles `]` but leaves `'` alone, so a CSV header like `Employee's ID`
  reached the rerun guard verbatim inside `[Employee's ID]`. The scanner that
  finds the end of the guarded statement read that apostrophe as the start of a
  string literal, inverted quote parity for the rest of the scan, missed the
  terminating semicolon and pulled the following `GO` inside the
  `IF ... BEGIN ... END` block - where sqlcmd and SSMS still honour it as a batch
  separator, leaving the first batch with an unterminated `BEGIN`. The scanner
  now skips bracketed and double-quoted identifiers and stops at a batch
  separator. Fixed in both generators.

- **A file named `orders.csv` can be kept away from `dbo.orders`.** Every
  generated object name is caller-controlled: `--schema`, `--table`,
  `--credential-name` and `--auth-method` on the CLI, and the same fields in the
  extension, which previously offered no way to set the credential name or the
  authentication method at all. The default is deliberately unchanged - a
  derived name still lands in `dbo`, because changing it silently would break
  existing scripts - so on a warehouse that already has that table, set
  `--schema`.
- **The local CSV `OPENROWSET` can actually be run.** It used to emit a
  `FORMATFILE = '<format_file>'` placeholder, which meant the statement could
  never execute as written. It now emits `FORMAT = 'CSV'` with an inline `WITH`
  schema, and keeps the bcp format-file route as a comment for the cases that
  need it.
- **`USE_TYPE_DEFAULT` is now `FALSE` and always written out.** The inherited
  default rewrites a missing value as `0` or an empty string, which quietly
  destroys the difference between absent and zero.
- **Newline-delimited JSON reads through the right kind of data source.** An
  `https` `TYPE = BLOB_STORAGE` source rejects row-framing options with error
  5369 on both engines. NDJSON now goes through an `abs://` virtualization
  source with CSV row framing, while whole-document JSON keeps the
  `BLOB_STORAGE` source with `SINGLE_CLOB`. The generator chooses by the shape
  of the JSON.
- **UTF-16 whole-file reads use `SINGLE_NCLOB`.** `SINGLE_CLOB` on a UTF-16 file
  fails with error 4806 because it requires a DBCS file.
- **Excel and Iceberg no longer fall through to a `DELIMITEDTEXT` external file
  format.** A format that would misread the file is worse than no format; they
  emit explicit guidance instead.
- **`FIRST_ROW` gating matches the engines.** It is emitted for SQL Server
  2022/2025, Azure SQL Database and Fabric SQL Database, and explained as
  unavailable elsewhere.
- **A CSV whose analysis fails no longer aborts generation.** The detector
  seeds every metadata field as empty, decides the format from the extension,
  then runs the per-format analyser inside a catch-all that records the error
  and carries on — so a missing optional dependency, an unreadable file or a
  corrupt one hands back a file still typed as CSV but with no delimiter. A
  dictionary default only fills in a key that is *missing*, not one that is
  present and empty, so generating the best-practices section for that file
  raised `TypeError` and lost the whole script. Every optional metadata field
  is now read through one helper that treats an empty value like an absent one,
  which also closed six `KeyError`s on an absent file path. Widening the test
  to every optional field the generators actually read then exposed the same
  class of defect in the native generator: a `schema` or `nullable_columns` that
  arrives as anything other than a list reached `.filter`/`.slice`, and a null
  `file_path` reached `.split`, in both cases throwing instead of degrading.
  Both generators are now checked against the same absent-and-empty matrix.
- **The setup section creates the data source a JSON read names.** A file format
  and a data source are different objects. JSON has no
  `CREATE EXTERNAL FILE FORMAT` on any engine, and the generator was treating
  that as "no setup needed" and returning a "not available" message - while the
  JSON read it generated still said `DATA_SOURCE = '<name>_Bulk'`. The result was
  a statement referring to an object nothing created, which fails with error
  12703 / 46501 and reads exactly like a generator defect. The setup now emits
  the data sources for JSON and states why no external file format follows.
- **Local JSON reads are encoding-aware, and NDJSON is not slurped as one
  document.** The local `OPENJSON` path hard-coded `SINGLE_CLOB`, so a UTF-16
  JSON file failed with error 4806 even though the remote path had already been
  fixed; and a `.jsonl` file was read as a single malformed document. The local
  path now picks `SINGLE_NCLOB` by encoding and assembles NDJSON lines into a
  JSON array before parsing.
- **The cleanup gate no longer refuses its own cleanup.** The certification
  harness forbids `DROP DATABASE`, and the rule was written as
  `\bDROP\s+DATABASE\b` - which also matches `DROP DATABASE SCOPED CREDENTIAL`,
  a different object entirely. Every credential the harness created was
  therefore un-droppable by the harness, and one live run finished reporting
  itself clean while leaving two managed-identity credentials on the server. The
  rule now carries a `(?!\s+SCOPED\s+CREDENTIAL\b)` lookahead, and every kind in
  `CLEANUP_ORDER` is put through the gate by a test. `ALTER DATABASE` still gets
  no equivalent exception: layer 1 was once the reason, but layer 1 is position
  dependent, so the rule stays broad on its own merits - nothing the harness
  generates alters a credential.
- **Cleanup outcomes are in the evidence.** A run used to report
  `cleanup_verified` and a residue count, which are both derived from an
  inventory query and say nothing about which statement ran. A `DROP` the gate
  refused looked identical to one that succeeded. Every cleanup statement is now
  recorded with its outcome, redacted, in the JSON and named in the Markdown when
  it did not run.
- **The safety gate checked only the first object in a list.** `DROP TABLE`,
  `DROP VIEW`, `DROP EXTERNAL TABLE`, `DROP SCHEMA` and `TRUNCATE TABLE` all
  accept a comma-separated list of objects, and every scope rule captured one
  name per verb. A statement whose first target was legitimately run-owned
  therefore carried every later name past the scope check untouched - schema
  scoping, prefix scoping and the foreign-database check alike - and the gate
  reported no violations at all:

  ```sql
  DROP TABLE [<run schema>].[<run table>], [sales].[invoices];
  ```

  Only the two text-wide scans still applied, so `dbo` and the TPC-H names
  stayed protected and every other schema on the instance did not. With a
  three-part name in the list it reached another database. Two defences now:
  the shape is refused outright, because neither generator has any reason to
  emit a multi-object drop and cleanup deliberately emits one statement per
  object so each outcome can be recorded on its own; and the scope check walks
  the whole list, because a scope check that depends on another rule holding is
  not a scope check. Each is tested with the other disabled.
- **An escaped `]]` inside a name defeated both of those defences at once.** A
  bracketed identifier ends at a *single* `]`; a doubled `]]` is an escaped
  bracket and stays inside the name. The gate's identifier grammar did not know
  that and stopped at the first `]`, which is the middle of the name as far as
  the server is concerned - so everything after that point was text no rule
  looked at:

  ```sql
  DROP TABLE IF EXISTS [<run schema>].[<run table>]]x], [sales].[invoices];
  ```

  The shape rule saw a `]` where it wanted a comma and did not fire; the list
  walk stopped on its first iteration. Both defences rest on the same grammar,
  so the redundancy they were built for was not there for the one input that
  needed it. This is not an exotic case either: `escapeIdentifier` and
  `_escape_identifier` emit `]]` by design, so it is the project's own escaping
  convention. The masker in `batches.py` had always handled it - and says in a
  comment why it must - but the lesson had never been carried across to the
  identifier regex. The grammar now consumes doubled `]]` and `""`, name
  splitting undoes the escape so scope comparisons see the real name, and a
  target list that cannot be fully parsed is refused rather than ignored, so a
  future grammar gap fails closed.
- **A Unicode letter did the same thing to the same grammar.** `_IDENT`'s
  unquoted alternative was `[A-Za-z_@#][A-Za-z0-9_@#$]*`, but T-SQL regular
  identifiers accept Unicode letters. One non-ASCII letter therefore truncated
  the name, and that single truncation defeated every layer at once: the
  truncated head is genuinely run-owned so the scope check passed, the comma was
  no longer adjacent to a complete name so the shape rule never fired, and the
  tail backstop was a denylist of the three characters the *then-known* desyncs
  left behind. A Cyrillic homoglyph makes such a payload invisible in review.
  The grammar is Unicode-aware now, and - the more important half - the tail
  backstop became an allowlist: whitespace, `;` or end of batch may follow a
  parsed object list, and anything else is refused. A denylist can only name
  the gaps somebody has already found, which is how the same bug arrived twice.
- **The gate and the server now read a qualified name the same way.** Three
  places where the two parsers could still disagree are closed. An omitted name
  part (`a..b`, `a...b`) had its empty pieces dropped before the part count was
  checked, so the gate read schema plus object while a server reads a database
  with a defaulted schema, or a linked server; it is refused now instead of
  being normalised away. `(` was removed from the tail allowlist, because no
  list verb is ever followed by a parenthesis against the object name - the
  shape that looked like a counterexample, `TRUNCATE ... WITH (PARTITIONS (1))`,
  is admitted by the space before `WITH`. And the batch-start scan required an
  ASCII first character, so a batch opening with a Unicode letter matched
  nothing and was never head-checked; it fails closed now like any other verb
  the scanner cannot name. None of the three had a working exploit. They are
  fixed because every breach found in this gate so far came from exactly this
  disagreement, and the cost of removing it is lower than the cost of arguing
  each time about whether it happens to be reachable.
- **A statement head could be swallowed by the line above it.** Layer 1's line
  scan separated its two-word phrase with `\s+`, which matches a newline, and it
  *consumed* what it matched. A one-word head on one line therefore absorbed the
  next line's verb, and `re.finditer` resumed after it, so that verb was never a
  scan position and never head-checked at all. `BEGIN` is an allowed simple head
  that both generators emit on its own line, which made this a normal shape:

  ```sql
  BEGIN
      ALTER TABLE [sales].[t] DROP COLUMN [c]
  END
  ```

  passed the entire gate with no violations. The loss was precisely layer 1, and
  it mattered for exactly the verbs layer 1 was the sole defence for - `ALTER`
  and the object kinds the harness does not manage. `ALTER SCHEMA ... TRANSFER`
  was the sharpest of them: it moves a pre-existing table into the run's own
  schema, at which point the run's own teardown destroys it. The scan now
  captures its phrase inside a lookahead and separates the words with horizontal
  whitespace only, so no scan position can be consumed. Independently, `ALTER`
  of an object and `DROP` of an unmanaged kind are now position-independent
  layer 2 refusals, so neither depends on the scanner finding the right position
  any more.
- **`SELECT ... INTO` needed no whitespace to escape its scope rule.** The rule
  required `INTO <name> FROM`, and T-SQL does not require a space after the
  target, so `SELECT * INTO [sales].[victim]FROM sys.objects` matched nothing
  and created a table outside the run schema that cleanup - which only removes
  names the run owns - would never have taken away.
- **The crash handler could not see the values it existed to hide.** It is the
  last thing between a driver exception, which routinely echoes the connection
  target back, and a console or CI log. It seeded its redactor from `args`, but
  `--host`, `--database` and `--user` are overrides with no defaults and the
  documented way to configure a run is the environment, so on the normal path it
  was seeding from `None` and falling back to pattern matching that has no
  generic-hostname or generic-login filter by design. It now reads both sources.
  A password is in neither, by design.
- **Each object is dropped exactly once.** Recording those outcomes immediately
  exposed a second cleanup bug that the residue count had been hiding: a run that
  removed everything it created reported 34 of 36 statements successful. An
  external table is a row in `sys.external_tables` and, because it is still a
  table, a row in `sys.tables`, so the inventory reported the same object under
  two kinds and the planner emitted a `DROP` for each - the second failing on
  something the first had already removed. The table inventory now excludes
  `is_external = 1`, and the planner deduplicates by namespace so the earlier and
  more specific kind in `CLEANUP_ORDER` wins, which is also the only correct
  choice because `DROP TABLE` does not remove an external table.
- **An assertion that was never evaluated no longer counts as a pass.** Every
  `sql_excludes` check is trivially true against an empty string, so a cell whose
  generator produced nothing came back with a full set of green assertions and
  was counted as accepted - the most misleading result the harness can produce,
  because it looks like proof and is the absence of one. Empty output is now
  recorded as unevaluated and cannot be accepted; guidance-only output, where a
  comment block genuinely is the deliverable, is checked against the full text
  and says so in the evidence.
- **Redaction leaves common words alone.** The redactor substitutes the literals
  it is handed, so a run against `master` blanked that word out of every "master
  key" message in its own evidence. System database names and a short list of
  ordinary words are now exempt, and literals shorter than four characters are
  ignored, which is the boundary below which substitution rewrites ordinary SQL
  rather than protecting anything.

### Added

- **The extension can set the credential name and the storage authentication
  method.** Both were generator options that no part of the UI could reach, so
  a webview user was stuck with the default credential name and could not pick
  SAS when a managed identity was unavailable. A multi-file export now also
  applies the table-name override to the file it was typed for instead of
  dropping it.
- **Managed identity is the default way the generated SQL reaches private
  storage.** `CREATE DATABASE SCOPED CREDENTIAL ... WITH IDENTITY = 'MANAGED
  IDENTITY'` stores no secret, so no database master key is created and there is
  no master key password to invent or rotate. This was verified live: the
  master key count stayed at zero before, during and after the credential
  existed. `--auth-method sas` restores the previous behaviour, and
  `--auth-method public` covers anonymous containers.
- **`tests/certification/expected-matrix.json`** records each live finding as a
  rule tagged `live`, `live-negative` or `static`, with the engines that
  produced it. `tests/certification/test_matrix.py` and
  `src/test/native/certificationEvidence.test.ts` both read it, so a change to
  either generator that contradicts the evidence fails the build.
- **`scripts/certification/`**, the harness that produced the evidence. It is
  not shipped - `.vscodeignore` is an allowlist, so nothing under `scripts/`
  can enter the package - and it refuses to send any statement that touches
  `dbo`, names an unprefixed object, or targets a TPC-H table. Its
  `execute --dry-run` mode is fully offline: no environment variable, no
  password, no adapter, no socket. Its connection layer requests encryption
  explicitly rather than trusting a driver default - `pymssql.connect` has no
  `encrypt` parameter, so the setting was being dropped - and refuses to connect
  at all if the installed driver cannot honour it. Every value that comes back
  from a driver is normalised before it is redacted, so a `bytes` column can
  neither crash the JSON report nor reach an artifact as raw binary.
- **The harness executes a cell in the state that cell needs.** Statements were
  being sent as isolated fragments: an `OPENROWSET` before its data source
  existed, an external table before its file format, a `BULK INSERT` with no
  table to insert into, and every statement in `master` because no run database
  was ever created or switched into. The run now owns a lifecycle - create a
  uniquely named run database, reconnect into it, create the run schema, run each
  cell's prerequisites, then the cell, then a verification query - and drops the
  database from `master` at the end, proving with `DB_ID` that it is gone. A
  prerequisite that fails marks the cell `NOT_EXECUTABLE`, never `FAIL`: a
  missing precondition is not a product defect.
- **A DDL statement is judged by the catalog, not by a row count.** Row and
  column expectations were applied to every cell, so `CREATE EXTERNAL FILE
  FORMAT` and `CREATE EXTERNAL TABLE` were recorded as failures for returning no
  rows, which is what they are supposed to do. Result assertions now attach only
  to the cells that run a query; a DDL cell passes when it raises no error and
  its object is present in the catalog afterwards.
- **The harness cannot mistake an unanswered question for a "no".** A catalog
  presence check that could not be read is now recorded as unverified rather than
  as an absent object, and a cleanup inventory that could not be read leaves
  `cleanup_verified` false and names the unreadable inventory kinds - previously
  a permission error would have reported a clean teardown. Both driver exception
  shapes are decoded, so an error number is recovered whether the driver passes
  it as an integer (pymssql) or parenthesised inside the message (pyodbc); until
  now every predicted refusal was read as a defect under pyodbc, and an
  unrecognised login failure could be retried. Retry classification fails closed:
  an unclassifiable failure is not replayed unless it also looks like a transport
  failure. The run database is dropped in a `finally`, so a failure to create the
  run schema can no longer leave a live database behind, and `verify` re-gates
  every batch a run would send - prerequisite setup and verification queries
  included - naming the block it refused.
- **A generated schema now describes the file the run actually reads.** The
  harness analysed a local demo fixture and then pointed the statement at a
  public blob, so a ten-column synthetic sales schema was being read against the
  five-column public iris CSV - and a Parquet fixture with nested, map and
  decimal-boundary columns was mapped onto 21 flat taxi columns. Those cells
  either failed for the wrong reason or passed with every projected value NULL.
  Staged fixtures now declare which public object they are, generation happens
  from that declaration, and a remote entry without one is planned
  `NOT_EXECUTABLE` rather than guessed at. Row expectations are capped to what
  the query asks for, and every cell that reads a declared object also asserts
  that its first row is not entirely NULL.

### Changed

- **ORC is documented as "DDL accepted, data path not certified"** rather than
  supported or unsupported. Both engines accept and drop
  `FORMAT_TYPE = ORC` cleanly. The exact fixture is now public, but the
  production path does not execute ORC row reads. The native reader still
  recognises ORC without parsing it, which is a separate limitation.
- **Storage paths keep their original case**, and the README says why: blob
  paths are case sensitive, and asking for `Yellow/` when the container holds
  `yellow/` fails with error 13807.
- **A script that still contains placeholders says so.** Output for a local file
  targeting Azure SQL leads with the staging step and the substitutions to make,
  instead of leaving placeholders to imply the script is ready to run.

### Notes

- The rubber-duck hypothesis that `CODEPAGE = '1200'` was wrong for UTF-16 bulk
  paths was **disproven** live: it preserved content, as did
  `DATAFILETYPE = 'widechar'`. The generator was left alone rather than changed
  on the strength of the claim. Exact UTF-16 CSV and TSV fixtures now pass
  against the canonical public bytes.
- Live certification covers the two engine versions that actually ran. No claim
  is made for SQL Server 2019 or 2022, which were not present.
- The Delta result certifies protocol `minReader = 1` / `minWriter = 2` and the
  `FORMAT_TYPE = DELTA` DDL, not newer Delta features.
- Final project verification runs closed with **no failures on either engine**: SQL
  Server 2025 at 24 PASS / 0 FAIL / 7 NOT_EXECUTABLE / 1 negative control, and
  Azure SQL Database at 29 PASS / 0 FAIL / 6 NOT_EXECUTABLE / 1 negative
  control. Zero confirmed defects. Cleanup was independently verified on both
  engines and **residue is zero on both**; on Azure SQL Database every one of the
  63 cleanup statements is recorded as successful. Earlier cleanup hardening
  took three attempts, all involving harness bugs rather than product ones —
  see "The cleanup gate no longer refuses its own cleanup" and "Each object is
  dropped exactly once" above. Remaining `NOT_EXECUTABLE` cells are explicit
  platform/construct limits rather than missing public bytes.
- **Excel and Iceberg are pinned by static assertion, not by live execution.**
  Both are settled by the tests that read the generated text — no
  `DELIMITEDTEXT` format, explicit guidance instead. Their fixtures are public,
  but neither has an executable external-file-format construct on these targets.
- **The live evidence was produced by the Python generator.** The harness imports
  `external_file_detection`, so every statement that reached an engine came from
  the Python implementation. The native TypeScript generator's certification is
  derived: `tests/native_parity/python_baseline.json` pins the structural markers
  of every statement both implementations produce for the same 19 fixtures, and
  `src/test/native/generatorParity.test.ts` fails if the port's markers differ.
  The shared matrix in `tests/certification/expected-matrix.json` is asserted
  against both. A behaviour certified live is therefore certified for the native
  generator only for as long as parity holds, which is what the parity suite is
  for.
- **The public JSONL fixture is a pinned snapshot of somebody else's CI
  artifact.** The OpenVMM `petri.jsonl` blob used for NDJSON row framing (729
  rows, four fields) belongs to a test-results container that its owners are free
  to prune or restructure. The URL and the expected shape are pinned in
  `scripts/certification/public_fixtures.py`, and a staged run checks the shape
  before asserting on it, so fixture rot shows up as an unstaged cell rather than
  as a generator defect.

## [2.0.0]

The extension is now a genuinely native VS Code extension. This is a major
version because the runtime architecture changed completely: the Python
interpreter check, the managed virtual environment, `pip`, the Flask server, the
localhost port, the health polling and the Simple Browser are all gone, and the
extension now ships as a single bundled JavaScript file.

The Python distribution versions independently and is unchanged by this release.
It remains supported as optional compatibility tooling.

### Changed

- **Version 2.0.0**, and the extension is bundled with esbuild. `main` is now
  `./dist/extension.js`: one CommonJS file with every runtime dependency inlined
  and minified, so the ESM-only `hyparquet` reader and the Azure SDK execute
  correctly under VS Code's Node runtime. `vscode:prepublish` runs the bundle.
- **`.vscodeignore` is a strict allowlist.** It starts from `**` and re-admits
  named files only, so a new file cannot leak into the package by default. The
  `.vsix` contains 17 entries and weighs 619 KiB: the bundle, the webview assets,
  the icons, the walkthrough GIF and markdown, `package.json`, `README.md`,
  `CHANGELOG.md`, `LICENSE` and `THIRD_PARTY_NOTICES.md`.
- **The README leads with the extension.** Installation is split so the VSIX
  install stands alone and the Python CLI has its own clearly optional section.
  The startup and analysis measurements, the supported-format matrix and the ORC
  limitation are stated explicitly rather than implied.
- **The walkthrough GIF was recaptured from the native UI.** The previous one
  showed the Flask browser interface that no longer exists. The new recording
  (960x540, 19.5 s, 0.20 MB) is driven by the real controller against
  `data sample/parquet/sales.parquet`, so the column types, row values and generated
  T-SQL in the frames are what the shipped engine produces. The Azure beat uses
  a synthetic `contoso.example` identity with no token, SAS or account key.

### Added

- **`scripts/build.js`** — the esbuild bundler, with a `verifyBundle()` step that
  fails the build if a dependency was left unbundled, if `require("vscode")` is
  missing, or if `child_process` or `worker_threads` appear in the output.
- **`scripts/audit-vsix.js` and `npm run audit:vsix`** — a mechanical audit of
  the built archive. It fails on any `.py` file, `pyproject.toml`, wheel, venv,
  `node_modules`, test, fixture, raw TypeScript, source map, cache or credential
  file; on backend vocabulary in the bundle; and on a package over 5 MB.
- **`scripts/generate-notices.js` and `THIRD_PARTY_NOTICES.md`** — notices
  derived from the real bundle metafile, so they always describe what actually
  ships. `npm run notices -- --check` fails CI if they drift. All 33 bundled
  packages are MIT.
- **`src/test/packaging.test.ts`** — packaging guards: the manifest, the version,
  the activation events, the dependency set, the allowlist shape, the absence of
  backend vocabulary in the bundle, dependency inlining, bundle size, notices
  coverage, and the full VSIX audit when a package is present.
- **`src/test/bundleRuntime.test.ts`** — loads and activates `dist/extension.js`
  itself, with `PATH` emptied and `child_process`, `http`, `https`, `net` and
  `dns` all sabotaged, so the artifact that ships is the artifact that is tested
  and offline activation is proven rather than assumed. It records load,
  activation, first render, warm render, first analysis, repeat analysis and
  retained-heap measurements as regression guards.
- **`src/test/native/demoMatrix.test.ts`** — turns the supported-format table in
  the README into an executable claim. Every fixture committed under `data sample/` is
  analysed through the shipped service and checked for its detected format,
  recovered column count and whether it was genuinely parsed or only recognised.
  Adding a fixture without adding its row fails the suite.
- **A "Get started" walkthrough** contributed to VS Code's welcome page, with
  four steps covering opening the view, analysing a file, reading the generated
  SQL, and connecting Azure Storage.
- **`scripts/capture-walkthrough.js` and `npm run capture:gif`** — regenerates
  the README GIF from the current native webview, using an already-installed
  Edge or Chrome. No browser download and no ffmpeg.
- F5 debugging now builds and launches the bundle. `main` moved to
  `dist/extension.js`, so the old `npm: compile` pre-launch task and
  `out/**/*.js` source-map roots would have attached a debugger to files VS Code
  was not running. A `npm: bundle:dev` task builds with an inline source map.

### Removed

- `src/backend.ts`, `src/pythonEnv.ts`, `src/process.ts` and
  `src/legacyBackendUrl.ts` are deleted, together with their tests. No module in
  the repository can now start a process, choose a port, build a loopback URL or
  poll a health endpoint on behalf of the extension.
- Every Python file, `pyproject.toml`, demo fixture, test and source file is
  excluded from the package. The extension carries no Python payload of any kind.

### Security

- **The Python `GO`-batch injection gap is closed.** `GO` is a client-side batch
  separator, not a T-SQL keyword, so a newline smuggled into a bracketed
  identifier or a quoted literal is accepted by the server-side parser but cuts
  the statement in half in sqlcmd, SSMS and Azure Data Studio — letting whatever
  follows run as its own batch. `external_file_detection/sql_generator.py` now
  collapses control characters fail-closed in `_escape_identifier`,
  `_quote_literal` and `_sql_comment`, and `_split_go_batches` is region-aware
  (literal, bracket, block comment, line comment) and splits on CR/LF only. The
  JSON-path and SQL-type allowlists are anchored with `\A`/`\Z` and compiled
  ASCII-only, because Python's `$` matches before a trailing newline and its
  `\d` is Unicode-aware — both would have been wider than the native engine.
- The collapse set in both implementations now also covers U+0085, U+000B,
  U+000C and U+001C-U+001E. Python's `str.splitlines()` breaks on all of them; a
  defence that depends on which reader splits the script is not a defence.
- New regressions in `tests/test_sql_injection.py` drive malicious CSV headers,
  JSON keys, file paths, data-source names and table/schema names end to end
  through `generate_all_statements`, and check the result against a *naive*
  sqlcmd-style splitter rather than the project's own region-aware one, so the
  tests model the client that actually executes the script.
- `npm audit --omit=dev` reports no vulnerabilities. No production dependency
  has an install script, a `gypfile` or a native binary.
- **`safeSqlType` no longer admits a line break.** The type-override allowlist
  used `\s*` between the type name and its parenthesised length. The accepted
  candidate is interpolated into DDL verbatim - it is the one generator path
  that does not run through the control-character collapse - so `\s` put a real
  CRLF inside `CREATE TABLE`. It is now `[ \t]*` in both implementations, which
  also removes a TS/Python divergence: JavaScript's `\s` matches U+00A0, U+2028,
  U+2029 and U+FEFF, which Python's `re.ASCII` does not. Found by code review;
  not exploitable as `GO` injection, because the grammar admits no line that can
  reduce to `GO`, but it contradicted the guarantee the rest of this release
  establishes.
- **The Excel reader no longer compiles untrusted input into a regular
  expression.** `firstSheetPath()` interpolated the `r:id` attribute of a
  caller-supplied workbook into `new RegExp`. A crafted id hangs the extension
  host on catastrophic backtracking - reproduced, not theorised - or throws a
  `SyntaxError` from a path that expects only a parse miss. Relationship ids are
  now compared with `===` against literal patterns, with regressions covering
  both shapes. Found by security review.
- **The VSIX audit now reads the bytes it vouches for.** It previously checked
  only filenames for credentials, so a key pasted into any source file was
  inlined into the bundle by esbuild and shipped under an innocent name with the
  gate reporting success. It now scans every shipped text entry against seven
  credential shapes (storage account key, SAS signature, private key, JWT,
  GitHub, Slack and AWS tokens), applies the backend-vocabulary rules to every
  shipped `.js` rather than the bundle alone, and states in its pass message
  what it actually checked. A test proves each pattern matches its own shape, so
  the scan cannot rot into decoration.
- `pythonStringRepr` now escapes U+0085, U+2028 and U+2029, matching CPython's
  `repr()` exactly. Every current caller wraps it in `sqlComment()`, so this
  changes no output today; it means a future caller that forgets cannot
  reintroduce the vector.

### Notes

- The Python CLI and web application remain fully functional and fully tested,
  but they are **optional compatibility tooling**. No command, view or menu in
  the extension reaches them.
- Not yet published to the Marketplace. This release is a package built and
  installed locally, pending live SQL Server and Azure SQL certification.

## [2.0.0 — Layer 2: native webview UI]

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
  `src/process.ts` and `src/legacyBackendUrl.ts` survived this layer as
  deprecated, unreferenced transition code; Layer 3 removed them together with
  packaging and dependency pruning.
- Adds one runtime dependency, `@azure/storage-blob` (MIT), and one development
  dependency, `esbuild`, used to bundle the extension so the ESM-only
  `hyparquet` reader ships correctly.
- The version was unchanged at 1.1.1 at the end of this layer. Layer 3 owns the
  version bump, the demo GIF and the Marketplace copy.

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
  semantic statement invariants for the committed `data sample/` fixtures into
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
