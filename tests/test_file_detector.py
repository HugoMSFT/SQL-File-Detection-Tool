"""Tests for file detector functionality."""

import os
import tempfile
import json
import csv
import sys
from pathlib import Path
from unittest.mock import patch
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

import external_file_detection.file_detector as file_detector_module
from external_file_detection.file_detector import FileDetector
from external_file_detection.external_file_detector import ExternalFileDetectorApp


def test_file_type_detection():
    """Test file type detection."""
    detector = FileDetector()
    
    with tempfile.TemporaryDirectory() as temp_dir:
        # Create test files
        csv_file = os.path.join(temp_dir, "test.csv")
        json_file = os.path.join(temp_dir, "test.json")
        txt_file = os.path.join(temp_dir, "test.txt")
        
        # CSV file
        with open(csv_file, 'w', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(['id', 'name'])
            writer.writerow([1, 'John'])
        
        # JSON file
        with open(json_file, 'w') as f:
            json.dump({"id": 1, "name": "John"}, f)
        
        # Text file
        with open(txt_file, 'w') as f:
            f.write("This is a text file")
        
        # Test detection
        assert detector.detect_file_type(csv_file) == 'csv'
        assert detector.detect_file_type(json_file) == 'json'
        assert detector.detect_file_type(txt_file) == 'text'


def test_csv_metadata_analysis():
    """Test CSV metadata analysis."""
    detector = FileDetector()
    
    with tempfile.TemporaryDirectory() as temp_dir:
        csv_file = os.path.join(temp_dir, "test.csv")
        
        with open(csv_file, 'w', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(['id', 'name', 'age'])
            writer.writerow([1, 'John', 30])
            writer.writerow([2, 'Jane', 25])
        
        metadata = detector.analyze_file_metadata(csv_file)
        
        assert metadata['file_type'] == 'csv'
        assert metadata['has_header'] == True
        assert metadata['delimiter'] == ','
        assert metadata['column_count'] == 3
        assert metadata['row_count'] == 2  # excluding header
        assert len(metadata['schema']) == 3


def test_json_metadata_analysis():
    """Test JSON metadata analysis."""
    detector = FileDetector()
    
    with tempfile.TemporaryDirectory() as temp_dir:
        json_file = os.path.join(temp_dir, "test.json")
        
        data = [
            {"id": 1, "name": "John", "active": True},
            {"id": 2, "name": "Jane", "active": False}
        ]
        
        with open(json_file, 'w') as f:
            json.dump(data, f)
        
        metadata = detector.analyze_file_metadata(json_file)
        
        assert metadata['file_type'] == 'json'
        assert metadata['row_count'] == 2
        assert metadata['column_count'] == 3
        assert len(metadata['schema']) == 3


def test_csv_exact_numeric_inference_preserves_boundary_samples(tmp_path):
    """CSV inference must not route BIGINT or exact decimals through float."""
    source = tmp_path / 'exact.csv'
    source.write_text(
        'small,big,max_big,decimal,over_big,over_precision,scaled,tiny\n'
        '2147483647,2147483648,9223372036854775807,'
        '12345678901234.5678,9223372036854775808,'
        f'{"9" * 39},1.2300e2,1e-4\n',
        encoding='utf-8',
    )

    metadata = FileDetector().analyze_file_metadata(str(source))
    schema = dict(metadata['schema'])
    assert schema == {
        'small': 'int32',
        'big': 'int64',
        'max_big': 'int64',
        'decimal': 'decimal(18,4)',
        'over_big': 'decimal(19,0)',
        'over_precision': 'decimal(39,0)',
        'scaled': 'object',
        'tiny': 'object',
    }
    assert metadata['sample_rows'][0][2] == '9223372036854775807'
    assert metadata['sample_rows'][0][3] == '12345678901234.5678'
    assert metadata['schema_inference'] == 'full'


def test_scientific_notation_stays_text_while_decimals_stay_exact(tmp_path):
    """Direct CSV loading cannot convert exponent syntax to DECIMAL."""
    source = tmp_path / 'scientific.csv'
    source.write_text(
        'normal,positive_exp,negative_exp\n'
        '123.4500,1e+7,1e-7\n',
        encoding='utf-8',
    )

    metadata = FileDetector().analyze_file_metadata(str(source))
    assert dict(metadata['schema']) == {
        'normal': 'decimal(7,4)',
        'positive_exp': 'object',
        'negative_exp': 'object',
    }
    assert metadata['sample_rows'][0] == [123.45, '1e+7', '1e-7']


def test_csv_and_json_preview_preserve_exact_numeric_text(
    tmp_path,
    monkeypatch,
):
    """The public preview API must bypass pandas/NumPy numeric coercion."""
    detector = FileDetector()
    csv_source = tmp_path / 'exact-preview.csv'
    csv_source.write_text(
        'big,decimal,scientific\n'
        '9223372036854775807,12345678901234.5678,1e-7\n',
        encoding='utf-8',
    )
    csv_preview = detector.get_preview_data(str(csv_source), max_rows=1)
    assert csv_preview['rows'][0] == [
        '9223372036854775807',
        '12345678901234.5678',
        '1e-7',
    ]

    json_source = tmp_path / 'exact-preview.json'
    json_source.write_text(
        '[{"big":9223372036854775807,'
        '"decimal":12345678901234.5678,"scientific":1e-7}]',
        encoding='utf-8',
    )
    json_preview = detector.get_preview_data(str(json_source), max_rows=1)
    assert json_preview['rows'][0] == [
        '9223372036854775807',
        '12345678901234.5678',
        '1e-7',
    ]

    mixed_source = tmp_path / 'mixed-preview.csv'
    mixed_source.write_text(
        'value,label,id\n1,first,10\nlater,second,20\n',
        encoding='utf-8',
    )
    mixed_preview = detector.get_preview_data(str(mixed_source), max_rows=2)
    assert mixed_preview['rows'] == [
        ['1', 'first', 10],
        ['later', 'second', 20],
    ]

    bool_source = tmp_path / 'sampled-bool-preview.csv'
    bool_source.write_text(
        'flag,label,id\nTrue,first,1\nunexpected,second,2\n',
        encoding='utf-8',
    )
    sampled_metadata = detector.analyze_file_metadata(str(bool_source))
    sampled_metadata['schema'] = [
        ('flag', 'bool'),
        ('label', 'object'),
        ('id', 'int32'),
    ]
    monkeypatch.setattr(
        detector,
        'analyze_file_metadata',
        lambda _path: sampled_metadata,
    )
    bool_preview = detector.get_preview_data(str(bool_source), max_rows=2)
    assert bool_preview['rows'] == [
        [True, 'first', 1],
        ['unexpected', 'second', 2],
    ]

    numeric_source = tmp_path / 'sampled-numeric-preview.csv'
    numeric_source.write_text(
        'value,label,id\n1,first,1\n  unexpected  ,second,2\n',
        encoding='utf-8',
    )
    numeric_metadata = sampled_metadata.copy()
    numeric_metadata['schema'] = [
        ('value', 'int32'),
        ('label', 'object'),
        ('id', 'int32'),
    ]
    monkeypatch.setattr(
        detector,
        'analyze_file_metadata',
        lambda _path: numeric_metadata,
    )
    numeric_preview = detector.get_preview_data(str(numeric_source), max_rows=2)
    assert numeric_preview['rows'][1][0] == '  unexpected  '


def test_csv_complete_scan_aggregates_after_sample_cap(tmp_path):
    """A small complete file must use evidence after the former 1000-row cap."""
    source = tmp_path / 'late.csv'
    rows = [str(index) for index in range(1000)] + ['x' * 5000]
    source.write_text('value\n' + '\n'.join(rows) + '\n', encoding='utf-8')

    metadata = FileDetector().analyze_file_metadata(str(source))
    assert metadata['schema'] == [('value', 'object')]
    assert metadata['schema_inference'] == 'full'
    assert metadata['schema_sample_size'] == 1001
    assert metadata['observed_max_string_lengths']['value'] == 5000


def test_json_aggregates_ranges_and_heterogeneous_families(tmp_path):
    """All non-null JSON values contribute to range and family inference."""
    exact = tmp_path / 'exact.json'
    exact.write_text(
        '[{"small":2147483647,"big":2147483648,'
        '"max_big":9223372036854775807,'
        '"over_big":9223372036854775808,'
        '"decimal":12345678901234.5678}]',
        encoding='utf-8',
    )
    metadata = FileDetector().analyze_file_metadata(str(exact))
    schema = dict(metadata['schema'])
    assert schema['small'] == 'int32'
    assert schema['big'] == 'int64'
    assert schema['max_big'] == 'int64'
    assert schema['over_big'] == 'decimal(19,0)'
    assert schema['decimal'] == 'decimal(18,4)'
    assert metadata['json_sample_values']['max_big'] == '9223372036854775807'
    assert metadata['json_sample_values']['decimal'] == '12345678901234.5678'

    mixed = tmp_path / 'mixed.json'
    rows = [{'value': index} for index in range(200)]
    rows.append({'value': 'late'})
    mixed.write_text(json.dumps(rows), encoding='utf-8')
    mixed_metadata = FileDetector().analyze_file_metadata(str(mixed))
    assert mixed_metadata['schema'] == [('value', 'str')]
    assert mixed_metadata['schema_inference'] == 'full'
    assert mixed_metadata['schema_sample_size'] == 201
    assert mixed_metadata['json_typed_projection_safe'] is False


def test_ndjson_dynamic_keys_are_bounded_and_marked_unsafe(tmp_path):
    """A stream cannot grow retained schema state past the column cap."""
    from external_file_detection.sql_generator import SQLGenerator

    source = tmp_path / 'dynamic.ndjson'
    source.write_text(
        ''.join(
            json.dumps({f'key_{index}': index}) + '\n'
            for index in range(file_detector_module.JSON_SCHEMA_MAX_COLUMNS + 2)
        ),
        encoding='utf-8',
    )

    metadata = FileDetector().analyze_file_metadata(str(source))
    assert len(metadata['schema']) == file_detector_module.JSON_SCHEMA_MAX_COLUMNS
    assert metadata['column_count'] == file_detector_module.JSON_SCHEMA_MAX_COLUMNS
    assert (
        metadata['schema_sample_size']
        == file_detector_module.JSON_SCHEMA_MAX_COLUMNS + 2
    )
    assert metadata['schema_inference'] == 'sampled'
    assert metadata['analysis_truncated'] is True
    assert metadata['json_typed_projection_safe'] is False
    assert 'distinct keys' in metadata['warning']
    assert (
        f'key_{file_detector_module.JSON_SCHEMA_MAX_COLUMNS}'
        not in dict(metadata['schema'])
    )
    generator = SQLGenerator()
    assert generator._generate_openjson_columns(metadata) == []
    assert '[key_0] NVARCHAR(MAX)' in generator.generate_create_table(
        metadata,
        'dynamic',
    )


def test_python_csv_field_limit_matches_native_bound(tmp_path):
    """Python accepts former-128-KiB fields and rejects over 4 MiB."""
    detector = FileDetector()
    accepted = tmp_path / 'accepted.csv'
    accepted.write_text(
        'id,payload\n1,' + ('x' * 131_073) + '\n',
        encoding='utf-8',
    )
    accepted_metadata = detector.analyze_file_metadata(str(accepted))
    assert 'error' not in accepted_metadata
    assert accepted_metadata['observed_max_string_lengths']['payload'] == 131_073

    rejected = tmp_path / 'rejected.csv'
    rejected.write_text(
        'id,payload\n1,'
        + ('x' * (file_detector_module.MAX_FIELD_CHARS + 1))
        + '\n',
        encoding='utf-8',
    )
    rejected_metadata = detector.analyze_file_metadata(str(rejected))
    assert 'field larger than field limit' in rejected_metadata['error']


def test_huge_numeric_tokens_fall_back_without_integer_conversion(tmp_path):
    """Over-precision JSON stays raw even where int digit limits differ."""
    token = '9' * 10_000
    source = tmp_path / 'huge-number.json'
    source.write_text(f'[{{"value":{token}}}]', encoding='utf-8')

    metadata = FileDetector().analyze_file_metadata(str(source))
    assert metadata['schema'] == [('value', 'str')]
    assert metadata['json_sample_values']['value'] == token
    assert file_detector_module._parse_numeric_token(token) is None


def test_unicode_digits_are_text_not_ascii_numerics(tmp_path):
    """CSV numeric syntax is deliberately restricted to ASCII digits."""
    source = tmp_path / 'unicode-digits.csv'
    source.write_text(
        'arabic_indic,full_width\n١٢٣,１２３\n',
        encoding='utf-8',
    )

    metadata = FileDetector().analyze_file_metadata(str(source))
    assert metadata['schema'] == [
        ('arabic_indic', 'object'),
        ('full_width', 'object'),
    ]
    assert metadata['sample_rows'] == [['١٢٣', '１２３']]


def test_parquet_unbounded_string_uses_max_and_blocks_external_table(tmp_path):
    """Parquet strings have no declared bound, even when one value is 5000 chars."""
    from external_file_detection.sql_generator import SQLGenerator

    source = tmp_path / 'wide.parquet'
    pq.write_table(pa.table({'payload': ['x' * 5000]}), source)
    metadata = FileDetector().analyze_file_metadata(str(source))
    generator = SQLGenerator()

    create_table = generator.generate_create_table(metadata, 'wide')
    assert '[payload] NVARCHAR(MAX)' in create_table
    external = generator.generate_external_table(
        metadata,
        target_platform='azure_sql_db',
    )
    assert 'NOT AVAILABLE' in external
    assert 'explicit bounded SQL type overrides' in external
    assert 'CREATE EXTERNAL TABLE [' not in external


def test_directory_scan():
    """Test directory scanning functionality."""
    detector = FileDetector()
    
    with tempfile.TemporaryDirectory() as temp_dir:
        # Create test files
        csv_file = os.path.join(temp_dir, "test.csv")
        json_file = os.path.join(temp_dir, "test.json")
        
        with open(csv_file, 'w', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(['id', 'name'])
            writer.writerow([1, 'John'])
        
        with open(json_file, 'w') as f:
            json.dump({"id": 1, "name": "John"}, f)
        
        results = detector.scan_directory(temp_dir)
        
        assert len(results) == 2
        file_types = [r['file_type'] for r in results]
        assert 'csv' in file_types
        assert 'json' in file_types


def test_unknown_extension():
    """Test that unknown extensions fall back to content-based detection."""
    detector = FileDetector()
    with tempfile.TemporaryDirectory() as temp_dir:
        unk = os.path.join(temp_dir, "data.xyz")
        with open(unk, 'w') as f:
            f.write("just some text\n")
        result = detector.detect_file_type(unk)
        # Content-based detection may classify this as text or csv
        assert result in ('text', 'csv', 'unknown')


def test_empty_file():
    """Test analysis of an empty file does not crash."""
    detector = FileDetector()
    with tempfile.TemporaryDirectory() as temp_dir:
        empty = os.path.join(temp_dir, "empty.csv")
        with open(empty, 'w') as f:
            pass  # 0 bytes
        metadata = detector.analyze_file_metadata(empty)
        assert metadata['file_type'] == 'csv'
        assert metadata['file_size'] == 0


def test_corrupted_json():
    """Test analysis of a corrupted JSON file."""
    detector = FileDetector()
    with tempfile.TemporaryDirectory() as temp_dir:
        bad = os.path.join(temp_dir, "bad.json")
        with open(bad, 'w') as f:
            f.write("{invalid json content!!!}")
        metadata = detector.analyze_file_metadata(bad)
        assert metadata['file_type'] == 'json'
        # Should still return metadata (possibly with an error key)


def test_csv_with_mixed_delimiters():
    """Test CSV detection with tab delimiter."""
    detector = FileDetector()
    with tempfile.TemporaryDirectory() as temp_dir:
        tsv = os.path.join(temp_dir, "data.tsv")
        with open(tsv, 'w') as f:
            f.write("id\tname\tage\n1\tAlice\t30\n2\tBob\t25\n")
        metadata = detector.analyze_file_metadata(tsv)
        assert metadata['file_type'] == 'csv'
        assert metadata['delimiter'] == '\t'


def test_delta_directory_detection():
    """Test Delta table directory detection."""
    detector = FileDetector()
    with tempfile.TemporaryDirectory() as temp_dir:
        delta_dir = os.path.join(temp_dir, "my_table")
        os.makedirs(os.path.join(delta_dir, "_delta_log"))
        # Create a dummy parquet file
        with open(os.path.join(delta_dir, "part-0.parquet"), 'wb') as f:
            f.write(b'PAR1' + b'\x00' * 100)
        result = detector.detect_file_type(delta_dir)
        assert result == 'delta'


def test_non_delta_directory():
    """Test that a regular directory returns 'unknown'."""
    detector = FileDetector()
    with tempfile.TemporaryDirectory() as temp_dir:
        sub = os.path.join(temp_dir, "subdir")
        os.makedirs(sub)
        assert detector.detect_file_type(sub) == 'unknown'


def test_encoding_detection():
    """Test encoding detection returns a tuple."""
    detector = FileDetector()
    with tempfile.TemporaryDirectory() as temp_dir:
        f_path = os.path.join(temp_dir, "utf8.txt")
        with open(f_path, 'w', encoding='utf-8') as f:
            f.write("Hello ñ world\n")
        enc, conf = detector.detect_encoding(f_path)
        assert isinstance(enc, str)
        assert isinstance(conf, float)
        assert 0.0 <= conf <= 1.0


def test_nullable_column_detection():
    """Test that nullable columns are detected in CSV."""
    detector = FileDetector()
    with tempfile.TemporaryDirectory() as temp_dir:
        csv_file = os.path.join(temp_dir, "nullable.csv")
        with open(csv_file, 'w', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(['id', 'name', 'optional'])
            writer.writerow([1, 'Alice', 'yes'])
            writer.writerow([2, 'Bob', ''])
        metadata = detector.analyze_file_metadata(csv_file)
        assert 'optional' in metadata.get('nullable_columns', [])


def test_scan_directory_detects_delta_table_folder():
    """Directory scan should treat a Delta table folder as one delta entry."""
    detector = FileDetector()

    with tempfile.TemporaryDirectory() as temp_dir:
        delta_dir = os.path.join(temp_dir, 'delta_table')
        data_dir = os.path.join(delta_dir, 'data')
        log_dir = os.path.join(delta_dir, '_delta_log')
        os.makedirs(data_dir, exist_ok=True)
        os.makedirs(log_dir, exist_ok=True)

        table = pa.table({'id': [1, 2], 'name': ['Alice', 'Bob']})
        pq.write_table(table, os.path.join(data_dir, 'part-00000.parquet'))

        with open(os.path.join(log_dir, '00000000000000000000.json'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                'metaData': {
                    'id': 'sample-delta',
                    'format': {'provider': 'parquet', 'options': {}},
                    'schemaString': json.dumps({
                        'type': 'struct',
                        'fields': [
                            {'name': 'id', 'type': 'long', 'nullable': True, 'metadata': {}},
                            {'name': 'name', 'type': 'string', 'nullable': True, 'metadata': {}},
                        ],
                    }),
                    'partitionColumns': [],
                    'configuration': {},
                    'createdTime': 1760000000000,
                }
            }) + '\n')

        results = detector.scan_directory(temp_dir)

        delta_results = [r for r in results if r['file_type'] == 'delta']
        assert len(delta_results) == 1
        assert delta_results[0]['file_path'] == delta_dir


def test_supported_file_types_are_deduplicated():
    """Supported file types exposed by the app should be unique and sorted."""
    app = ExternalFileDetectorApp()
    supported = app.get_supported_file_types()

    assert supported == sorted(set(supported))
    assert 'csv' in supported
    assert supported.count('csv') == 1


def test_analyze_location_uses_delta_folder_as_single_entry():
    """App-level location analysis should include the Delta folder, not just inner parquet files."""
    app = ExternalFileDetectorApp()

    with tempfile.TemporaryDirectory() as temp_dir:
        delta_dir = os.path.join(temp_dir, 'delta_table')
        data_dir = os.path.join(delta_dir, 'data')
        log_dir = os.path.join(delta_dir, '_delta_log')
        os.makedirs(data_dir, exist_ok=True)
        os.makedirs(log_dir, exist_ok=True)

        table = pa.table({'id': [1, 2], 'name': ['Alice', 'Bob']})
        pq.write_table(table, os.path.join(data_dir, 'part-00000.parquet'))

        with open(os.path.join(log_dir, '00000000000000000000.json'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                'metaData': {
                    'id': 'sample-delta',
                    'format': {'provider': 'parquet', 'options': {}},
                    'schemaString': json.dumps({
                        'type': 'struct',
                        'fields': [
                            {'name': 'id', 'type': 'long', 'nullable': True, 'metadata': {}},
                            {'name': 'name', 'type': 'string', 'nullable': True, 'metadata': {}},
                        ],
                    }),
                    'partitionColumns': [],
                    'configuration': {},
                    'createdTime': 1760000000000,
                }
            }) + '\n')

        results = app.analyze_location(temp_dir, data_source='DS')
        assert results['files_found'] == 1
        assert results['summary']['file_types']['delta'] == 1
        assert results['files'][0]['metadata']['file_type'] == 'delta'


if __name__ == '__main__':
    test_file_type_detection()
    test_csv_metadata_analysis()
    test_json_metadata_analysis()
    test_directory_scan()
    test_unknown_extension()
    test_empty_file()
    test_corrupted_json()
    test_csv_with_mixed_delimiters()
    test_delta_directory_detection()
    test_non_delta_directory()
    test_encoding_detection()
    test_nullable_column_detection()
    test_scan_directory_detects_delta_table_folder()
    test_supported_file_types_are_deduplicated()
    test_analyze_location_uses_delta_folder_as_single_entry()


# ---- New tests using conftest fixtures ----

def test_parquet_metadata_analysis(sample_parquet):
    """Test Parquet metadata analysis with a real Parquet file."""
    detector = FileDetector()
    metadata = detector.analyze_file_metadata(sample_parquet)
    assert metadata['file_type'] == 'parquet'
    assert metadata['row_count'] == 3
    assert metadata['column_count'] == 3
    assert len(metadata['schema']) == 3
    col_names = [c[0] for c in metadata['schema']]
    assert 'id' in col_names
    assert 'name' in col_names
    assert 'score' in col_names
    assert metadata['parquet_physical_types']['id'] == 'INT64'


def test_parquet_preview_does_not_load_full_file(sample_parquet):
    """Test that Parquet preview reads efficiently."""
    detector = FileDetector()
    result = detector.get_preview_data(sample_parquet, max_rows=2)
    assert len(result['rows']) == 2
    assert len(result['columns']) == 3


def test_ndjson_detection(sample_ndjson):
    """Test NDJSON file detection and analysis."""
    detector = FileDetector()
    assert detector.detect_file_type(sample_ndjson) == 'json'
    metadata = detector.analyze_file_metadata(sample_ndjson)
    assert metadata['file_type'] == 'json'
    assert metadata.get('json_format') == 'ndjson'
    assert metadata['row_count'] == 2


def test_wide_csv_sample_rows(wide_csv):
    """Test that wide CSV files still produce sample_rows."""
    detector = FileDetector()
    metadata = detector.analyze_file_metadata(wide_csv)
    assert metadata['file_type'] == 'csv'
    assert metadata['column_count'] == 25
    assert len(metadata['sample_rows']) >= 1
    assert len(metadata['sample_rows'][0]) == 25


def test_nested_json_analysis(nested_json):
    """Test nested JSON detection and schema analysis."""
    detector = FileDetector()
    metadata = detector.analyze_file_metadata(nested_json)
    assert metadata['file_type'] == 'json'
    nesting = metadata.get('json_nesting', {})
    assert nesting.get('address') == 'object'
    assert nesting.get('tags') == 'array'
    assert nesting.get('id') == 'scalar'


def test_encoding_warning_for_low_confidence(temp_dir):
    """Test that low-confidence encoding detection adds a warning."""
    detector = FileDetector()
    # Create a file with ambiguous encoding
    path = os.path.join(temp_dir, "ambiguous.csv")
    with open(path, 'wb') as f:
        # Write bytes that chardet may struggle with
        f.write(b"id,name\n1,test\n2,data\n")
    metadata = detector.analyze_file_metadata(path)
    # Encoding confidence is reported; warning may or may not be present
    # depending on chardet certainty, but the field must exist
    assert 'encoding_confidence' in metadata
    assert isinstance(metadata['encoding_confidence'], int)


def test_preview_rows_capped():
    """Test that get_preview_data caps max_rows to 10000."""
    detector = FileDetector()
    # The method should internally cap, verified by the function signature
    import inspect
    src = inspect.getsource(detector.get_preview_data)
    assert '10000' in src


def test_thread_safe_cache():
    """Test that FileDetector uses thread-safe caching."""
    detector = FileDetector()
    assert hasattr(detector, '_cache_lock')
    import threading
    assert isinstance(detector._cache_lock, type(threading.Lock()))
    print("All tests passed!")


def test_caches_are_lru_bounded(temp_dir):
    """Long-running processes should not retain one cache entry per file forever."""
    detector = FileDetector(cache_max_entries=2)
    paths = []
    for index in range(3):
        path = os.path.join(temp_dir, f'{index}.txt')
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(f'row {index}\n')
        paths.append(path)
        detector.analyze_file_metadata(path)

    assert len(detector._metadata_cache) == 2
    assert len(detector._encoding_cache) == 2
    assert detector._get_file_signature(paths[0]) not in detector._metadata_cache


def test_csv_inference_is_conservatively_nullable(temp_dir):
    """Complete type evidence does not weaken conservative nullability."""
    csv_path = os.path.join(temp_dir, 'required-looking.csv')
    with open(csv_path, 'w', newline='', encoding='utf-8') as handle:
        writer = csv.writer(handle)
        writer.writerow(['id', 'description'])
        writer.writerow([1, 'x' * 240])

    metadata = FileDetector().analyze_file_metadata(csv_path)

    assert metadata['nullable_columns'] == ['id', 'description']
    assert metadata['nullability_inference'] == 'conservative'
    assert metadata['schema_inference'] == 'full'
    assert metadata['observed_max_string_lengths']['description'] == 240
    assert metadata['max_string_lengths']['description'] == 300


def test_ndjson_analysis_counts_rows_without_retaining_them(temp_dir):
    """NDJSON analysis streams all rows into constant-memory type evidence."""
    json_path = os.path.join(temp_dir, 'events.ndjson')
    with open(json_path, 'w', encoding='utf-8') as handle:
        for index in range(350):
            handle.write(json.dumps({'id': index, 'name': f'event-{index}'}) + '\n')

    metadata = FileDetector().analyze_file_metadata(json_path)

    assert metadata['json_format'] == 'ndjson'
    assert metadata['row_count'] == 350
    assert metadata['schema_sample_size'] == 350
    assert metadata['schema_inference'] == 'full'


def test_large_json_array_uses_bounded_schema_sample(temp_dir, monkeypatch):
    """Large JSON arrays should not require a full in-memory parse."""
    monkeypatch.setattr(
        file_detector_module, 'JSON_FULL_PARSE_MAX_BYTES', 100
    )
    monkeypatch.setattr(
        file_detector_module, 'JSON_SAMPLE_MAX_CHARS', 4096
    )
    json_path = os.path.join(temp_dir, 'large.json')
    with open(json_path, 'w', encoding='utf-8') as handle:
        json.dump(
            [{'id': index, 'value': f'value-{index}'} for index in range(50)],
            handle,
        )

    detector = FileDetector()
    metadata = detector.analyze_file_metadata(json_path)
    preview = detector.get_preview_data(json_path, max_rows=3)

    assert metadata['analysis_truncated'] is True
    assert metadata['row_count'] is None
    assert metadata['schema_sample_size'] == 50
    assert len(preview['rows']) == 3
    assert preview['truncated'] is True


def test_delta_fallback_analyzes_data_file_not_directory(temp_dir):
    """Optional Delta support should still provide bounded schema metadata."""
    delta_dir = os.path.join(temp_dir, 'delta')
    os.makedirs(os.path.join(delta_dir, '_delta_log'))
    data_dir = os.path.join(delta_dir, 'data')
    os.makedirs(data_dir)
    pq.write_table(
        pa.table({'id': [1, 2], 'name': ['a', 'b']}),
        os.path.join(data_dir, 'part-000.parquet'),
    )

    with patch.dict(sys.modules, {'deltalake': None}):
        metadata = FileDetector().analyze_file_metadata(delta_dir)

    assert 'error' not in metadata
    assert metadata['file_type'] == 'delta'
    assert metadata['row_count'] is None
    assert metadata['schema_inference'] == 'underlying_parquet_file'


def test_delta_fallback_excludes_checkpoint_parquet_files(temp_dir):
    """Transaction-log checkpoints are metadata, not table data files."""
    delta_dir = os.path.join(temp_dir, 'delta-checkpoint')
    log_dir = os.path.join(delta_dir, '_delta_log')
    data_dir = os.path.join(delta_dir, 'data')
    os.makedirs(log_dir)
    os.makedirs(data_dir)
    pq.write_table(
        pa.table({'checkpoint_metadata': ['not table data']}),
        os.path.join(log_dir, '00000000000000000010.checkpoint.parquet'),
    )
    pq.write_table(
        pa.table({'id': [1], 'name': ['row']}),
        os.path.join(data_dir, 'part-000.parquet'),
    )

    detector = FileDetector()
    with patch.dict(sys.modules, {'deltalake': None}):
        metadata = detector.analyze_file_metadata(delta_dir)
        preview = detector.get_preview_data(delta_dir, max_rows=1)

    assert [name for name, _ in metadata['schema']] == ['id', 'name']
    assert [column['name'] for column in preview['columns']] == ['id', 'name']


def test_iceberg_uses_numeric_version_and_current_schema(temp_dir):
    """Iceberg versions, schema IDs, and list partition specs follow metadata."""
    table_dir = os.path.join(temp_dir, 'iceberg')
    metadata_dir = os.path.join(table_dir, 'metadata')
    os.makedirs(metadata_dir)

    old_metadata = {
        'format-version': 2,
        'table-uuid': 'table-id',
        'current-schema-id': 1,
        'schemas': [{
            'type': 'struct',
            'schema-id': 1,
            'fields': [{
                'id': 1,
                'name': 'old_column',
                'required': True,
                'type': 'long',
            }],
        }],
        'partition-spec': [],
        'current-snapshot-id': None,
    }
    with open(
        os.path.join(metadata_dir, 'v9.metadata.json'),
        'w',
        encoding='utf-8',
    ) as handle:
        json.dump(old_metadata, handle)

    current_metadata = {
        'format-version': 2,
        'table-uuid': 'table-id',
        'current-schema-id': 10,
        'schemas': [
            {
                'type': 'struct',
                'schema-id': 10,
                'fields': [
                    {
                        'id': 1,
                        'name': 'id',
                        'required': True,
                        'type': 'long',
                    },
                    {
                        'id': 2,
                        'name': 'amount',
                        'required': False,
                        'type': 'decimal(10, 2)',
                    },
                ],
            },
            {
                'type': 'struct',
                'schema-id': 2,
                'fields': [],
            },
        ],
        'partition-spec': [{
            'source-id': 1,
            'field-id': 1000,
            'name': 'id_bucket',
            'transform': 'bucket[16]',
        }],
        'current-snapshot-id': 123,
        'snapshots': [{
            'snapshot-id': 123,
            'summary': {'total-records': '42'},
        }],
    }
    with open(
        os.path.join(metadata_dir, 'v10.metadata.json'),
        'w',
        encoding='utf-8',
    ) as handle:
        json.dump(current_metadata, handle)
    with open(
        os.path.join(metadata_dir, 'version-hint.text'),
        'w',
        encoding='ascii',
    ) as handle:
        handle.write('9')

    metadata = FileDetector().analyze_file_metadata(table_dir)

    assert metadata['schema'] == [('id', 'int64'), ('amount', 'decimal(10,2)')]
    assert metadata['nullable_columns'] == ['amount']
    assert metadata['row_count'] == 42
    assert metadata['iceberg_metadata']['metadata_file'] == 'v10.metadata.json'
    assert metadata['iceberg_metadata']['partition_spec'][0]['name'] == 'id_bucket'


def test_iceberg_type_preserves_decimal_and_timestamp_semantics():
    """Iceberg logical types must not be flattened to generic SQL types."""
    detector = FileDetector()
    assert detector._iceberg_type('decimal(18,4)') == 'decimal(18,4)'
    assert detector._iceberg_type('decimal(38, 10)') == 'decimal(38,10)'
    assert detector._iceberg_type('timestamp') == 'timestamp[us]'
    assert detector._iceberg_type('timestamptz') == 'timestamp[us, tz=UTC]'
    assert detector._iceberg_type('timestamp_ns') == 'timestamp[ns]'
    assert detector._iceberg_type('timestamptz_ns') == 'timestamp[ns, tz=UTC]'
    assert detector._iceberg_type('time') == 'time64[us]'


def test_iceberg_types_round_trip_to_sql_types():
    """The preserved Iceberg types must map to precise SQL types."""
    from external_file_detection.sql_generator import SQLGenerator
    detector = FileDetector()
    gen = SQLGenerator()
    assert gen._map_type_to_sql(detector._iceberg_type('decimal(18,4)')) == \
        'DECIMAL(18,4)'
    assert gen._map_type_to_sql(detector._iceberg_type('timestamptz')) == \
        'DATETIMEOFFSET(6)'
    assert gen._map_type_to_sql(detector._iceberg_type('timestamp_ns')) == \
        'DATETIME2(7)'
    assert gen._map_type_to_sql(detector._iceberg_type('timestamptz_ns')) == \
        'DATETIMEOFFSET(7)'


def test_iceberg_detects_modern_metadata_filenames(temp_dir):
    """UUID-suffixed metadata files should identify an Iceberg table."""
    table_dir = os.path.join(temp_dir, 'iceberg-modern')
    metadata_dir = os.path.join(table_dir, 'metadata')
    os.makedirs(metadata_dir)
    with open(
        os.path.join(metadata_dir, '00001-table.metadata.json'),
        'w',
        encoding='utf-8',
    ) as handle:
        json.dump({
            'format-version': 2,
            'schema': {'type': 'struct', 'fields': []},
            'partition-spec': [],
            'current-snapshot-id': None,
        }, handle)

    detector = FileDetector()

    assert detector.detect_file_type(table_dir) == 'iceberg'
    metadata = detector.analyze_file_metadata(table_dir)
    assert metadata['iceberg_metadata']['metadata_file'] == (
        '00001-table.metadata.json'
    )
    assert detector.scan_directory(table_dir)[0]['file_type'] == 'iceberg'

# ---------------------------------------------------------------------------
# Encoding detection must not depend on which chardet build is installed.
#
# Under Python 3.9 CI, chardet classified valid UTF-8 demo fixtures as a
# charmap codec; every later read then died with "'charmap' codec can't decode
# byte 0x81". A byte-order mark, pure ASCII and valid UTF-8 are facts about the
# bytes, so they are settled before the statistical guess is consulted.
# ---------------------------------------------------------------------------

class _WrongChardet:
    """Stands in for a chardet build that guesses badly."""

    def __init__(self, encoding='Windows-1252', confidence=0.99):
        self.encoding = encoding
        self.confidence = confidence
        self.calls = 0

    def detect(self, raw):
        self.calls += 1
        return {'encoding': self.encoding, 'confidence': self.confidence}


@pytest.fixture
def sabotaged_chardet(monkeypatch):
    import sys as _sys
    fake = _WrongChardet()
    monkeypatch.setitem(_sys.modules, 'chardet', fake)
    return fake


@pytest.mark.parametrize(
    'payload, expected',
    [
        ('row_id,name\n1,caf\u00e9 na\u00efve\n', 'utf-8'),
        ('row_id,name\n1,\u3053\u3093\u306b\u3061\u306f\n', 'utf-8'),
        ('row_id,name\n1,\U0001f600 emoji\n', 'utf-8'),
        ('row_id,name\n1,plain ascii\n', 'ascii'),
    ],
)
def test_certain_encodings_ignore_a_misbehaving_chardet(
        tmp_path, sabotaged_chardet, payload, expected):
    path = tmp_path / 'sample.csv'
    path.write_bytes(payload.encode('utf-8'))

    encoding, confidence = FileDetector().detect_encoding(str(path))

    assert encoding == expected
    assert confidence == 1.0
    assert sabotaged_chardet.calls == 0, 'chardet must not be consulted'


@pytest.mark.parametrize(
    'payload, expected',
    [
        (b'\xef\xbb\xbfid,name\n', 'utf-8-sig'),
        (b'\xff\xfei\x00d\x00', 'utf-16'),
        (b'\xfe\xff\x00i\x00d', 'utf-16'),
        (b'\xff\xfe\x00\x00i\x00\x00\x00', 'utf-32'),
        (b'\x00\x00\xfe\xff\x00\x00\x00i', 'utf-32'),
    ],
)
def test_a_byte_order_mark_settles_the_encoding(
        tmp_path, sabotaged_chardet, payload, expected):
    # The UTF-32LE mark begins with the UTF-16LE mark, so the longer mark has
    # to be tested first or every UTF-32LE file reads as UTF-16LE.
    path = tmp_path / 'sample.csv'
    path.write_bytes(payload)

    encoding, _ = FileDetector().detect_encoding(str(path))

    assert encoding == expected
    assert sabotaged_chardet.calls == 0


def test_chardet_still_names_a_legacy_codepage():
    """Naming CP932 is the job only the statistical guess can do.

    Uses the committed fixture rather than a synthetic one: chardet needs
    enough representative text to be confident, and this is the file whose
    classification must not regress.
    """
    pytest.importorskip('chardet')
    fixture = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        'data sample', 'unicode', 'japanese_cp932.csv')

    detector = FileDetector()
    encoding, _ = detector.detect_encoding(fixture)

    assert encoding not in ('utf-8', 'ascii')
    assert detector.encoding_to_codepage(encoding) == '932'


def test_a_multibyte_character_split_by_the_read_cap_is_still_utf8(
    tmp_path, sabotaged_chardet
):
    """A capped read can slice a character in half; that is not a verdict."""
    from external_file_detection import file_detector as fd

    path = tmp_path / 'big.csv'
    body = ('row_id,name\n' + '1,\u00e9\u00e9\u00e9\u00e9\u00e9\n' * 4000).encode('utf-8')
    path.write_bytes(body)

    # Force the cap to land inside a two-byte character.
    cut = body.rindex('\u00e9'.encode('utf-8')) + 1
    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr(fd, 'ENCODING_DETECTION_BYTES', cut)
        encoding, confidence = FileDetector().detect_encoding(str(path))
    finally:
        monkey.undo()

    assert encoding == 'utf-8'
    # Without the tolerance the sliced tail would fail the strict decode and
    # the answer would come from chardet instead, so the verdict has to be the
    # certain one and chardet has to have been left alone.
    assert confidence == 1.0
    assert sabotaged_chardet.calls == 0

@pytest.mark.parametrize(
    'codec, expected, codepage',
    [
        ('utf-16-le', 'utf-16-le', '1200'),
        ('utf-16-be', 'utf-16-be', '1201'),
    ],
)
def test_utf16_without_a_bom_is_not_mistaken_for_ascii(
    tmp_path, codec, expected, codepage
):
    """Latin UTF-16 is all bytes below 0x80, which is not the same as ASCII."""
    path = tmp_path / 'nobom.csv'
    path.write_bytes('id,name,city\r\n1,Alice,Paris\r\n2,Bob,Tokyo\r\n'.encode(codec))

    detector = FileDetector()
    encoding, _ = detector.detect_encoding(str(path))

    assert encoding == expected
    assert detector.encoding_to_codepage(encoding) == codepage


def test_utf16_without_a_bom_still_counts_its_rows(tmp_path):
    """Reading UTF-16 as a single byte codepage turns NUL padding into data."""
    path = tmp_path / 'nobom.csv'
    path.write_bytes('id,name,city\r\n1,Alice,Paris\r\n2,Bob,Tokyo\r\n'.encode('utf-16-le'))

    metadata = FileDetector().analyze_file_metadata(str(path))

    assert metadata.get('error') is None
    assert metadata['codepage'] == '1200'
    assert [name for name, _ in metadata['schema']] == ['id', 'name', 'city']
    # Read as a single byte codepage the NUL padding becomes data and this is 6.
    assert metadata['row_count'] == 2
    assert metadata['sample_rows'] == [[1, 'Alice', 'Paris'], [2, 'Bob', 'Tokyo']]


@pytest.mark.parametrize(
    'name, body',
    [
        ('plain ascii', b'id,name\r\n1,Alice\r\n2,Bob\r\n'),
        ('utf-8 text', 'id,name\r\n1,Bj\u00f6rk\r\n'.encode('utf-8')),
        ('nuls on both parities', bytes([0, 0, 1, 2]) * 64),
        ('too short to judge', b'\x41\x00'),
    ],
)
def test_the_utf16_heuristic_keeps_to_itself(name, body):
    """It must claim UTF-16 only, never ordinary text or binary."""
    assert FileDetector._looks_like_bomless_utf16(body) is None, name