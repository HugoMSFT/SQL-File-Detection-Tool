"""The certification matrix.

The matrix is deliberately *representative*, not combinatorial. Multiplying
every fixture by every statement kind by every platform would produce thousands
of cells, most of which re-test the same code path, and the cost of that is
paid by a human reading the report. Each entry below exists because it can fail
in a way none of the others can.

Every entry declares the hypothesis it is meant to settle. That is what stops
the matrix from drifting away from the questions it was built to answer: if a
hypothesis is resolved in the code but no cell references it, the static test
suite fails.

Verdict vocabulary (shared with :mod:`evidence`)::

    PASS                    executed and every assertion held
    FAIL                    executed and an assertion did not hold
    EXEC_AFTER_SUBSTITUTION executed only after declared placeholder values
                            were substituted; the raw generator output was not
                            runnable as-is
    NOT_EXECUTABLE          could not be executed (unresolved placeholder,
                            missing staging, or an access method the target
                            genuinely does not offer)
    UNSUPPORTED_EXPECTED    the generator correctly refused, or the platform
                            documented-and-proved it does not support this
    BLOCKED                 the safety gate refused to send it
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, FrozenSet, List, Optional, Sequence, Tuple

VERDICTS: Tuple[str, ...] = (
    'PASS',
    'FAIL',
    'EXEC_AFTER_SUBSTITUTION',
    'NOT_EXECUTABLE',
    'UNSUPPORTED_EXPECTED',
    'BLOCKED',
)

#: How the engine is expected to reach the bytes. Files are *not* local to the
#: engine just because they are local to the client, and conflating the two is
#: the single most common way a generated script becomes fiction.
ACCESS_METHODS: Tuple[str, ...] = (
    'none',            # no file access at all (CREATE TABLE, FOR JSON, OPENJSON on a literal)
    'engine_local',    # a path on the engine host or a UNC share it can reach
    'blob_storage',    # EXTERNAL DATA SOURCE ... TYPE = BLOB_STORAGE (bulk source)
    'abs',             # abs:// data virtualization source
)

#: Certification targets. ``vm`` is SQL Server on an Azure VM; ``azure`` is
#: Azure SQL Database. One VM certifies exactly the version it runs, which is
#: why the platform is carried per-target rather than assumed.
TARGETS: Tuple[str, ...] = ('vm', 'azure')


@dataclass(frozen=True)
class Fixture:
    """A file (or table directory) the matrix exercises."""

    key: str
    path: str
    file_type: str
    description: str
    #: Set when the fixture cannot be staged remotely and must run engine-local.
    engine_local_only: bool = False


#: Fixtures come from the repository's own demo corpus so the certification
#: exercises exactly the bytes the demo and unit tests already describe.
FIXTURES: Tuple[Fixture, ...] = (
    Fixture('csv_scalar', 'demo/csv/sales_scalars.csv', 'csv',
            'CSV with the full scalar type spread'),
    Fixture('tsv', 'demo/csv/sales_scalars.tsv', 'csv', 'tab-separated variant'),
    Fixture('pipe', 'demo/csv/sales_scalars_pipe.csv', 'csv', 'pipe-separated variant'),
    Fixture('utf8', 'demo/unicode/unicode_utf8.csv', 'csv', 'UTF-8 without BOM'),
    Fixture('utf8_bom', 'demo/unicode/unicode_utf8_bom.csv', 'csv', 'UTF-8 with BOM'),
    Fixture('utf16le_bom', 'demo/unicode/unicode_utf16le_bom.csv', 'csv',
            'UTF-16LE with BOM — the encoding SQL Server bulk paths handle least well'),
    Fixture('cp932', 'demo/unicode/japanese_cp932.csv', 'csv',
            'Shift-JIS / CP932 Japanese text'),
    Fixture('collation', 'demo/unicode/collation_cases_utf8.csv', 'csv',
            'kana width, accent and case collation cases'),
    Fixture('json_array', 'demo/json/orders_array.json', 'json', 'JSON array document'),
    Fixture('json_object', 'demo/json/order_single_object.json', 'json',
            'single JSON object document'),
    Fixture('ndjson', 'demo/json/orders.ndjson', 'json', 'newline-delimited JSON'),
    Fixture('json_nested', 'test_data/customers_nested.json', 'json',
            'nested objects and arrays one level deep'),
    Fixture('parquet_all_types', 'demo/parquet/all_types.parquet', 'parquet',
            'every scalar and logical Parquet type the detector maps'),
    Fixture('parquet_sales', 'demo/parquet/sales.parquet', 'parquet', 'plain Parquet'),
    Fixture('orc', 'demo/orc/all_types.orc', 'orc',
            'ORC — native analysis is explicitly unsupported'),
    Fixture('excel', 'demo/excel/inventory.xlsx', 'excel',
            'Excel workbook — a binary format with no external file format'),
    Fixture('text', 'demo/text/readme_sample.txt', 'text', 'unstructured text'),
    Fixture('delta', 'demo/tables/events_delta', 'delta',
            'Delta Lake table, protocol minReader=1 / minWriter=2'),
    Fixture('iceberg', 'demo/tables/events_iceberg', 'iceberg', 'Apache Iceberg table'),
)

FIXTURES_BY_KEY: Dict[str, Fixture] = {f.key: f for f in FIXTURES}


@dataclass(frozen=True)
class Assertion:
    """One checkable claim about a cell.

    ``kind`` is interpreted by :mod:`evidence`:

    ``sql_contains`` / ``sql_excludes``     literal text in generated *code*
                                            (comments stripped first)
    ``sql_matches``                         regular expression over code
    ``row_count``                           exact row count from execution
    ``column_count``                        exact column count
    ``value_equals``                        one scalar equals an expected value
    ``no_error``                            execution raised nothing
    ``error_number``                        execution raised this SQL error
    """

    kind: str
    value: object
    detail: str = ''


@dataclass(frozen=True)
class MatrixEntry:
    """One row of the certification matrix."""

    cell_id: str
    fixture: str
    statement_kind: str
    targets: Sequence[str]
    access: str
    hypothesis: str
    intent: str
    #: Verdicts that count as success for this cell. Anything else is a defect.
    accepts: Sequence[str] = ('PASS',)
    static_assertions: Sequence[Assertion] = field(default_factory=tuple)
    notes: str = ''

    def applies_to(self, target: str) -> bool:
        return target in self.targets


def platform_for(target: str, *, vm_platform: str = 'sql_server_2025') -> str:
    """Map a certification target onto the generator's platform identifier.

    ``vm_platform`` is passed in rather than assumed: the live VM certifies the
    version it actually runs, and claiming coverage for 2019 or 2022 from a 2025
    host would be exactly the kind of overclaim this harness exists to prevent.
    """
    if target == 'vm':
        return vm_platform
    if target == 'azure':
        return 'azure_sql_db'
    raise ValueError(f'unknown certification target {target!r}')


A = Assertion

#: The matrix itself.
MATRIX: Tuple[MatrixEntry, ...] = (
    # -- naming safety ---------------------------------------------------
    MatrixEntry(
        'C01', 'csv_scalar', 'create_table', ('vm', 'azure'), 'none', 'H1',
        'A caller-supplied table and schema name must propagate to every '
        'statement so a file called orders.csv can never resolve to dbo.orders.',
        static_assertions=(
            A('sql_excludes', '[dbo]', 'no dbo anywhere in generated code'),
            A('sql_matches', r'CREATE TABLE \[sqlfdt_cert_[0-9a-f]{8}\]\.'),
        ),
    ),
    # -- encoding --------------------------------------------------------
    MatrixEntry(
        'C02', 'utf8_bom', 'bulk_insert', ('vm', 'azure'), 'blob_storage', 'H2',
        'UTF-8 with a BOM must load with CODEPAGE 65001 and the BOM must not '
        'appear in the first column value.',
    ),
    MatrixEntry(
        'C03', 'utf16le_bom', 'bulk_insert', ('vm', 'azure'), 'blob_storage', 'H2',
        'UTF-16LE is the case CODEPAGE alone cannot express: SQL Server bulk '
        'paths need DATAFILETYPE = widechar, and CODEPAGE = 1200 without it is '
        'rejected or silently mangles the data.',
        static_assertions=(
            A('sql_matches', r"DATAFILETYPE\s*=\s*'widechar'",
              'UTF-16 bulk load must select the wide-character data file type'),
            A('sql_excludes', "CODEPAGE        = '1200'",
              'CODEPAGE 1200 is not a valid BULK INSERT codepage'),
        ),
    ),
    MatrixEntry(
        'C04', 'cp932', 'bulk_insert', ('vm', 'azure'), 'blob_storage', 'H2',
        'CP932 must map to CODEPAGE 932 and round-trip kana exactly.',
        static_assertions=(A('sql_matches', r"CODEPAGE\s+=\s+'932'"),),
    ),
    MatrixEntry(
        'C05', 'utf16le_bom', 'external_file_format', ('vm', 'azure'), 'abs', 'H2',
        'CREATE EXTERNAL FILE FORMAT only accepts ENCODING UTF8 or UTF16; any '
        'other detected encoding must degrade to a documented choice rather '
        'than emit an invalid keyword.',
        static_assertions=(
            A('sql_matches', r"ENCODING = '(?:UTF8|UTF16)'"),
        ),
    ),
    MatrixEntry(
        'C06', 'cp932', 'external_file_format', ('vm', 'azure'), 'abs', 'H2',
        'A CP932 file has no external-file-format encoding; the generator must '
        'say so instead of emitting ENCODING = CP932.',
        static_assertions=(A('sql_excludes', "ENCODING = 'CP932'"),),
    ),
    # -- JSON ------------------------------------------------------------
    MatrixEntry(
        'C07', 'json_array', 'json_functions', ('vm', 'azure'), 'none', 'H3',
        'OPENJSON over a literal document must parse arrays and round-trip '
        'non-ASCII text exactly.',
    ),
    MatrixEntry(
        'C08', 'json_array', 'openrowset', ('vm', 'azure'), 'blob_storage', 'H3',
        'Remote whole-document JSON through a TYPE = BLOB_STORAGE bulk source. '
        'Live engines accept SINGLE_CLOB with a BLOB_STORAGE DATA_SOURCE, so '
        'the generator must use it instead of framing the document through the '
        'CSV reader with non-printing terminators.',
        static_assertions=(
            A('sql_matches', r'SINGLE_CLOB',
              'BLOB_STORAGE bulk sources do support SINGLE_CLOB + DATA_SOURCE'),
        ),
    ),
    MatrixEntry(
        'C09', 'json_array', 'openrowset', ('vm', 'azure'), 'abs', 'H3',
        'Remote JSON through an abs:// virtualization source. This is the case '
        'where SINGLE_CLOB genuinely cannot be combined with DATA_SOURCE, so '
        'row framing is correct here and only here.',
        accepts=('PASS', 'UNSUPPORTED_EXPECTED'),
        static_assertions=(A('sql_excludes', 'SINGLE_CLOB'),),
    ),
    MatrixEntry(
        'C10', 'ndjson', 'json_functions', ('vm', 'azure'), 'none', 'H3',
        'NDJSON is not a JSON document; the generator must frame it per line.',
    ),
    MatrixEntry(
        'C11', 'json_nested', 'json_functions', ('vm', 'azure'), 'none', 'H3',
        'Nested objects and arrays must surface as JSON text, not as a silently '
        'flattened scalar.',
    ),
    MatrixEntry(
        'C12', 'json_object', 'for_json', ('vm', 'azure'), 'none', 'H3',
        'FOR JSON PATH with INCLUDE_NULL_VALUES must preserve explicit nulls.',
    ),
    # -- CSV through both remote access shapes ---------------------------
    MatrixEntry(
        'C13', 'csv_scalar', 'openrowset', ('vm', 'azure'), 'abs', 'H6',
        'CSV through abs:// virtualization with FORMAT = CSV.',
        static_assertions=(
            A('sql_matches', r"FORMAT\s*=\s*'CSV'"),
            A('sql_excludes', 'FORMATFILE',
              'a FORMATFILE placeholder is not executable'),
        ),
    ),
    MatrixEntry(
        'C14', 'csv_scalar', 'bulk_insert', ('vm', 'azure'), 'blob_storage', 'H6',
        'CSV through a BLOB_STORAGE bulk source with BULK INSERT.',
        static_assertions=(A('sql_matches', r"FORMAT\s*=\s*'CSV'"),),
    ),
    MatrixEntry(
        'C15', 'csv_scalar', 'openrowset', ('vm',), 'engine_local', 'H6',
        'CSV from a path the engine can open itself. The generated OPENROWSET '
        'must be runnable, not a FORMATFILE placeholder.',
        accepts=('PASS', 'NOT_EXECUTABLE'),
        static_assertions=(
            A('sql_excludes', '<path_to_format_file.xml>',
              'placeholder FORMATFILE makes the statement non-executable'),
        ),
        notes='Requires the parent to stage the fixture on the engine host.',
    ),
    # -- external tables -------------------------------------------------
    MatrixEntry(
        'C16', 'csv_scalar', 'external_file_format', ('vm', 'azure'), 'abs', 'H_FIRSTROW',
        'A header row must be skipped by the external file format itself. '
        'Without FIRST_ROW the header is converted to the column type and the '
        'query fails with error 4864.',
        static_assertions=(A('sql_matches', r'FIRST_ROW = 2'),),
    ),
    MatrixEntry(
        'C17', 'csv_scalar', 'create_external_table', ('vm', 'azure'), 'abs', 'H_FIRSTROW',
        'External table over CSV returns the exact row count with no header row.',
    ),
    MatrixEntry(
        'C18', 'parquet_all_types', 'create_external_table', ('vm', 'azure'), 'abs', 'H10',
        'Parquet external table: decimal scale, timestamp precision and nulls '
        'must survive.',
    ),
    MatrixEntry(
        'C19', 'parquet_all_types', 'create_table', ('vm', 'azure'), 'none', 'H10',
        'Parquet logical types map to SQL types that can hold them.',
        static_assertions=(
            A('sql_excludes', 'DECIMAL(38,10) NOT NULL',
              'inferred decimals must stay nullable unless proven otherwise'),
        ),
    ),
    MatrixEntry(
        'C20', 'csv_scalar', 'external_file_format', ('vm', 'azure'), 'abs', 'H5',
        'USE_TYPE_DEFAULT = TRUE replaces missing values with 0 / empty string '
        'and destroys null fidelity. The behaviour-safe default is FALSE.',
        static_assertions=(
            A('sql_matches', r'USE_TYPE_DEFAULT = FALSE'),
        ),
    ),
    # -- formats with no external file format ----------------------------
    MatrixEntry(
        'C21', 'excel', 'external_file_format', ('vm', 'azure'), 'abs', 'H4',
        'Excel is a binary workbook. It must never fall through to '
        'DELIMITEDTEXT, which would produce a script that runs and returns '
        'garbage.',
        accepts=('UNSUPPORTED_EXPECTED',),
        static_assertions=(
            A('sql_excludes', 'DELIMITEDTEXT'),
            A('sql_matches', r'not supported|unsupported'),
        ),
    ),
    MatrixEntry(
        'C22', 'iceberg', 'external_file_format', ('vm', 'azure'), 'abs', 'H4',
        'Iceberg has no CREATE EXTERNAL FILE FORMAT type; falling through to '
        'DELIMITEDTEXT would misrepresent the table.',
        accepts=('UNSUPPORTED_EXPECTED',),
        static_assertions=(
            A('sql_excludes', 'DELIMITEDTEXT'),
            A('sql_matches', r'not supported|unsupported'),
        ),
    ),
    MatrixEntry(
        'C23', 'orc', 'external_file_format', ('vm',), 'abs', 'H4',
        'ORC is recognised but not analysable natively; the generator may still '
        'emit FORMAT_TYPE = ORC from a caller-supplied schema.',
        accepts=('PASS', 'UNSUPPORTED_EXPECTED', 'NOT_EXECUTABLE'),
    ),
    MatrixEntry(
        'C24', 'text', 'create_table', ('vm', 'azure'), 'none', 'H4',
        'Unstructured text maps to a single wide column, not to a fabricated '
        'delimited schema.',
    ),
    # -- Delta -----------------------------------------------------------
    MatrixEntry(
        'C25', 'delta', 'openrowset', ('vm', 'azure'), 'abs', 'H10',
        'Delta must point at the table folder with a trailing slash, and the '
        'result certifies protocol minReader=1 / minWriter=2 only.',
        static_assertions=(
            A('sql_matches', r"FORMAT\s*=\s*'DELTA'"),
            A('sql_matches', r"BULK\s+'[^']*/'", 'Delta location needs a trailing slash'),
        ),
    ),
    # -- credentials -----------------------------------------------------
    MatrixEntry(
        'C26', 'csv_scalar', 'credential_setup', ('azure',), 'abs', 'H8',
        'Managed identity must be offered for private storage instead of '
        'forcing a database master key and a SAS secret into the script.',
        accepts=('PASS', 'NOT_EXECUTABLE'),
        static_assertions=(
            A('sql_matches', r"IDENTITY = 'MANAGED IDENTITY'"),
        ),
        notes='The harness never mutates RBAC; this cell certifies the emitted '
              'shape and, where a public container is used, that a '
              'credential-free data source is offered first.',
    ),
    MatrixEntry(
        'C27', 'csv_scalar', 'credential_setup', ('vm', 'azure'), 'abs', 'H8',
        'A public container needs no credential at all; the generator must say '
        'so rather than demand a SAS token.',
        accepts=('PASS', 'NOT_EXECUTABLE'),
    ),
    # -- whole document --------------------------------------------------
    MatrixEntry(
        'C28', 'csv_scalar', 'complete_ddl', ('vm', 'azure'), 'abs', 'H7',
        'The complete document must either be runnable as-is or state plainly '
        'which placeholders remain. It must also be idempotent enough to rerun.',
        accepts=('PASS', 'EXEC_AFTER_SUBSTITUTION'),
    ),
    MatrixEntry(
        'C29', 'csv_scalar', 'complete_ddl', ('vm', 'azure'), 'abs', 'H7',
        'Second execution of the same document: rerun behaviour is part of the '
        'contract, not an accident.',
        accepts=('PASS', 'EXEC_AFTER_SUBSTITUTION', 'UNSUPPORTED_EXPECTED'),
    ),
    # -- negative --------------------------------------------------------
    MatrixEntry(
        'C30', 'csv_scalar', 'create_table', ('vm', 'azure'), 'none', 'H1',
        'Negative control: the default, file-derived name is generated and the '
        'safety gate must refuse to execute it because it is not run-scoped.',
        accepts=('BLOCKED',),
    ),
    # -- attribution -----------------------------------------------------
    MatrixEntry(
        'C31', 'csv_scalar', 'external_file_format', ('vm', 'azure'), 'none', 'H9',
        'Version attribution: the generated script must name the platform it '
        'was generated for, so a verdict recorded on one engine is never read '
        'as covering a version that was never run. The live run reaches exactly '
        'two engines (SQL Server 2025 and Azure SQL Database); every other '
        'platform in the generator stays static-only.',
        static_assertions=(
            Assertion('sql_contains', 'CREATE EXTERNAL FILE FORMAT'),
        ),
        accepts=('PASS', 'EXEC_AFTER_SUBSTITUTION', 'BLOCKED'),
    ),
)

#: Engines the live certification run actually reaches. A PASS recorded by this
#: harness attributes to exactly these two products and nothing else: the other
#: entries in ``SQLGenerator.PLATFORMS`` remain covered by static tests only.
#: This is the machine-readable half of hypothesis H9.
LIVE_CERTIFIED_PLATFORMS = ('sql_server_2025', 'azure_sql_db')

#: Platforms the generator supports but that no live engine in this run covers.
STATIC_ONLY_PLATFORMS = (
    'sql_server_2019',
    'sql_server_2022',
    'azure_sql_mi',
    'fabric_sql_db',
)

MATRIX_BY_ID: Dict[str, MatrixEntry] = {entry.cell_id: entry for entry in MATRIX}

#: Every hypothesis the matrix is expected to settle. Kept explicit so a
#: hypothesis cannot quietly lose its coverage.
HYPOTHESES: Dict[str, str] = {
    'H1': 'Default/file-derived names can collide with existing TPC-H objects; '
          'the table and schema must be overridable end to end, including from '
          'the command line.',
    'H2': 'UTF-16LE needs DATAFILETYPE = widechar for bulk paths, and external '
          'file formats accept only UTF8/UTF16 as ENCODING.',
    'H3': 'SINGLE_CLOB rules differ by source type: a TYPE = BLOB_STORAGE bulk '
          'source accepts SINGLE_CLOB with DATA_SOURCE, an abs:// '
          'virtualization source does not.',
    'H4': 'Excel and Iceberg must never fall through to a DELIMITEDTEXT '
          'external file format.',
    'H5': 'USE_TYPE_DEFAULT = TRUE destroys null fidelity for external CSV '
          'tables.',
    'H6': 'A local OPENROWSET over CSV with a placeholder FORMATFILE is not '
          'executable; FORMAT = CSV is where the engine supports it.',
    'H7': 'A complete script must not claim to be runnable while placeholders '
          'remain.',
    'H8': 'Managed identity should be offered for private Azure storage rather '
          'than forcing a master key and SAS secret.',
    'H9': 'One VM certifies only the engine version it runs.',
    'H10': 'Delta certification covers protocol minReader=1 / minWriter=2 only; '
           'Parquet logical types must map to types that can hold them.',
    'H_FIRSTROW': 'FIRST_ROW in CREATE EXTERNAL FILE FORMAT: platform gating '
                  'must follow live engine evidence, not the generic '
                  'documentation annotation.',
}


def entries_for(target: str) -> List[MatrixEntry]:
    return [entry for entry in MATRIX if entry.applies_to(target)]


def covered_hypotheses() -> FrozenSet[str]:
    return frozenset(entry.hypothesis for entry in MATRIX)


def uncovered_hypotheses() -> FrozenSet[str]:
    return frozenset(HYPOTHESES) - covered_hypotheses()
