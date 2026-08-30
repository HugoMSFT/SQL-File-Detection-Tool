"""Tests for the ``demo/`` sample fixtures and their generator.

These tests keep the committed samples honest: they must exist, they must
be analysable by the detector, they must map to the SQL types the README
advertises, and regenerating them must be idempotent.

Binary container formats embed writer metadata, so equality is asserted on
decoded content rather than on raw bytes.
"""

import importlib.util
import json
import os
import subprocess
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO_DIR = os.path.join(REPO_ROOT, 'demo')
sys.path.insert(0, REPO_ROOT)

from external_file_detection.file_detector import FileDetector  # noqa: E402
from external_file_detection.sql_generator import SQLGenerator  # noqa: E402


def _load_generator_module():
    spec = importlib.util.spec_from_file_location(
        'demo_generate_samples',
        os.path.join(DEMO_DIR, 'generate_samples.py'),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


generate_samples = _load_generator_module()


@pytest.fixture(scope='module')
def detector():
    return FileDetector()


# ---------------------------------------------------------------------------
# Presence
# ---------------------------------------------------------------------------

EXPECTED_SAMPLES = [
    'README.md',
    'generate_samples.py',
    'collation_samples.sql',
    'csv/sales_scalars.csv',
    'csv/sales_scalars.tsv',
    'csv/sales_scalars_pipe.csv',
    'json/orders_array.json',
    'json/orders.ndjson',
    'json/order_single_object.json',
    'parquet/all_types.parquet',
    'parquet/sales.parquet',
    'excel/inventory.xlsx',
    'text/readme_sample.txt',
    'tables/events_delta/_delta_log/00000000000000000000.json',
    'tables/events_iceberg/metadata/v1.metadata.json',
    'unicode/unicode_utf8.csv',
    'unicode/unicode_utf8_bom.csv',
    'unicode/unicode_utf16le_bom.csv',
    'unicode/unicode_utf16le_bom.tsv',
    'unicode/japanese_cp932.csv',
    'unicode/collation_cases_utf8.csv',
]


@pytest.mark.parametrize('relative_path', EXPECTED_SAMPLES)
def test_sample_is_committed(relative_path):
    path = os.path.join(DEMO_DIR, relative_path)
    assert os.path.exists(path), f'missing demo sample: {relative_path}'
    assert os.path.getsize(path) > 0


def test_no_sample_is_large():
    """Demo fixtures stay small enough to live in git comfortably."""
    for root, _dirs, files in os.walk(DEMO_DIR):
        for name in files:
            path = os.path.join(root, name)
            assert os.path.getsize(path) < 256 * 1024, path


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

ANALYSABLE = {
    'csv/sales_scalars.csv': 'csv',
    'csv/sales_scalars.tsv': 'csv',
    'csv/sales_scalars_pipe.csv': 'csv',
    'json/orders_array.json': 'json',
    'json/orders.ndjson': 'json',
    'json/order_single_object.json': 'json',
    'parquet/all_types.parquet': 'parquet',
    'parquet/sales.parquet': 'parquet',
    'excel/inventory.xlsx': 'excel',
    'tables/events_delta': 'delta',
    'tables/events_iceberg': 'iceberg',
    'unicode/unicode_utf8.csv': 'csv',
    'unicode/unicode_utf8_bom.csv': 'csv',
    'unicode/unicode_utf16le_bom.csv': 'csv',
    'unicode/unicode_utf16le_bom.tsv': 'csv',
    'unicode/japanese_cp932.csv': 'csv',
    'unicode/collation_cases_utf8.csv': 'csv',
}


@pytest.mark.parametrize('relative_path,expected_type',
                         sorted(ANALYSABLE.items()))
def test_sample_analyses_without_error(detector, relative_path,
                                       expected_type):
    metadata = detector.analyze_file_metadata(
        os.path.join(DEMO_DIR, relative_path))
    assert metadata.get('error') is None, metadata.get('error')
    assert metadata['file_type'] == expected_type
    assert metadata['schema'], relative_path
    assert metadata['column_count'] >= 1


def test_text_sample_analyses_without_error(detector):
    metadata = detector.analyze_file_metadata(
        os.path.join(DEMO_DIR, 'text', 'readme_sample.txt'))
    assert metadata.get('error') is None
    assert metadata['file_type'] == 'text'
    assert metadata['encoding'] == 'utf-8'
    assert metadata['codepage'] == '65001'
    assert metadata['row_count'] > 0


def test_scalar_csv_columns_and_delimiter(detector):
    metadata = detector.analyze_file_metadata(
        os.path.join(DEMO_DIR, 'csv', 'sales_scalars.csv'))
    assert metadata['delimiter'] == ','
    assert metadata['has_header'] is True
    assert metadata['row_count'] == 6
    names = [name for name, _ in metadata['schema']]
    assert names == generate_samples.SCALAR_HEADER


def test_scalar_tsv_delimiter_is_tab(detector):
    metadata = detector.analyze_file_metadata(
        os.path.join(DEMO_DIR, 'csv', 'sales_scalars.tsv'))
    assert metadata['delimiter'] == '\t'
    assert metadata['column_count'] == len(generate_samples.SCALAR_HEADER)


def test_ndjson_and_array_agree(detector):
    array_meta = detector.analyze_file_metadata(
        os.path.join(DEMO_DIR, 'json', 'orders_array.json'))
    ndjson_meta = detector.analyze_file_metadata(
        os.path.join(DEMO_DIR, 'json', 'orders.ndjson'))
    assert array_meta['row_count'] == ndjson_meta['row_count'] == 3
    assert ({n for n, _ in array_meta['schema']}
            == {n for n, _ in ndjson_meta['schema']})
    assert 'customer' in {n for n, _ in array_meta['schema']}


# ---------------------------------------------------------------------------
# Parquet -> SQL mapping
# ---------------------------------------------------------------------------

EXPECTED_SQL_TYPES = {
    'c_int8': 'SMALLINT',
    'c_int16': 'SMALLINT',
    'c_int32': 'INT',
    'c_int64': 'BIGINT',
    'c_uint8': 'TINYINT',
    'c_uint16': 'INT',
    'c_uint32': 'BIGINT',
    'c_uint64': 'DECIMAL(20,0)',
    'c_float32': 'FLOAT',
    'c_float64': 'FLOAT',
    'c_bool': 'BIT',
    'c_string': 'NVARCHAR(255)',
    'c_large_string': 'NVARCHAR(MAX)',
    'c_binary': 'VARBINARY(MAX)',
    'c_large_binary': 'VARBINARY(MAX)',
    'c_date32': 'DATE',
    'c_time32_ms': 'TIME(3)',
    'c_time64_us': 'TIME(6)',
    'c_timestamp_ms': 'DATETIME2(3)',
    'c_timestamp_us': 'DATETIME2(6)',
    'c_timestamp_ns': 'DATETIME2(7)',
    'c_timestamp_utc': 'DATETIMEOFFSET(6)',
    'c_decimal': 'DECIMAL(18,4)',
    'c_list_int32': 'NVARCHAR(MAX)',
    'c_struct': 'NVARCHAR(MAX)',
    'c_map': 'NVARCHAR(MAX)',
}


def test_all_types_parquet_covers_every_column(detector):
    metadata = detector.analyze_file_metadata(
        os.path.join(DEMO_DIR, 'parquet', 'all_types.parquet'))
    assert ({name for name, _ in metadata['schema']}
            == set(EXPECTED_SQL_TYPES))
    assert metadata['row_count'] == 4


def test_all_types_parquet_sql_type_mapping(detector):
    metadata = detector.analyze_file_metadata(
        os.path.join(DEMO_DIR, 'parquet', 'all_types.parquet'))
    generator = SQLGenerator()
    for column, arrow_type in metadata['schema']:
        assert generator._map_type_to_sql(arrow_type) == \
            EXPECTED_SQL_TYPES[column], (column, arrow_type)


def test_all_types_parquet_create_table_is_complete(detector):
    metadata = detector.analyze_file_metadata(
        os.path.join(DEMO_DIR, 'parquet', 'all_types.parquet'))
    ddl = SQLGenerator().generate_create_table(metadata, 'all_types')
    for column, sql_type in EXPECTED_SQL_TYPES.items():
        assert f'[{column}] {sql_type}' in ddl, column


# ---------------------------------------------------------------------------
# Table format recognition
# ---------------------------------------------------------------------------

def test_delta_table_is_recognised(detector):
    path = os.path.join(DEMO_DIR, 'tables', 'events_delta')
    assert detector.is_delta_table_directory(path)
    assert detector.detect_file_type(path) == 'delta'

    metadata = detector.analyze_file_metadata(path)
    names = [name for name, _ in metadata['schema']]
    assert names == ['event_id', 'event_name', 'event_value', 'is_test',
                     'event_date']


def test_delta_log_is_valid_json_lines():
    log = os.path.join(DEMO_DIR, 'tables', 'events_delta', '_delta_log',
                       '00000000000000000000.json')
    with open(log, encoding='utf-8') as handle:
        actions = [json.loads(line) for line in handle if line.strip()]
    kinds = {key for action in actions for key in action}
    assert {'protocol', 'metaData', 'add', 'commitInfo'} <= kinds


def test_iceberg_table_is_recognised(detector):
    path = os.path.join(DEMO_DIR, 'tables', 'events_iceberg')
    assert detector.is_iceberg_table_directory(path)
    assert detector.detect_file_type(path) == 'iceberg'

    metadata = detector.analyze_file_metadata(path)
    names = [name for name, _ in metadata['schema']]
    assert names == ['event_id', 'event_name', 'event_value', 'is_test',
                     'event_ts', 'amount']
    assert metadata['row_count'] == 3


def test_iceberg_decimal_precision_survives(detector):
    metadata = detector.analyze_file_metadata(
        os.path.join(DEMO_DIR, 'tables', 'events_iceberg'))
    types = dict(metadata['schema'])
    assert SQLGenerator()._map_type_to_sql(types['amount']) == 'DECIMAL(12,2)'


def test_orc_sample_analyses_when_present(detector):
    path = os.path.join(DEMO_DIR, 'orc', 'all_types.orc')
    if not os.path.exists(path):
        pytest.skip('pyarrow on this host cannot write ORC')
    metadata = detector.analyze_file_metadata(path)
    assert metadata.get('error') is None
    assert metadata['file_type'] == 'orc'
    assert metadata['row_count'] == 4
    assert 'c_string' in {name for name, _ in metadata['schema']}


# ---------------------------------------------------------------------------
# Encoding fixtures
# ---------------------------------------------------------------------------

def _decoded_rows(path, encoding, delimiter=','):
    import csv
    with open(path, encoding=encoding, newline='') as handle:
        return list(csv.reader(handle, delimiter=delimiter))


def test_utf8_sample_has_no_bom():
    path = os.path.join(DEMO_DIR, 'unicode', 'unicode_utf8.csv')
    with open(path, 'rb') as handle:
        assert handle.read(3) != b'\xef\xbb\xbf'


def test_utf8_bom_sample_has_bom():
    path = os.path.join(DEMO_DIR, 'unicode', 'unicode_utf8_bom.csv')
    with open(path, 'rb') as handle:
        assert handle.read(3) == b'\xef\xbb\xbf'


def test_utf16le_sample_has_bom():
    for name in ('unicode_utf16le_bom.csv', 'unicode_utf16le_bom.tsv'):
        with open(os.path.join(DEMO_DIR, 'unicode', name), 'rb') as handle:
            assert handle.read(2) == b'\xff\xfe', name


@pytest.mark.parametrize('name,encoding,delimiter', [
    ('unicode_utf8.csv', 'utf-8', ','),
    ('unicode_utf8_bom.csv', 'utf-8-sig', ','),
    ('unicode_utf16le_bom.csv', 'utf-16', ','),
    ('unicode_utf16le_bom.tsv', 'utf-16', '\t'),
])
def test_unicode_variants_decode_to_the_same_values(name, encoding,
                                                    delimiter):
    rows = _decoded_rows(os.path.join(DEMO_DIR, 'unicode', name), encoding,
                         delimiter)
    assert rows[0] == generate_samples.UNICODE_HEADER
    assert len(rows) == 1 + len(generate_samples.UNICODE_ROWS)

    by_script = {row[1]: row[2] for row in rows[1:]}
    assert by_script['Japanese-hiragana'] == 'ひらがな'
    assert by_script['Japanese-katakana'] == 'カタカナ'
    assert by_script['Japanese-halfwidth'] == 'ｶﾀｶﾅ'
    assert by_script['Korean'] == '한국어 문자열'
    assert by_script['Cyrillic'] == 'Привет, мир'
    assert by_script['Latin-composed'] == 'caf\u00e9'
    assert by_script['Latin-decomposed'] == 'cafe\u0301'
    assert by_script['Multiline'] == 'line one\nline two'
    assert by_script['Quoted'] == 'He said "hello", then left'
    # Supplementary-plane characters survive the UTF-16 round trip.
    assert '\U0001F600' in by_script['Emoji-supplementary']
    assert '\u200d' in by_script['Emoji-ZWJ']


def test_composed_and_decomposed_forms_are_byte_distinct():
    rows = _decoded_rows(
        os.path.join(DEMO_DIR, 'unicode', 'unicode_utf8.csv'), 'utf-8')
    values = {row[1]: row[2] for row in rows[1:]}
    composed = values['Latin-composed']
    decomposed = values['Latin-decomposed']
    assert composed != decomposed
    assert len(composed) == 4 and len(decomposed) == 5


def test_cp932_sample_decodes_and_maps_to_codepage_932(detector):
    path = os.path.join(DEMO_DIR, 'unicode', 'japanese_cp932.csv')
    rows = _decoded_rows(path, 'cp932')
    assert rows[0] == ['row_id', 'kana_type', 'sample_text', 'note']
    assert rows[1][2] == '日本語'
    assert rows[4][2] == 'ｶﾀｶﾅ'

    metadata = detector.analyze_file_metadata(path)
    assert metadata['codepage'] == '932'


@pytest.mark.parametrize('encoding,expected', [
    ('cp932', '932'),
    ('shift_jis', '932'),
    ('utf-8', '65001'),
    ('utf-8-sig', '65001'),
    ('utf-16-le', '1200'),
    ('utf-16-be', '1201'),
])
def test_codepage_mapping(detector, encoding, expected):
    assert detector.encoding_to_codepage(encoding) == expected


# ---------------------------------------------------------------------------
# Collation demo
# ---------------------------------------------------------------------------

def test_collation_csv_contains_expected_pairs():
    rows = _decoded_rows(
        os.path.join(DEMO_DIR, 'unicode', 'collation_cases_utf8.csv'),
        'utf-8')
    assert rows[0] == generate_samples.COLLATION_HEADER
    categories = {row[1] for row in rows[1:]}
    assert {'kana_type', 'kana_width', 'latin_width', 'case', 'sharp_s',
            'accent', 'unicode_form', 'turkish_i', 'turkish_dotted',
            'trailing_space'} <= categories


def _collation_script():
    with open(os.path.join(DEMO_DIR, 'collation_samples.sql'),
              encoding='utf-8') as handle:
        return handle.read()


def test_collation_script_is_non_destructive():
    script = _collation_script()
    upper = script.upper()
    for forbidden in ('DROP DATABASE', 'ALTER DATABASE', 'TRUNCATE TABLE',
                      'DELETE FROM', 'UPDATE ', 'DROP LOGIN', 'SHUTDOWN'):
        assert forbidden not in upper, forbidden
    # The only DROP statements target the temp table.
    for line in script.splitlines():
        if 'DROP TABLE' in line.upper():
            assert '#collation_demo' in line


def test_collation_script_checks_collation_availability():
    script = _collation_script()
    assert 'sys.fn_helpcollations()' in script
    for collation in generate_samples.DEMO_COLLATIONS:
        assert collation in script, collation


def test_collation_script_uses_unicode_literals():
    script = _collation_script()
    assert 'NVARCHAR(200)' in script
    assert "N'ひらがな'" in script
    assert "N'ｶﾀｶﾅ'" in script
    # Every inserted literal is N-prefixed: each literal contributes one
    # "N'" and exactly two single quotes.
    for line in script.splitlines():
        stripped = line.strip()
        if stripped.startswith('(') and stripped.endswith(('),', ');')):
            assert stripped.count("'") == 2 * stripped.count("N'"), stripped


def test_collation_script_is_regenerated_deterministically():
    assert generate_samples.build_collation_script() == _collation_script()


# ---------------------------------------------------------------------------
# Generator idempotence
# ---------------------------------------------------------------------------

TEXT_SAMPLES = [
    'collation_samples.sql',
    'csv/sales_scalars.csv',
    'csv/sales_scalars.tsv',
    'csv/sales_scalars_pipe.csv',
    'json/orders_array.json',
    'json/orders.ndjson',
    'json/order_single_object.json',
    'text/readme_sample.txt',
    'tables/events_delta/_delta_log/00000000000000000000.json',
    'tables/events_iceberg/metadata/v1.metadata.json',
    'unicode/unicode_utf8.csv',
    'unicode/unicode_utf8_bom.csv',
    'unicode/unicode_utf16le_bom.csv',
    'unicode/unicode_utf16le_bom.tsv',
    'unicode/japanese_cp932.csv',
    'unicode/collation_cases_utf8.csv',
]


def _read_bytes(path):
    with open(path, 'rb') as handle:
        return handle.read()


def test_generator_is_idempotent_for_text_samples(tmp_path):
    first_dir = tmp_path / 'first'
    second_dir = tmp_path / 'second'
    generate_samples.generate_all(str(first_dir))
    generate_samples.generate_all(str(second_dir))

    # Running twice into the same directory must also be stable.
    generate_samples.generate_all(str(first_dir))

    for relative in TEXT_SAMPLES:
        left = first_dir / relative
        right = second_dir / relative
        assert left.exists(), relative
        assert _read_bytes(str(left)) == _read_bytes(str(right)), relative


def test_generator_output_matches_committed_text_samples(tmp_path):
    fresh = tmp_path / 'fresh'
    generate_samples.generate_all(str(fresh))
    for relative in TEXT_SAMPLES:
        assert _read_bytes(str(fresh / relative)) == \
            _read_bytes(os.path.join(DEMO_DIR, relative)), relative


def test_generator_binary_samples_are_content_stable(tmp_path):
    """Parquet/ORC/XLSX embed writer metadata; compare decoded content."""
    import pyarrow.parquet as pq

    fresh = tmp_path / 'fresh'
    generate_samples.generate_all(str(fresh))

    for relative in ('parquet/all_types.parquet', 'parquet/sales.parquet',
                     'tables/events_delta/part-00000-demo-c000.snappy.parquet',
                     'tables/events_iceberg/data/00000-0-demo.parquet'):
        committed = pq.read_table(os.path.join(DEMO_DIR, relative))
        regenerated = pq.read_table(str(fresh / relative))
        assert committed.equals(regenerated), relative

    import pandas as pd
    committed_xlsx = pd.read_excel(
        os.path.join(DEMO_DIR, 'excel', 'inventory.xlsx'))
    regenerated_xlsx = pd.read_excel(str(fresh / 'excel' / 'inventory.xlsx'))
    assert list(committed_xlsx.columns) == list(regenerated_xlsx.columns)
    assert committed_xlsx.shape == regenerated_xlsx.shape


def test_xlsx_zip_container_is_normalised(tmp_path):
    """The workbook is rewritten with pinned timestamps, so it is stable.

    openpyxl otherwise stamps every zip entry and ``dcterms:modified`` with
    the current time, which would make the committed workbook dirty after
    every regeneration.
    """
    import zipfile

    first = tmp_path / 'first'
    second = tmp_path / 'second'
    generate_samples.generate_all(str(first))
    generate_samples.generate_all(str(second))

    left = first / 'excel' / 'inventory.xlsx'
    right = second / 'excel' / 'inventory.xlsx'
    assert _read_bytes(str(left)) == _read_bytes(str(right))

    with zipfile.ZipFile(str(left)) as archive:
        stamps = {item.date_time for item in archive.infolist()}
        core = archive.read('docProps/core.xml').decode('utf-8')
    assert len(stamps) == 1, 'zip entries must share one pinned timestamp'
    assert '2024-01-15T08:30:00Z' in core


def test_generator_runs_as_a_script(tmp_path):
    output = tmp_path / 'cli'
    completed = subprocess.run(
        [sys.executable, os.path.join(DEMO_DIR, 'generate_samples.py'),
         '--output-dir', str(output), '--quiet'],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    assert completed.returncode == 0, completed.stderr
    assert (output / 'csv' / 'sales_scalars.csv').exists()


# ---------------------------------------------------------------------------
# README accuracy
# ---------------------------------------------------------------------------

def test_readme_lists_every_sample():
    with open(os.path.join(DEMO_DIR, 'README.md'), encoding='utf-8') as fh:
        readme = fh.read()
    for relative in EXPECTED_SAMPLES:
        if relative in ('README.md',):
            continue
        assert os.path.basename(relative) in readme, relative


def test_readme_explains_encoding_versus_collation():
    with open(os.path.join(DEMO_DIR, 'README.md'), encoding='utf-8') as fh:
        readme = fh.read()
    assert 'never carries a collation' in readme
    assert 'recognition-only' in readme
    assert 'BLOB_STORAGE' in readme
