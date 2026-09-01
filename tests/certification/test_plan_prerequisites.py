"""No object may be created twice in one cell.

The first live run of C14 died at error 46502. The prerequisite setup created
the BLOB_STORAGE external data source, and then the BULK INSERT statement -
generated with its own "Step 0" prerequisite - created the same source again.
Nothing in the plan noticed it was asking the server to make one object twice,
so the failure arrived looking like evidence against the generator.

These tests pin both the fix and the invariant that would have caught it.
"""

import os
import re
import sys

import pytest

sys.path.insert(
    0,
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        'scripts',
    ),
)

from certification.manifest import (  # noqa: E402
    Staging,
    _created_objects,
    _reject_duplicate_creates,
    build_manifest,
)
from certification.runid import RunIdentity  # noqa: E402

STAGING_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    'scripts', 'certification', 'staging.example.json',
)

CREATE_EDS = re.compile(
    r'^\s*CREATE\s+EXTERNAL\s+DATA\s+SOURCE\s+(\[[^\]]+\])',
    re.IGNORECASE | re.MULTILINE,
)


def _plan(target='vm'):
    return build_manifest(
        target=target,
        identity=RunIdentity('0123abcd'),
        staging=Staging.load(STAGING_PATH),
        emit_sql=True,
    )


def _sql_of(block):
    return block.get('sql') or block.get('sql_redacted') or ''


def _cell(manifest, cell_id):
    for cell in manifest['cells']:
        if cell['cell_id'] == cell_id:
            return cell
    raise AssertionError(f'{cell_id} is not in the plan')


@pytest.fixture(scope='module')
def vm_plan():
    return _plan('vm')


def _creates_in(cell):
    """Every ``CREATE EXTERNAL DATA SOURCE`` name, per section."""
    setup = []
    for step in cell.get('setup') or []:
        for batch in step.get('batches') or []:
            setup.extend(CREATE_EDS.findall(_sql_of(batch)))
    body = []
    for batch in cell.get('batches') or []:
        body.extend(CREATE_EDS.findall(_sql_of(batch)))
    return setup, body


def test_the_bulk_cell_does_not_recreate_its_prerequisite(vm_plan):
    cell = _cell(vm_plan, 'C14')
    setup, body = _creates_in(cell)
    assert any(name.endswith('_Bulk]') for name in setup), (
        'the prerequisite setup should still create the bulk source'
    )
    assert body == [], f'the cell created {body} that setup had already created'


def test_the_bulk_cell_says_where_its_data_source_came_from(vm_plan):
    # Dropping the CREATE silently would leave a reader wondering what the
    # statement depends on. The generator replaces it with a pointer.
    cell = _cell(vm_plan, 'C14')
    assert 'from the setup section' in _sql_of(cell['batches'][0])


def test_the_bulk_cell_is_still_ready(vm_plan):
    assert _cell(vm_plan, 'C14')['plan_verdict'] == 'READY'


def test_no_cell_creates_an_object_its_prerequisites_already_created(vm_plan):
    offenders = {
        cell['cell_id']: cell['duplicate_creates']
        for cell in vm_plan['cells']
        if cell.get('duplicate_creates')
    }
    assert offenders == {}


def test_the_azure_plan_is_clean_too():
    manifest = _plan('azure')
    assert [
        cell['cell_id'] for cell in manifest['cells'] if cell.get('duplicate_creates')
    ] == []


# -- the invariant itself ----------------------------------------------------

def _batch(sql):
    return {'sql': sql, 'sql_redacted': sql}


def test_created_objects_reads_every_kind():
    found = _created_objects([
        _batch('CREATE EXTERNAL DATA SOURCE [src]\nWITH ( TYPE = BLOB_STORAGE );'),
        _batch('CREATE EXTERNAL FILE FORMAT [fmt] WITH ( FORMAT_TYPE = DELIMITEDTEXT );'),
        _batch("CREATE DATABASE SCOPED CREDENTIAL [cred] WITH IDENTITY = 'x';"),
        _batch('CREATE TABLE [s].[t] ( [a] INT );'),
        _batch('CREATE EXTERNAL TABLE [s].[e] ( [a] INT ) WITH ( LOCATION = 1 );'),
    ])
    assert found == {
        'external data source [src]',
        'external file format [fmt]',
        'database scoped credential [cred]',
        'table [s].[t]',
        'external table [s].[e]',
    }


def test_a_commented_create_is_not_a_create():
    assert _created_objects([_batch('-- CREATE EXTERNAL DATA SOURCE [src]')]) == set()


def test_the_same_object_in_setup_and_cell_is_named():
    planned = {
        'setup': [{'batches': [_batch('CREATE EXTERNAL DATA SOURCE [src_Bulk] WITH ();')]}],
        'batches': [_batch('CREATE EXTERNAL DATA SOURCE [src_Bulk] WITH ();')],
    }
    _reject_duplicate_creates(planned)
    assert planned['duplicate_creates'] == ['external data source [src_Bulk]']


def test_two_different_objects_are_not_a_duplicate():
    planned = {
        'setup': [{'batches': [_batch('CREATE EXTERNAL DATA SOURCE [a] WITH ();')]}],
        'batches': [_batch('CREATE EXTERNAL DATA SOURCE [b] WITH ();')],
    }
    _reject_duplicate_creates(planned)
    assert 'duplicate_creates' not in planned


def test_the_same_name_in_two_object_kinds_is_not_a_duplicate():
    # A file format and a data source may legitimately share a name.
    planned = {
        'setup': [{'batches': [_batch('CREATE EXTERNAL DATA SOURCE [x] WITH ();')]}],
        'batches': [_batch('CREATE EXTERNAL FILE FORMAT [x] WITH ();')],
    }
    _reject_duplicate_creates(planned)
    assert 'duplicate_creates' not in planned


def test_a_cell_with_no_prerequisites_is_never_flagged():
    planned = {
        'setup': [],
        'batches': [_batch('CREATE EXTERNAL DATA SOURCE [x] WITH ();')],
    }
    _reject_duplicate_creates(planned)
    assert 'duplicate_creates' not in planned


def test_a_duplicate_blocks_the_cell_instead_of_being_sent(monkeypatch):
    """The invariant has to change the verdict, not just annotate it."""
    from certification import manifest as manifest_module

    collide = 'CREATE EXTERNAL DATA SOURCE [collide] WITH ( TYPE = BLOB_STORAGE );'
    monkeypatch.setattr(
        manifest_module, '_generate', lambda *args, **kwargs: collide,
    )
    manifest = _plan('vm')
    blocked = [
        cell for cell in manifest['cells']
        if cell.get('duplicate_creates') and cell['plan_verdict'] == 'BLOCKED'
    ]
    assert blocked, 'a colliding plan must be refused'
    assert 'external data source [collide]' in blocked[0]['reason']
    assert 'already-exists' in blocked[0]['reason']
