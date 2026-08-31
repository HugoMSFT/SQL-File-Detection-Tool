#!/usr/bin/env python
"""Generate Python parity baselines for the native TypeScript analysis core.

The native core in ``src/native`` is a from-scratch TypeScript port of
:mod:`external_file_detection.file_detector` and
:mod:`external_file_detection.sql_generator`. To prove the port, this script
records what the *current Python implementation* produces for the committed
``demo/`` fixtures and writes it to a JSON baseline that the Node test suite
compares against.

The baseline is deliberately normalised so it is reproducible on any machine:

* paths are repository-relative and always use forward slashes,
* absolute paths are never recorded,
* nondeterministic or environment-specific values (encoding confidence,
  serialized footer size, wall-clock timestamps) are dropped,
* generated SQL is reduced to order-preserving *semantic invariants* rather
  than exact whitespace, because the port is allowed to normalise formatting.

Usage::

    python scripts/generate_parity_baselines.py            # rewrite baseline
    python scripts/generate_parity_baselines.py --check    # verify only
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from external_file_detection.file_detector import FileDetector  # noqa: E402
from external_file_detection.sql_generator import SQLGenerator  # noqa: E402

BASELINE_PATH = os.path.join(
    REPO_ROOT, 'tests', 'native_parity', 'python_baseline.json'
)

#: Fixtures covered by the parity matrix, relative to the repository root.
FIXTURES: List[str] = [
    'demo/csv/sales_scalars.csv',
    'demo/csv/sales_scalars.tsv',
    'demo/csv/sales_scalars_pipe.csv',
    'demo/json/orders_array.json',
    'demo/json/orders.ndjson',
    'demo/json/order_single_object.json',
    'demo/parquet/all_types.parquet',
    'demo/parquet/sales.parquet',
    'demo/excel/inventory.xlsx',
    'demo/orc/all_types.orc',
    'demo/text/readme_sample.txt',
    'demo/unicode/unicode_utf8.csv',
    'demo/unicode/unicode_utf8_bom.csv',
    'demo/unicode/unicode_utf16le_bom.csv',
    'demo/unicode/unicode_utf16le_bom.tsv',
    'demo/unicode/japanese_cp932.csv',
    'demo/unicode/collation_cases_utf8.csv',
    'demo/tables/events_delta',
    'demo/tables/events_iceberg',
]

#: Storage URLs exercised by the generator matrix.
STORAGE_URLS: Dict[str, Optional[str]] = {
    'local': None,
    'azure_blob': 'https://acct.blob.core.windows.net/container/folder/file.csv',
    'adls': 'abfss://container@acct.dfs.core.windows.net/folder/file.csv',
    's3': 's3://bucket/folder/file.csv',
    'onelake': 'abfss://workspace@onelake.dfs.fabric.microsoft.com/lh/Files/f',
}

#: Metadata keys that are environment specific or otherwise not comparable.
VOLATILE_METADATA_KEYS = frozenset({
    'file_path',
    'encoding_confidence',
    'encoding_warning',
})

#: ``parquet_metadata`` members that depend on the reader rather than the file.
VOLATILE_PARQUET_KEYS = frozenset({'serialized_size'})

#: ``delta_metadata`` members that depend on table creation time.
VOLATILE_DELTA_KEYS = frozenset({'created_time'})


def _relative(path: str) -> str:
    return os.path.relpath(path, REPO_ROOT).replace(os.sep, '/')


def _normalise_metadata(metadata: Dict[str, Any]) -> Dict[str, Any]:
    """Strip environment-specific values and sort for stable diffing."""
    normalised: Dict[str, Any] = {}
    for key, value in metadata.items():
        if key in VOLATILE_METADATA_KEYS:
            continue
        if key == 'encoding' and str(value).lower().replace('-', '_') in {
            'shift_jis',
            'shiftjis',
            'sjis',
        }:
            normalised[key] = 'cp932'
            continue
        if key == 'schema' and value:
            normalised[key] = [[str(name), str(dtype)] for name, dtype in value]
            continue
        if key == 'parquet_metadata' and isinstance(value, dict):
            normalised[key] = {
                inner: outer
                for inner, outer in sorted(value.items())
                if inner not in VOLATILE_PARQUET_KEYS
            }
            continue
        if key == 'delta_metadata' and isinstance(value, dict):
            normalised[key] = {
                inner: outer
                for inner, outer in sorted(value.items())
                if inner not in VOLATILE_DELTA_KEYS
            }
            continue
        normalised[key] = value
    return dict(sorted(normalised.items()))


#: Structural markers extracted from generated T-SQL. Comparing these instead of
#: raw text lets the TypeScript port normalise whitespace while still proving it
#: emits the same statements, options, identifiers and platform gating.
_INVARIANT_PATTERNS = (
    re.compile(r'\bCREATE\s+TABLE\s+(\[[^\]]*\]\.\[[^\]]*\])', re.IGNORECASE),
    re.compile(r'\bCREATE\s+EXTERNAL\s+TABLE\s+(\[[^\]]*\]\.\[[^\]]*\])',
               re.IGNORECASE),
    re.compile(r'\bCREATE\s+EXTERNAL\s+FILE\s+FORMAT\s+(\[[^\]]*\])',
               re.IGNORECASE),
    re.compile(r'\bCREATE\s+EXTERNAL\s+DATA\s+SOURCE\s+(\[[^\]]*\])',
               re.IGNORECASE),
    re.compile(r'\bCREATE\s+DATABASE\s+SCOPED\s+CREDENTIAL\s+(\[[^\]]*\])',
               re.IGNORECASE),
    re.compile(r'\bBULK\s+INSERT\s+(\[[^\]]*\]\.\[[^\]]*\])', re.IGNORECASE),
    re.compile(r'\bFORMAT_TYPE\s*=\s*(\w+)', re.IGNORECASE),
    re.compile(r'\bFORMAT\s*=\s*\'([^\']*)\'', re.IGNORECASE),
    re.compile(r'\bDATA_SOURCE\s*=\s*\'([^\']*)\'', re.IGNORECASE),
    re.compile(r'\bDATA_SOURCE\s*=\s*(\[[^\]]*\])', re.IGNORECASE),
    re.compile(r'\bLOCATION\s*=\s*\'([^\']*)\'', re.IGNORECASE),
    re.compile(r'\bBULK\s+N?\'([^\']*)\'', re.IGNORECASE),
    re.compile(r'\bTYPE\s*=\s*(HADOOP|BLOB_STORAGE)\b', re.IGNORECASE),
    re.compile(r'\bCODEPAGE\s*=\s*\'([^\']*)\'', re.IGNORECASE),
    re.compile(r'\bFIELDTERMINATOR\s*=\s*\'([^\']*)\'', re.IGNORECASE),
    re.compile(r'\bFIELD_TERMINATOR\s*=\s*\'([^\']*)\'', re.IGNORECASE),
    re.compile(r'\bFIRSTROW\s*=\s*(\d+)', re.IGNORECASE),
    re.compile(r'\bFIRST_ROW\s*=\s*(\d+)', re.IGNORECASE),
    re.compile(r'\bROWTERMINATOR\s*=\s*\'([^\']*)\'', re.IGNORECASE),
    re.compile(r'\bROW_TERMINATOR\s*=\s*\'([^\']*)\'', re.IGNORECASE),
    # USE_TYPE_DEFAULT decides whether an empty CSV field arrives as NULL or as
    # a zero, which is a semantic difference the live matrix asserts on. It is
    # exactly the kind of option a port can drop without any test noticing.
    re.compile(r'\bUSE_TYPE_DEFAULT\s*=\s*(TRUE|FALSE)\b', re.IGNORECASE),
    re.compile(r'\bSTRING_DELIMITER\s*=\s*\'([^\']*)\'', re.IGNORECASE),
    re.compile(r'\bFIELDQUOTE\s*=\s*\'([^\']*)\'', re.IGNORECASE),
    re.compile(r'\bENCODING\s*=\s*\'([^\']*)\'', re.IGNORECASE),
    re.compile(r'\bDATAFILETYPE\s*=\s*\'([^\']*)\'', re.IGNORECASE),
    # The credential shape is a security property: identity-based methods store
    # no secret, while SAS and S3 access-key methods require one.
    re.compile(r'\bIDENTITY\s*=\s*\'(MANAGED\s+IDENTITY|USER\s+IDENTITY|SHARED\s+ACCESS\s+SIGNATURE|S3\s+ACCESS\s+KEY)\'',
               re.IGNORECASE),
    # A live TRUNCATE in a generated document empties a table the user already
    # had. It is only ever correct for a caller-owned schema, so it belongs in
    # the parity markers where a change to either generator has to be explained.
    # Anchored so the commented guidance form does not count as a live one.
    re.compile(r'^\s*TRUNCATE\s+TABLE\s+(\[[^\]]*\]\.\[[^\]]*\])',
               re.IGNORECASE | re.MULTILINE),
    re.compile(r'\bREJECT_TYPE\s*=\s*(\w+)', re.IGNORECASE),
    re.compile(r'\bSERDE_METHOD\s*=\s*\'([^\']*)\'', re.IGNORECASE),
    re.compile(r'\bDATA_COMPRESSION\s*=\s*\'([^\']*)\'', re.IGNORECASE),
    re.compile(r'\b(SINGLE_CLOB|SINGLE_NCLOB|SINGLE_BLOB)\b', re.IGNORECASE),
    re.compile(r'\bNOT\s+AVAILABLE\s+on\s+(.+)$', re.IGNORECASE | re.MULTILINE),
)


def _statement_invariants(sql: str) -> Dict[str, Any]:
    """Reduce a generated statement to comparable structural facts."""
    code_lines = [
        line for line in sql.splitlines()
        if line.strip() and not line.strip().startswith('--')
    ]
    code = '\n'.join(code_lines)

    markers: List[str] = []
    for pattern in _INVARIANT_PATTERNS:
        for match in pattern.finditer(sql):
            captured = match.group(1) if match.groups() else match.group(0)
            markers.append(f'{pattern.pattern}=>{captured.strip()}')

    columns = re.findall(
        r'^\s*(\[[^\]]*\])\s+([A-Za-z][A-Za-z0-9_]*(?:\s*\([^)]*\))?)',
        code,
        re.MULTILINE,
    )
    return {
        'markers': markers,
        'columns': [[name, ' '.join(sql_type.split())] for name, sql_type in columns],
        'go_batches': len([
            line for line in sql.splitlines() if line.strip().upper() == 'GO'
        ]),
        'has_sql': bool(code_lines),
    }


def build_baseline() -> Dict[str, Any]:
    detector = FileDetector()
    generator = SQLGenerator()

    metadata_baseline: Dict[str, Any] = {}
    statements_baseline: Dict[str, Any] = {}

    for fixture in FIXTURES:
        absolute = os.path.join(REPO_ROOT, fixture.replace('/', os.sep))
        if not os.path.exists(absolute):
            raise FileNotFoundError(f'Missing parity fixture: {fixture}')

        metadata = detector.analyze_file_metadata(absolute)
        metadata_baseline[fixture] = _normalise_metadata(metadata)

        # Keep the generator input path stable across machines: the generator
        # only ever uses it to derive a table name and a local BULK path.
        portable = dict(metadata)
        portable['file_path'] = fixture

        for platform in SQLGenerator.PLATFORMS:
            for url_label, storage_url in STORAGE_URLS.items():
                statements = generator.generate_all_statements(
                    portable,
                    table_name=None,
                    data_source='MyDataSource',
                    location=None,
                    schema_name='dbo',
                    target_platform=platform,
                    storage_url=storage_url,
                )
                key = f'{fixture}|{platform}|{url_label}'
                statements_baseline[key] = {
                    name: _statement_invariants(sql)
                    for name, sql in sorted(statements.items())
                }

    return {
        'version': 1,
        'description': (
            'Normalised Python reference output for the native TypeScript '
            'analysis core. Regenerate with '
            'python scripts/generate_parity_baselines.py'
        ),
        'default_target_platform': SQLGenerator.DEFAULT_PLATFORM,
        'platforms': list(SQLGenerator.PLATFORMS),
        'storage_urls': STORAGE_URLS,
        'metadata': metadata_baseline,
        'statements': statements_baseline,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--check',
        action='store_true',
        help='Fail if the committed baseline is out of date instead of rewriting it.',
    )
    args = parser.parse_args()

    baseline = build_baseline()
    serialised = json.dumps(baseline, indent=1, sort_keys=True, default=str)
    serialised += '\n'

    if args.check:
        if not os.path.exists(BASELINE_PATH):
            print(f'Baseline missing: {_relative(BASELINE_PATH)}')
            return 1
        with open(BASELINE_PATH, 'r', encoding='utf-8') as handle:
            current = handle.read()
        if current != serialised:
            print(f'Baseline out of date: {_relative(BASELINE_PATH)}')
            return 1
        print(f'Baseline up to date: {_relative(BASELINE_PATH)}')
        return 0

    os.makedirs(os.path.dirname(BASELINE_PATH), exist_ok=True)
    with open(BASELINE_PATH, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(serialised)
    print(
        f'Wrote {_relative(BASELINE_PATH)} '
        f'({len(baseline["metadata"])} fixtures, '
        f'{len(baseline["statements"])} statement sets)'
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
