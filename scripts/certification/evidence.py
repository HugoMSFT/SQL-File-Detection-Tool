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
* elapsed time and the cleanup outcome.

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
from .matrix import VERDICTS, Assertion
from .redaction import Redactor

PASS = 'PASS'
FAIL = 'FAIL'
EXEC_AFTER_SUBSTITUTION = 'EXEC_AFTER_SUBSTITUTION'
NOT_EXECUTABLE = 'NOT_EXECUTABLE'
UNSUPPORTED_EXPECTED = 'UNSUPPORTED_EXPECTED'
BLOCKED = 'BLOCKED'

#: Verdicts that mean "nothing reached the server", used when deciding whether
#: a cleanup step is required.
NON_EXECUTED = frozenset({NOT_EXECUTABLE, UNSUPPORTED_EXPECTED, BLOCKED})


@dataclass
class AssertionResult:
    kind: str
    expected: Any
    actual: Any
    ok: bool
    detail: str = ''

    def as_dict(self) -> Dict[str, Any]:
        return {
            'kind': self.kind,
            'expected': self.expected,
            'actual': self.actual,
            'ok': self.ok,
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
            'elapsed_ms': round(self.elapsed_ms, 2),
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

    @property
    def accepted(self) -> bool:
        return self.verdict in self.accepts

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
            'elapsed_ms': round(self.elapsed_ms, 2),
            'cleanup': self.cleanup,
            'notes': self.notes,
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

    @property
    def defects(self) -> List[CellResult]:
        return [c for c in self.cells if not c.accepted]

    def summary(self) -> Dict[str, int]:
        counts = {verdict: 0 for verdict in VERDICTS}
        for cell in self.cells:
            counts[cell.verdict] = counts.get(cell.verdict, 0) + 1
        counts['ACCEPTED'] = sum(1 for c in self.cells if c.accepted)
        counts['DEFECTS'] = len(self.defects)
        return counts

    def as_dict(self, redactor: Optional[Redactor] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            'schema_version': 1,
            'run_id': self.run_id,
            'target': self.target,
            'platform': self.platform,
            'started_at': self.started_at,
            'finished_at': self.finished_at or datetime.now(timezone.utc).isoformat(),
            'engine': self.engine,
            'inventory_before': self.inventory_before,
            'inventory_after': self.inventory_after,
            'cleanup_verified': self.cleanup_verified,
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
    """
    code = strip_sql_comments(sql)
    results: List[AssertionResult] = []
    for assertion in assertions:
        if assertion.kind == 'sql_contains':
            ok = str(assertion.value) in code
            results.append(AssertionResult('sql_contains', assertion.value, ok, ok,
                                           assertion.detail))
        elif assertion.kind == 'sql_excludes':
            ok = str(assertion.value) not in code
            results.append(AssertionResult('sql_excludes', assertion.value, not ok, ok,
                                           assertion.detail))
        elif assertion.kind == 'sql_matches':
            match = re.search(str(assertion.value), code, re.IGNORECASE)
            results.append(
                AssertionResult('sql_matches', assertion.value,
                                match.group(0) if match else None, bool(match),
                                assertion.detail)
            )
    return results


def check_result_assertions(
    assertions: Iterable[Assertion],
    *,
    row_count: Optional[int] = None,
    column_count: Optional[int] = None,
    values: Optional[Dict[str, Any]] = None,
    error_number: Optional[int] = None,
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
    return results


# ---------------------------------------------------------------------------
# Renderers
# ---------------------------------------------------------------------------

def write_json(evidence: RunEvidence, path: str, redactor: Redactor) -> None:
    payload = evidence.as_dict(redactor)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False, sort_keys=False)
        handle.write('\n')


def write_junit(evidence: RunEvidence, path: str, redactor: Redactor) -> None:
    suite = ET.Element(
        'testsuite',
        name=f'sql-file-detection-certification-{evidence.target}',
        tests=str(len(evidence.cells)),
        failures=str(len(evidence.defects)),
        time=f'{sum(c.elapsed_ms for c in evidence.cells) / 1000:.3f}',
    )
    for cell in evidence.cells:
        case = ET.SubElement(
            suite,
            'testcase',
            classname=f'{evidence.target}.{cell.hypothesis}',
            name=f'{cell.cell_id} {cell.fixture} {cell.statement_kind} ({cell.access})',
            time=f'{cell.elapsed_ms / 1000:.3f}',
        )
        if not cell.accepted:
            failure = ET.SubElement(
                case, 'failure',
                message=redactor.redact(f'{cell.verdict}: {cell.intent}'),
                type=cell.verdict,
            )
            failed = [a for a in cell.assertions if not a.ok]
            detail = '\n'.join(
                redactor.redact(f'{a.kind}: expected {a.expected!r}, got {a.actual!r} {a.detail}')
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
    lines: List[str] = [
        f'# Certification evidence — {evidence.target} ({evidence.platform})',
        '',
        f'* run id: `{evidence.run_id}`',
        f'* engine: {redactor.redact(str(evidence.engine.get("version", "unknown")))}',
        f'* started: {evidence.started_at}',
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
                        f'`{redactor.redact(str(assertion.expected))}`, got '
                        f'`{redactor.redact(str(assertion.actual))}` {assertion.detail}'
                    )
            for batch in cell.batches:
                if batch.error_message:
                    lines.append(
                        f'* batch {batch.index} error {batch.error_number} '
                        f'({batch.sqlstate}): {redactor.redact(batch.error_message)}'
                    )
            lines.append('')
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(lines) + '\n')
