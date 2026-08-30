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

# A quoted identifier ends at a *single* closing delimiter; a doubled `]]` or
# `""` is an escaped delimiter and stays inside the name. This has to agree with
# the masker's lexer in `batches.py`, and for a while it did not: `_IDENT`
# terminated at the first `]`, which is the middle of the name as far as the
# server is concerned. Everything after that point was text no scope rule looked
# at, so
#
#     DROP TABLE IF EXISTS [<run schema>].[<run table>]]x], [sales].[invoices];
#
# passed the whole gate with zero violations - the shape rule saw a `]` where it
# wanted a comma, and the list walk stopped on its first iteration. Both
# defences rest on this grammar, so both failed together on the one input.
# `escapeIdentifier`/`_escape_identifier` in the generators emit `]]` by design,
# so this is the project's own escaping convention rather than an exotic case.
#
# The unquoted alternative is Unicode aware for the same reason. T-SQL regular
# identifiers accept Unicode letters, and while this was `[A-Za-z_@#]...` a
# single non-ASCII letter truncated the name and reproduced the bypass exactly:
#
#     DROP TABLE <run schema>.<run table>X, [sales].[invoices];   -- X non-ASCII
#
# The truncated head is genuinely run-owned so it passes the scope check, the
# comma is no longer adjacent to a complete name so the shape rule never fires,
# and a Cyrillic homoglyph makes the payload invisible in review.
_IDENT = (
    r'(?:\[(?:[^\]\n]|\]\]){1,128}\]'
    r'|"(?:[^"\n]|""){1,128}"'
    r'|(?:[^\W\d]|[@#])[\w@#$]{0,127})'
)
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


def _lex_qname(name: str) -> List[str]:
    """Split a qualified name into its parts, honouring doubled delimiters.

    Mirrors the lexer in :func:`certification.batches.mask_sql`. A regex split
    on ``.`` cannot do this: the dot separating two parts and a dot *inside* a
    bracketed part look identical to a regex, and a doubled ``]]`` breaks any
    bracket-counting lookaround. Walking the string is the only way to get
    ``[a]]x].[b]`` back as ``['a]x', 'b']``.
    """
    parts: List[str] = []
    current: List[str] = []
    index = 0
    length = len(name)
    while index < length:
        char = name[index]
        if char in '["':
            closer = ']' if char == '[' else '"'
            index += 1
            while index < length:
                if name[index] == closer:
                    if index + 1 < length and name[index + 1] == closer:
                        current.append(closer)
                        index += 2
                        continue
                    index += 1
                    break
                current.append(name[index])
                index += 1
        elif char == '.':
            parts.append(''.join(current))
            current = []
            index += 1
        else:
            current.append(char)
            index += 1
    parts.append(''.join(current))
    return parts


def _qname_parts(name: str) -> List[str]:
    """Split a possibly-qualified name into lowercase, unbracketed parts."""
    return [part for part in _split_qualified(name) if part]



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
    return [part.strip().lower() for part in _lex_qname(name.strip())]


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

#: The single admitted shape of a ``TRUNCATE``. Anything else is refused at
#: layer 1; this one is still scope checked at layer 3.
_TRUNCATE_TABLE_RE = re.compile(r'TRUNCATE\s+TABLE\s+[\[A-Za-z_]', re.I)


# ---------------------------------------------------------------------------
# Layer 2 — forbidden patterns
# ---------------------------------------------------------------------------

_FORBIDDEN: Tuple[Tuple[str, Pattern[str], str], ...] = (
    # The lookahead is load bearing. ``DATABASE SCOPED CREDENTIAL`` is a
    # different object to a database, and without it this rule refuses the
    # cleanup statement that drops a credential the run itself created, which
    # leaves credential residue behind on a live server.
    ('DROP_DATABASE', re.compile(r'\bDROP\s+DATABASE\b(?!\s+SCOPED\s+CREDENTIAL\b)', re.I),
     'DROP DATABASE is only produced by the cleanup planner for the disposable '
     'certification database and is never accepted from generated SQL'),
    # A comma-separated object list is refused outright.
    #
    # `DROP TABLE a, b` is one statement with two targets, and a scope rule that
    # captures one name per verb only ever checked `a`. Everything after the
    # comma reached the server unexamined, so a statement opening with a
    # legitimately run-owned table could drop anything in any schema - or, with
    # a three-part name, in another database - while the gate reported no
    # violations at all.
    #
    # The scope check now walks the whole list, but this rule stays in front of
    # it because neither generator has any reason to emit a multi-object drop:
    # cleanup emits one statement per object precisely so that each one can be
    # judged and its outcome recorded on its own. Refusing the shape is a
    # smaller thing to get right than parsing it.
    ('MULTI_TARGET',
     re.compile(
         r'\b(?:DROP\s+(?:TABLE|VIEW|EXTERNAL\s+TABLE|SCHEMA|EXTERNAL\s+FILE\s+FORMAT|'
         r'EXTERNAL\s+DATA\s+SOURCE|DATABASE\s+SCOPED\s+CREDENTIAL)|TRUNCATE\s+TABLE)\s+'
         rf'(?:IF\s+EXISTS\s+)?{_QNAME}\s*,',
         re.I,
     ),
     'dropping or truncating several objects in one statement is never generated, '
     'and only the first name in such a list can be scope-checked reliably'),
    # `ALTER DATABASE` deliberately carries no `SCOPED` exception. Layer 1 was
    # once the reason - it refuses every ALTER head - but layer 1 is position
    # dependent and could be stepped around, so this rule stays broad on its
    # own merits: nothing the harness generates alters a credential, and
    # narrowing it would widen the gate for a statement that is never emitted.
    # `ALTER` and the object kinds the harness does not manage used to rest
    # entirely on layer 1's head allowlist, which is position dependent. These
    # two rules are position independent, so they hold wherever the statement
    # sits - after a `BEGIN`, inside an `IF`, on a continuation line.
    #
    # `CREATE OR ALTER VIEW` is a shape a target rule accepts, so it is excused
    # here; every other ALTER of an object is refused. `ALTER SCHEMA ...
    # TRANSFER` is the sharpest of them: it moves a pre-existing table into the
    # run's own schema, at which point the run's own teardown destroys it.
    ('ALTER_OBJECT',
     re.compile(
         r'(?<!\bOR )\bALTER\s+(?:TABLE|SCHEMA|INDEX|VIEW|PROCEDURE|PROC|FUNCTION|'
         r'TRIGGER|SEQUENCE|TYPE|ASSEMBLY|PARTITION|FULLTEXT|SYMMETRIC|ASYMMETRIC|'
         r'CERTIFICATE|QUEUE|SERVICE|RESOURCE|COLUMN|CONSTRAINT)\b',
         re.I,
     ),
     'the harness never alters an object; it creates its own and drops them'),
    ('UNMANAGED_DROP',
     re.compile(
         r'\bDROP\s+(?:INDEX|STATISTICS|SYNONYM|SEQUENCE|PROCEDURE|PROC|FUNCTION|'
         r'TRIGGER|TYPE|AGGREGATE|ASSEMBLY|DEFAULT|RULE|PARTITION|FULLTEXT|'
         r'SYMMETRIC|ASYMMETRIC|CERTIFICATE|QUEUE|SERVICE|CONTRACT|ROUTE|ENDPOINT|'
         r'COLUMN|CONSTRAINT)\b',
         re.I,
     ),
     'only the object kinds the certification run creates may be dropped'),
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
    ('DESTRUCTIVE_DML', re.compile(r'\b(?:DELETE|UPDATE|MERGE)\b|\bTRUNCATE\b(?!\s+TABLE\s+[\[\w])', re.I),
     'the certification matrix never mutates existing rows; cleanup uses DROP. '
     'TRUNCATE TABLE of a named table is the one exception and is still scope '
     'checked, so it can only ever empty a table this run created'),
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
    # TRUNCATE is otherwise forbidden. It is allowed here only because the
    # scope rule forces the target to carry this run's prefix, which means it
    # can only ever empty a table the run itself created.
    ('truncate target', True,
     re.compile(rf'\bTRUNCATE\s+TABLE\s+(?P<name>{_QNAME})', re.I)),
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
    # `\s+FROM` would have been wrong: T-SQL does not require whitespace after
    # the target, so `SELECT * INTO [sales].[victim]FROM sys.objects` and
    # `... [sales].[victim](a)FROM ...` are both valid and both slipped past the
    # rule entirely, creating an object outside the run schema that cleanup -
    # which only removes names `identity.owns()` - would never take away.
    ('select into target', True,
     re.compile(rf'\bINTO\s+(?P<name>{_QNAME})\s*(?=FROM\b|\()', re.I)),
)

#: Verbs whose object is a *list*. See :data:`_MULTI_TARGET_RE`.
#:
#: T-SQL defines the last three as single-object statements, so a real server
#: answers the comma with a syntax error and there is no exploit path. They are
#: here anyway: the invariant worth holding is "every name in a statement is
#: scope-checked", and resting that on the server's grammar rather than on the
#: gate's is exactly the kind of assumption the object-list bypass was built on.
_LIST_VERB_KINDS: Tuple[Tuple[str, bool, Pattern[str]], ...] = (
    ('table', True, re.compile(r'\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?', re.I)),
    ('view', True, re.compile(r'\bDROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?', re.I)),
    ('external table', True,
     re.compile(r'\bDROP\s+EXTERNAL\s+TABLE\s+(?:IF\s+EXISTS\s+)?', re.I)),
    ('schema', False, re.compile(r'\bDROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?', re.I)),
    ('truncate target', True, re.compile(r'\bTRUNCATE\s+TABLE\s+', re.I)),
    ('external file format', False,
     re.compile(r'\bDROP\s+EXTERNAL\s+FILE\s+FORMAT\s+(?:IF\s+EXISTS\s+)?', re.I)),
    ('external data source', False,
     re.compile(r'\bDROP\s+EXTERNAL\s+DATA\s+SOURCE\s+(?:IF\s+EXISTS\s+)?', re.I)),
    ('database scoped credential', False,
     re.compile(r'\bDROP\s+DATABASE\s+SCOPED\s+CREDENTIAL\s+(?:IF\s+EXISTS\s+)?', re.I)),
)

#: One more name in a comma-separated object list.
_NEXT_IN_LIST_RE = re.compile(rf'\s*,\s*(?P<name>{_QNAME})', re.I)
#: The first name after a list verb, matched from a position rather than anchored.
_LIST_HEAD_RE = re.compile(rf'(?P<name>{_QNAME})', re.I)
#: What may legitimately sit immediately after a parsed object list: whitespace
#: (a newline before the next statement, a space before `WITH (...)`, or a
#: blanked-out comment), a statement terminator, an opening parenthesis, or the
#: end of the batch. Anything else means the parse stopped in the middle of
#: something the server would go on to read, so it is refused.
#:
#: This is deliberately an allowlist. It began as a denylist of `]`, `"` and
#: `,` - the three characters the *then-known* desyncs left behind - and a
#: single non-ASCII letter walked straight past it, because a denylist can only
#: name the gaps somebody already found. An allowlist turns the next identifier
#: grammar surprise into a refusal instead of a third silent bypass.
_LIST_TAIL_BENIGN_RE = re.compile(r'\s|[;(]|\Z')

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

    # -- Layer 3b': every name in an object *list*, not just the first
    #
    # `DROP TABLE`, `DROP VIEW`, `DROP EXTERNAL TABLE`, `DROP SCHEMA` and
    # `TRUNCATE TABLE` all take a comma-separated list. The rules above capture
    # one name each, so a statement whose *first* target was legitimately
    # run-owned carried every later name straight past the scope check:
    #
    #     DROP TABLE [<run schema>].[<run table>], [sales].[invoices];
    #
    # was allowed with no violations at all - and with a three-part name in the
    # list, into another database. Only the two text-wide scans still applied,
    # so `dbo` and the TPC-H names were safe and every other schema on the
    # instance was not.
    #
    # Each additional name is now scope-checked under the same rule as the
    # first. `_MULTI_TARGET` in the forbidden list refuses the shape outright as
    # well; this stays because a scope check that depends on another rule
    # holding is not a scope check.
    for kind, needs_schema, verb in _LIST_VERB_KINDS:
        for match in verb.finditer(masked):
            # `.match(text, pos)` already anchors at `pos`; an `\A` here would
            # anchor at the start of the whole batch instead and never match.
            first = _LIST_HEAD_RE.match(masked, match.end())
            if first is None:
                report.violations.append(
                    Violation(
                        'UNPARSED_TARGET_LIST',
                        f'the target of this {kind} statement could not be parsed, so '
                        f'it cannot be scope checked',
                        line=_line_of(masked, match.start()),
                    )
                )
                continue
            cursor = first.end()
            while True:
                following = _NEXT_IN_LIST_RE.match(masked, cursor)
                if following is None:
                    break
                name = following.group('name')
                report.targets.append((kind, name.strip()))
                violation = policy._scope_violation(kind, name, needs_schema)
                if violation is not None:
                    report.violations.append(
                        Violation(
                            violation.code,
                            violation.message,
                            line=_line_of(masked, following.start()),
                        )
                    )
                cursor = following.end()
            if not _LIST_TAIL_BENIGN_RE.match(masked, cursor):
                report.violations.append(
                    Violation(
                        'UNPARSED_TARGET_LIST',
                        f'this {kind} statement continues past the names that could be '
                        f'parsed, so part of it would reach the server unchecked',
                        line=_line_of(masked, cursor),
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
    # A statement boundary proper: the start of the batch or just after a
    # semicolon. Anything the scanner cannot name here is refused, because an
    # unrecognised verb in that position is a statement the harness has no
    # rule for. Line starts are scanned too (below) but only for known verbs,
    # since ordinary continuation lines legitimately begin with FROM, WITH (,
    # column lists and the like.
    for match in re.finditer(r'(?:\A|;)\s*(?=(?P<word>[A-Za-z_][A-Za-z_0-9]{1,29}))', masked):
        word = match.group('word').lower()
        if any(word == token or token.startswith(word + ' ') for token in _HEAD_TOKENS):
            continue
        violations.append(
            Violation(
                'UNKNOWN_STATEMENT',
                f'{word.upper()} does not begin any statement the harness recognises',
                line=_line_of(masked, match.start('word')),
            )
        )
    # Two details here are load bearing, and both were wrong.
    #
    # The separator between the two words is horizontal whitespace only. With
    # `\s+` it matched a newline, so a one-word head on one line and the verb on
    # the next were captured as a single two-word phrase.
    #
    # The phrase is captured inside a lookahead so the scan never consumes it.
    # It used to be consumed, and `finditer` then resumed *after* the second
    # word - which meant the second line's `^` was not a scan position and its
    # verb was never head-checked at all. `BEGIN` is an allowed simple head and
    # is emitted on its own line by `_guard_create_statements` in both
    # generators, so
    #
    #     BEGIN
    #         ALTER TABLE [sales].[t] DROP COLUMN [c]
    #     END
    #
    # passed the whole gate with no violations. That mattered precisely for the
    # verbs layer 1 is the sole defence for; the position-independent layer 2
    # rules below now cover `ALTER` and the unmanaged `DROP` kinds as well, so
    # neither depends on the scanner finding the right position any more.
    for match in re.finditer(
        r'(?:^|;)[ \t]*(?=(?P<phrase>[A-Za-z_]{2,20}(?:[ \t]+[A-Za-z_]{2,20})?))',
        masked,
        re.M,
    ):
        phrase = ' '.join(match.group('phrase').lower().split())
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
            tail = upper[match.start('phrase') :]
            kind = _object_kind(tail[len(head) :])
            if kind is None:
                violations.append(
                    Violation(
                        'UNKNOWN_OBJECT_KIND',
                        f'{head.upper()} of an object kind the harness does not manage',
                        line=_line_of(masked, match.start('phrase')),
                    )
                )
            continue
        if head == 'truncate':
            # TRUNCATE is refused everywhere else. It is admitted here only in
            # the exact `TRUNCATE TABLE <name>` shape, because the generated
            # complete document empties its own load target so a second run
            # does not double the data. Layer 3 still forces that name to carry
            # this run's prefix, so it can only ever empty a table this run
            # created. Any other TRUNCATE - a bare one, or a variable target -
            # falls through to the refusal below.
            tail = upper[match.start('phrase') :]
            if _TRUNCATE_TABLE_RE.match(tail):
                continue
        violations.append(
            Violation(
                'STATEMENT_NOT_ALLOWED',
                f'{head.upper()} is not on the certification statement allowlist',
                line=_line_of(masked, match.start('phrase')),
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
