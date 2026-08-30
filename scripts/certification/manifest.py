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
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

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
    )
    if statement_kind == 'complete_ddl':
        return generator.generate_complete_ddl(metadata, **common)
    statements = generator.generate_all_statements(metadata, **common)
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
    """
    statements: List[str] = []
    for kind in CLEANUP_ORDER:
        for raw in inventory.get(kind, []):
            if not identity.owns(raw):
                continue
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
        'hosts': list(staging.hosts),
        'allow_create_database': target == 'vm',
        'contains_raw_sql': emit_sql,
        'cells': cells,
        'plan_sha256': _sha256(
            '|'.join(f'{c["cell_id"]}:{c["sql_sha256"]}' for c in cells)
        ),
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
        'substitutions': [],
        'batches': [],
        'sql_sha256': '',
        'sql_redacted': '',
        'plan_verdict': None,
    }

    if not os.path.exists(fixture_path):
        planned['plan_verdict'] = NOT_EXECUTABLE
        planned['reason'] = f'fixture {fixture.path} is missing from the repository'
        return planned

    location = staging.location(entry.fixture, entry.access)
    if entry.access != 'none' and not location:
        planned['plan_verdict'] = NOT_EXECUTABLE
        planned['reason'] = (
            f'no {entry.access} location staged for fixture {entry.fixture!r}; '
            f'the harness will not invent one'
        )
        return planned

    if entry.fixture not in metadata_cache:
        metadata_cache[entry.fixture] = _metadata_for(fixture_path)
    metadata = dict(metadata_cache[entry.fixture])

    # Cell C30 is the negative control: it deliberately keeps the default,
    # file-derived name so the safety gate has something real to refuse.
    use_default_names = entry.cell_id == 'C30'
    table_name = None if use_default_names else identity.name(entry.cell_id.lower(), entry.fixture)
    schema_name = 'dbo' if use_default_names else identity.schema
    data_source = identity.name(entry.cell_id.lower(), 'src')
    # Every generated object gets the run prefix, not just the table. Without
    # this the shared prerequisites (ff_csv_format, cred_<ds>) keep their
    # derived names and the safety gate correctly refuses the whole batch.
    format_name = None if use_default_names else identity.name(entry.cell_id.lower(), 'fmt')
    external_table_name = (
        None if use_default_names else identity.name(entry.cell_id.lower(), 'ext')
    )
    credential_name = (
        None if use_default_names else identity.name(entry.cell_id.lower(), 'cred')
    )
    # Managed identity keeps the run secretless: no master key, no SAS token,
    # nothing secret-shaped for the redactor or the gate to trip over.
    auth_method = None if use_default_names else 'managed_identity'

    sql = _generate(
        metadata,
        statement_kind=entry.statement_kind,
        table_name=table_name,
        schema_name=schema_name,
        data_source=data_source,
        platform=platform,
        storage_url=location,
        format_name=format_name,
        external_table_name=external_table_name,
        credential_name=credential_name,
        auth_method=auth_method,
    )

    planned['sql_sha256'] = _sha256(sql)
    planned['sql_redacted'] = redactor.redact(sql)

    batches: List[Batch] = split_batches(sql)
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
        planned['batches'].append(batch_entry)
        if not report.allowed:
            all_allowed = False
        if report.requires_substitution:
            any_substitution = True

    if not batches:
        planned['plan_verdict'] = NOT_EXECUTABLE
        planned['reason'] = 'generator produced no executable batch'
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


def write_manifest(manifest: Dict[str, Any], path: str) -> None:
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
        handle.write('\n')
