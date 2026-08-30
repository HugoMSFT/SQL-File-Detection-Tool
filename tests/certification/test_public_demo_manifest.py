import hashlib
import json
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).resolve().parents[2]
DEMO = ROOT / 'demo'
MANIFEST = ROOT / 'scripts' / 'certification' / 'public-demo-fixtures.json'
NON_ARTIFACTS = {'README.md', 'generate_samples.py', '.gitattributes', 'collation_samples.sql'}


def _payload():
    return json.loads(MANIFEST.read_text(encoding='utf-8'))


def test_manifest_covers_every_demo_artifact_with_exact_bytes_and_hash():
    payload = _payload()
    entries = {entry['local_path']: entry for entry in payload['artifacts']}
    actual = {
        path.relative_to(ROOT).as_posix()
        for path in DEMO.rglob('*')
        if path.is_file()
        and path.name not in NON_ARTIFACTS
        and '__pycache__' not in path.parts
    }
    assert set(entries) == actual
    assert payload['artifact_count'] == len(actual) == 21

    for relative, entry in entries.items():
        content = (ROOT / relative).read_bytes()
        assert entry['bytes'] == len(content)
        assert entry['sha256'] == hashlib.sha256(content).hexdigest()
        expected_url = (
            payload['base_url'].rstrip('/')
            + '/'
            + quote(relative.removeprefix('demo/'), safe='/')
        )
        assert entry['url'] == expected_url
        assert entry['expected_availability'] == 'public_anonymous'


def test_table_references_are_preserved_and_missing_iceberg_sidecar_is_explicit():
    payload = _payload()
    entries = {entry['local_path'] for entry in payload['artifacts']}
    delta_log = (
        DEMO / 'tables/events_delta/_delta_log/00000000000000000000.json'
    ).read_text(encoding='utf-8')
    delta_rows = [json.loads(line) for line in delta_log.splitlines()]
    delta_path = next(row['add']['path'] for row in delta_rows if 'add' in row)
    assert f'demo/tables/events_delta/{delta_path}' in entries
    assert payload['reference_validation']['delta'] == 'complete'

    iceberg = json.loads(
        (DEMO / 'tables/events_iceberg/metadata/v1.metadata.json').read_text(
            encoding='utf-8'
        )
    )
    manifest_list = iceberg['snapshots'][0]['manifest-list']
    assert f'demo/tables/events_iceberg/{manifest_list}' not in entries
    assert payload['reference_validation']['iceberg'] == (
        f'blocked_missing_{manifest_list}'
    )
