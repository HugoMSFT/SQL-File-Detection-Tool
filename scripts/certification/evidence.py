"""Verdicts, assertion checking and redacted reporting.

Evidence is the product of this harness. A certification run that cannot be
audited afterwards has certified nothing, so every cell records:

* the exact generated SQL (redacted) and its SHA-256 over the *unredacted* text,
  so two runs can be compared byte-for-byte without either artifact carrying a
  secret;
* every substitution that was applied, and why;
* the batch index each result belongs to, because batches are what actually ran;
* SQLSTATE / error number / redacted message on failure;
* row and column counts and the assertions that were checked;
* cleanup outcome.

Three renderings are produced from the same structure: JSON for machines, JUnit
XML for CI, and Markdown for humans reviewing the pull request.
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence

from .batches import strip_sql_comments
from .matrix import HARNESS_ONLY_VERDICTS, VERDICTS, Assertion
from .redaction import Redactor, normalize_value

PASS = 'PASS'
FAIL = 'FAIL'
EXEC_AFTER_SUBSTITUTION = 'EXEC_AFTER_SUBSTITUTION'
NOT_EXECUTABLE = 'NOT_EXECUTABLE'
UNSUPPORTED_EXPECTED = 'UNSUPPORTED_EXPECTED'
BLOCKED = 'BLOCKED'
DRY_RUN_ACCEPTED = 'DRY_RUN_ACCEPTED'

#: Verdicts that mean "nothing reached the server", used when deciding whether
#: a cleanup step is required.
NON_EXECUTED = frozenset(
    {NOT_EXECUTABLE, UNSUPPORTED_EXPECTED, BLOCKED, DRY_RUN_ACCEPTED}
)


@dataclass
class AssertionResult:
    kind: str
    expected: Any
    actual: Any
    ok: bool
    detail: str = ''
    #: True when the assertion could not be judged at all, as opposed to judged
    #: and satisfied. An ``sql_excludes`` check against an empty string is
    #: trivially true and means nothing; recording that as a pass is how three
    #: cells came to be "accepted" without a single byte of SQL behind them.
    evaluated: bool = True

    def as_dict(self) -> Dict[str, Any]:
        return {
            'kind': self.kind,
            'expected': self.expected,
            'actual': self.actual,
            'ok': self.ok,
            'evaluated': self.evaluated,
            'detail': self.detail,
        }


@dataclass
class BatchResult:
    """What happened to one ``GO``-separated batch."""

    index: int
    start_line: int
    verdict: str
    elapsed_ms: float = 0.0
    row_count: Optional[int] = None
    column_count: Optional[int] = None
    sqlstate: Optional[str] = None
    error_number: Optional[int] = None
    error_message: Optional[str] = None
    safety_codes: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, Any]:
        return {
            'batch_index': self.index,
            'start_line': self.start_line,
            'verdict': self.verdict,
            'row_count': self.row_count,
            'column_count': self.column_count,
            'sqlstate': self.sqlstate,
            'error_number': self.error_number,
            'error_message': self.error_message,
            'safety_codes': self.safety_codes,
        }


@dataclass
class CellResult:
    """The full record for one matrix cell on one target."""

    cell_id: str
    target: str
    platform: str
    fixture: str
    statement_kind: str
    access: str
    hypothesis: str
    intent: str
    accepts: Sequence[str]
    verdict: str = NOT_EXECUTABLE
    sql_sha256: str = ''
    sql_redacted: str = ''
    substitutions: List[Dict[str, str]] = field(default_factory=list)
    placeholders: List[str] = field(default_factory=list)
    batches: List[BatchResult] = field(default_factory=list)
    assertions: List[AssertionResult] = field(default_factory=list)
    cleanup: str = 'not_required'
    notes: str = ''
    #: Set when the planner refused to run the cell because the fixture is not
    #: staged (or is unreachable on this target), rather than because anything
    #: about the generated SQL was wrong.
    unstaged: bool = False
    #: What the cell's prerequisites did. An OPENROWSET needs its data source and
    #: an external table needs its file format; running the cell's fragment
    #: alone produces errors 12703 / 46501 / 208 / 2760 that describe the
    #: harness, not the generator.
    setup_steps: List[Dict[str, Any]] = field(default_factory=list)
    #: Set when a prerequisite failed, so the cell never got to run its own SQL.
    prerequisite_failed: bool = False
    #: Catalog object the cell was supposed to create, and whether it was there
    #: afterwards. This is the success criterion for DDL, which returns no rows.
    catalog_object: Optional[str] = None
    #: The public object this cell actually read, where it read one. Live
    #: evidence has to name the bytes, not the demo fixture whose key the matrix
    #: uses: `csv_scalar` on a live run means the public iris CSV, and saying so
    #: is what stops a demo fixture's type-fidelity claims being read onto it.
    public_shape: Optional[str] = None
    public_shape_url: Optional[str] = None

    @property
    def accepted(self) -> bool:
        # A harness-mode verdict describes the harness, not the engine, so it
        # can never satisfy a cell's acceptance list even if someone lists it.
        if self.verdict in HARNESS_ONLY_VERDICTS:
            return False
        # A cell is not accepted while one of its own assertions is unmet. The
        # verdict alone is not enough: an UNSUPPORTED_EXPECTED or a
        # NOT_EXECUTABLE cell is still asserting something about the SQL that
        # was generated for it, and "the engine could not run this" is no reason
        # to stop checking that the generator wrote the right thing.
        if any(not a.ok for a in self.assertions):
            return False
        return self.verdict in self.accepts

    @property
    def unevaluated_assertions(self) -> List['AssertionResult']:
        """Assertions that could not be judged, typically for want of any SQL."""
        return [a for a in self.assertions if not a.evaluated]

    @property
    def not_certified(self) -> bool:
        """True when nothing was proved through no fault of the generator.

        Two cases. The fixture was never staged, so the SQL the harness was
        willing to send had nowhere to read from. Or a prerequisite failed, so
        the cell's own statement never ran - and a statement that never ran
        cannot have a defect. Reporting these as defects made an offline plan
        look like 21 broken cells, and made one live run look like 19.
        """
        if self.verdict != NOT_EXECUTABLE:
            return False
        return self.unstaged or self.prerequisite_failed

    @property
    def is_defect(self) -> bool:
        """True when this cell represents a real, reportable defect.

        A dry run proves nothing either way, so it is neither accepted nor a
        defect. Counting dry runs as defects produced the misleading
        "27 defects" summary on an offline run that had in fact found none.
        An unstaged fixture is likewise not the generator's fault.
        """
        if self.verdict in HARNESS_ONLY_VERDICTS:
            return False
        if self.not_certified:
            return False
        return not self.accepted

    @property
    def elapsed_ms(self) -> float:
        return sum(b.elapsed_ms for b in self.batches)

    def as_dict(self) -> Dict[str, Any]:
        return {
            'cell_id': self.cell_id,
            'target': self.target,
            'platform': self.platform,
            'fixture': self.fixture,
            'statement_kind': self.statement_kind,
            'access': self.access,
            'hypothesis': self.hypothesis,
            'intent': self.intent,
            'verdict': self.verdict,
            'accepts': list(self.accepts),
            'accepted': self.accepted,
            'sql_sha256': self.sql_sha256,
            'sql_redacted': self.sql_redacted,
            'substitutions': self.substitutions,
            'placeholders': sorted(set(self.placeholders)),
            'batches': [b.as_dict() for b in self.batches],
            'assertions': [a.as_dict() for a in self.assertions],
            'cleanup': self.cleanup,
            'notes': self.notes,
            'unstaged': self.unstaged,
            'setup_steps': self.setup_steps,
            'prerequisite_failed': self.prerequisite_failed,
            'catalog_object': self.catalog_object,
            'not_certified': self.not_certified,
        }


@dataclass
class RunEvidence:
    """Everything one certification run produced."""

    run_id: str
    target: str
    platform: str
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    finished_at: str = ''
    engine: Dict[str, Any] = field(default_factory=dict)
    inventory_before: Dict[str, Any] = field(default_factory=dict)
    inventory_after: Dict[str, Any] = field(default_factory=dict)
    cells: List[CellResult] = field(default_factory=list)
    cleanup_verified: bool = False
    residue: List[str] = field(default_factory=list)
    #: What the run did with its database and schema: whether the disposable
    #: database was created, whether the run schema was created, whether the
    #: database was dropped again, and the sanitised connect-attempt log.
    lifecycle: Dict[str, Any] = field(default_factory=dict)
    #: One record per cleanup statement: the redacted statement, whether it ran,
    #: and why not when it did not. This is what makes ``cleanup_verified`` an
    #: auditable claim instead of a bare boolean.
    cleanup_statements: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def defects(self) -> List[CellResult]:
        return [c for c in self.cells if c.is_defect]

    @property
    def dry_run_cells(self) -> List[CellResult]:
        return [c for c in self.cells if c.verdict in HARNESS_ONLY_VERDICTS]

    def summary(self) -> Dict[str, int]:
        counts = {verdict: 0 for verdict in VERDICTS}
        for cell in self.cells:
            counts[cell.verdict] = counts.get(cell.verdict, 0) + 1
        counts['ACCEPTED'] = sum(1 for c in self.cells if c.accepted)
        counts['NOT_CERTIFIED'] = sum(1 for c in self.cells if c.not_certified)
        counts['DEFECTS'] = len(self.defects)
        return counts

    def as_dict(self, redactor: Optional[Redactor] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            'schema_version': 1,
            'run_id': self.run_id,
            'target': self.target,
            'platform': self.platform,
            'engine': self.engine,
            'lifecycle': self.lifecycle,
            'inventory_before': self.inventory_before,
            'inventory_after': self.inventory_after,
            'cleanup_verified': self.cleanup_verified,
            'cleanup_statements': self.cleanup_statements,
            'residue': self.residue,
            'summary': self.summary(),
            'cells': [cell.as_dict() for cell in self.cells],
        }
        if redactor is not None:
            payload = redactor.redact_obj(payload)
        return payload


# ---------------------------------------------------------------------------
# Assertion checking
# ---------------------------------------------------------------------------

def check_static_assertions(sql: str, assertions: Iterable[Assertion]) -> List[AssertionResult]:
    """Check ``sql_*`` assertions against generated SQL.

    Comments are stripped first. The generator writes long explanatory comment
    blocks, and a check that passes because the keyword appears in a comment
    would certify prose rather than SQL.

    Empty SQL is reported as unevaluated rather than as a pass. Every
    ``sql_excludes`` check is trivially true against an empty string, so a cell
    whose generator produced nothing at all used to come back with a full set of
    green assertions - which is the most misleading result the harness can
    produce, because it looks like proof and is the absence of it.

    Guidance-only output is the one case where comments *are* the deliverable.
    When a format has no external file format on either engine the generator is
    supposed to say so and point elsewhere, so a cell like that has nothing but
    a comment block to certify. Those assertions are checked against the full
    text and say so in their detail, which keeps them honest without pretending
    prose is SQL.
    """
    code = strip_sql_comments(sql)
    results: List[AssertionResult] = []
    executable = bool(code.strip())
    guidance_only = not executable and bool((sql or '').strip())
    subject = code if executable else (sql or '')
    suffix = ' [checked against guidance comments: no SQL was generated]'
    for assertion in assertions:
        if not executable and not guidance_only:
            results.append(
                AssertionResult(assertion.kind, assertion.value, None, False,
                                'not evaluated: the generator produced no output',
                                evaluated=False)
            )
            continue
        detail = assertion.detail + (suffix if guidance_only else '')
        if assertion.kind == 'sql_contains':
            ok = str(assertion.value) in subject
            results.append(AssertionResult('sql_contains', assertion.value, ok, ok,
                                           detail))
        elif assertion.kind == 'sql_excludes':
            ok = str(assertion.value) not in subject
            results.append(AssertionResult('sql_excludes', assertion.value, not ok, ok,
                                           detail))
        elif assertion.kind == 'sql_matches':
            match = re.search(str(assertion.value), subject, re.IGNORECASE)
            results.append(
                AssertionResult('sql_matches', assertion.value,
                                match.group(0) if match else None, bool(match),
                                detail)
            )
    return results


def check_result_assertions(
    assertions: Iterable[Assertion],
    *,
    row_count: Optional[int] = None,
    column_count: Optional[int] = None,
    values: Optional[Dict[str, Any]] = None,
    error_number: Optional[int] = None,
    catalog_present: Optional[bool] = None,
    first_row: Optional[Sequence[Any]] = None,
) -> List[AssertionResult]:
    """Check execution-time assertions against what the server returned."""
    values = values or {}
    results: List[AssertionResult] = []
    for assertion in assertions:
        if assertion.kind == 'row_count':
            ok = row_count == assertion.value
            results.append(AssertionResult('row_count', assertion.value, row_count, ok,
                                           assertion.detail))
        elif assertion.kind == 'column_count':
            ok = column_count == assertion.value
            results.append(AssertionResult('column_count', assertion.value, column_count,
                                           ok, assertion.detail))
        elif assertion.kind == 'value_equals':
            key, expected = assertion.value  # type: ignore[misc]
            actual = values.get(key)
            results.append(AssertionResult('value_equals', expected, actual,
                                           actual == expected, assertion.detail))
        elif assertion.kind == 'no_error':
            results.append(AssertionResult('no_error', None, error_number,
                                           error_number is None, assertion.detail))
        elif assertion.kind == 'error_number':
            results.append(AssertionResult('error_number', assertion.value, error_number,
                                           error_number == assertion.value,
                                           assertion.detail))
        elif assertion.kind == 'values_not_all_null':
            # The failure this exists to catch: a schema generated from one file
            # and pointed at another projects column names the data does not
            # have, so every value comes back NULL while the row and column
            # counts look perfect. A count-only assertion calls that a PASS.
            if first_row is None:
                results.append(AssertionResult(
                    'values_not_all_null', 'at least one non-NULL value', None, True,
                    'no row was returned; nullness not verified',
                ))
            else:
                non_null = [value for value in first_row if value is not None]
                results.append(AssertionResult(
                    'values_not_all_null', 'at least one non-NULL value',
                    len(non_null), bool(non_null), assertion.detail,
                ))
        elif assertion.kind == 'catalog_present':
            # The success criterion for DDL. CREATE EXTERNAL FILE FORMAT
            # returns no rows, so "did it work?" is answered by the catalog,
            # not by a row count.
            #
            # `None` means the question could not be asked - the probe itself
            # errored, or returned something that is not a count. That is a
            # weaker run, not a failed statement, so it must not turn a CREATE
            # that raised no error into a reported product defect.
            if catalog_present is None:
                results.append(AssertionResult(
                    'catalog_present', assertion.value, None, True,
                    'catalog could not be read; presence not verified',
                ))
            else:
                results.append(AssertionResult('catalog_present', assertion.value,
                                               catalog_present,
                                               catalog_present is True,
                                               assertion.detail))
    return results


# ---------------------------------------------------------------------------
# Renderers
# ---------------------------------------------------------------------------

def write_json(evidence: RunEvidence, path: str, redactor: Redactor) -> None:
    payload = evidence.as_dict(redactor)
    with open(path, 'w', encoding='utf-8') as handle:
        # `default` is unreachable while redaction normalises every leaf, and
        # is kept because losing a completed live run to a serialisation error
        # costs a whole credentialed execution to reproduce.
        json.dump(payload, handle, indent=2, ensure_ascii=False, sort_keys=False,
                  default=normalize_value)
        handle.write('\n')


def write_junit(evidence: RunEvidence, path: str, redactor: Redactor) -> None:
    suite = ET.Element(
        'testsuite',
        name=f'sql-file-detection-certification-{evidence.target}',
        tests=str(len(evidence.cells)),
        failures=str(len(evidence.defects)),
    )
    for cell in evidence.cells:
        case = ET.SubElement(
            suite,
            'testcase',
            classname=f'{evidence.target}.{cell.hypothesis}',
            name=f'{cell.cell_id} {cell.fixture} {cell.statement_kind} ({cell.access})',
        )
        if cell.verdict in HARNESS_ONLY_VERDICTS:
            ET.SubElement(
                case, 'skipped',
                message=redactor.redact(f'{cell.verdict}: {cell.intent}'),
            )
        elif not cell.accepted:
            failure = ET.SubElement(
                case, 'failure',
                message=redactor.redact(f'{cell.verdict}: {cell.intent}'),
                type=cell.verdict,
            )
            failed = [a for a in cell.assertions if not a.ok]
            detail = '\n'.join(
                redactor.redact(
                    f'{a.kind}: expected {normalize_value(a.expected)!r}, '
                    f'got {normalize_value(a.actual)!r} {a.detail}'
                )
                for a in failed
            )
            errors = '\n'.join(
                redactor.redact(f'batch {b.index}: error {b.error_number} {b.error_message}')
                for b in cell.batches
                if b.error_message
            )
            failure.text = '\n'.join(part for part in (detail, errors) if part)
        elif cell.verdict in NON_EXECUTED:
            ET.SubElement(case, 'skipped', message=cell.verdict)
    ET.ElementTree(suite).write(path, encoding='utf-8', xml_declaration=True)


def write_markdown(evidence: RunEvidence, path: str, redactor: Redactor) -> None:
    summary = evidence.summary()
    engine_version = ' '.join(
        redactor.redact(
            str(normalize_value(evidence.engine.get('version', 'unknown')))
        ).split()
    )
    lines: List[str] = [
        f'# Certification evidence — {evidence.target} ({evidence.platform})',
        '',
        f'* run id: `{evidence.run_id}`',
        f'* engine: {engine_version}',
        f'* cleanup verified: **{evidence.cleanup_verified}**'
        + (f' (residue: {len(evidence.residue)})' if evidence.residue else ' (residue: 0)'),
        '',
        '| verdict | count |',
        '| --- | ---: |',
    ]
    for verdict in VERDICTS:
        lines.append(f'| {verdict} | {summary.get(verdict, 0)} |')
    lines += [
        '',
        f'**{summary["ACCEPTED"]}/{len(evidence.cells)} cells accepted, '
        f'{summary["DEFECTS"]} defect(s).**',
        '',
        '| cell | hypothesis | fixture | statement | access | verdict | accepted |',
        '| --- | --- | --- | --- | --- | --- | --- |',
    ]
    for cell in evidence.cells:
        if cell.verdict in HARNESS_ONLY_VERDICTS:
            mark = 'n/a (dry run)'
        else:
            mark = 'yes' if cell.accepted else '**NO**'
        lines.append(
            f'| {cell.cell_id} | {cell.hypothesis} | {cell.fixture} | '
            f'{cell.statement_kind} | {cell.access} | {cell.verdict} | {mark} |'
        )
    if evidence.defects:
        lines += ['', '## Defects', '']
        for cell in evidence.defects:
            lines += [f'### {cell.cell_id} — {cell.hypothesis}', '', cell.intent, '']
            for assertion in cell.assertions:
                if not assertion.ok:
                    lines.append(
                        f'* failed `{assertion.kind}`: expected '
                        f'`{redactor.redact(str(normalize_value(assertion.expected)))}`, got '
                        f'`{redactor.redact(str(normalize_value(assertion.actual)))}` '
                        f'{assertion.detail}'
                    )
            for batch in cell.batches:
                if batch.error_message:
                    lines.append(
                        f'* batch {batch.index} error {batch.error_number} '
                        f'({batch.sqlstate}): {redactor.redact(batch.error_message)}'
                    )
            lines.append('')
    if evidence.cleanup_statements:
        blocked = [s for s in evidence.cleanup_statements if not s.get('ok')]
        lines += [
            '',
            '## Cleanup',
            '',
            f'{len(evidence.cleanup_statements) - len(blocked)}/'
            f'{len(evidence.cleanup_statements)} cleanup statements succeeded.',
            '',
        ]
        for step in blocked:
            reason = step.get('violations') or step.get('error') or 'unknown'
            lines.append(
                f'* **did not run**: `{redactor.redact(str(step.get("statement", "")))}` '
                f'— {redactor.redact(str(reason))}'
            )
        if blocked:
            lines.append('')
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(lines) + '\n')
