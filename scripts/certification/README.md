# Certification harness

This directory is **not shipped**. `.vscodeignore` is an allowlist that starts
from `**`, so nothing under `scripts/` can enter the `.vsix`, and nothing here is
imported by the extension at runtime or by the Python package.

Its job is narrow: take what the generators actually emit, decide whether each
statement is safe to run against a live engine, and record the answer as
evidence. It exists because the alternative — hand-pasting generated SQL into a
production server that holds real TPC-H data — is how you drop someone's
`dbo.orders`.

## Final run

| | SQL Server 2025 | Azure SQL Database |
| --- | --- | --- |
| PASS | 16 | 17 |
| FAIL | 0 | 0 |
| NOT_EXECUTABLE | 14 | 12 |
| BLOCKED (negative control) | 1 | 1 |
| Accepted verdicts | 24 | 21 |
| Confirmed defects | 0 | 0 |
| Cleanup statements succeeded | all | 34 / 34 |
| Residue after independent recount | 0 | 0 |

The two accepted-verdict counts were computed under different rules and are not
comparable to each other. The Azure figure is the later, stricter one: a cell
whose static assertions fail no longer counts as accepted, and a cell that
generated no SQL at all is recorded as not evaluated instead of passing
vacuously. Three cells that the earlier rule accepted are excluded by the later
one. The SQL Server number predates that change. Neither engine produced a
confirmed defect under either rule, which is the number that matters.

Cleanup was verified independently after each run, and on both engines the final
residue is zero. Getting there on Azure SQL Database took three attempts, and the
reason is worth keeping. The v7 run left behind the two database-scoped
credentials it had created. The cause was in this harness, not in the product:
the gate's `DROP DATABASE` rule was written as `\bDROP\s+DATABASE\b`, which also
matches `DROP DATABASE SCOPED CREDENTIAL`, so the cleanup planner's own statement
was refused as if it were an attempt to drop a database. Those two credentials
were removed by hand. The rule now carries a `(?!\s+SCOPED\s+CREDENTIAL\b)`
lookahead and `tests/certification/test_safety.py` puts every kind in
`CLEANUP_ORDER` through the gate.

That fix would have been hard to confirm, because `cleanup_verified` and the
residue count are both derived from an inventory query and say nothing about
which statement actually ran — a `DROP` the gate refused looked exactly like one
that succeeded. So every cleanup statement is now recorded with its outcome. The
v8 run came back clean, and immediately showed a second, smaller problem that had
been invisible until then: 34 of 36 statements succeeded, the two failures being
`DROP TABLE` for external tables that `DROP EXTERNAL TABLE` had already removed.
`sys.tables` lists external tables, so the same object was inventoried under two
kinds. The table inventory now excludes `is_external = 1` and the cleanup planner
deduplicates by scope, and v9 reports **34 of 34 statements successful with an
empty residue list**, confirmed against an independent baseline count.

The `NOT_EXECUTABLE` cells are the byte-fidelity ones — the all-types, Unicode,
Delta, ORC, Excel and Iceberg fixtures. Proving those needs those exact bytes
readable by the engine itself, and the run had neither writable storage it was
authorised to create nor permission to change the server's configuration to
reach a local path. Recording them as not executable is the honest answer;
claiming coverage from a differently-shaped public file would not be. Each
engine's single `BLOCKED` cell is the deliberate negative control: a statement
the gate is meant to refuse, which proves the gate was live throughout.

No live run certifies an engine version it did not run against. These numbers
cover SQL Server 2025 and Azure SQL Database only.

## Safety model

The harness assumes the connection it is handed points at a database that
contains valuable data, and refuses anything it cannot prove is disposable.

Every run mints a unique identity: a schema name and an object prefix derived
from a run id. `safety.evaluate_batch` then rejects a batch outright if it

- touches `[dbo].` or any schema outside the run's own,
- names an object that does not carry the run prefix,
- names a protected object (`orders` and the rest of the TPC-H set),
- issues a statement outside the allowlist (no `DROP DATABASE`, no `ALTER
  DATABASE`, no service or server-level changes),
- references a host outside the maintained public fixtures,
- or contains anything that looks like secret material.

A batch that fails any of those is never sent. The violation code — for example
`PROTECTED_OBJECT`, `UNPREFIXED_TARGET`, `FORBIDDEN_SCHEMA_DBO` — is recorded
instead of a result.

`DELETE`, `UPDATE` and `MERGE` are refused outright. `TRUNCATE TABLE <name>` is
the single admitted exception, because the harness asks the generator for a
complete document that empties its own load target so a second run does not
double the data. That truncate is opt-in (`rerun_truncate=True` /
`rerunTruncate: true`) and the generator refuses to emit a live one for the
default schema at all — see the CHANGELOG entry on rerun ownership. Here it is
admitted only in that exact shape — a bare `TRUNCATE`, or one aimed at a
variable, is still refused — and the name still has to pass the scope rules, so
it can only ever empty a table the run itself created.

A statement gets **one** object. `DROP TABLE`, `DROP VIEW`,
`DROP EXTERNAL TABLE`, `DROP SCHEMA` and `TRUNCATE TABLE` all accept a
comma-separated list, and the scope rules capture one name per verb, so for a
while a statement opening with a legitimately run-owned table carried every
later name past the scope check with no violation recorded at all:

```sql
DROP TABLE [<run schema>].[<run table>], [sales].[invoices];
```

Only the `dbo` and TPC-H scans still applied, which left every other schema on
the instance unprotected — and a three-part name in the list reached another
database entirely. There are now two independent defences. The shape is refused
outright, because neither generator emits a multi-object drop and cleanup
deliberately emits one statement per object so that each outcome can be judged
and recorded on its own; and the scope check walks the whole list, because a
scope check that depends on another rule holding is not a scope check. Each is
tested with the other disabled.

A cell may not create an object its own prerequisite setup already created.
That is what C14 did on the first live run: the setup step created the
BLOB_STORAGE data source, and the `BULK INSERT` statement was generated with
its own prerequisite step, which created it a second time. The server answered
46502 and the failure arrived looking like evidence against the generator.
Cells whose `requires` includes `setup` are now generated with
`include_prereq=False`, and `_reject_duplicate_creates` blocks any plan where
the same object is created in both places, naming it.

Cleanup is generated as an explicit inverse of the setup, in dependency order,
and the run captures an object inventory before and after so residue is proven
to be zero rather than assumed.

## Credentials

The harness never asks for a password and never stores one. Endpoints, database
names and usernames come from environment variables or CLI flags; the password
comes only from an environment variable, stdin or an OS secret lookup, and is
removed from the process environment as soon as it is read.

| Variable | Meaning |
| --- | --- |
| `SQLFDT_CERT_HOST` | Server or endpoint to connect to |
| `SQLFDT_CERT_PORT` | Port, defaulted when unset |
| `SQLFDT_CERT_DATABASE` | Database name |
| `SQLFDT_CERT_USER` | Login name |
| `SQLFDT_CERT_PASSWORD` | Password, consumed and cleared immediately |

Everything written to disk goes through `redaction.py` first. Hosts, user names,
IP addresses and connection strings are replaced; the maintained public fixture
hosts are the only ones allowed through, because the evidence is meaningless if
you cannot tell which public file was read.

A driver error arrives as `(number, bytes)` from pymssql, so error text is
decoded — UTF-8 with replacement — before it is redacted. A `b'...'` repr in an
artifact would be both unreadable and a redaction hole, so all three renderers
are tested against a real-shaped byte-valued exception.

Connecting tries each available driver in turn and keeps the classification of
each candidate separately. A transient pymssql transport failure alongside a
pyodbc "no driver installed" stays retryable: the pair used to be called
permanent because permanence was OR-ed across candidates, and the retry that
would have succeeded never happened. An authentication or certificate failure
anywhere still makes the aggregate permanent, because retrying cannot fix it.

Exception arguments are flattened before anything reads them. pymssql does not
use one stable shape: it normally raises `OperationalError(number, message)`,
but an Azure SQL gateway failover produced `args == ((40613, b'...'),)` — a
single argument that is itself the pair. Reading one level deep found no number
and no text, so the failure was classified permanent and recorded with a `b'...'`
repr. Azure's retryable numbers, 40613 among them, are named explicitly in
`TRANSIENT_ERROR_NUMBERS` rather than left to the permissive default, and
`AUTH_ERROR_NUMBERS` still wins wherever both appear. Azure SQL's session
tracing ID is redacted out of the message it arrives in.

## Commands

Run from the repository root with `scripts` on the path:

```
set PYTHONPATH=%CD%\scripts
python -m certification plan --target azure --emit-sql --out manifest.json
python -m certification verify --manifest manifest.json
python -m certification execute --manifest manifest.json --dry-run
python -m certification execute --manifest manifest.json --confirm
python -m certification matrix
python -m certification report --evidence certification-evidence.json
```

`plan` builds a manifest of cells from real generator output. `verify` checks
that the manifest is internally complete — every hypothesis is covered, every
cell has a target and a cleanup path — and re-runs the safety gate over *every*
batch the run would send, including prerequisite setup and verification queries,
naming the offending block (`setup[0]:external_data_source`, `cell`,
`verification`) when one is refused. `execute --dry-run` is fully offline: it
gates, hashes and classifies every batch without reading any environment
variable, without asking for a password, without loading a database adapter and
without opening a socket. `--confirm` is required only when actually connecting.

`execute` writes three artifacts: redacted JSON evidence, a JUnit XML file so a
CI run can display the matrix, and a Markdown summary.

## Run lifecycle

A live `execute` does not send the cells as isolated fragments. It owns the
state each cell needs:

1. Connect to `master` and create a run database whose name carries the run
   prefix (on a target where `allow_create_database` is set — Azure SQL Database
   uses the database it was pointed at instead).
2. Reconnect *into* that database and create the run schema. Nothing scoped is
   run in `master`, which is also why no database scoped credential is created
   there: SQL Server rejects that with error 33158.
3. For each cell, run its prerequisites first — an `OPENROWSET` needs its
   external data source, an external table needs the file format too, a
   `BULK INSERT` needs a table to insert into. A prerequisite that fails marks
   the cell `NOT_EXECUTABLE`, never `FAIL`. Errors 12703, 46501, 208 and 2760
   are sequencing failures, not generator defects.
4. Run the cell's own batches, one `GO`-separated batch at a time.
5. Run the cell's verification query, where it has one, and assert row and
   column counts against *that* result rather than against the cell. A DDL cell
   asserts nothing about rows; it passes when it raises no error and its object
   is present in the catalog afterwards.
6. Clean up in inverse dependency order, then drop the run database from
   `master` and prove with `DB_ID` that it is gone.

Cells that read a file the engine cannot reach are planned as `NOT_EXECUTABLE`
rather than run. A path is engine-local, not client-local: the file is analysed
on this machine and the statement runs on the server, so interpolating a
worktree path produces error 4860. Where a fixture is staged on the server, the
staging file supplies an `engine_local` location and the generator is given that
path explicitly.

Public fixtures are read anonymously and emit no credential and no database
master key. Managed identity is one cell of its own, not a blanket default.

## Staged bytes and generated schemas

The harness analyses a local demo fixture and then points the generated
statement at a public blob. That is only sound when the two describe the same
file, and for a while they did not: `csv_scalar` mapped ten columns of synthetic
sales data onto the five-column public iris CSV. The generated `WITH` clause
then named columns the object does not have, which produces either an error that
reads as a generator defect or - worse - the right number of rows with every
value NULL, which a count-only assertion calls a PASS.

So a remote staging entry must also declare a `shape`, naming an object in
`public_fixtures.py`. That module is committed, carries no credentials and pins
a public URL per object, and the planner generates from *it* rather than from
the demo file. A remote entry with no declared shape is planned
`NOT_EXECUTABLE` on purpose, as is one whose shape is the wrong file type. An
`engine_local` entry needs no shape, because it means *these* fixture bytes were
copied to the engine host.

Three consequences worth stating:

- The demo `all_types.parquet` fixture has nested, map, list and
  decimal-boundary columns. No public object has that shape, and NYC taxi - 21
  flat scalars - is not a substitute. Those cells stay `NOT_EXECUTABLE` rather
  than borrow a file that cannot support their claims.
- A row-count expectation is capped to whatever the generated query asks for. A
  `SELECT TOP (100)` against a 729-row object returns 100 rows, and comparing
  that to 729 is the harness misreading its own query.
- Any cell that reads a declared object also asserts that its first row is not
  entirely NULL. Counts alone cannot see the failure this whole mechanism
  exists to prevent.

Transient connection failures are retried with bounded backoff. Authentication
failures — 18456, 18452, 40615, 40532, 4060, 916, 18470 — are never retried,
because retrying a bad credential is how accounts get locked out. The
classifier reads both driver shapes: pymssql raises the native number as an
integer argument, pyodbc puts it in parentheses inside the message text. A
failure it cannot classify is *not* retried unless it also looks like a
transport failure, so an unrecognised login error can never be replayed.

The run database is dropped in a `finally`. If the schema cannot be created, or
anything at all raises, the database this harness made is still removed and the
lifecycle record still says so.

Two answers are deliberately distinguished from "no":

- A catalog presence check that could not be *read* is recorded as unverified
  and does not fail the cell. Only an object that is genuinely absent fails it.
- A cleanup inventory that could not be read leaves `cleanup_verified` false and
  names the inventory kinds that were unreadable. Silence is never treated as
  proof that nothing was left behind.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| `PASS` | Ran on the engine and every assertion held |
| `FAIL` | Ran and an assertion failed — a real defect |
| `EXEC_AFTER_SUBSTITUTION` | Ran, but only after a documented substitution |
| `NOT_EXECUTABLE` | Cannot run as generated, e.g. an unresolved path |
| `UNSUPPORTED_EXPECTED` | The engine rejected it and that is the correct answer |
| `BLOCKED` | The safety gate refused to send it |
| `DRY_RUN_ACCEPTED` | Gated and hashed but deliberately not sent |

`DRY_RUN_ACCEPTED` is harness-only. It exists so an offline run can distinguish
"this cell is ready and was withheld" from "this cell could never run", and it
never counts as a defect.

## Evidence

`tests/certification/expected-matrix.json` is the machine-readable record of
what the live engines actually did, one rule per finding, each tagged `live`,
`live-negative` or `static` along with the engines that produced it. Both test
suites read that file — `tests/certification/test_matrix.py` on the Python side
and `src/test/native/certificationEvidence.test.ts` on the TypeScript side — so
neither generator can quietly drift away from the evidence.
