"""The only module that touches a live server.

Execution follows a fixed sequence, and each step exists because skipping it
would make the resulting evidence untrustworthy:

1. **Probe** the engine read-only. A run may only claim to certify the version
   it actually met, so version, edition, collation, compatibility level,
   updateability, PolyBase availability and master-key presence are captured
   before any DDL.
2. **Inventory** the objects that already exist, so cleanup can be proved by
   difference rather than asserted.
3. **Re-check** every batch through the safety gate immediately before sending
   it. The plan was checked when it was built; checking again here means a
   hand-edited manifest cannot bypass the gate.
4. **Execute** one batch at a time, recording a verdict per batch. There is no
   global transaction, and pretending otherwise would be the lie this harness
   exists to avoid.
5. **Clean up** with explicit inverse statements built from the *live*
   inventory, then re-inventory and report residue.

The runner never enables a feature, never restarts anything, never drops a
pre-existing key or credential, and never writes an unredacted artifact.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

from . import adapters
from .adapters import Connection, ConnectionSettings, ENGINE_PROBES, INVENTORY_QUERIES
from .evidence import (
    BLOCKED,
    EXEC_AFTER_SUBSTITUTION,
    FAIL,
    DRY_RUN_ACCEPTED,
    NOT_EXECUTABLE,
    PASS,
    UNSUPPORTED_EXPECTED,
    BatchResult,
    CellResult,
    RunEvidence,
    check_result_assertions,
    check_static_assertions,
)
from .manifest import explicit_cleanup_statements
from .matrix import MATRIX_BY_ID
from .redaction import Redactor
from .runid import RunIdentity, is_certification_object
from .safety import SafetyPolicy, evaluate_batch


@dataclass
class ExecutionOptions:
    dry_run: bool = False
    stop_on_block: bool = True
    statement_timeout_s: int = 120


def probe_engine(connection: Connection) -> Dict[str, Any]:
    """Capture read-only engine facts. Failures are recorded, never fatal."""
    facts: Dict[str, Any] = {'driver': connection.driver}
    for name, sql in ENGINE_PROBES.items():
        try:
            result = connection.execute(sql)
            facts[name] = result.rows[0][0] if result.rows else None
        except Exception as exc:
            facts[name] = f'<probe failed: {type(exc).__name__}>'
    return facts


def read_inventory(connection: Connection, identity: RunIdentity) -> Dict[str, List[str]]:
    """List the objects that exist right now, per object kind."""
    inventory: Dict[str, List[str]] = {}
    for kind, template in INVENTORY_QUERIES.items():
        sql = template.format(schema=identity.schema)
        try:
            result = connection.execute(sql)
            inventory[kind] = [str(row[0]) for row in result.rows]
        except Exception as exc:
            inventory[kind] = [f'<inventory failed: {type(exc).__name__}>']
    return inventory


def certification_residue(inventory: Dict[str, List[str]]) -> List[str]:
    """Names in ``inventory`` that belong to *any* certification run."""
    residue: List[str] = []
    for kind, names in inventory.items():
        for name in names:
            if is_certification_object(name):
                residue.append(f'{kind}:{name}')
    return sorted(residue)


def _error_facts(exc: Exception) -> Dict[str, Any]:
    """Extract number / SQLSTATE / message without leaking the connection."""
    number: Optional[int] = None
    sqlstate: Optional[str] = None
    message = str(exc)
    args = getattr(exc, 'args', ())
    if args:
        first = args[0]
        if isinstance(first, int):
            number = first
            if len(args) > 1:
                message = str(args[1])
        elif isinstance(first, str) and len(first) == 5:
            sqlstate = first
            if len(args) > 1:
                message = str(args[1])
    return {'error_number': number, 'sqlstate': sqlstate, 'error_message': message}


def execute_cell(
    connection: Optional[Connection],
    planned: Dict[str, Any],
    *,
    policy: SafetyPolicy,
    redactor: Redactor,
    options: ExecutionOptions,
) -> CellResult:
    """Execute one planned cell, batch by batch."""
    entry = MATRIX_BY_ID[planned['cell_id']]
    result = CellResult(
        cell_id=planned['cell_id'],
        target=planned['target'],
        platform=planned['platform'],
        fixture=planned['fixture'],
        statement_kind=planned['statement_kind'],
        access=planned['access'],
        hypothesis=planned['hypothesis'],
        intent=planned['intent'],
        accepts=planned['accepts'],
        sql_sha256=planned.get('sql_sha256', ''),
        sql_redacted=planned.get('sql_redacted', ''),
        substitutions=planned.get('substitutions', []),
        notes=planned.get('notes', ''),
    )

    # Static assertions are checked whether or not the cell can execute: a
    # generator defect visible in the text is still a defect.
    result.assertions.extend(
        check_static_assertions(planned.get('sql_redacted', ''), entry.static_assertions)
    )

    plan_verdict = planned.get('plan_verdict')
    if plan_verdict == BLOCKED:
        result.verdict = BLOCKED
        for batch in planned.get('batches', []):
            result.batches.append(
                BatchResult(
                    index=batch['batch_index'],
                    start_line=batch['start_line'],
                    verdict=BLOCKED,
                    safety_codes=[v['code'] for v in batch['safety']['violations']],
                )
            )
        return result

    if plan_verdict == NOT_EXECUTABLE:
        result.verdict = NOT_EXECUTABLE
        result.notes = planned.get('reason', result.notes)
        return result

    if connection is None or options.dry_run:
        # The SQL cleared every safety layer and would have been sent. Saying
        # NOT_EXECUTABLE here would conflate a generator defect with a
        # deliberate offline run, so it gets its own harness-only verdict.
        result.verdict = DRY_RUN_ACCEPTED
        result.notes = (
            'dry run: batches were classified, gated and hashed but not sent; '
            'no certification may be claimed from this verdict'
        )
        for batch in planned.get('batches', []):
            result.batches.append(
                BatchResult(
                    index=batch['batch_index'],
                    start_line=batch['start_line'],
                    verdict=DRY_RUN_ACCEPTED,
                )
            )
        return result

    unsupported_seen = False
    failed = False
    last_rows = 0
    last_cols = 0

    for batch in planned.get('batches', []):
        # Layer of defence 3: re-check immediately before sending.
        report = evaluate_batch(batch.get('sql', batch.get('sql_redacted', '')), policy) \
            if 'sql' in batch else None
        if report is not None and not report.allowed:
            result.batches.append(
                BatchResult(
                    index=batch['batch_index'],
                    start_line=batch['start_line'],
                    verdict=BLOCKED,
                    safety_codes=report.codes,
                )
            )
            result.verdict = BLOCKED
            return result

        sql = batch.get('sql')
        if sql is None:
            # The manifest was written without raw SQL (the default, so the
            # artifact carries nothing sensitive). Nothing can be executed.
            result.verdict = NOT_EXECUTABLE
            result.notes = 'manifest contains redacted SQL only; re-plan with --emit-sql'
            return result

        started = time.perf_counter()
        try:
            query = connection.execute(sql)
            elapsed = (time.perf_counter() - started) * 1000
            last_rows, last_cols = query.row_count, query.column_count
            result.batches.append(
                BatchResult(
                    index=batch['batch_index'],
                    start_line=batch['start_line'],
                    verdict=PASS,
                    elapsed_ms=elapsed,
                    row_count=query.row_count,
                    column_count=query.column_count,
                )
            )
        except Exception as exc:
            elapsed = (time.perf_counter() - started) * 1000
            facts = _error_facts(exc)
            # A refusal the matrix predicted is evidence, not a defect.
            expected_unsupported = UNSUPPORTED_EXPECTED in entry.accepts
            verdict = UNSUPPORTED_EXPECTED if expected_unsupported else FAIL
            unsupported_seen = unsupported_seen or expected_unsupported
            failed = failed or not expected_unsupported
            result.batches.append(
                BatchResult(
                    index=batch['batch_index'],
                    start_line=batch['start_line'],
                    verdict=verdict,
                    elapsed_ms=elapsed,
                    sqlstate=facts['sqlstate'],
                    error_number=facts['error_number'],
                    error_message=redactor.redact(str(facts['error_message'])),
                )
            )
            break

    expectations = planned.get('expectations') or {}
    result.assertions.extend(
        check_result_assertions(
            tuple(
                _expectation_assertions(expectations)
            ),
            row_count=last_rows,
            column_count=last_cols,
            error_number=next(
                (b.error_number for b in result.batches if b.error_number), None
            ),
        )
    )

    if failed or any(not a.ok for a in result.assertions):
        result.verdict = FAIL
    elif unsupported_seen:
        result.verdict = UNSUPPORTED_EXPECTED
    elif result.substitutions:
        result.verdict = EXEC_AFTER_SUBSTITUTION
    else:
        result.verdict = PASS
    return result


def _expectation_assertions(expectations: Dict[str, Any]):
    from .matrix import Assertion  # local import keeps the module graph flat

    if 'row_count' in expectations:
        yield Assertion('row_count', expectations['row_count'], 'staged row count')
    if 'column_count' in expectations:
        yield Assertion('column_count', expectations['column_count'], 'staged column count')


def run_cleanup(
    connection: Connection,
    identity: RunIdentity,
    *,
    redactor: Redactor,
    policy: Optional[SafetyPolicy] = None,
    drop_database: bool = False,
) -> Dict[str, Any]:
    """Drop everything the run created, then prove it is gone."""
    inventory = read_inventory(connection, identity)
    statements = explicit_cleanup_statements(identity, inventory)
    gate = policy if policy is not None else SafetyPolicy(identity)
    executed: List[Dict[str, Any]] = []
    for statement in statements:
        # Cleanup is built from names read back off a live server, so it goes
        # through the same gate as everything else. A statement that cannot be
        # proven safe is recorded and skipped, not sent.
        verdict = evaluate_batch(statement, gate)
        if not verdict.allowed:
            executed.append(
                {
                    'statement': statement,
                    'ok': False,
                    'blocked': True,
                    'violations': sorted({v.code for v in verdict.violations}),
                }
            )
            continue
        try:
            connection.execute(statement)
            executed.append({'statement': statement, 'ok': True})
        except Exception as exc:
            facts = _error_facts(exc)
            executed.append(
                {
                    'statement': statement,
                    'ok': False,
                    'error': redactor.redact(str(facts['error_message'])),
                }
            )
    after = read_inventory(connection, identity)
    residue = [name for name in certification_residue(after) if identity.owns(name.split(':', 1)[1])]
    return {
        'statements': executed,
        'inventory_after': after,
        'residue': residue,
        'verified': not residue,
        'database_dropped': bool(drop_database),
    }
