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

import re
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

from . import adapters
from .adapters import (
    ADMIN_DATABASE,
    CATALOG_PRESENCE_QUERIES,
    Connection,
    ConnectionSettings,
    ENGINE_PROBES,
    INVENTORY_QUERIES,
    SessionFactory,
)
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
            result = connection.execute(sql, textual=True)
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
            result = connection.execute(sql, textual=True)
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


def _decode_error_arg(value: Any) -> str:
    """Render one exception argument as text without leaking a Python repr.

    Drivers hand back ``bytes`` for the server's message. ``str(b'...')``
    produces ``b'Cannot bulk load...'``, and that ``b'`` prefix reached the
    markdown and JSON artifacts of a live run. Decoding first keeps the message
    readable and keeps the redactor working on text rather than on a repr.
    """
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value).decode('utf-8', 'replace')
    return str(value)


def _error_facts(exc: Exception) -> Dict[str, Any]:
    """Extract number / SQLSTATE / message without leaking the connection."""
    number: Optional[int] = None
    sqlstate: Optional[str] = None
    args = getattr(exc, 'args', ())
    message = _decode_error_arg(exc) if not args else ''
    if args:
        first = args[0]
        message = _decode_error_arg(first)
        if isinstance(first, int):
            number = first
            if len(args) > 1:
                message = _decode_error_arg(args[1])
        else:
            text = _decode_error_arg(first)
            if len(text) == 5:
                sqlstate = text
                if len(args) > 1:
                    message = _decode_error_arg(args[1])
    if not message:
        message = _decode_error_arg(exc)
    return {'error_number': number, 'sqlstate': sqlstate, 'error_message': message}


def _run_batches(
    connection: Connection,
    batches: Sequence[Dict[str, Any]],
    *,
    policy: SafetyPolicy,
    redactor: Redactor,
) -> Dict[str, Any]:
    """Send a block of batches one at a time, stopping at the first error.

    Returns the per-batch records plus the facts callers need: whether it all
    succeeded, and the row/column counts of the last statement that returned a
    result set.
    """
    records: List[BatchResult] = []
    for batch in batches:
        sql = batch.get('sql')
        if sql is None:
            return {
                'batches': records,
                'ok': False,
                'missing_sql': True,
                'error': None,
                'row_count': None,
                'column_count': None,
            }
        # Layer of defence 3: re-check immediately before sending, so a
        # hand-edited manifest cannot bypass the gate.
        report = evaluate_batch(sql, policy)
        if not report.allowed:
            records.append(
                BatchResult(
                    index=batch['batch_index'],
                    start_line=batch['start_line'],
                    verdict=BLOCKED,
                    safety_codes=report.codes,
                )
            )
            return {
                'batches': records,
                'ok': False,
                'blocked': True,
                'error': None,
                'row_count': None,
                'column_count': None,
            }

        started = time.perf_counter()
        try:
            query = connection.execute(sql)
        except Exception as exc:
            elapsed = (time.perf_counter() - started) * 1000
            facts = _error_facts(exc)
            records.append(
                BatchResult(
                    index=batch['batch_index'],
                    start_line=batch['start_line'],
                    verdict=FAIL,
                    elapsed_ms=elapsed,
                    sqlstate=facts['sqlstate'],
                    error_number=facts['error_number'],
                    error_message=redactor.redact(facts['error_message']),
                )
            )
            return {
                'batches': records,
                'ok': False,
                'error': facts,
                'row_count': None,
                'column_count': None,
            }
        elapsed = (time.perf_counter() - started) * 1000
        records.append(
            BatchResult(
                index=batch['batch_index'],
                start_line=batch['start_line'],
                verdict=PASS,
                elapsed_ms=elapsed,
                row_count=query.row_count,
                column_count=query.column_count,
            )
        )
    last = records[-1] if records else None
    return {
        'batches': records,
        'ok': True,
        'error': None,
        'row_count': last.row_count if last else None,
        'column_count': last.column_count if last else None,
    }


_SAFE_NAME = re.compile(r'^[A-Za-z0-9_]+$')


def _catalog_present(
    connection: Connection,
    kind: Optional[str],
    names: Dict[str, Any],
    schema: str,
) -> Optional[bool]:
    """Ask the catalog whether the object a DDL cell should have created is there.

    Returns ``None`` when the question cannot be asked, which is different from
    ``False``: an unanswerable question must not fail a cell.
    """
    if not kind:
        return None
    template = CATALOG_PRESENCE_QUERIES.get(kind)
    key = _CATALOG_NAME_KEYS.get(kind)
    if not template or not key:
        return None
    name = names.get(key)
    if not name:
        return None
    # These names come out of the plan, but the plan is a file on disk. The
    # queries interpolate rather than bind, so anything that is not a plain
    # identifier is refused rather than sent.
    if not _SAFE_NAME.match(str(name)) or (schema and not _SAFE_NAME.match(str(schema))):
        return None
    sql = template.format(schema=schema, name=name)
    try:
        result = connection.execute(sql, textual=True)
    except Exception:
        return None
    if not result.rows:
        return False
    try:
        return int(result.rows[0][0]) > 0
    except (TypeError, ValueError):
        return None


#: Which planned name answers "did this object appear?" for each object kind.
_CATALOG_NAME_KEYS: Dict[str, str] = {
    'table': 'table',
    'view': 'table',
    'external table': 'external_table',
    'external file format': 'external_file_format',
    'external data source': 'external_data_source',
    'database scoped credential': 'database_scoped_credential',
    'schema': 'schema',
}


def execute_cell(
    connection: Optional[Connection],
    planned: Dict[str, Any],
    *,
    policy: SafetyPolicy,
    redactor: Redactor,
    options: ExecutionOptions,
) -> CellResult:
    """Execute one planned cell: prerequisites, then its own SQL, then verification."""
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
        catalog_object=planned.get('catalog_object'),
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
        result.unstaged = bool(planned.get('unstaged'))
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

    # --- prerequisites ---------------------------------------------------
    # An OPENROWSET cannot resolve a DATA_SOURCE nobody created, and an
    # external table needs its file format. Those failures (12703, 46501, 208,
    # 2760) say the harness ran the statements out of order; they say nothing
    # about the generator.
    for step in planned.get('setup', []):
        outcome = _run_batches(
            connection, step.get('batches', []), policy=policy, redactor=redactor,
        )
        record = {
            'requirement': step['requirement'],
            'statement_kind': step['statement_kind'],
            'ok': bool(outcome['ok']),
            'batches': [b.as_dict() for b in outcome['batches']],
        }
        if outcome['error']:
            record['error_number'] = outcome['error']['error_number']
            record['error_message'] = redactor.redact(outcome['error']['error_message'])
        result.setup_steps.append(record)
        if not outcome['ok']:
            result.verdict = NOT_EXECUTABLE
            result.prerequisite_failed = True
            result.notes = (
                f'prerequisite {step["requirement"]!r} '
                f'({step["statement_kind"]}) did not complete, so the cell never '
                f'ran; this is a harness sequencing result, not a generator defect'
            )
            return result

    # --- the cell's own statement ---------------------------------------
    unsupported_seen = False
    failed = False
    last_rows: Optional[int] = None
    last_cols: Optional[int] = None

    for batch in planned.get('batches', []):
        sql = batch.get('sql')
        if sql is None:
            # The manifest was written without raw SQL (the default, so the
            # artifact carries nothing sensitive). Nothing can be executed.
            result.verdict = NOT_EXECUTABLE
            result.notes = 'manifest contains redacted SQL only; re-plan with --emit-sql'
            return result

        # Layer of defence 3: re-check immediately before sending.
        report = evaluate_batch(sql, policy)
        if not report.allowed:
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
            # A refusal the matrix predicted is evidence, not a defect - but
            # only when it is the refusal that was predicted. Accepting any
            # error at all would let a typo in the generated SQL masquerade as
            # a platform limitation, which is the exact confusion this harness
            # exists to prevent.
            expected_unsupported = (
                UNSUPPORTED_EXPECTED in entry.accepts
                and (
                    not entry.expected_errors
                    or facts['error_number'] in entry.expected_errors
                )
            )
            if (
                UNSUPPORTED_EXPECTED in entry.accepts
                and entry.expected_errors
                and not expected_unsupported
            ):
                result.notes = (
                    f'error {facts["error_number"]} is not one of the expected '
                    f'refusals {list(entry.expected_errors)}'
                )
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
                    error_message=redactor.redact(facts['error_message']),
                )
            )
            break

    # --- verification ----------------------------------------------------
    # Row and column counts describe a result set. A load cell proves itself by
    # selecting from what it loaded; DDL proves itself through the catalog.
    verification = planned.get('verification')
    if verification and not failed:
        outcome = _run_batches(
            connection, verification.get('batches', []), policy=policy, redactor=redactor,
        )
        result.batches.extend(outcome['batches'])
        if outcome['ok']:
            last_rows, last_cols = outcome['row_count'], outcome['column_count']
        else:
            failed = True

    catalog_present: Optional[bool] = None
    if planned.get('catalog_object') and not failed:
        catalog_present = _catalog_present(
            connection,
            planned.get('catalog_object'),
            planned.get('names') or {},
            (planned.get('names') or {}).get('schema') or '',
        )

    result_assertions = list(_result_assertions(planned, entry))
    if result_assertions:
        result.assertions.extend(
            check_result_assertions(
                tuple(result_assertions),
                row_count=last_rows,
                column_count=last_cols,
                error_number=next(
                    (b.error_number for b in result.batches if b.error_number), None
                ),
                catalog_present=catalog_present,
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


def _result_assertions(planned: Dict[str, Any], entry) -> List[Any]:
    """Which execution-time assertions actually apply to this cell.

    Staged row and column counts describe the *data*, so they only mean
    something where the cell (or its verification query) returned that data.
    Applying them to ``CREATE EXTERNAL FILE FORMAT`` marked C16 and C20 FAIL in
    a live run for DDL that had succeeded.
    """
    from .matrix import Assertion  # local import keeps the module graph flat

    assertions: List[Any] = []
    if planned.get('asserts_result_counts'):
        expectations = planned.get('expectations') or {}
        if 'row_count' in expectations:
            assertions.append(
                Assertion('row_count', expectations['row_count'], 'staged row count')
            )
        if 'column_count' in expectations:
            assertions.append(
                Assertion('column_count', expectations['column_count'],
                          'staged column count')
            )
    if planned.get('catalog_object'):
        assertions.append(
            Assertion('catalog_present', planned['catalog_object'],
                      'DDL succeeds when the object is in the catalog, not when '
                      'it returns rows')
        )
    return assertions


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


# ---------------------------------------------------------------------------
# Session orchestration
# ---------------------------------------------------------------------------

def _ensure_schema(connection: Connection, identity: RunIdentity) -> Dict[str, Any]:
    """Create the run schema. Every scoped object lives inside it.

    A run that never creates its schema puts its objects wherever the login's
    default schema points, which on a fresh connection is ``dbo`` - the one
    place this harness must never write. The first live run connected to
    ``master`` and never issued ``CREATE SCHEMA`` at all.
    """
    schema = identity.schema
    if not _SAFE_NAME.match(schema):  # pragma: no cover - identity guarantees this
        return {'ok': False, 'error': 'run schema name is not a plain identifier'}
    sql = (
        f"IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = '{schema}') "
        f'EXEC(N\'CREATE SCHEMA [{schema}]\');'
    )
    try:
        connection.execute(sql)
        connection.commit()
    except Exception as exc:
        return {'ok': False, 'error': _error_facts(exc)['error_message']}
    return {'ok': True, 'schema': schema}


def create_run_database(connection: Connection, identity: RunIdentity) -> Dict[str, Any]:
    """Create the disposable run database from ``master``.

    Nothing scoped is ever created in ``master``: a database scoped credential
    there fails with error 33158, and the run has no business writing to a
    system database in any case.
    """
    database = identity.database
    if not _SAFE_NAME.match(database):  # pragma: no cover - identity guarantees this
        return {'ok': False, 'error': 'run database name is not a plain identifier'}
    sql = (
        f"IF DB_ID('{database}') IS NULL CREATE DATABASE [{database}];"
    )
    try:
        connection.execute(sql)
        connection.commit()
    except Exception as exc:
        return {'ok': False, 'error': _error_facts(exc)['error_message']}
    return {'ok': True, 'database': database}


def drop_run_database(connection: Connection, identity: RunIdentity) -> Dict[str, Any]:
    """Drop the disposable run database from ``master`` and prove it is gone.

    Single-user mode first, because a lingering session would otherwise leave
    the database behind and the run would report clean while it was not.
    """
    database = identity.database
    if not _SAFE_NAME.match(database):  # pragma: no cover
        return {'ok': False, 'error': 'run database name is not a plain identifier'}
    statements = [
        f"IF DB_ID('{database}') IS NOT NULL "
        f'ALTER DATABASE [{database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;',
        f"IF DB_ID('{database}') IS NOT NULL DROP DATABASE [{database}];",
    ]
    errors: List[str] = []
    for sql in statements:
        try:
            connection.execute(sql)
            connection.commit()
        except Exception as exc:
            errors.append(_error_facts(exc)['error_message'])
    try:
        check = connection.execute(f"SELECT DB_ID('{database}');", textual=True)
        gone = not check.rows or check.rows[0][0] in (None, '')
    except Exception as exc:
        errors.append(_error_facts(exc)['error_message'])
        gone = False
    return {'ok': gone, 'database': database, 'errors': errors, 'dropped': gone}


def run_session(
    factory: SessionFactory,
    manifest: Dict[str, Any],
    identity: RunIdentity,
    *,
    policy: SafetyPolicy,
    redactor: Redactor,
    options: ExecutionOptions,
    evidence: RunEvidence,
) -> RunEvidence:
    """Run a whole manifest, owning the database and schema lifecycle.

    On a SQL Server target the run gets its own disposable database: created
    from ``master``, connected into, used for every cell, then cleaned and
    dropped from ``master`` again. On Azure SQL Database a database cannot be
    created on the fly, so the run works inside the database it was pointed at
    and is confined by its schema instead.
    """
    create_database = bool(manifest.get('allow_create_database'))
    lifecycle: Dict[str, Any] = {'created_database': False, 'dropped_database': False}
    admin: Optional[Connection] = None
    work: Optional[Connection] = None

    try:
        if create_database:
            admin = factory.connect(ADMIN_DATABASE)
            evidence.engine = redactor.redact_obj(probe_engine(admin))
            created = create_run_database(admin, identity)
            lifecycle['created_database'] = bool(created.get('ok'))
            if not created.get('ok'):
                lifecycle['create_error'] = redactor.redact(str(created.get('error', '')))
                evidence.lifecycle = lifecycle
                evidence.cleanup_verified = False
                return evidence
            work = factory.connect(identity.database)
        else:
            work = factory.connect()
            evidence.engine = redactor.redact_obj(probe_engine(work))

        schema = _ensure_schema(work, identity)
        lifecycle['schema'] = identity.schema
        lifecycle['schema_created'] = bool(schema.get('ok'))
        if not schema.get('ok'):
            lifecycle['schema_error'] = redactor.redact(str(schema.get('error', '')))
            evidence.lifecycle = lifecycle
            evidence.cleanup_verified = False
            return evidence

        evidence.inventory_before = read_inventory(work, identity)
        for cell in manifest['cells']:
            evidence.cells.append(
                execute_cell(work, cell, policy=policy, redactor=redactor, options=options)
            )

        cleanup = run_cleanup(work, identity, redactor=redactor, policy=policy)
        evidence.inventory_after = cleanup['inventory_after']
        evidence.cleanup_verified = cleanup['verified']
        evidence.residue = cleanup['residue']
    finally:
        if work is not None:
            work.close()

    if create_database:
        # The drop happens from master because a database cannot drop itself,
        # and it happens after the work connection is closed so nothing is
        # still holding it.
        try:
            if admin is None:
                admin = factory.connect(ADMIN_DATABASE)
            dropped = drop_run_database(admin, identity)
            lifecycle['dropped_database'] = bool(dropped.get('dropped'))
            if dropped.get('errors'):
                lifecycle['drop_errors'] = [
                    redactor.redact(str(e)) for e in dropped['errors']
                ]
            if not dropped.get('dropped'):
                evidence.cleanup_verified = False
                evidence.residue = list(evidence.residue) + [
                    f'database:{identity.database}'
                ]
        finally:
            if admin is not None:
                admin.close()
    elif admin is not None:  # pragma: no cover - defensive
        admin.close()

    lifecycle['connect_attempts'] = list(factory.attempts_log)
    evidence.lifecycle = lifecycle
    return evidence
