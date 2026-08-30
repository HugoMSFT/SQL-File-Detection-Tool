"""The staged bytes and the generated schema have to describe the same file.

The harness analyses a local demo fixture and then points the generated
statement at a public blob. That is only sound if the two agree, and for a
while they did not: `csv_scalar` mapped ten columns of synthetic sales data onto
the five-column public iris CSV. The generated `WITH` clause then named columns
the file does not have, and the read comes back either as an error that looks
like a generator defect or - worse - as the right number of rows with every
value NULL, which a count-only assertion calls a PASS.

These tests pin the two halves together: every remote staging entry declares a
shape, every declared shape matches the object it names, and a remote entry
without one is refused rather than planned.
"""

import json
import os

import pytest

from certification.manifest import Staging, build_manifest
from certification.runid import RunIdentity
from certification.public_fixtures import (
    PUBLIC_SHAPES,
    PublicShape,
    resolve_shape,
    shape_mismatch,
)
from certification.matrix import FIXTURES_BY_KEY

from conftest import REPO_ROOT

STAGING_PATH = os.path.join(REPO_ROOT, 'scripts', 'certification', 'staging.example.json')


@pytest.fixture()
def staging():
    return Staging.load(STAGING_PATH)


@pytest.fixture()
def staging_document():
    with open(STAGING_PATH, 'r', encoding='utf-8') as handle:
        return json.load(handle)


REMOTE_ACCESS = ('abs', 'adls', 'blob_storage')


def test_every_remote_staging_entry_declares_a_shape(staging_document):
    for key, entry in (staging_document.get('fixtures') or {}).items():
        if not isinstance(entry, dict):
            continue
        remote = [access for access in REMOTE_ACCESS if entry.get(access)]
        if not remote:
            continue
        assert entry.get('shape'), (
            f'fixture {key!r} is staged at {remote} but declares no shape, so '
            f'the generator would be handed the local demo file\'s schema'
        )
        assert resolve_shape(entry['shape']) is not None, (
            f'fixture {key!r} names shape {entry["shape"]!r}, which does not exist'
        )


def test_declared_shapes_match_the_fixture_type_they_are_staged_for(staging_document):
    for key, entry in (staging_document.get('fixtures') or {}).items():
        if not isinstance(entry, dict) or not entry.get('shape'):
            continue
        shape = resolve_shape(entry['shape'])
        fixture = FIXTURES_BY_KEY[key]
        assert shape_mismatch(shape, fixture.file_type) is None, (
            f'fixture {key!r} is {fixture.file_type} but shape '
            f'{shape.key!r} is {shape.file_type}'
        )


def test_all_types_parquet_is_not_staged_against_the_taxi_dataset(staging_document):
    """The demo all_types fixture has nested, map, list and decimal columns.

    The NYC taxi dataset has 21 flat scalars. Mapping one onto the other would
    transfer the demo fixture's type-fidelity claims onto a file that cannot
    support them, so those cells stay unstaged until the exact bytes are.
    """
    entry = (staging_document.get('fixtures') or {}).get('parquet_all_types')
    assert not entry, 'parquet_all_types must not be mapped to a substitute object'


def test_shape_metadata_column_names_and_count_agree(staging_document):
    for shape in PUBLIC_SHAPES.values():
        metadata = shape.metadata()
        names = [name for name, _ in shape.columns]
        assert metadata['column_count'] == len(names) == shape.column_count
        assert [pair[0] for pair in metadata['schema']] == names
        assert metadata['nullable_columns'] == names
        # The provenance is what lets a reviewer check the shape by hand.
        assert metadata['public_shape'] == shape.key
        assert metadata['public_shape_url'].startswith('https://')


def test_a_declared_width_covers_every_wide_text_column():
    for shape in PUBLIC_SHAPES.values():
        for column in shape.wide_text_columns:
            assert column in shape.max_string_lengths, (
                f'{shape.key}.{column} is wide text but has no declared width, '
                f'so the generator would size it NVARCHAR(255)'
            )
            assert shape.max_string_lengths[column] >= 4000


def test_the_ndjson_shape_is_the_object_the_live_run_certified():
    shape = PUBLIC_SHAPES['petri_ndjson']
    assert shape.row_count == 729
    assert [name for name, _ in shape.columns] == [
        'timestamp', 'source', 'severity', 'message',
    ]
    assert shape.json_format == 'ndjson'
    # The exact object, not the container root. A root `petri.jsonl` does not
    # exist, and planning against it would fail on a path error that looks like
    # a row-framing defect.
    assert shape.url.endswith(
        '/aarch64_exclusive__openvmm_linux_aarch64_assigned_device_peer_to_peer'
        '_dma_aarch64_tcg/petri.jsonl'
    )


def test_the_iris_shape_is_five_columns_and_not_a_type_fidelity_claim():
    shape = PUBLIC_SHAPES['iris_csv']
    assert shape.column_count == 5
    assert shape.row_count == 150
    assert [name for name, _ in shape.columns][:4] == [
        'sepal_length', 'sepal_width', 'petal_length', 'petal_width',
    ]


def test_the_taxi_shape_asserts_no_row_count():
    """A month of taxi trips is millions of rows.

    Declaring a count would either be wrong or force a full scan to prove, and
    reading ten rows certifies the access pattern just as well.
    """
    shape = PUBLIC_SHAPES['taxi_parquet_2018_06']
    assert shape.column_count == 21
    assert shape.row_count is None
    assert shape.verification_limit == 10
    assert 'row_count' not in shape.expectations()
    assert shape.expectations()['column_count'] == 21


def test_the_whole_document_shape_projects_real_keys():
    """`aliases.json` is an ARM deployment template, so its top level is fixed.

    An invented column name would return one row of NULL and pass a count-only
    assertion, which is the exact failure this whole file exists to stop.
    """
    shape = PUBLIC_SHAPES['aliases_json']
    names = [name for name, _ in shape.columns]
    assert names == [
        '$schema', 'contentVersion', 'parameters', 'variables', 'resources',
        'outputs',
    ]
    assert shape.json_format == 'object'
    # A key that is not a plain identifier has to become a quoted JSON path.
    assert '$schema' in shape.json_nesting


@pytest.mark.parametrize('shape_key', sorted(PUBLIC_SHAPES))
def test_a_shape_never_leaks_a_local_path(shape_key):
    shape = PUBLIC_SHAPES[shape_key]
    metadata = shape.metadata()
    assert os.sep not in str(metadata['file_path'])
    assert ':' not in str(metadata['file_path'])


def test_a_mismatched_shape_is_named_rather_than_silently_used():
    csv_shape = PUBLIC_SHAPES['iris_csv']
    assert shape_mismatch(csv_shape, 'csv') is None
    reason = shape_mismatch(csv_shape, 'parquet')
    assert reason and 'iris_csv' in reason and 'parquet' in reason


def test_a_remote_fixture_without_a_shape_is_not_executable(tmp_path):
    """The refusal is the feature: no shape means no trustworthy schema."""
    document = {
        'version': 1,
        'hosts': ['azuremlexamples.blob.core.windows.net'],
        'fixtures': {
            'csv_scalar': {
                'abs': 'abs://datasets@azuremlexamples.blob.core.windows.net/iris.csv',
            },
        },
    }
    path = tmp_path / 'staging.json'
    path.write_text(json.dumps(document), encoding='utf-8')

    manifest = build_manifest(target='azure', identity=RunIdentity('0123abcd'), staging=Staging.load(str(path)))
    remote = [
        cell for cell in manifest['cells']
        if cell['fixture'] == 'csv_scalar' and cell['access'] == 'abs'
    ]
    assert remote, 'the matrix has no remote csv_scalar cell to check'
    for cell in remote:
        assert cell['plan_verdict'] == 'NOT_EXECUTABLE'
        assert cell['unstaged'] is True
        assert 'declares no public shape' in cell['reason']


def test_a_staged_cell_generates_from_the_public_shape_not_the_demo_file():
    manifest = build_manifest(target='azure', identity=RunIdentity('0123abcd'), staging=Staging.load(STAGING_PATH), emit_sql=True)
    staged = [
        cell for cell in manifest['cells']
        if cell.get('public_shape') == 'iris_csv'
        and cell['plan_verdict'] == 'READY'
        and cell['statement_kind'] in ('bulk_insert', 'openrowset')
    ]
    assert staged, 'no READY iris cell to check'
    for cell in staged:
        blocks = [cell['sql_redacted']]
        for step in cell.get('setup') or []:
            blocks.extend(
                batch.get('sql') or batch.get('sql_redacted') or ''
                for batch in step.get('batches') or []
            )
        combined = '\n'.join(blocks)
        # A BULK INSERT names no columns itself; the shape shows up in the
        # CREATE TABLE it depends on, which is exactly why prerequisites have
        # to be generated from the same metadata.
        assert 'sepal_length' in combined, cell['cell_id']
        # The demo fixture's columns must not appear anywhere in a cell that
        # reads the public object.
        assert 'unit_price' not in combined, cell['cell_id']
        assert 'order_timestamp' not in combined, cell['cell_id']


def test_a_capped_read_does_not_assert_the_files_full_row_count():
    """`SELECT TOP (100)` returns 100 rows even from a 729-row object."""
    manifest = build_manifest(target='azure', identity=RunIdentity('0123abcd'), staging=Staging.load(STAGING_PATH), emit_sql=True)
    capped = [
        cell for cell in manifest['cells']
        if cell.get('row_count_capped_from')
    ]
    assert capped, 'no capped cell in the plan'
    for cell in capped:
        expected = cell['expectations']['row_count']
        assert expected < cell['row_count_capped_from']
        assert f'TOP ({expected})' in cell['sql_redacted'] or expected == 10


def test_shapes_are_frozen_so_a_plan_cannot_mutate_them():
    shape = PUBLIC_SHAPES['iris_csv']
    with pytest.raises(Exception):
        shape.row_count = 1  # type: ignore[misc]
    assert isinstance(shape, PublicShape)

