"""Live certification harness for the SQL File Detection Tool.

This package is **not shipped**. ``.vscodeignore`` is an allowlist that starts
by excluding ``**``, so nothing under ``scripts/`` can reach the VSIX, and the
extension keeps its native, Python-free startup path.

The harness exists because the SQL the tool generates is only trustworthy if a
real engine has accepted it. It therefore has to be able to run generated SQL
against a live SQL Server / Azure SQL Database *without* ever becoming a way to
damage that database. Every module here is built around that second half of the
sentence:

``runid``       unique, verifiable run identity (schema + object prefix).
``redaction``   removes secrets and environment identifiers from all artifacts.
``batches``     T-SQL aware ``GO`` splitting, because a batch is the unit of
                execution and there is no global transaction to hide behind.
``safety``      mechanical, deny-by-default pre-execution gate.
``matrix``      the certification matrix: which cell is expected to do what.
``manifest``    turns generator output into a safety-checked, executable plan.
``adapters``    optional DB drivers (``pymssql`` / ``pyodbc``), imported lazily.
``execute``     the only module that touches a live server.
``evidence``    redacted JSON / JUnit / Markdown reporting.

No module in this package imports anything from the extension runtime, and the
only hard dependency is the Python standard library. ``manifest`` imports the
repository's own ``external_file_detection`` package purely to *read* what it
generates.
"""

from .runid import RunIdentity, new_run_identity, parse_run_identity
from .batches import Batch, split_batches, mask_sql
from .redaction import Redactor, secret_findings
from .safety import (
    SafetyPolicy,
    SafetyReport,
    Violation,
    evaluate_batch,
    evaluate_script,
)

__all__ = [
    'Batch',
    'RunIdentity',
    'Redactor',
    'SafetyPolicy',
    'SafetyReport',
    'Violation',
    'evaluate_batch',
    'evaluate_script',
    'mask_sql',
    'new_run_identity',
    'parse_run_identity',
    'secret_findings',
    'split_batches',
]
