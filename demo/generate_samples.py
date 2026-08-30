#!/usr/bin/env python3
"""Generate the deterministic demo fixtures shipped in ``demo/``.

The generator only uses dependencies that the project already declares
(``pandas``, ``pyarrow``, ``openpyxl``) plus the standard library.  Every
sample is written from constant data, so running the script repeatedly
produces logically identical files.  Text based samples are byte-for-byte
stable; binary container formats (Parquet / ORC / XLSX) embed writer
version metadata and archive timestamps, so they are stable in content but
not necessarily in bytes.

Usage::

    python demo/generate_samples.py
    python demo/generate_samples.py --output-dir path/to/demo
"""

from __future__ import annotations

import argparse
import datetime as dt
import decimal
import json
import os
import re
import sys

import pyarrow as pa
import pyarrow.parquet as pq

DEMO_DIR = os.path.dirname(os.path.abspath(__file__))

# A fixed instant used for every embedded document property so that no
# sample depends on the moment it was generated.
FIXED_TIMESTAMP = dt.datetime(2024, 1, 15, 8, 30, 0)
FIXED_EPOCH_MS = 1705307400000


# ---------------------------------------------------------------------------
# Small IO helpers
# ---------------------------------------------------------------------------

def _ensure_dir(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    return path


def write_text(path: str, text: str, encoding: str = 'utf-8') -> str:
    """Write *text* with explicit LF newlines and a known encoding."""
    _ensure_dir(os.path.dirname(path))
    with open(path, 'w', encoding=encoding, newline='') as handle:
        handle.write(text)
    return path


def write_bytes(path: str, payload: bytes) -> str:
    _ensure_dir(os.path.dirname(path))
    with open(path, 'wb') as handle:
        handle.write(payload)
    return path


def _rows_to_delimited(header, rows, delimiter: str) -> str:
    """Render RFC 4180 style delimited text with LF line endings."""
    def field(value):
        if value is None:
            return ''
        text = str(value)
        needs_quotes = (
            delimiter in text
            or '"' in text
            or '\n' in text
            or '\r' in text
        )
        if needs_quotes:
            return '"' + text.replace('"', '""') + '"'
        return text

    lines = [delimiter.join(field(name) for name in header)]
    lines.extend(delimiter.join(field(cell) for cell in row) for row in rows)
    return '\n'.join(lines) + '\n'


# ---------------------------------------------------------------------------
# 1. Scalar CSV / TSV
# ---------------------------------------------------------------------------

SCALAR_HEADER = [
    'row_id', 'quantity', 'unit_price', 'temperature_c', 'is_active',
    'product_name', 'notes', 'order_date', 'order_timestamp',
    'order_timestamp_utc',
]

SCALAR_ROWS = [
    [1, 12, 19.99, -3.5, 'true', 'Widget, standard', 'first order',
     '2024-01-15', '2024-01-15T08:30:00', '2024-01-15T08:30:00Z'],
    [2, -4, 0.0, 0.0, 'false', 'Gadget "Pro"', None,
     '2024-02-29', '2024-02-29T23:59:59', '2024-02-29T23:59:59Z'],
    [3, 0, 1234.5678, 21.25, 'true', 'Ünicode Ünit — ★', 'accented name',
     '2024-03-01', '2024-03-01T00:00:00', '2024-03-01T00:00:00Z'],
    [4, 2147483647, -0.001, 100.0, 'false', '日本語の商品', 'CJK name',
     '2024-06-30', '2024-06-30T12:00:00', '2024-06-30T12:00:00Z'],
    [5, None, None, None, None, 'Missing values row', None,
     None, None, None],
    [6, -2147483648, 0.0000001, -273.15, 'true', 'Edge case', 'min int32',
     '2024-12-31', '2024-12-31T23:59:59', '2024-12-31T23:59:59Z'],
]


def generate_scalar_csv(root: str) -> list:
    created = []
    csv_text = _rows_to_delimited(SCALAR_HEADER, SCALAR_ROWS, ',')
    created.append(write_text(os.path.join(root, 'csv', 'sales_scalars.csv'),
                              csv_text))

    # The TSV variant carries the same values; commas inside product names
    # no longer need quoting when the delimiter is a tab.
    tsv_text = _rows_to_delimited(SCALAR_HEADER, SCALAR_ROWS, '\t')
    created.append(write_text(os.path.join(root, 'csv', 'sales_scalars.tsv'),
                              tsv_text))

    # A pipe delimited file exercises delimiter sniffing.
    pipe_text = _rows_to_delimited(SCALAR_HEADER, SCALAR_ROWS, '|')
    created.append(write_text(
        os.path.join(root, 'csv', 'sales_scalars_pipe.csv'), pipe_text))
    return created


# ---------------------------------------------------------------------------
# 2. JSON array and NDJSON
# ---------------------------------------------------------------------------

JSON_RECORDS = [
    {
        'order_id': 1001,
        'customer': {'id': 'C-1', 'name': 'Ada Lovelace',
                     'address': {'city': 'London', 'postcode': 'NW1'}},
        'items': [
            {'sku': 'W-1', 'qty': 2, 'price': 19.99},
            {'sku': 'G-2', 'qty': 1, 'price': 249.0},
        ],
        'tags': ['priority', 'gift'],
        'total': 288.98,
        'is_paid': True,
        'discount': None,
        'placed_at': '2024-01-15T08:30:00Z',
    },
    {
        'order_id': 1002,
        'customer': {'id': 'C-2', 'name': '山田 太郎',
                     'address': {'city': '東京', 'postcode': '100-0001'}},
        'items': [{'sku': 'W-1', 'qty': 10, 'price': 18.5}],
        'tags': [],
        'total': 185.0,
        'is_paid': False,
        'discount': 0.05,
        'placed_at': '2024-02-29T23:59:59Z',
    },
    {
        'order_id': 1003,
        'customer': {'id': 'C-3', 'name': 'Márquez, "Gabo"',
                     'address': {'city': 'Bogotá', 'postcode': '110111'}},
        'items': [],
        'tags': ['refund'],
        'total': 0.0,
        'is_paid': True,
        'discount': None,
        'placed_at': '2024-03-01T00:00:00Z',
    },
]


def generate_json_samples(root: str) -> list:
    created = []
    array_text = json.dumps(JSON_RECORDS, ensure_ascii=False, indent=2,
                            sort_keys=True) + '\n'
    created.append(write_text(os.path.join(root, 'json', 'orders_array.json'),
                              array_text))

    ndjson_text = ''.join(
        json.dumps(record, ensure_ascii=False, sort_keys=True) + '\n'
        for record in JSON_RECORDS
    )
    created.append(write_text(os.path.join(root, 'json', 'orders.ndjson'),
                              ndjson_text))

    # A single JSON object (not an array) exercises the object code path.
    object_text = json.dumps(JSON_RECORDS[0], ensure_ascii=False, indent=2,
                             sort_keys=True) + '\n'
    created.append(write_text(
        os.path.join(root, 'json', 'order_single_object.json'), object_text))
    return created


# ---------------------------------------------------------------------------
# 3. Parquet covering every Arrow family the SQL mapper claims to support
# ---------------------------------------------------------------------------

def _all_types_table() -> pa.Table:
    """Build the wide Arrow table used for the Parquet / ORC samples."""
    fields = [
        ('c_int8', pa.int8(), [-128, 0, 127, None]),
        ('c_int16', pa.int16(), [-32768, 0, 32767, None]),
        ('c_int32', pa.int32(), [-2147483648, 0, 2147483647, None]),
        ('c_int64', pa.int64(), [-9223372036854775808, 0,
                                 9223372036854775807, None]),
        ('c_uint8', pa.uint8(), [0, 1, 255, None]),
        ('c_uint16', pa.uint16(), [0, 1, 65535, None]),
        ('c_uint32', pa.uint32(), [0, 1, 4294967295, None]),
        ('c_uint64', pa.uint64(), [0, 1, 18446744073709551615, None]),
        ('c_float32', pa.float32(), [-1.5, 0.0, 3.25, None]),
        ('c_float64', pa.float64(), [-1.5e100, 0.0, 3.141592653589793, None]),
        ('c_bool', pa.bool_(), [True, False, True, None]),
        ('c_string', pa.string(), ['ascii', 'Ünicode ★', '日本語', None]),
        ('c_large_string', pa.large_string(),
         ['large ascii', 'Ünicode ★', '한국어 문자열', None]),
        ('c_binary', pa.binary(), [b'\x00\x01\x02', b'', b'PAR1', None]),
        ('c_large_binary', pa.large_binary(),
         [b'\xff\xfe', b'', b'large-binary', None]),
        ('c_date32', pa.date32(),
         [dt.date(1970, 1, 1), dt.date(2024, 2, 29), dt.date(2999, 12, 31),
          None]),
        ('c_time32_ms', pa.time32('ms'),
         [dt.time(0, 0, 0), dt.time(12, 34, 56, 789000),
          dt.time(23, 59, 59, 999000), None]),
        ('c_time64_us', pa.time64('us'),
         [dt.time(0, 0, 0), dt.time(12, 34, 56, 789012),
          dt.time(23, 59, 59, 999999), None]),
        ('c_timestamp_ms', pa.timestamp('ms'),
         [dt.datetime(1970, 1, 1), dt.datetime(2024, 2, 29, 23, 59, 59),
          dt.datetime(2999, 12, 31), None]),
        ('c_timestamp_us', pa.timestamp('us'),
         [dt.datetime(1970, 1, 1),
          dt.datetime(2024, 2, 29, 23, 59, 59, 123456),
          dt.datetime(2999, 12, 31), None]),
        ('c_timestamp_ns', pa.timestamp('ns'),
         [dt.datetime(1970, 1, 1), dt.datetime(2024, 2, 29, 23, 59, 59),
          dt.datetime(2262, 4, 11), None]),
        ('c_timestamp_utc', pa.timestamp('us', tz='UTC'),
         [dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc),
          dt.datetime(2024, 2, 29, 23, 59, 59, tzinfo=dt.timezone.utc),
          dt.datetime(2999, 12, 31, tzinfo=dt.timezone.utc), None]),
        ('c_decimal', pa.decimal128(18, 4),
         [decimal.Decimal('-12345678901234.5678'),
          decimal.Decimal('0.0000'),
          decimal.Decimal('99999999999999.9999'), None]),
        ('c_list_int32', pa.list_(pa.int32()),
         [[1, 2, 3], [], [None, 7], None]),
        ('c_struct', pa.struct([('id', pa.int32()), ('label', pa.string())]),
         [{'id': 1, 'label': 'one'}, {'id': 2, 'label': 'ni'},
          {'id': None, 'label': None}, None]),
        ('c_map', pa.map_(pa.string(), pa.int32()),
         [[('a', 1), ('b', 2)], [], [('key', None)], None]),
    ]

    schema = pa.schema([pa.field(name, typ) for name, typ, _ in fields])
    arrays = [pa.array(values, type=typ) for _, typ, values in fields]
    return pa.Table.from_arrays(arrays, schema=schema)


def generate_parquet_samples(root: str):
    created = []
    table = _all_types_table()
    path = os.path.join(root, 'parquet', 'all_types.parquet')
    _ensure_dir(os.path.dirname(path))
    pq.write_table(table, path, compression='snappy', version='2.6')
    created.append(path)

    # A narrow, business-shaped Parquet file for the everyday walkthrough.
    sales = pa.table({
        'order_id': pa.array([1001, 1002, 1003, 1004], pa.int64()),
        'customer': pa.array(['Ada', '山田 太郎', 'Márquez', None],
                             pa.string()),
        'quantity': pa.array([2, 10, 0, 5], pa.int32()),
        'amount': pa.array([288.98, 185.0, 0.0, None], pa.float64()),
        'is_paid': pa.array([True, False, True, None], pa.bool_()),
        'order_date': pa.array(
            [dt.date(2024, 1, 15), dt.date(2024, 2, 29),
             dt.date(2024, 3, 1), dt.date(2024, 6, 30)], pa.date32()),
    })
    sales_path = os.path.join(root, 'parquet', 'sales.parquet')
    pq.write_table(sales, sales_path, compression='snappy', version='2.6')
    created.append(sales_path)
    return created, table


# ---------------------------------------------------------------------------
# 4. ORC
# ---------------------------------------------------------------------------

# The Arrow ORC writer does not accept every Arrow type that Parquet does;
# unsigned integers and the large_* variants are not representable.
ORC_COLUMNS = [
    'c_int8', 'c_int16', 'c_int32', 'c_int64', 'c_float32', 'c_float64',
    'c_bool', 'c_string', 'c_binary', 'c_date32', 'c_timestamp_us',
    'c_decimal', 'c_list_int32', 'c_struct', 'c_map',
]

# Writing ORC timestamps requires an IANA time zone database on the host.
ORC_COLUMNS_NO_TIMESTAMP = [c for c in ORC_COLUMNS if 'timestamp' not in c]


def generate_orc_sample(root: str, table: pa.Table) -> list:
    try:
        import pyarrow.orc as orc
    except ImportError:  # pragma: no cover - depends on the pyarrow build
        return []

    path = os.path.join(root, 'orc', 'all_types.orc')
    _ensure_dir(os.path.dirname(path))

    # The ORC writer needs an IANA time zone database to encode timestamps.
    # Many Windows installations do not ship one, so fall back to a
    # timestamp-free column set instead of failing the whole generation.
    for columns in (ORC_COLUMNS, ORC_COLUMNS_NO_TIMESTAMP):
        subset = table.select([c for c in columns if c in table.schema.names])
        try:
            orc.write_table(subset, path)
        except (pa.ArrowNotImplementedError, pa.ArrowInvalid,
                pa.lib.ArrowException):
            continue
        return [path]

    if os.path.exists(path):
        os.remove(path)
    return []


# ---------------------------------------------------------------------------
# 5. Excel and plain text
# ---------------------------------------------------------------------------

def generate_excel_sample(root: str) -> list:
    from openpyxl import Workbook

    path = os.path.join(root, 'excel', 'inventory.xlsx')
    _ensure_dir(os.path.dirname(path))

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = 'inventory'
    sheet.append(['sku', 'description', 'on_hand', 'unit_cost',
                  'is_discontinued', 'last_counted'])
    rows = [
        ['W-1', 'Widget, standard', 120, 9.99, False, dt.date(2024, 1, 15)],
        ['G-2', 'Gadget "Pro"', 0, 199.5, True, dt.date(2024, 2, 29)],
        ['U-3', 'Ünicode Ünit — ★', -5, 0.0, False, dt.date(2024, 3, 1)],
        ['J-4', '日本語の商品', 42, 1234.5678, False, None],
    ]
    for row in rows:
        sheet.append(row)

    # Pin document properties so the workbook does not embed "now".
    workbook.properties.created = FIXED_TIMESTAMP
    workbook.properties.modified = FIXED_TIMESTAMP
    workbook.properties.creator = 'SQL File Detection Tool demo'
    workbook.properties.lastModifiedBy = 'SQL File Detection Tool demo'
    workbook.save(path)
    _normalise_zip(path)
    return [path]


def _normalise_zip(path: str) -> None:
    """Rewrite a zip container with fixed entry timestamps and no extras.

    ``openpyxl`` stamps every zip entry with the current local time, so two
    runs produce different bytes even for identical content.  Rebuilding the
    archive with a pinned ``date_time`` makes the workbook byte-for-byte
    reproducible.
    """
    import zipfile

    stamp = (FIXED_TIMESTAMP.year, FIXED_TIMESTAMP.month, FIXED_TIMESTAMP.day,
             FIXED_TIMESTAMP.hour, FIXED_TIMESTAMP.minute,
             FIXED_TIMESTAMP.second)
    iso = FIXED_TIMESTAMP.strftime('%Y-%m-%dT%H:%M:%SZ').encode('ascii')
    with zipfile.ZipFile(path) as source:
        entries = [(item, source.read(item.filename))
                   for item in source.infolist()]

    temporary = path + '.tmp'
    with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as target:
        for item, payload in entries:
            if item.filename == 'docProps/core.xml':
                # openpyxl stamps dcterms:modified with "now" while saving,
                # ignoring the value set on workbook.properties.
                payload = re.sub(
                    br'(<dcterms:modified[^>]*>)[^<]*(</dcterms:modified>)',
                    br'\g<1>' + iso + br'\g<2>', payload)
            info = zipfile.ZipInfo(item.filename, date_time=stamp)
            info.compress_type = item.compress_type
            info.external_attr = item.external_attr
            info.create_system = 0
            target.writestr(info, payload)
    os.replace(temporary, path)


TEXT_SAMPLE = (
    'SQL File Detection Tool - plain text sample\n'
    '==============================================\n'
    '\n'
    "This file exercises the 'text' detector path. It contains ASCII text\n"
    'plus a few non-ASCII characters so that encoding detection has\n'
    'something to work with: cafe\u0301 (decomposed), caf\u00e9 (composed),\n'
    '\u65e5\u672c\u8a9e, \u0420\u0443\u0441\u0441\u043a\u0438\u0439, '
    '\u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac.\n'
    '\n'
    'Lines are terminated with LF (0x0A), so SQL Server BULK INSERT needs\n'
    "ROWTERMINATOR = '0x0a' rather than the Windows default.\n"
)


def generate_text_sample(root: str) -> list:
    return [write_text(os.path.join(root, 'text', 'readme_sample.txt'),
                       TEXT_SAMPLE)]


# ---------------------------------------------------------------------------
# 6. Delta Lake table folder
# ---------------------------------------------------------------------------

DELTA_SCHEMA_STRING = json.dumps({
    'type': 'struct',
    'fields': [
        {'name': 'event_id', 'type': 'long', 'nullable': False,
         'metadata': {}},
        {'name': 'event_name', 'type': 'string', 'nullable': True,
         'metadata': {}},
        {'name': 'event_value', 'type': 'double', 'nullable': True,
         'metadata': {}},
        {'name': 'is_test', 'type': 'boolean', 'nullable': True,
         'metadata': {}},
        {'name': 'event_date', 'type': 'date', 'nullable': True,
         'metadata': {}},
    ],
}, sort_keys=True)


def generate_delta_table(root: str) -> list:
    created = []
    table_dir = os.path.join(root, 'tables', 'events_delta')
    log_dir = os.path.join(table_dir, '_delta_log')
    _ensure_dir(log_dir)

    part = pa.table({
        'event_id': pa.array([1, 2, 3], pa.int64()),
        'event_name': pa.array(['created', '更新', None], pa.string()),
        'event_value': pa.array([1.5, -2.25, None], pa.float64()),
        'is_test': pa.array([False, True, None], pa.bool_()),
        'event_date': pa.array([dt.date(2024, 1, 15), dt.date(2024, 2, 29),
                                dt.date(2024, 3, 1)], pa.date32()),
    })
    part_name = 'part-00000-demo-c000.snappy.parquet'
    part_path = os.path.join(table_dir, part_name)
    pq.write_table(part, part_path, compression='snappy', version='2.6')
    created.append(part_path)

    # Delta protocol actions, one JSON object per line, deterministic ids.
    actions = [
        {'protocol': {'minReaderVersion': 1, 'minWriterVersion': 2}},
        {'metaData': {
            'id': '00000000-0000-0000-0000-0000000000de',
            'name': 'events_delta',
            'description': 'Demo Delta table for SQL File Detection Tool',
            'format': {'provider': 'parquet', 'options': {}},
            'schemaString': DELTA_SCHEMA_STRING,
            'partitionColumns': [],
            'configuration': {},
            'createdTime': FIXED_EPOCH_MS,
        }},
        {'add': {
            'path': part_name,
            'partitionValues': {},
            'size': os.path.getsize(part_path),
            'modificationTime': FIXED_EPOCH_MS,
            'dataChange': True,
        }},
        {'commitInfo': {
            'timestamp': FIXED_EPOCH_MS,
            'operation': 'WRITE',
            'operationParameters': {'mode': 'Overwrite'},
            'isBlindAppend': False,
        }},
    ]
    log_text = ''.join(json.dumps(a, sort_keys=True) + '\n' for a in actions)
    created.append(write_text(
        os.path.join(log_dir, '00000000000000000000.json'), log_text))
    return created


# ---------------------------------------------------------------------------
# 7. Apache Iceberg table folder
# ---------------------------------------------------------------------------

def generate_iceberg_table(root: str) -> list:
    created = []
    table_dir = os.path.join(root, 'tables', 'events_iceberg')
    data_dir = _ensure_dir(os.path.join(table_dir, 'data'))
    metadata_dir = _ensure_dir(os.path.join(table_dir, 'metadata'))

    data = pa.table({
        'event_id': pa.array([1, 2, 3], pa.int64()),
        'event_name': pa.array(['created', '갱신', None], pa.string()),
        'event_value': pa.array([1.5, -2.25, None], pa.float64()),
        'is_test': pa.array([False, True, None], pa.bool_()),
        'event_ts': pa.array(
            [dt.datetime(2024, 1, 15, 8, 30, tzinfo=dt.timezone.utc),
             dt.datetime(2024, 2, 29, 23, 59, 59, tzinfo=dt.timezone.utc),
             None], pa.timestamp('us', tz='UTC')),
        'amount': pa.array(
            [decimal.Decimal('10.50'), decimal.Decimal('-3.25'), None],
            pa.decimal128(12, 2)),
    })
    data_path = os.path.join(data_dir, '00000-0-demo.parquet')
    pq.write_table(data, data_path, compression='snappy', version='2.6')
    created.append(data_path)

    metadata = {
        'format-version': 2,
        'table-uuid': '00000000-0000-0000-0000-0000000000ce',
        'location': 'file:///demo/tables/events_iceberg',
        'last-sequence-number': 1,
        'last-updated-ms': FIXED_EPOCH_MS,
        'last-column-id': 6,
        'current-schema-id': 0,
        'schemas': [{
            'type': 'struct',
            'schema-id': 0,
            'identifier-field-ids': [1],
            'fields': [
                {'id': 1, 'name': 'event_id', 'required': True,
                 'type': 'long'},
                {'id': 2, 'name': 'event_name', 'required': False,
                 'type': 'string'},
                {'id': 3, 'name': 'event_value', 'required': False,
                 'type': 'double'},
                {'id': 4, 'name': 'is_test', 'required': False,
                 'type': 'boolean'},
                {'id': 5, 'name': 'event_ts', 'required': False,
                 'type': 'timestamptz'},
                {'id': 6, 'name': 'amount', 'required': False,
                 'type': 'decimal(12, 2)'},
            ],
        }],
        'default-spec-id': 0,
        'partition-specs': [{'spec-id': 0, 'fields': []}],
        'last-partition-id': 999,
        'default-sort-order-id': 0,
        'sort-orders': [{'order-id': 0, 'fields': []}],
        'properties': {'write.format.default': 'parquet'},
        'current-snapshot-id': 1000000000000000001,
        'snapshots': [{
            'sequence-number': 1,
            'snapshot-id': 1000000000000000001,
            'timestamp-ms': FIXED_EPOCH_MS,
            'summary': {
                'operation': 'append',
                'total-records': '3',
                'total-data-files': '1',
            },
            'manifest-list':
                'metadata/snap-1000000000000000001-1-demo.avro',
            'schema-id': 0,
        }],
        'snapshot-log': [{'timestamp-ms': FIXED_EPOCH_MS,
                          'snapshot-id': 1000000000000000001}],
        'metadata-log': [],
    }
    created.append(write_text(
        os.path.join(metadata_dir, 'v1.metadata.json'),
        json.dumps(metadata, indent=2, sort_keys=True) + '\n'))
    return created


# ---------------------------------------------------------------------------
# 8. Unicode encoding fixtures
# ---------------------------------------------------------------------------

UNICODE_HEADER = ['row_id', 'script', 'sample_text', 'code_points', 'note']

# NOTE: file *encoding* (below) and SQL *collation* (COLLATION_ROWS) are
# independent concerns.  Encoding decides which bytes represent a
# character on disk; collation decides how SQL Server compares and sorts
# the characters once they are inside an NVARCHAR column.
UNICODE_ROWS = [
    [1, 'Latin', 'Grüßen aus München', 'U+00FC U+00DF', 'German sharp s'],
    [2, 'Latin-composed', 'caf\u00e9', 'U+0063 U+0061 U+0066 U+00E9',
     'NFC single code point'],
    [3, 'Latin-decomposed', 'cafe\u0301',
     'U+0063 U+0061 U+0066 U+0065 U+0301', 'NFD combining acute'],
    [4, 'Japanese-kanji', '日本語の文字列', 'U+65E5 U+672C U+8A9E', 'kanji'],
    [5, 'Japanese-hiragana', 'ひらがな', 'U+3072 U+3089 U+304C U+306A',
     'hiragana'],
    [6, 'Japanese-katakana', 'カタカナ', 'U+30AB U+30BF U+30AB U+30CA',
     'full-width katakana'],
    [7, 'Japanese-halfwidth', 'ｶﾀｶﾅ', 'U+FF76 U+FF80 U+FF76 U+FF85',
     'half-width katakana'],
    [8, 'Chinese', '简体中文 / 繁體中文', 'U+7B80 U+4F53',
     'simplified and traditional'],
    [9, 'Korean', '한국어 문자열', 'U+D55C U+AD6D U+C5B4', 'hangul'],
    [10, 'Arabic', 'مرحبا بالعالم', 'U+0645 U+0631 U+062D', 'right-to-left'],
    [11, 'Hebrew', 'שלום עולם', 'U+05E9 U+05DC U+05D5 U+05DD',
     'right-to-left'],
    [12, 'Devanagari', 'नमस्ते दुनिया', 'U+0928 U+092E U+0938',
     'combining marks'],
    [13, 'Cyrillic', 'Привет, мир', 'U+041F U+0440 U+0438', 'Russian'],
    [14, 'Greek', 'Γειά σου Κόσμε', 'U+0393 U+03B5 U+03B9', 'Greek'],
    [15, 'Symbols-BMP', '☃ ★ ♥', 'U+2603 U+2605 U+2665',
     'basic multilingual plane symbols'],
    [16, 'Emoji-supplementary', '😀 🚀 𝔘', 'U+1F600 U+1F680 U+1D518',
     'surrogate pairs in UTF-16'],
    [17, 'Emoji-ZWJ', '👩‍💻 👨‍👩‍👧‍👦', 'U+1F469 U+200D U+1F4BB',
     'zero-width-joiner sequences'],
    [18, 'Quoted', 'He said "hello", then left', 'U+0022',
     'embedded quotes and comma'],
    [19, 'Multiline', 'line one\nline two', 'U+000A',
     'embedded newline inside a quoted field'],
    [20, 'Null-value', None, '', 'empty field is NULL'],
]


def generate_unicode_samples(root: str) -> list:
    created = []
    unicode_dir = os.path.join(root, 'unicode')

    csv_text = _rows_to_delimited(UNICODE_HEADER, UNICODE_ROWS, ',')
    tsv_text = _rows_to_delimited(UNICODE_HEADER, UNICODE_ROWS, '\t')

    # UTF-8 without BOM.
    created.append(write_bytes(
        os.path.join(unicode_dir, 'unicode_utf8.csv'),
        csv_text.encode('utf-8')))

    # UTF-8 with BOM (what Excel writes on Windows).
    created.append(write_bytes(
        os.path.join(unicode_dir, 'unicode_utf8_bom.csv'),
        b'\xef\xbb\xbf' + csv_text.encode('utf-8')))

    # UTF-16LE with BOM, tab delimited.
    created.append(write_bytes(
        os.path.join(unicode_dir, 'unicode_utf16le_bom.tsv'),
        b'\xff\xfe' + tsv_text.encode('utf-16-le')))

    # UTF-16LE with BOM, comma delimited.
    created.append(write_bytes(
        os.path.join(unicode_dir, 'unicode_utf16le_bom.csv'),
        b'\xff\xfe' + csv_text.encode('utf-16-le')))

    # CP932 / Shift-JIS: only characters that exist in that codepage.
    cp932_header = ['row_id', 'kana_type', 'sample_text', 'note']
    cp932_rows = [
        [1, 'kanji', '日本語', '漢字'],
        [2, 'hiragana', 'ひらがな', 'ひらがな'],
        [3, 'katakana', 'カタカナ', '全角カタカナ'],
        [4, 'halfwidth', 'ｶﾀｶﾅ', '半角カタカナ'],
        [5, 'mixed', '東京都渋谷区', '住所の例'],
        [6, 'ascii', 'Tokyo', 'ASCII only'],
    ]
    cp932_text = _rows_to_delimited(cp932_header, cp932_rows, ',')
    created.append(write_bytes(
        os.path.join(unicode_dir, 'japanese_cp932.csv'),
        cp932_text.encode('cp932')))
    return created


# ---------------------------------------------------------------------------
# 9. Collation-sensitive value pairs
# ---------------------------------------------------------------------------

COLLATION_HEADER = ['pair_id', 'category', 'left_value', 'right_value',
                    'differs_under']

COLLATION_ROWS = [
    [1, 'kana_type', 'ひらがな', 'ヒラガナ', 'kana sensitivity (_KS)'],
    [2, 'kana_width', 'カタカナ', 'ｶﾀｶﾅ', 'width sensitivity (_WS)'],
    [3, 'latin_width', 'ABC123', 'ＡＢＣ１２３', 'width sensitivity (_WS)'],
    [4, 'case', 'straße', 'STRASSE', 'case sensitivity (_CS)'],
    [5, 'sharp_s', 'straße', 'strasse', 'German sharp s expansion'],
    [6, 'accent', 'resume', 'résumé', 'accent sensitivity (_AS)'],
    [7, 'unicode_form', 'caf\u00e9', 'cafe\u0301',
     'binary collations only (_BIN2)'],
    [8, 'turkish_i', 'ISTANBUL', 'istanbul', 'Turkish_100 dotless i'],
    [9, 'turkish_dotted', 'İstanbul', 'Istanbul', 'Turkish_100 dotted I'],
    [10, 'trailing_space', 'value', 'value   ',
     'trailing spaces ignored by = but not by DATALENGTH'],
    [11, 'lookalike', 'A', 'Α', 'Latin A vs Greek Alpha'],
    [12, 'lookalike_cyrillic', 'A', 'А', 'Latin A vs Cyrillic A'],
    [13, 'kana_prolonged', 'コーヒー', 'コ－ヒ－',
     'prolonged sound mark vs full-width hyphen'],
    [14, 'identical', '😀', '😀', 'identical supplementary-plane characters'],
]


def generate_collation_samples(root: str) -> list:
    text = _rows_to_delimited(COLLATION_HEADER, COLLATION_ROWS, ',')
    return [write_bytes(
        os.path.join(root, 'unicode', 'collation_cases_utf8.csv'),
        text.encode('utf-8'))]


def _collation_literal(value: str) -> str:
    return "N'" + value.replace("'", "''") + "'"


# Collation names used below. Every one of them is verified against
# sys.fn_helpcollations() by section 0 of the generated script before the
# rest of the script relies on it.
DEMO_COLLATIONS = [
    'Japanese_XJIS_140_CI_AS_KS_WS',
    'Japanese_XJIS_140_CI_AI',
    'Japanese_Bushu_Kakusu_140_CI_AS',
    'Latin1_General_100_CI_AI',
    'Latin1_General_100_CI_AS',
    'Latin1_General_100_CS_AS',
    'Latin1_General_100_BIN2_UTF8',
    'Turkish_100_CI_AS',
]


def build_collation_script() -> str:
    """Render demo/collation_samples.sql from the collation fixture rows."""
    collation_list = ',\n'.join(
        '                 ' + _collation_literal(name)
        for name in DEMO_COLLATIONS
    ).lstrip()

    lines = [
        '-- ============================================================',
        '-- SQL File Detection Tool demo: encoding vs. collation',
        '-- ------------------------------------------------------------',
        '-- Generated by demo/generate_samples.py - do not edit by hand.',
        '--',
        '-- File ENCODING (UTF-8, UTF-16LE, CP932, ...) decides which bytes',
        '-- represent a character on disk. SQL COLLATION decides how the',
        '-- server compares, sorts and groups those characters once they',
        '-- are inside an NVARCHAR column or expression. A CSV or JSON file',
        '-- never carries a collation.',
        '--',
        '-- The script only creates a #temp table, so it is safe to run in',
        '-- any database.',
        '-- ============================================================',
        'SET NOCOUNT ON;',
        'GO',
        '',
        '-- ------------------------------------------------------------',
        '-- 0. Which of the collations used below does this instance have?',
        '--    Check this first: collation availability depends on the',
        '--    SQL Server / Azure SQL version.',
        '-- ------------------------------------------------------------',
        'SELECT [name], [description]',
        'FROM sys.fn_helpcollations()',
        'WHERE [name] IN (' + collation_list + ')',
        'ORDER BY [name];',
        'GO',
        '',
        '-- ------------------------------------------------------------',
        '-- 1. Load the demo values. NVARCHAR + N-prefixed literals keep',
        '--    every code point, including supplementary-plane emoji.',
        '-- ------------------------------------------------------------',
        "IF OBJECT_ID(N'tempdb..#collation_demo') IS NOT NULL",
        '    DROP TABLE #collation_demo;',
        'GO',
        '',
        'CREATE TABLE #collation_demo (',
        '    [pair_id]       INT            NOT NULL PRIMARY KEY,',
        '    [category]      NVARCHAR(64)   NOT NULL,',
        '    [left_value]    NVARCHAR(200)  NULL,',
        '    [right_value]   NVARCHAR(200)  NULL,',
        '    [differs_under] NVARCHAR(200)  NULL',
        ');',
        'GO',
        '',
        'INSERT INTO #collation_demo',
        '    ([pair_id], [category], [left_value], [right_value],'
        ' [differs_under])',
        'VALUES',
    ]

    values = [
        '    ({0}, {1}, {2}, {3}, {4})'.format(
            pair_id,
            _collation_literal(category),
            _collation_literal(left),
            _collation_literal(right),
            _collation_literal(note),
        )
        for pair_id, category, left, right, note in COLLATION_ROWS
    ]
    lines += [',\n'.join(values) + ';', 'GO', '']

    lines += [
        '-- ------------------------------------------------------------',
        '-- 2. Japanese collations: kana type (_KS) and width (_WS).',
        '--    Japanese_XJIS_140_* are the Unicode 14 Japanese collations.',
        '--      _KS = kana sensitive   (hiragana <> katakana)',
        '--      _WS = width sensitive  (full-width <> half-width)',
        '--    Dropping _KS / _WS makes those pairs compare EQUAL.',
        '-- ------------------------------------------------------------',
        'SELECT',
        '    [pair_id],',
        '    [category],',
        '    [left_value],',
        '    [right_value],',
        '    CASE WHEN [left_value] COLLATE Japanese_XJIS_140_CI_AS_KS_WS',
        '              = [right_value] COLLATE Japanese_XJIS_140_CI_AS_KS_WS',
        "         THEN N'equal' ELSE N'different' END"
        ' AS [kana_width_sensitive],',
        '    CASE WHEN [left_value] COLLATE Japanese_XJIS_140_CI_AI',
        '              = [right_value] COLLATE Japanese_XJIS_140_CI_AI',
        "         THEN N'equal' ELSE N'different' END"
        ' AS [kana_width_insensitive]',
        'FROM #collation_demo',
        "WHERE [category] IN (N'kana_type', N'kana_width',"
        " N'kana_prolonged', N'latin_width')",
        'ORDER BY [pair_id];',
        'GO',
        '',
        '-- ------------------------------------------------------------',
        '-- 3. Case, accent and Unicode normalisation.',
        '--    Only a binary (_BIN2) collation separates the composed and',
        '--    decomposed forms of the same visible character.',
        '-- ------------------------------------------------------------',
        'SELECT',
        '    [pair_id],',
        '    [category],',
        '    CASE WHEN [left_value] COLLATE Latin1_General_100_CI_AI',
        '              = [right_value] COLLATE Latin1_General_100_CI_AI',
        "         THEN N'equal' ELSE N'different' END AS [ci_ai],",
        '    CASE WHEN [left_value] COLLATE Latin1_General_100_CS_AS',
        '              = [right_value] COLLATE Latin1_General_100_CS_AS',
        "         THEN N'equal' ELSE N'different' END AS [cs_as],",
        '    CASE WHEN [left_value] COLLATE Latin1_General_100_BIN2_UTF8',
        '              = [right_value] COLLATE Latin1_General_100_BIN2_UTF8',
        "         THEN N'equal' ELSE N'different' END AS [binary_utf8],",
        '    DATALENGTH([left_value])  AS [left_bytes],',
        '    DATALENGTH([right_value]) AS [right_bytes]',
        'FROM #collation_demo',
        "WHERE [category] IN (N'case', N'sharp_s', N'accent',"
        " N'unicode_form', N'trailing_space', N'lookalike',"
        " N'lookalike_cyrillic')",
        'ORDER BY [pair_id];',
        'GO',
        '',
        '-- ------------------------------------------------------------',
        '-- 4. Turkish dotted / dotless I.',
        '--    Turkish_100_CI_AS treats i / I and dotless i / dotted I',
        '--    differently from Latin1_General_100_CI_AS.',
        '-- ------------------------------------------------------------',
        'SELECT',
        '    [pair_id],',
        '    [left_value],',
        '    [right_value],',
        '    CASE WHEN [left_value] COLLATE Turkish_100_CI_AS',
        '              = [right_value] COLLATE Turkish_100_CI_AS',
        "         THEN N'equal' ELSE N'different' END AS [turkish_ci_as],",
        '    CASE WHEN [left_value] COLLATE Latin1_General_100_CI_AS',
        '              = [right_value] COLLATE Latin1_General_100_CI_AS',
        "         THEN N'equal' ELSE N'different' END AS [latin_ci_as]",
        'FROM #collation_demo',
        "WHERE [category] LIKE N'turkish%'",
        'ORDER BY [pair_id];',
        'GO',
        '',
        '-- ------------------------------------------------------------',
        '-- 5. Sort order depends on the collation.',
        '--    Japanese_Bushu_Kakusu_140_CI_AS orders kanji by radical and',
        '--    stroke count; a _BIN2 collation orders by code point.',
        '-- ------------------------------------------------------------',
        'SELECT [pair_id], [left_value]',
        'FROM #collation_demo',
        'ORDER BY [left_value] COLLATE Japanese_Bushu_Kakusu_140_CI_AS,'
        ' [pair_id];',
        'GO',
        '',
        'SELECT [pair_id], [left_value]',
        'FROM #collation_demo',
        'ORDER BY [left_value] COLLATE Latin1_General_100_BIN2_UTF8,'
        ' [pair_id];',
        'GO',
        '',
        '-- ------------------------------------------------------------',
        '-- 6. Grouping collapses values the collation calls equal.',
        '-- ------------------------------------------------------------',
        'SELECT',
        '    [left_value] COLLATE Japanese_XJIS_140_CI_AI'
        ' AS [grouped_value],',
        '    COUNT(*) AS [rows]',
        'FROM #collation_demo',
        'GROUP BY [left_value] COLLATE Japanese_XJIS_140_CI_AI',
        'ORDER BY [grouped_value];',
        'GO',
        '',
        '-- ------------------------------------------------------------',
        '-- 7. Clean up.',
        '-- ------------------------------------------------------------',
        "IF OBJECT_ID(N'tempdb..#collation_demo') IS NOT NULL",
        '    DROP TABLE #collation_demo;',
        'GO',
    ]

    return '\n'.join(lines) + '\n'


def generate_collation_script(root: str) -> list:
    return [write_text(os.path.join(root, 'collation_samples.sql'),
                       build_collation_script())]


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def generate_all(root: str = DEMO_DIR) -> list:
    """Generate every demo sample under *root* and return the file list."""
    created = []
    created += generate_scalar_csv(root)
    created += generate_json_samples(root)
    parquet_files, all_types_table = generate_parquet_samples(root)
    created += parquet_files
    created += generate_orc_sample(root, all_types_table)
    created += generate_excel_sample(root)
    created += generate_text_sample(root)
    created += generate_delta_table(root)
    created += generate_iceberg_table(root)
    created += generate_unicode_samples(root)
    created += generate_collation_samples(root)
    created += generate_collation_script(root)
    return sorted(created)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description='Generate the deterministic SQL File Detection Tool '
                    'demo samples.')
    parser.add_argument('--output-dir', default=DEMO_DIR,
                        help='Directory to write the samples into.')
    parser.add_argument('--quiet', action='store_true',
                        help='Do not print the generated file list.')
    args = parser.parse_args(argv)

    root = os.path.abspath(args.output_dir)
    created = generate_all(root)

    if not args.quiet:
        for path in created:
            print(os.path.relpath(path, root).replace(os.sep, '/'))
        print(f'\n{len(created)} sample files written to {root}')
    return 0


if __name__ == '__main__':  # pragma: no cover
    sys.exit(main())
