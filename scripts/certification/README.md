# Certification harness

This directory is **not shipped**. `.vscodeignore` is an allowlist that starts
from `**`, so nothing under `scripts/` can enter the `.vsix`, and nothing here is
imported by the extension at runtime or by the Python package.

Its job is narrow: take what the generators actually emit, decide whether each
statement is safe to run against a live engine, and record the answer as
evidence. It exists because the alternative — hand-pasting generated SQL into a
production server that holds real TPC-H data — is how you drop someone's
`dbo.orders`.

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
cell has a target and a cleanup path. `execute --dry-run` is fully offline: it
gates, hashes and classifies every batch without reading any environment
variable, without asking for a password, without loading a database adapter and
without opening a socket. `--confirm` is required only when actually connecting.

`execute` writes three artifacts: redacted JSON evidence, a JUnit XML file so a
CI run can display the matrix, and a Markdown summary.

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
