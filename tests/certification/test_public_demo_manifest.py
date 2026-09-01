import hashlib
import json
from pathlib import Path
from urllib.parse import quote

from fastavro import reader


ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ROOT / 'data sample'
MANIFEST = ROOT / 'scripts' / 'certification' / 'public-demo-fixtures.json'
NON_ARTIFACTS = {'README.md', 'generate_samples.py', '.gitattributes', 'collation_samples.sql'}


def _payload():
    return json.loads(MANIFEST.read_text(encoding='utf-8'))


def test_manifest_covers_the_published_canonical_artifacts():
    payload = _payload()
    entries = {entry['local_path']: entry for entry in payload['artifacts']}
    assert payload['artifact_count'] == len(entries) == 23

    for relative, entry in entries.items():
        assert relative.startswith('data sample/')
        assert (ROOT / relative).is_file()
        assert (ROOT / relative).name not in NON_ARTIFACTS
        content = (ROOT / relative).read_bytes()
        assert entry['bytes'] == len(content)
        assert entry['sha256'] == hashlib.sha256(content).hexdigest()
        expected_url = (
            payload['base_url'].rstrip('/')
            + '/'
            + quote(relative.removeprefix('data sample/'), safe='/')
        )
        assert entry['url'] == expected_url
        assert entry['expected_availability'] == 'public_anonymous'


def test_table_references_are_preserved_and_iceberg_tree_is_complete():
    payload = _payload()
    entries = {entry['local_path'] for entry in payload['artifacts']}
    delta_log = (
        SAMPLES / 'tables/events_delta/_delta_log/00000000000000000000.json'
    ).read_text(encoding='utf-8')
    delta_rows = [json.loads(line) for line in delta_log.splitlines()]
    delta_path = next(row['add']['path'] for row in delta_rows if 'add' in row)
    assert f'data sample/tables/events_delta/{delta_path}' in entries
    assert payload['reference_validation']['delta'] == 'complete'

    iceberg = json.loads(
        (SAMPLES / 'tables/events_iceberg/metadata/v1.metadata.json').read_text(
            encoding='utf-8'
        )
    )
    manifest_list = iceberg['snapshots'][0]['manifest-list']
    base_url = payload['base_url'].rstrip('/')
    assert manifest_list.startswith(base_url + '/tables/events_iceberg/')
    manifest_list_local = 'data sample/' + manifest_list.removeprefix(base_url + '/')
    assert manifest_list_local in entries

    with (ROOT / manifest_list_local).open('rb') as handle:
        manifest_list_reader = reader(handle)
        assert manifest_list_reader.metadata['format-version'] == '2'
        manifest_list_rows = list(manifest_list_reader)
    assert len(manifest_list_rows) == 1
    manifest_url = manifest_list_rows[0]['manifest_path']
    assert manifest_url.startswith(base_url + '/tables/events_iceberg/')
    manifest_local = 'data sample/' + manifest_url.removeprefix(base_url + '/')
    assert manifest_local in entries
    assert manifest_list_rows[0]['manifest_length'] == (
        ROOT / manifest_local
    ).stat().st_size

    with (ROOT / manifest_local).open('rb') as handle:
        manifest_reader = reader(handle)
        assert json.loads(manifest_reader.metadata['schema']) == iceberg['schemas'][0]
        manifest_rows = list(manifest_reader)
    assert len(manifest_rows) == 1
    data_url = manifest_rows[0]['data_file']['file_path']
    data_local = 'data sample/' + data_url.removeprefix(base_url + '/')
    assert data_local in entries
    assert manifest_rows[0]['data_file']['record_count'] == 3
    assert payload['reference_validation']['iceberg'] == 'complete'
