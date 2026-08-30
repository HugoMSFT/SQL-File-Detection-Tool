"""Mechanical, deny-by-default pre-execution safety gate.

The certification targets are not scratch servers. One of them holds a TPC-H
data set whose ``dbo.orders`` table is exactly the name this tool would derive
from a file called ``orders.csv``. A harness that merely *tries* to be careful
is not good enough; the gate has to be able to say "no" for mechanical reasons
before a single byte reaches the server.

Design
------
The gate is **deny-by-default at the statement level**. A batch may execute only
if every statement head it contains is on a short allowlist, *and* none of the
forbidden patterns appear, *and* every object it creates, drops or writes to
belongs to this run's schema and prefix.

Four independent layers have to agree, so a gap in one is covered by another:

``L1 statement allowlist``  unknown verbs are refused outright, so a statement
                            nobody anticipated cannot slip through a denylist.
``L2 forbidden patterns``   named catastrophes (``DROP DATABASE``, ``ALTER
                            SERVER``, ``sp_configure``, ``EXEC``, ``RESTORE``…).
``L3 scope rules``          every DDL/DML target must be inside this run's
                            schema *and* carry this run's prefix; ``dbo`` and
                            the TPC-H table names are hard-blocked anywhere.
``L4 material rules``       unresolved placeholders make a batch
                            non-executable; secret-shaped literals block it.

All pattern matching runs against :func:`~scripts.certification.batches.mask_sql`
output, so a keyword inside a comment or a string literal cannot trigger — or
hide — a rule. Bracketed identifiers are deliberately *not* masked, because the
gate must be able to see ``[dbo].[orders]``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, FrozenSet, List, Optional, Pattern, Sequence, Set, Tuple

from .batches import Batch, mask_sql, split_batches
from .redaction import secret_findings
from .runid import RunIdentity

# ---------------------------------------------------------------------------
# Identifier grammar
# ---------------------------------------------------------------------------

_IDENT = r'(?:\[[^\]\n]{1,128}\]|"[^"\n]{1,128}"|[A-Za-z_@#][A-Za-z0-9_@#$]{0,127})'
_QNAME = rf'{_IDENT}(?:\s*\.\s*{_IDENT}?)*'

#: Placeholder tokens the generator emits on purpose, e.g. ``<storage_account>``.
#: Scanned against raw (unmasked) text because they live inside string literals.
PLACEHOLDER_RE = re.compile(r'<[A-Za-z_][A-Za-z0-9_.!?\- ]{0,78}>')

#: Keywords after which an identifier is an *object* reference rather than a
#: column or alias. A JSON key or column called ``customer`` is harmless; a
#: ``FROM customer`` is not, so the TPC-H gate only looks at these positions
#: (plus any schema-qualified name, handled separately).
_OBJECT_REF_RE = re.compile(
    r'(?<![\w.])(?:'
    r'FROM|JOIN|APPLY|INTO|UPDATE|DELETE\s+FROM|MERGE(?:\s+INTO)?|TRUNCATE\s+TABLE|'
    r'(?:ALTER|DROP|CREATE)(?:\s+EXTERNAL)?\s+TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|'
    r'(?:ALTER|DROP|CREATE)\s+(?:VIEW|PROCEDURE|PROC|FUNCTION|SCHEMA|INDEX)|'
    r'OBJECT_ID|EXEC(?:UTE)?'
    r')\s+(?P<name>' + _QNAME + r')',
    re.IGNORECASE,
)

#: Any dotted name, used to catch ``anything.orders`` no matter the position.
_QUALIFIED_REF_RE = re.compile(
    _IDENT + r'\s*\.\s*' + _IDENT + r'(?:\s*\.\s*' + _IDENT + r')?',
)


def _qname_parts(name: str) -> List[str]:
    """Split a possibly-qualified name into lowercase, unbracketed parts."""
    return [
        part.strip().strip('[]"').lower()
        for part in name.split('.')
        if part.strip().strip('[]"')
    ]



#: Touching any of these is a hard stop regardless of schema qualification.
TPCH_PROTECTED_NAMES: FrozenSet[str] = frozenset(
    {
        'orders',
        'lineitem',
        'customer',
        'part',
        'partsupp',
        'supplier',
        'nation',
        'region',
    }
)

#: Schemas that may appear as a qualifier. Everything else is refused.
_READ_ONLY_SCHEMAS: FrozenSet[str] = frozenset({'sys', 'information_schema'})


def _split_qualified(name: str) -> List[str]:
    """Split ``a.b.c`` into unquoted lowercase parts, keeping empty middles."""
    parts: List[str] = []
    for raw in re.split(r'\.(?=(?:[^\]]*\[[^\]]*\])*[^\]]*$)', name.strip()):
        token = raw.strip()
        if token.startswith('[') and token.endswith(']'):
            token = token[1:-1]
        elif token.startswith('"') and token.endswith('"'):
            token = token[1:-1]
        parts.append(token.strip().lower())
    return parts


# ---------------------------------------------------------------------------
# Layer 1 — statement allowlist
# ---------------------------------------------------------------------------

#: ``CREATE``/``DROP`` object kinds the harness is allowed to manage.
_ALLOWED_OBJECT_KINDS: FrozenSet[str] = frozenset(
    {
        'table',
        'view',
        'schema',
        'external table',
        'external data source',
        'external file format',
        'database scoped credential',
        'master key',
        'database',  # gated further by SafetyPolicy.allow_create_database
    }
)

#: Statement heads that never need an object kind.
_ALLOWED_SIMPLE_HEADS: FrozenSet[str] = frozenset(
    {
        'select',
        'with',
        'insert',
        'bulk insert',
        'set',
        'declare',
        'if',
        'else',
        'begin',
        'end',
        'print',
        'use',
        'open',
        'close',
        'return',
    }
)

#: Recognised leading keywords, longest first so ``bulk insert`` wins over
#: ``bulk``.
_HEAD_TOKENS: Tuple[str, ...] = tuple(
    sorted(
        _ALLOWED_SIMPLE_HEADS | {'create', 'drop', 'alter', 'delete', 'update', 'merge',
                                 'truncate', 'exec', 'execute', 'grant', 'deny', 'revoke',
                                 'backup', 'restore', 'dbcc', 'kill', 'shutdown',
                                 'reconfigure', 'waitfor'},
        key=len,
        reverse=True,
    )
)


# ---------------------------------------------------------------------------
# Layer 2 — forbidden patterns
# ---------------------------------------------------------------------------

_FORBIDDEN: Tuple[Tuple[str, Pattern[str], str], ...] = (
    ('DROP_DATABASE', re.compile(r'\bDROP\s+DATABASE\b', re.I),
     'DROP DATABASE is only produced by the cleanup planner for the disposable '
     'certification database and is never accepted from generated SQL'),
    ('ALTER_DATABASE', re.compile(r'\bALTER\s+DATABASE\b', re.I),
     'altering database-scoped settings would mutate a pre-existing database'),
    ('ALTER_SERVER', re.compile(r'\bALTER\s+SERVER\b', re.I),
     'server-level configuration must not change'),
    ('SP_CONFIGURE', re.compile(r'\bsp_configure\b|\bRECONFIGURE\b', re.I),
     'server configuration must not change (this is how PolyBase would be enabled)'),
    ('SERVICE_CONTROL', re.compile(r'\bSHUTDOWN\b|\bALTER\s+AVAILABILITY\s+GROUP\b', re.I),
     'the harness must never stop or fail over a service'),
    ('BACKUP_RESTORE', re.compile(r'\b(?:BACKUP|RESTORE)\s+(?:DATABASE|LOG|SERVICE|MASTER|CERTIFICATE|SYMMETRIC)\b', re.I),
     'backup/restore touches storage and recovery state outside the run'),
    ('DBCC', re.compile(r'\bDBCC\b', re.I), 'DBCC commands can mutate engine state'),
    ('KILL', re.compile(r'\bKILL\b', re.I), 'killing sessions affects other users'),
    ('EXECUTE', re.compile(r'\bEXEC(?:UTE)?\b', re.I),
     'dynamic execution defeats static analysis, so it is never allowed'),
    ('XP_PROC', re.compile(r'\b(?:xp_|sp_OA|sp_add|sp_drop|sp_execute)\w*', re.I),
     'system stored procedures are outside the certification surface'),
    ('LINKED_SERVER', re.compile(r'\bOPENQUERY\b|\bOPENDATASOURCE\b', re.I),
     'linked-server access is outside the certification surface'),
    ('PRINCIPAL_DDL', re.compile(r'\b(?:CREATE|ALTER|DROP)\s+(?:LOGIN|USER|SERVER\s+ROLE|ROLE|APPLICATION\s+ROLE)\b', re.I),
     'the harness must not change principals'),
    ('PERMISSION_DDL', re.compile(r'\b(?:GRANT|DENY|REVOKE)\b', re.I),
     'the harness must not change permissions or RBAC'),
    ('DROP_MASTER_KEY', re.compile(r'\b(?:DROP|ALTER)\s+(?:SERVICE\s+)?MASTER\s+KEY\b', re.I),
     'a pre-existing master key must never be dropped or altered'),
    ('SERVER_CREDENTIAL', re.compile(r'\b(?:CREATE|ALTER|DROP)\s+CREDENTIAL\b', re.I),
     'server-scoped credentials are shared state; only DATABASE SCOPED CREDENTIAL is allowed'),
    ('DESTRUCTIVE_DML', re.compile(r'\b(?:DELETE|UPDATE|MERGE|TRUNCATE)\b', re.I),
     'the certification matrix never mutates existing rows; cleanup uses DROP'),
    ('WAITFOR', re.compile(r'\bWAITFOR\b', re.I), 'timing statements can hold locks'),
)


# ---------------------------------------------------------------------------
# Layer 3 — scope rules
# ---------------------------------------------------------------------------

#: (object kind, needs schema qualification, regex). Each regex captures the
#: target name in group ``name``.
_TARGET_RULES: Tuple[Tuple[str, bool, Pattern[str]], ...] = (
    ('table', True, re.compile(rf'\bCREATE\s+TABLE\s+(?P<name>{_QNAME})', re.I)),
    ('table', True, re.compile(rf'\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?P<name>{_QNAME})', re.I)),
    ('view', True, re.compile(rf'\bCREATE\s+(?:OR\s+ALTER\s+)?VIEW\s+(?P<name>{_QNAME})', re.I)),
    ('view', True, re.compile(rf'\bDROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?(?P<name>{_QNAME})', re.I)),
    ('external table', True,
     re.compile(rf'\bCREATE\s+EXTERNAL\s+TABLE\s+(?P<name>{_QNAME})', re.I)),
    ('external table', True,
     re.compile(rf'\bDROP\s+EXTERNAL\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?P<name>{_QNAME})', re.I)),
    ('external data source', False,
     re.compile(rf'\bCREATE\s+EXTERNAL\s+DATA\s+SOURCE\s+(?P<name>{_QNAME})', re.I)),
    ('external data source', False,
     re.compile(rf'\bDROP\s+EXTERNAL\s+DATA\s+SOURCE\s+(?:IF\s+EXISTS\s+)?(?P<name>{_QNAME})', re.I)),
    ('external file format', False,
     re.compile(rf'\bCREATE\s+EXTERNAL\s+FILE\s+FORMAT\s+(?P<name>{_QNAME})', re.I)),
    ('external file format', False,
     re.compile(rf'\bDROP\s+EXTERNAL\s+FILE\s+FORMAT\s+(?:IF\s+EXISTS\s+)?(?P<name>{_QNAME})', re.I)),
    ('database scoped credential', False,
     re.compile(rf'\bCREATE\s+DATABASE\s+SCOPED\s+CREDENTIAL\s+(?P<name>{_QNAME})', re.I)),
    ('database scoped credential', False,
     re.compile(rf'\bDROP\s+DATABASE\s+SCOPED\s+CREDENTIAL\s+(?:IF\s+EXISTS\s+)?(?P<name>{_QNAME})', re.I)),
    ('schema', False, re.compile(rf'\bCREATE\s+SCHEMA\s+(?P<name>{_QNAME})', re.I)),
    ('schema', False,
     re.compile(rf'\bDROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?(?P<name>{_QNAME})', re.I)),
    ('bulk insert target', True, re.compile(rf'\bBULK\s+INSERT\s+(?P<name>{_QNAME})', re.I)),
    ('insert target', True,
     re.compile(rf'\bINSERT\s+(?:INTO\s+)?(?P<name>{_QNAME})', re.I)),
    ('select into target', True,
     re.compile(rf'\bINTO\s+(?P<name>{_QNAME})\s+FROM\b', re.I)),
)

_USE_RE = re.compile(rf'\bUSE\s+(?P<name>{_IDENT})', re.I)
#: ``CREATE DATABASE`` proper — the negative lookahead keeps ``CREATE DATABASE
#: SCOPED CREDENTIAL`` out of this rule.
_CREATE_DATABASE_RE = re.compile(
    rf'\bCREATE\s+DATABASE\s+(?!SCOPED\b)(?P<name>{_IDENT})', re.I
)
_LOCATION_RE = re.compile(r"\b(?:LOCATION|BULK)\s*=?\s*N?'([^']*)'", re.I)
_URL_HOST_RE = re.compile(r'(?:abs|abfss|adls|https?|wasbs?)://(?:[^@/\s]+@)?([A-Za-z0-9._\-]+)', re.I)


# ---------------------------------------------------------------------------
# Report types
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Violation:
    """One reason a batch may not be executed."""

    code: str
    message: str
    line: int = 0
    fatal: bool = True

    def as_dict(self) -> Dict[str, object]:
        return {
            'code': self.code,
            'message': self.message,
            'line': self.line,
            'fatal': self.fatal,
        }


@dataclass
class SafetyReport:
    """Outcome of evaluating one batch or one whole script."""

    violations: List[Violation] = field(default_factory=list)
    placeholders: List[str] = field(default_factory=list)
    targets: List[Tuple[str, str]] = field(default_factory=list)

    @property
    def fatal_violations(self) -> List[Violation]:
        return [v for v in self.violations if v.fatal]

    @property
    def allowed(self) -> bool:
        """True when the batch may be sent to a live server."""
        return not self.fatal_violations and not self.placeholders

    @property
    def requires_substitution(self) -> bool:
        """True when only unresolved placeholders stand in the way."""
        return bool(self.placeholders) and not self.fatal_violations

    @property
    def codes(self) -> List[str]:
        return sorted({v.code for v in self.violations})

    def merge(self, other: 'SafetyReport') -> None:
        self.violations.extend(other.violations)
        self.placeholders.extend(other.placeholders)
        self.targets.extend(other.targets)

    def as_dict(self) -> Dict[str, object]:
        return {
            'allowed': self.allowed,
            'requires_substitution': self.requires_substitution,
            'violations': [v.as_dict() for v in self.violations],
            'placeholders': sorted(set(self.placeholders)),
            'targets': [{'kind': k, 'name': n} for k, n in self.targets],
        }


@dataclass
class SafetyPolicy:
    """What one certification run is permitted to do.

    ``allow_create_database`` is off by default. It is switched on only for the
    SQL Server VM plan, where the run works inside a disposable database, and
    even then the database name must equal ``identity.database``.
    """

    identity: RunIdentity
    allowed_databases: Sequence[str] = ()
    allowed_hosts: Sequence[str] = ()
    allow_create_database: bool = False
    allow_master_key: bool = False

    def __post_init__(self) -> None:
        self._databases: Set[str] = {d.lower().strip('[]"') for d in self.allowed_databases if d}
        self._databases.add(self.identity.database.lower())
        self._hosts: Set[str] = {h.lower() for h in self.allowed_hosts if h}

    # -- helpers ---------------------------------------------------------

    def _scope_violation(self, kind: str, name: str, needs_schema: bool) -> Optional[Violation]:
        parts = _split_qualified(name)
        parts = [p for p in parts if p != '']
        if not parts:
            return Violation('EMPTY_IDENTIFIER', f'{kind} target could not be parsed: {name!r}')

        if len(parts) >= 3:
            database = parts[0]
            if database not in self._databases:
                return Violation(
                    'FOREIGN_DATABASE',
                    f'{kind} target {name!r} names database {database!r}, which is not '
                    f'part of this run',
                )
            parts = parts[1:]

        if needs_schema:
            if len(parts) < 2:
                return Violation(
                    'UNQUALIFIED_TARGET',
                    f'{kind} target {name!r} is not schema-qualified; the certification '
                    f'schema {self.identity.schema!r} must be explicit so a default '
                    f'schema can never resolve to dbo',
                )
            schema, obj = parts[-2], parts[-1]
            if schema != self.identity.schema:
                return Violation(
                    'FOREIGN_SCHEMA',
                    f'{kind} target {name!r} is in schema {schema!r}, not the run schema '
                    f'{self.identity.schema!r}',
                )
        else:
            obj = parts[-1]
            if len(parts) > 1 and parts[-2] != self.identity.schema:
                return Violation(
                    'FOREIGN_SCHEMA',
                    f'{kind} target {name!r} is qualified with {parts[-2]!r}, not the run '
                    f'schema {self.identity.schema!r}',
                )

        if kind == 'schema':
            if obj != self.identity.schema:
                return Violation(
                    'FOREIGN_SCHEMA',
                    f'schema target {name!r} is not the run schema {self.identity.schema!r}',
                )
            return None

        if not obj.startswith(self.identity.prefix):
            return Violation(
                'UNPREFIXED_TARGET',
                f'{kind} target {name!r} does not start with the run prefix '
                f'{self.identity.prefix!r}',
            )
        return None


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def _line_of(text: str, index: int) -> int:
    return text.count('\n', 0, index) + 1


def evaluate_batch(sql: str, policy: SafetyPolicy) -> SafetyReport:
    """Evaluate a single batch against ``policy``."""
    report = SafetyReport()
    if not sql or not sql.strip():
        return report

    masked = mask_sql(sql)
    upper = masked.upper()

    # -- Layer 4a: unresolved placeholders.
    # String-literal content is kept (LOCATION = '<path>' really would be sent)
    # but comments are blanked, because a placeholder inside a guidance comment
    # is documentation and never reaches the server.
    uncommented = mask_sql(sql, mask_strings=False)
    for match in PLACEHOLDER_RE.finditer(uncommented):
        report.placeholders.append(match.group(0))

    # -- Layer 4b: secret-shaped material
    for finding in secret_findings(sql):
        report.violations.append(
            Violation(
                'SECRET_MATERIAL',
                f'batch carries secret-shaped material ({finding.kind}); credentials must '
                f'come from the environment, never from generated SQL',
                line=finding.line,
            )
        )

    # -- Layer 3a: dbo anywhere, TPC-H names in object-reference position
    for match in re.finditer(_IDENT, masked):
        token = match.group(0)
        bare = token.strip('[]"').lower()
        if bare == 'dbo':
            report.violations.append(
                Violation(
                    'FORBIDDEN_SCHEMA_DBO',
                    'the dbo schema is never a valid certification target',
                    line=_line_of(masked, match.start()),
                )
            )

    for match in _OBJECT_REF_RE.finditer(masked):
        name = match.group('name')
        for part in _qname_parts(name):
            if part in TPCH_PROTECTED_NAMES:
                report.violations.append(
                    Violation(
                        'PROTECTED_OBJECT',
                        f'{part!r} is a TPC-H object name present on the certification '
                        f'targets and must never be referenced as an object',
                        line=_line_of(masked, match.start('name')),
                    )
                )

    for match in _QUALIFIED_REF_RE.finditer(masked):
        parts = _qname_parts(match.group(0))
        if len(parts) > 1 and parts[-1] in TPCH_PROTECTED_NAMES:
            report.violations.append(
                Violation(
                    'PROTECTED_OBJECT',
                    f'{parts[-1]!r} is a TPC-H object name and must never be '
                    f'referenced as a qualified object',
                    line=_line_of(masked, match.start()),
                )
            )

    # -- Layer 2: forbidden patterns
    for code, pattern, reason in _FORBIDDEN:
        match = pattern.search(masked)
        if not match:
            continue
        if code == 'DROP_MASTER_KEY' and policy.allow_master_key:
            # Still forbidden: allow_master_key only permits CREATE.
            pass
        report.violations.append(
            Violation(code, reason, line=_line_of(masked, match.start()))
        )

    # -- CREATE DATABASE is conditional rather than flatly forbidden
    for match in _CREATE_DATABASE_RE.finditer(masked):
        name = match.group('name').strip('[]"').lower()
        if not policy.allow_create_database:
            report.violations.append(
                Violation(
                    'CREATE_DATABASE_NOT_ALLOWED',
                    'this plan may not create databases',
                    line=_line_of(masked, match.start()),
                )
            )
        elif name != policy.identity.database.lower():
            report.violations.append(
                Violation(
                    'CREATE_DATABASE_NAME',
                    f'may only create the disposable database '
                    f'{policy.identity.database!r}, not {name!r}',
                    line=_line_of(masked, match.start()),
                )
            )

    # -- CREATE MASTER KEY is conditional
    if re.search(r'\bCREATE\s+MASTER\s+KEY\b', masked, re.I) and not policy.allow_master_key:
        report.violations.append(
            Violation(
                'MASTER_KEY_NOT_ALLOWED',
                'creating a database master key changes durable database state and is only '
                'allowed when the plan proves no master key already exists',
            )
        )

    # -- USE must stay inside the run's databases
    for match in _USE_RE.finditer(masked):
        name = match.group('name').strip('[]"').lower()
        if name not in policy._databases:
            report.violations.append(
                Violation(
                    'FOREIGN_DATABASE',
                    f'USE {name!r} would leave the databases this run may touch',
                    line=_line_of(masked, match.start()),
                )
            )

    # -- Layer 3b: DDL/DML target scope
    for kind, needs_schema, pattern in _TARGET_RULES:
        for match in pattern.finditer(masked):
            name = match.group('name')
            report.targets.append((kind, name.strip()))
            violation = policy._scope_violation(kind, name, needs_schema)
            if violation is not None:
                report.violations.append(
                    Violation(
                        violation.code,
                        violation.message,
                        line=_line_of(masked, match.start()),
                    )
                )

    # -- Layer 3c: external locations must point at allowed hosts
    if policy._hosts:
        for match in _LOCATION_RE.finditer(sql):
            for host_match in _URL_HOST_RE.finditer(match.group(1)):
                host = host_match.group(1).lower()
                if host not in policy._hosts:
                    report.violations.append(
                        Violation(
                            'FOREIGN_HOST',
                            f'external location points at {host!r}, which is not in the '
                            f'staging allowlist',
                            line=_line_of(sql, match.start()),
                        )
                    )

    # -- Layer 1: statement head allowlist
    report.violations.extend(_head_violations(masked, upper))

    return report


def _head_violations(masked: str, upper: str) -> List[Violation]:
    """Refuse any statement whose leading keyword is not on the allowlist.

    This is intentionally a scanner rather than a parser. It finds every
    position where a recognised statement keyword starts a statement (start of
    batch, after ``;``, or at the start of a line) and checks that keyword. A
    verb nobody anticipated therefore fails closed instead of being ignored.
    """
    violations: List[Violation] = []
    for match in re.finditer(r'(?:^|;)\s*([A-Za-z_]{2,20}(?:\s+[A-Za-z_]{2,20})?)', masked, re.M):
        phrase = ' '.join(match.group(1).lower().split())
        head = None
        for token in _HEAD_TOKENS:
            if phrase == token or phrase.startswith(token + ' '):
                head = token
                break
        if head is None:
            continue
        if head in _ALLOWED_SIMPLE_HEADS:
            continue
        if head in ('create', 'drop'):
            tail = upper[match.end(1) - len(match.group(1)) :]
            kind = _object_kind(tail[len(head) :])
            if kind is None:
                violations.append(
                    Violation(
                        'UNKNOWN_OBJECT_KIND',
                        f'{head.upper()} of an object kind the harness does not manage',
                        line=_line_of(masked, match.start(1)),
                    )
                )
            continue
        violations.append(
            Violation(
                'STATEMENT_NOT_ALLOWED',
                f'{head.upper()} is not on the certification statement allowlist',
                line=_line_of(masked, match.start(1)),
            )
        )
    return violations


def _object_kind(tail: str) -> Optional[str]:
    """Match the longest allowed object kind at the start of ``tail``."""
    normalized = ' '.join(tail.lower().split())
    for kind in sorted(_ALLOWED_OBJECT_KINDS, key=len, reverse=True):
        if normalized.startswith(kind + ' ') or normalized == kind:
            return kind
    return None


def evaluate_script(sql: str, policy: SafetyPolicy) -> Tuple[List[Batch], List[SafetyReport]]:
    """Split ``sql`` into batches and evaluate each one.

    Returns the batches alongside a parallel list of reports so callers can
    record a per-batch verdict, which is the only accounting that reflects how
    the SQL will actually be executed.
    """
    batches = split_batches(sql)
    reports = [evaluate_batch(batch.text, policy) for batch in batches]
    for batch, report in zip(batches, reports):
        if batch.repeat != 1:
            report.violations.append(
                Violation(
                    'GO_REPEAT_COUNT',
                    f'batch is followed by "GO {batch.repeat}"; repeated execution is never '
                    f'part of the certification plan',
                    line=batch.start_line,
                )
            )
    return batches, reports


def script_is_executable(sql: str, policy: SafetyPolicy) -> bool:
    """Convenience predicate: every batch of ``sql`` may run as-is."""
    _batches, reports = evaluate_script(sql, policy)
    return bool(reports) and all(report.allowed for report in reports)
