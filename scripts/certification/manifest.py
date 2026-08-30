"""Turn generator output into a safety-checked, executable plan.

The manifest is the contract between this session and whoever runs the
credentialed half. It contains, for every matrix cell: the exact SQL the tool
generated, the substitutions that were applied to it, the ``GO``-split batches,
and the safety gate's verdict on each batch. Nothing else is needed to execute
a run, and nothing in it is a secret.

Staging
-------
Files are not local to an engine merely because they are local to the client.
The harness therefore refuses to invent a location: remote URLs come from a
staging document supplied by the caller, which is also where the host allowlist
comes from. A cell whose access method has no staged location is planned as
``NOT_EXECUTABLE`` rather than quietly skipped, so the gap shows up in the
report.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from .batches import Batch, split_batches
from .evidence import BLOCKED, NOT_EXECUTABLE
from .matrix import (
    FIXTURES_BY_KEY,
    MATRIX,
    MatrixEntry,
    entries_for,
    platform_for,
)
from .redaction import Redactor
from .public_fixtures import resolve_shape, shape_mismatch
from .runid import RunIdentity
from .safety import SafetyPolicy, evaluate_batch

MANIFEST_SCHEMA_VERSION = 1


def repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _ensure_repo_on_path() -> None:
    root = repo_root()
    if root not in sys.path:
        sys.path.insert(0, root)


# ---------------------------------------------------------------------------
# Staging
# ---------------------------------------------------------------------------

@dataclass
class Staging:
    """Where the certification fixtures actually live for each access method.

    The document is plain JSON and deliberately carries no credentials::

        {
          "version": 1,
          "hosts": ["azuremlexamples.blob.core.windows.net"],
          "fixtures": {
            "csv_scalar": {
              "abs": "abs://datasets@azuremlexamples.blob.core.windows.net/iris.csv",
              "blob_storage": "https://azuremlexamples.blob.core.windows.net/datasets/iris.csv",
              "row_count": 150,
              "column_count": 5
            }
          }
        }

    ``hosts`` becomes the safety gate's allowlist, so a typo in a URL cannot
    send a request to an unexpected account.
    """

    hosts: Sequence[str] = ()
    fixtures: Dict[str, Dict[str, Any]] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Optional[str]) -> 'Staging':
        if not path:
            return cls()
        with open(path, 'r', encoding='utf-8') as handle:
            raw = json.load(handle)
        return cls(hosts=tuple(raw.get('hosts') or ()), fixtures=raw.get('fixtures') or {})

    def location(self, fixture_key: str, access: str) -> Optional[str]:
        if access == 'none':
            return None
        entry = self.fixtures.get(fixture_key) or {}
        value = entry.get(access)
        return str(value) if value else None

    def shape_key(self, fixture_key: str) -> Optional[str]:
        """Which public object this fixture's remote locations actually point at.

        A remote location without a declared shape is refused by the planner. The
        harness analyses a local demo file and then reads a public blob, and
        those only describe the same bytes if someone says so.
        """
        entry = self.fixtures.get(fixture_key) or {}
        value = entry.get('shape')
        return str(value) if value else None

    def expectations(self, fixture_key: str) -> Dict[str, Any]:
        entry = self.fixtures.get(fixture_key) or {}
        return {
            key: entry[key]
            for key in ('row_count', 'column_count', 'first_value')
            if key in entry
        }


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

@dataclass
class Substitution:
    token: str
    value: str
    reason: str

    def as_dict(self) -> Dict[str, str]:
        return {'token': self.token, 'value': self.value, 'reason': self.reason}


def _metadata_for(fixture_path: str) -> Dict[str, Any]:
    _ensure_repo_on_path()
    from external_file_detection.file_detector import FileDetector  # noqa: WPS433

    return FileDetector().analyze_file_metadata(fixture_path)


def _generate(
    metadata: Dict[str, Any],
    *,
    statement_kind: str,
    table_name: str,
    schema_name: str,
    data_source: str,
    platform: str,
    storage_url: Optional[str],
    format_name: Optional[str] = None,
    external_table_name: Optional[str] = None,
    credential_name: Optional[str] = None,
    auth_method: Optional[str] = None,
    file_path_override: Optional[str] = None,
    include_prereq: bool = True,
) -> str:
    _ensure_repo_on_path()
    from external_file_detection.sql_generator import SQLGenerator  # noqa: WPS433

    generator = SQLGenerator()
    common = dict(
        table_name=table_name,
        schema_name=schema_name,
        data_source=data_source,
        target_platform=platform,
        storage_url=storage_url,
        format_name=format_name,
        external_table_name=external_table_name,
        credential_name=credential_name,
        auth_method=auth_method,
        file_path_override=file_path_override,
    )
    if statement_kind == 'complete_ddl':
        # The rerun truncate is opt-in because it is destructive against a table
        # the document cannot prove it owns. Here it can: every certification
        # target lives in this run's own schema under this run's own prefix, and
        # the C29 rerun cell is precisely the test that a second execution ends
        # at the same row count rather than double it.
        return generator.generate_complete_ddl(metadata, rerun_truncate=True, **common)
    statements = generator.generate_all_statements(metadata, **common)
    if statement_kind == 'bulk_insert' and not include_prereq:
        # The cell runs after its prerequisite setup, which already created the
        # BLOB_STORAGE source. Generating the statement with its own Step 0
        # creates that source a second time and the run dies at 46502 - which
        # reads as a product defect and is in fact the harness asking for the
        # same object twice. The generator's own complete document solves this
        # the same way.
        return generator.generate_bulk_insert(
            metadata,
            generator.resolve_table_name(metadata, table_name),
            schema_name,
            target_platform=platform,
            storage_url=storage_url,
            data_source=data_source,
            include_prereq=False,
            credential_name=credential_name,
            auth_method=auth_method,
            file_path_override=file_path_override,
        )
    return statements.get(statement_kind, '')


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


# ---------------------------------------------------------------------------
# Cleanup planning
# ---------------------------------------------------------------------------

#: Inverse operations, in the order dependencies allow them to be dropped.
#: An external table depends on both its file format and its data source; a
#: data source may depend on a credential; a credential may depend on the
#: database master key — which the harness never drops, because it may predate
#: the run.
CLEANUP_ORDER: Tuple[str, ...] = (
    'external table',
    'external file format',
    'external data source',
    'database scoped credential',
    'view',
    'table',
    'schema',
)


def cleanup_script(identity: RunIdentity, *, drop_database: bool = False) -> str:
    """Generate the explicit inverse of everything a run can create.

    This is written from the run identity rather than from the objects the run
    believes it made, so it still cleans up after a run that died halfway
    through. Every statement is guarded by an existence check, so the script is
    idempotent and safe to run twice.
    """
    schema = identity.schema
    prefix = identity.prefix
    lines: List[str] = [
        f'-- Certification cleanup for run {identity.run_id}',
        '-- Drops only objects carrying this run identity. Pre-existing objects,',
        '-- including any database master key, are left untouched.',
        '',
        'SET NOCOUNT ON;',
        'GO',
    ]

    lines += [
        '-- 1. External tables',
        'DECLARE @sql NVARCHAR(MAX) = N\'\';',
        'SELECT @sql = @sql + N\'DROP EXTERNAL TABLE [\' + s.name + N\'].[\' + t.name + N\'];\' + CHAR(10)',
        'FROM sys.external_tables AS t',
        'JOIN sys.schemas AS s ON s.schema_id = t.schema_id',
        f"WHERE s.name = '{schema}' AND t.name LIKE '{prefix}%';",
        'IF @sql <> N\'\' PRINT @sql;',
        'GO',
        '',
        '-- 2. Tables and views',
        '-- 3. External file formats, data sources, credentials',
        '-- 4. Schema',
        '',
        '-- The dynamic form above is printed rather than executed: the harness',
        '-- refuses to run EXEC, so cleanup is emitted as explicit statements by',
        '-- scripts.certification.execute after it has read the live inventory.',
        'GO',
    ]

    if drop_database:
        lines += [
            '',
            f'-- 5. Disposable database (SQL Server on a VM only)',
            f'-- DROP DATABASE [{identity.database}];  -- issued by the runner, not here',
            'GO',
        ]
    return '\n'.join(lines) + '\n'


def _escape_ident(name: str) -> str:
    """Double any ``]`` so a name cannot close its own bracket quoting."""
    return str(name).replace(']', ']]')


def explicit_cleanup_statements(
    identity: RunIdentity,
    inventory: Dict[str, List[str]],
) -> List[str]:
    """Build explicit ``DROP`` statements for the objects actually present.

    ``inventory`` maps an object kind from :data:`CLEANUP_ORDER` to the names
    found on the server. Only names owned by ``identity`` produce a statement,
    so an inventory that accidentally includes a pre-existing object cannot
    turn into a destructive script. These names come off a live server rather
    than out of the plan, so they are bracket-escaped as well as filtered.

    A name is dropped once. Catalog views overlap - an external table is a row
    in ``sys.external_tables`` *and* in ``sys.tables`` - so the same object
    arrived under two kinds and got two DROPs, the second failing with 3701 on
    something the first had already removed. The inventory queries now exclude
    external tables from the table kind, and this is the second line of defence:
    whatever shape the raw catalog answers come back in, the earlier kind in
    :data:`CLEANUP_ORDER` wins, which is also the more specific one.
    """
    statements: List[str] = []
    seen: set = set()
    for kind in CLEANUP_ORDER:
        for raw in inventory.get(kind, []):
            if not identity.owns(raw):
                continue
            # Schema-scoped and server-scoped kinds share no namespace, so the
            # key is the kind's scope rather than the bare name: an external
            # file format and a table may legitimately be called the same thing.
            scope = 'schema' if kind in ('table', 'view', 'external table') else kind
            key = (scope, raw.lower())
            if key in seen:
                continue
            seen.add(key)
            name = _escape_ident(raw)
            schema = _escape_ident(identity.schema)
            if kind == 'schema':
                statements.append(f'DROP SCHEMA [{schema}];')
            elif kind in ('table', 'view', 'external table'):
                verb = {'table': 'DROP TABLE', 'view': 'DROP VIEW',
                        'external table': 'DROP EXTERNAL TABLE'}[kind]
                statements.append(f'{verb} [{schema}].[{name}];')
            elif kind == 'external file format':
                statements.append(f'DROP EXTERNAL FILE FORMAT [{name}];')
            elif kind == 'external data source':
                statements.append(f'DROP EXTERNAL DATA SOURCE [{name}];')
            elif kind == 'database scoped credential':
                statements.append(f'DROP DATABASE SCOPED CREDENTIAL [{name}];')
    return statements


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

def build_manifest(
    *,
    target: str,
    identity: RunIdentity,
    staging: Staging,
    vm_platform: str = 'sql_server_2025',
    root: Optional[str] = None,
    redactor: Optional[Redactor] = None,
    emit_sql: bool = False,
) -> Dict[str, Any]:
    """Plan a whole certification run without touching a server.

    ``emit_sql`` keeps the unredacted SQL in each batch. It is off by default so
    the manifest is safe to attach to a pull request; the runner turns it on to
    produce an execution input that stays on its own machine.
    """
    root = root or repo_root()
    platform = platform_for(target, vm_platform=vm_platform)
    redactor = redactor or Redactor()
    policy = SafetyPolicy(
        identity,
        allowed_hosts=staging.hosts,
        allow_create_database=(target == 'vm'),
    )

    metadata_cache: Dict[str, Dict[str, Any]] = {}
    cells: List[Dict[str, Any]] = []

    for entry in entries_for(target):
        cells.append(
            _plan_cell(
                entry,
                target=target,
                platform=platform,
                identity=identity,
                staging=staging,
                policy=policy,
                root=root,
                redactor=redactor,
                metadata_cache=metadata_cache,
                emit_sql=emit_sql,
            )
        )

    return {
        'schema_version': MANIFEST_SCHEMA_VERSION,
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'target': target,
        'platform': platform,
        'identity': identity.as_dict(),
        # The staging hosts are whatever the operator staged fixtures on, which
        # may well be a tenant storage account, and a plain manifest is meant to
        # be attachable to a pull request. So they are redacted like every other
        # environment-bearing field - the maintained public fixture hosts pass
        # through untouched, which is what keeps the plan readable.
        #
        # They stay in cleartext only in an --emit-sql manifest. That manifest
        # already carries the raw SQL and is documented as machine-local, and
        # `execute` rebuilds the host allowlist from this field: a redacted
        # allowlist against raw SQL would refuse every remote statement.
        'hosts': (
            list(staging.hosts) if emit_sql
            else [redactor.redact(host) for host in staging.hosts]
        ),
        'allow_create_database': target == 'vm',
        'contains_raw_sql': emit_sql,
        'cells': cells,
        'plan_sha256': _sha256(
            '|'.join(f'{c["cell_id"]}:{c["sql_sha256"]}' for c in cells)
        ),
    }


def _plan_sql_block(
    sql: str,
    *,
    policy: SafetyPolicy,
    redactor: Redactor,
    emit_sql: bool,
) -> Dict[str, Any]:
    """Gate, split and record one block of generated SQL.

    Returns the batch list together with the two facts the plan verdict needs:
    whether every batch was allowed, and whether any batch still carries a
    placeholder.
    """
    batches: List[Batch] = split_batches(sql)
    entries: List[Dict[str, Any]] = []
    all_allowed = bool(batches)
    any_substitution = False
    for batch in batches:
        report = evaluate_batch(batch.text, policy)
        batch_entry: Dict[str, Any] = {
            'batch_index': batch.index,
            'start_line': batch.start_line,
            'repeat': batch.repeat,
            'sql_redacted': redactor.redact(batch.text),
            'sql_sha256': _sha256(batch.text),
            'safety': report.as_dict(),
        }
        if emit_sql:
            batch_entry['sql'] = batch.text
        entries.append(batch_entry)
        if not report.allowed:
            all_allowed = False
        if report.requires_substitution:
            any_substitution = True
    return {
        'batches': entries,
        'all_allowed': all_allowed,
        'any_substitution': any_substitution,
    }


#: Which generated statement satisfies each prerequisite. The prerequisites are
#: produced by the generator under test, with the same run-scoped names, so
#: satisfying one also exercises the code that made it. Borrowing a hand-written
#: setup script instead would certify the harness rather than the product.
PREREQUISITE_STATEMENTS: Dict[str, str] = {
    'setup': 'credential_setup',
    'file_format': 'external_file_format',
    'target_table': 'create_table',
}


def _plan_cell(
    entry: MatrixEntry,
    *,
    target: str,
    platform: str,
    identity: RunIdentity,
    staging: Staging,
    policy: SafetyPolicy,
    root: str,
    redactor: Redactor,
    metadata_cache: Dict[str, Dict[str, Any]],
    emit_sql: bool = False,
) -> Dict[str, Any]:
    fixture = FIXTURES_BY_KEY[entry.fixture]
    fixture_path = os.path.join(root, fixture.path.replace('/', os.sep))

    planned: Dict[str, Any] = {
        'cell_id': entry.cell_id,
        'target': target,
        'platform': platform,
        'fixture': entry.fixture,
        'fixture_path': fixture.path,
        'file_type': fixture.file_type,
        'statement_kind': entry.statement_kind,
        'access': entry.access,
        'hypothesis': entry.hypothesis,
        'intent': entry.intent,
        'accepts': list(entry.accepts),
        'notes': entry.notes,
        'expectations': staging.expectations(entry.fixture),
        'requires': list(entry.requires),
        'verification_kind': entry.verification,
        # Row and column counts describe a result set. DDL has none, so the
        # first live run marked C16 and C20 FAIL for statements that had in
        # fact succeeded. Success for DDL is "no error, and the object is in
        # the catalog" - which is what catalog_object below is for.
        'asserts_result_counts': entry.asserts_result_counts,
        'catalog_object': entry.catalog_object,
        'auth_method': entry.auth_method,
        'names': {},
        'setup': [],
        'verification': None,
        'substitutions': [],
        'batches': [],
        'sql_sha256': '',
        'sql_redacted': '',
        'plan_verdict': None,
    }

    if not os.path.exists(fixture_path):
        planned['plan_verdict'] = NOT_EXECUTABLE
        planned['unstaged'] = True
        planned['reason'] = f'fixture {fixture.path} is missing from the repository'
        return planned

    location = staging.location(entry.fixture, entry.access)
    if entry.access != 'none' and not location:
        planned['plan_verdict'] = NOT_EXECUTABLE
        planned['unstaged'] = True
        planned['reason'] = (
            f'no {entry.access} location staged for fixture {entry.fixture!r}; '
            f'the harness will not invent one'
        )
        return planned

    # A remote location reads bytes that are not this fixture's bytes. Generating
    # the schema from the local demo file and pointing it at a public blob is how
    # a run projects ten sales columns out of a five-column iris file: every
    # value NULL, and either a false FAIL or a false PASS. So a remote cell must
    # say which public object it reads, and generate from *that*.
    remote_access = entry.access not in ('none', 'engine_local')
    shape = resolve_shape(staging.shape_key(entry.fixture)) if remote_access else None
    if remote_access and shape is None:
        planned['plan_verdict'] = NOT_EXECUTABLE
        planned['unstaged'] = True
        planned['reason'] = (
            f'fixture {entry.fixture!r} is staged at a remote location but '
            f'declares no public shape; refusing to generate a schema from '
            f'unrelated local demo bytes'
        )
        return planned
    if shape is not None:
        mismatch = shape_mismatch(shape, fixture.file_type)
        if mismatch:
            planned['plan_verdict'] = NOT_EXECUTABLE
            planned['unstaged'] = True
            planned['reason'] = mismatch
            return planned

    if shape is not None:
        # Live evidence must name the object it actually read, not the demo
        # fixture whose key the matrix happens to use.
        metadata = shape.metadata()
        planned['public_shape'] = shape.key
        planned['public_shape_url'] = shape.url
        planned['public_shape_summary'] = shape.summary
        planned['verification_limit'] = shape.verification_limit
        # A staging document may still pin a first value; the shape owns the
        # counts, because the shape is what describes the bytes.
        expectations = dict(shape.expectations())
        expectations.update({
            key: value
            for key, value in staging.expectations(entry.fixture).items()
            if key == 'first_value'
        })
        planned['expectations'] = expectations
    else:
        if entry.fixture not in metadata_cache:
            metadata_cache[entry.fixture] = _metadata_for(fixture_path)
        metadata = dict(metadata_cache[entry.fixture])

    # Cell C30 is the negative control: it deliberately keeps the default,
    # file-derived name so the safety gate has something real to refuse.
    use_default_names = entry.cell_id == 'C30'
    # Names follow the *naming* cell, not this one. C29 reruns C28's document,
    # and a rerun that writes to fresh names is a first run wearing a rerun
    # label.
    stem = entry.naming_cell.lower()
    table_name = None if use_default_names else identity.name(stem, entry.fixture)
    schema_name = 'dbo' if use_default_names else identity.schema
    data_source = identity.name(stem, 'src')
    # Every generated object gets the run prefix, not just the table. Without
    # this the shared prerequisites (ff_csv_format, cred_<ds>) keep their
    # derived names and the safety gate correctly refuses the whole batch.
    format_name = None if use_default_names else identity.name(stem, 'fmt')
    external_table_name = None if use_default_names else identity.name(stem, 'ext')
    credential_name = None if use_default_names else identity.name(stem, 'cred')
    # A public container needs no credential and no database master key. The
    # first live run asked for managed identity everywhere, which minted a
    # credential per cell that nothing used - and, on SQL Server, tried to do it
    # in master (error 33158). Managed identity is now its own cell (C26).
    auth_method = None if use_default_names else entry.auth_method

    # A path is engine-local, not client-local: the file is analysed here and
    # the statement runs there. Where a cell reads a staged server path, the
    # generator is told that path explicitly instead of interpolating this
    # machine's worktree (which the first live run did, earning error 4860).
    engine_local_path = location if entry.access == 'engine_local' else None
    storage_url = None if entry.access == 'engine_local' else location

    common = dict(
        table_name=table_name,
        schema_name=schema_name,
        data_source=data_source,
        platform=platform,
        storage_url=storage_url,
        format_name=format_name,
        external_table_name=external_table_name,
        credential_name=credential_name,
        auth_method=auth_method,
        file_path_override=engine_local_path,
    )

    planned['names'] = {
        'schema': schema_name,
        'table': table_name,
        'external_table': external_table_name,
        'external_file_format': format_name,
        'external_data_source': data_source,
        'database_scoped_credential': credential_name,
    }

    sql = _generate(
        metadata, statement_kind=entry.statement_kind,
        # 'setup' is the generator's own prerequisite section, and for a bulk
        # load it already creates the BLOB_STORAGE source the statement needs.
        include_prereq='setup' not in entry.requires,
        **common,
    )

    planned['sql_sha256'] = _sha256(sql)
    planned['sql_redacted'] = redactor.redact(sql)

    block = _plan_sql_block(sql, policy=policy, redactor=redactor, emit_sql=emit_sql)
    planned['batches'] = block['batches']
    all_allowed = block['all_allowed']
    any_substitution = block['any_substitution']

    # Prerequisites. An OPENROWSET needs its data source, an external table
    # needs the format too, and a BULK INSERT needs somewhere to insert into.
    # Running the cell's fragment alone produced errors 12703 / 46501 / 208 /
    # 2760 in the first live run, and those were filed as generator defects.
    # They were missing prerequisites.
    for requirement in entry.requires:
        statement_kind = PREREQUISITE_STATEMENTS[requirement]
        setup_sql = _generate(metadata, statement_kind=statement_kind, **common)
        setup_block = _plan_sql_block(
            setup_sql, policy=policy, redactor=redactor, emit_sql=emit_sql,
        )
        planned['setup'].append({
            'requirement': requirement,
            'statement_kind': statement_kind,
            'sql_sha256': _sha256(setup_sql),
            'sql_redacted': redactor.redact(setup_sql),
            'batches': setup_block['batches'],
        })
        if not setup_block['all_allowed']:
            all_allowed = False
        if setup_block['any_substitution']:
            any_substitution = True

    verification_sql = _verification_sql(
        entry, schema_name, table_name, external_table_name,
        limit=planned.get('verification_limit'),
    )
    # A statement that asks for TOP (n) rows returns n rows, not the file's row
    # count. Asserting 729 against a capped read is a harness bug that reads as
    # a generator defect, so the expectation is capped to whatever the query
    # that produces the result set actually asks for.
    counted_sql = verification_sql or planned.get('sql_redacted') or ''
    _cap_row_expectation(planned, counted_sql)
    if verification_sql:
        verification_block = _plan_sql_block(
            verification_sql, policy=policy, redactor=redactor, emit_sql=emit_sql,
        )
        planned['verification'] = {
            'kind': entry.verification,
            'sql_sha256': _sha256(verification_sql),
            'sql_redacted': redactor.redact(verification_sql),
            'batches': verification_block['batches'],
        }
        if not verification_block['all_allowed']:
            all_allowed = False

    _reject_duplicate_creates(planned)

    if not planned['batches']:
        planned['plan_verdict'] = NOT_EXECUTABLE
        planned['reason'] = 'generator produced no executable batch'
    elif planned.get('duplicate_creates'):
        # Creating the same object in setup and again in the cell is a plan the
        # server will reject at 46502 / 2714, and the run will read that as a
        # product defect. Refuse to send it.
        planned['plan_verdict'] = BLOCKED
        names = ', '.join(planned['duplicate_creates'])
        planned['reason'] = (
            f'prerequisite setup and the cell both create {names}; '
            f'the second CREATE would fail as already-exists'
        )
    elif all_allowed:
        planned['plan_verdict'] = 'READY'
    elif any_substitution and not any(
        b['safety']['violations'] for b in planned['batches']
    ):
        planned['plan_verdict'] = NOT_EXECUTABLE
        planned['reason'] = 'unresolved placeholders remain in the generated SQL'
    else:
        planned['plan_verdict'] = BLOCKED
        planned['reason'] = 'safety gate refused at least one batch'

    return planned


_TOP_CAP_RE = re.compile(r'\bTOP\s*\(\s*(\d+)\s*\)', re.IGNORECASE)

#: The object kinds a cell and its prerequisites can both try to create. Each
#: pattern captures the object name so the check compares names, not kinds: two
#: different data sources are fine, the same one twice is not.
_CREATE_PATTERNS: Tuple[Tuple[str, 're.Pattern[str]'], ...] = (
    ('external data source', re.compile(
        r'^\s*CREATE\s+EXTERNAL\s+DATA\s+SOURCE\s+(\[[^\]]+\]|\S+)',
        re.IGNORECASE | re.MULTILINE)),
    ('external file format', re.compile(
        r'^\s*CREATE\s+EXTERNAL\s+FILE\s+FORMAT\s+(\[[^\]]+\]|\S+)',
        re.IGNORECASE | re.MULTILINE)),
    ('database scoped credential', re.compile(
        r'^\s*CREATE\s+DATABASE\s+SCOPED\s+CREDENTIAL\s+(\[[^\]]+\]|\S+)',
        re.IGNORECASE | re.MULTILINE)),
    ('external table', re.compile(
        r'^\s*CREATE\s+EXTERNAL\s+TABLE\s+(\S+)',
        re.IGNORECASE | re.MULTILINE)),
    ('table', re.compile(
        r'^\s*CREATE\s+TABLE\s+(\S+)',
        re.IGNORECASE | re.MULTILINE)),
)


def _created_objects(batches: Sequence[Dict[str, Any]]) -> Set[str]:
    """Every object these batches create, as ``kind name`` keys."""
    created: Set[str] = set()
    for batch in batches:
        sql = batch.get('sql') or batch.get('sql_redacted') or ''
        for kind, pattern in _CREATE_PATTERNS:
            for name in pattern.findall(sql):
                created.add(f'{kind} {name.strip().rstrip(";")}')
    return created


def _reject_duplicate_creates(planned: Dict[str, Any]) -> None:
    """Name any object the prerequisites and the cell both create.

    The first live run of C14 died at 46502. The prerequisite setup created the
    BLOB_STORAGE source and then the BULK INSERT statement, generated with its
    own Step 0, created it again. Nothing in the plan noticed that it was asking
    the server to make one object twice, so the failure arrived as evidence
    against the generator. This is the invariant that would have caught it.
    """
    setup_objects: Set[str] = set()
    for step in planned.get('setup') or []:
        setup_objects |= _created_objects(step.get('batches') or [])
    if not setup_objects:
        return
    duplicates = sorted(setup_objects & _created_objects(planned.get('batches') or []))
    if duplicates:
        planned['duplicate_creates'] = duplicates


def _cap_row_expectation(planned: Dict[str, Any], sql: str) -> None:
    """Lower a row-count expectation to the cap the statement imposes.

    The generated ad-hoc reads are deliberately bounded - `SELECT TOP (100)`
    against a blob is a sane thing to generate and an insane thing to remove.
    But the staged object has 729 rows, and comparing 729 to the 100 that come
    back is the harness misreading its own query as a generator defect.
    """
    expected = (planned.get('expectations') or {}).get('row_count')
    if expected is None or not sql:
        return
    caps = [int(match) for match in _TOP_CAP_RE.findall(sql)]
    if not caps:
        return
    cap = min(caps)
    if cap < expected:
        planned['expectations'] = dict(planned['expectations'], row_count=cap)
        planned['row_count_capped_from'] = expected


def _verification_sql(
    entry: MatrixEntry,
    schema_name: str,
    table_name: Optional[str],
    external_table_name: Optional[str],
    limit: Optional[int] = None,
) -> Optional[str]:
    """The query that proves a load worked, or ``None`` where the cell is its own proof.

    ``SELECT *`` rather than ``COUNT(*)`` on purpose: the row count and the
    column count both come out of the same result set, and so does the value
    fidelity the encoding cells care about.

    ``limit`` bounds the read where the staged object is large. A month of NYC
    taxi trips is millions of rows and reading all of them certifies nothing
    that reading ten does not - but the column count still has to come from a
    real projection, which is why this stays ``SELECT *`` with a ``TOP``.
    """
    top = f'TOP ({int(limit)}) ' if limit else ''
    if entry.verification == 'target_table' and table_name:
        return (
            f'SELECT {top}* FROM [{_escape_ident(schema_name)}].'
            f'[{_escape_ident(table_name)}];'
        )
    if entry.verification == 'external_table' and external_table_name:
        return (
            f'SELECT {top}* FROM [{_escape_ident(schema_name)}].'
            f'[{_escape_ident(external_table_name)}];'
        )
    return None


def write_manifest(manifest: Dict[str, Any], path: str) -> None:
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
        handle.write('\n')
