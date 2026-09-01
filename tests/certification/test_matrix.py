"""The matrix and the recorded live evidence must stay in step with the Python
generator. ``expected-matrix.json`` is the single source both language test
suites read, so neither implementation can drift away from what an engine
actually did.
"""

import json
import os
import re

import pytest

from certification.matrix import (
    FIXTURES,
    ACCESS_METHODS,
    HYPOTHESES,
    MATRIX,
    MATRIX_BY_ID,
    VERDICTS,
    covered_hypotheses,
    uncovered_hypotheses,
)

from external_file_detection.sql_generator import AUTH_METHODS, SQLGenerator

DDL_ONLY_CERTIFIED_FORMATS = SQLGenerator.DDL_ONLY_CERTIFIED_FORMATS
FIRST_ROW_FORMAT_PLATFORMS = SQLGenerator.FIRST_ROW_FORMAT_PLATFORMS
NO_EXTERNAL_FORMAT_FILE_TYPES = SQLGenerator.NO_EXTERNAL_FORMAT_FILE_TYPES

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))


def _code(sql):
    """Strip comment lines so assertions cannot pass on prose alone."""
    return '\n'.join(
        line for line in sql.split('\n') if not line.strip().startswith('--')
    )


@pytest.fixture(scope='module')
def expected():
    with open(os.path.join(HERE, 'expected-matrix.json'), 'r', encoding='utf-8') as fh:
        return json.load(fh)


@pytest.fixture(scope='module')
def rules(expected):
    return {rule['id']: rule for rule in expected['rules']}


# ---------------------------------------------------------------------------
# Matrix structure
# ---------------------------------------------------------------------------

def test_cell_ids_are_unique():
    assert len(MATRIX_BY_ID) == len(MATRIX)


def test_every_cell_uses_a_known_access_method_and_verdict():
    for entry in MATRIX:
        assert entry.access in ACCESS_METHODS, entry.cell_id
        for verdict in entry.accepts:
            assert verdict in VERDICTS, entry.cell_id


def test_every_cell_names_a_declared_hypothesis():
    for entry in MATRIX:
        assert entry.hypothesis in HYPOTHESES, entry.cell_id


def test_every_hypothesis_has_at_least_one_cell():
    # The completeness invariant that caught H9 having no cell at all.
    assert uncovered_hypotheses() == frozenset()
    assert covered_hypotheses() <= frozenset(HYPOTHESES)


def test_every_cell_targets_at_least_one_engine():
    for entry in MATRIX:
        assert entry.targets, entry.cell_id
        assert set(entry.targets) <= {'vm', 'azure'}, entry.cell_id


def test_unsupported_cells_name_the_error_they_expect():
    # Accepting *any* error as "unsupported as expected" would let a typo in
    # the generated SQL be filed as a platform limitation.
    for entry in MATRIX:
        if 'UNSUPPORTED_EXPECTED' in entry.accepts:
            assert entry.expected_errors, entry.cell_id
            for number in entry.expected_errors:
                assert isinstance(number, int) and number > 0, entry.cell_id


def test_expected_errors_are_only_declared_where_they_apply():
    for entry in MATRIX:
        if entry.expected_errors:
            assert 'UNSUPPORTED_EXPECTED' in entry.accepts, entry.cell_id


def test_not_executable_acceptance_is_pinned_to_specific_output():
    for entry in MATRIX:
        if tuple(entry.accepts) == ('NOT_EXECUTABLE',):
            assert entry.static_assertions, entry.cell_id


# ---------------------------------------------------------------------------
# Evidence file integrity
# ---------------------------------------------------------------------------

def test_rules_reference_declared_hypotheses(rules):
    for rule in rules.values():
        assert rule['hypothesis'] in HYPOTHESES, rule['id']


def test_evidence_kinds_are_known(rules):
    for rule in rules.values():
        assert rule['evidence'] in {'live', 'live-negative', 'static'}, rule['id']


def test_live_rules_name_the_engines_that_ran_them(expected, rules):
    certified = {engine['id'] for engine in expected['engines_certified']}
    for rule in rules.values():
        if rule['evidence'].startswith('live'):
            assert rule.get('engines'), rule['id']
            assert set(rule['engines']) <= certified, rule['id']


def test_no_environment_identifiers_leak_into_the_evidence_file(expected):
    blob = json.dumps(expected)
    # No private SQL endpoint, no local paths, no database name.
    assert 'database.windows.net' not in blob
    assert not re.search(r'\b[A-Za-z]:\\\\', blob)
    assert 'tpch' not in blob.lower()

    # No IP addresses. Dotted-quad *version* literals such as the ARM template
    # contentVersion 1.0.0.0 quoted from the public fixture are not addresses,
    # so they are allowed: every octet below 10 cannot be a routable host in
    # the certification environment, whose address is a public IPv4.
    for match in re.finditer(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', blob):
        octets = [int(part) for part in match.group(0).split('.')]
        assert all(octet < 10 for octet in octets), match.group(0)


# ---------------------------------------------------------------------------
# The generator must agree with the recorded evidence
# ---------------------------------------------------------------------------

def test_first_row_platforms_match_evidence(rules):
    expect = rules['R10']['expect']
    assert set(FIRST_ROW_FORMAT_PLATFORMS) == set(expect['platforms'])
    for platform in expect['excluded_platforms']:
        assert platform not in FIRST_ROW_FORMAT_PLATFORMS


def test_managed_identity_platforms_match_evidence(rules):
    from external_file_detection.sql_generator import MANAGED_IDENTITY_PLATFORMS

    expect = rules['R09']['expect']
    assert set(MANAGED_IDENTITY_PLATFORMS) == set(expect['supported_platforms'])
    assert expect['default_auth_method'] in AUTH_METHODS


def test_binary_workbook_types_have_no_external_format(rules):
    expect = rules['R07']['expect']
    generator = SQLGenerator()
    for file_type in expect['file_types']:
        assert file_type in NO_EXTERNAL_FORMAT_FILE_TYPES
        metadata = {
            'file_path': f'C:/data/book.{file_type}',
            'file_name': f'book.{file_type}',
            'file_type': file_type,
            'encoding': 'utf-8',
            'delimiter': ',',
            'columns': [{'name': 'a', 'sql_type': 'INT', 'nullable': True}],
        }
        outputs = {
            'format': generator.generate_external_file_format(
                metadata, format_name='sqlfdt_cert_fmt',
                target_platform='azure_sql_db'),
            'table': generator.generate_external_table(
                metadata, table_name='sqlfdt_cert_t',
                target_platform='azure_sql_db'),
        }
        for where, sql in outputs.items():
            for banned in expect['generated_code_excludes']:
                assert banned not in sql, f'{file_type}/{where}: {banned}'
            # An empty format type must never reach the platform lookup and
            # produce "CREATE EXTERNAL ... ()" with a generic message.
            assert not re.search(r'EXTERNAL (FILE FORMAT|TABLE) \(\)', sql), (
                f'{file_type}/{where}')
            assert re.search(
                r'not available|not supported|unsupported', sql, re.I)


def test_ddl_only_formats_are_not_claimed_as_data_certified(rules):
    # ORC and Delta both had their DDL accepted and their data path unverified.
    assert 'ORC' in {f.upper() for f in DDL_ONLY_CERTIFIED_FORMATS}
    sql = SQLGenerator().generate_external_file_format(
        {'file_name': 'part.orc', 'file_type': 'orc', 'encoding': 'utf-8'},
        format_name='sqlfdt_cert_fmt',
        target_platform='azure_sql_db',
    )
    assert re.search(r'FORMAT_TYPE\s*=\s*ORC', sql)
    assert rules['R12']['expect']['guidance_must_not_say'].lower() not in sql.lower()


def test_whole_document_json_uses_a_bulk_blob_storage_source(rules):
    expect = rules['R05']['expect']
    generator = SQLGenerator()
    metadata = {
        'file_path': 'C:/data/doc.json',
        'file_name': 'doc.json',
        'file_type': 'json',
        'json_format': 'array',
        'encoding': 'utf-8',
        'columns': [{'name': 'a', 'sql_type': 'INT', 'nullable': True}],
    }
    sql = generator.generate_openrowset(
        metadata,
        data_source='TestDS',
        storage_url='https://acct.blob.core.windows.net/container/doc.json',
        target_platform='azure_sql_db',
    )
    body = _code(sql)
    assert re.search(r'SINGLE_N?CLOB', body)
    assert f"TestDS{expect['data_source_suffix']}" in body
    assert re.search(rf"TYPE\s*=\s*{expect['data_source_type']}", sql)

    ndjson = generator.generate_openrowset(
        dict(metadata, file_name='lines.jsonl', json_format='ndjson'),
        data_source='TestDS',
        storage_url='https://acct.blob.core.windows.net/container/lines.jsonl',
        target_platform='azure_sql_db',
    )
    # Concatenated NDJSON is not one JSON document, so it must stay row framed.
    assert 'ROWTERMINATOR' in _code(ndjson)
    assert not re.search(r'SINGLE_N?CLOB', _code(ndjson))


def test_json_setup_still_creates_the_data_source_its_openrowset_needs(rules):
    """R19. A file format and a data source are different objects.

    JSON has no CREATE EXTERNAL FILE FORMAT anywhere, but the generated JSON
    read names a DATA_SOURCE. Refusing to emit the setup left that statement
    referring to an object nothing creates - error 12703 / 46501 at run time,
    which reads like a generator defect and is not one.
    """
    expect = rules['R19']['expect']
    generator = SQLGenerator()
    metadata = {
        'file_path': 'C:/data/doc.json',
        'file_name': 'doc.json',
        'file_type': 'json',
        'json_format': 'array',
        'encoding': 'utf-8',
        'columns': [{'name': 'a', 'sql_type': 'INT', 'nullable': True}],
    }
    for platform in ('sql_server_2025', 'azure_sql_db'):
        setup = generator.generate_credential_setup(
            data_source='TestDS',
            metadata=metadata,
            target_platform=platform,
            storage_url='https://acct.blob.core.windows.net/container/doc.json',
        )
        body = _code(setup)
        assert expect['setup_must_contain'] in body, platform
        assert expect['setup_must_not_contain'] not in body, platform
        # The read that needs it must be able to find it by name.
        read = _code(generator.generate_openrowset(
            metadata,
            data_source='TestDS',
            storage_url='https://acct.blob.core.windows.net/container/doc.json',
            target_platform=platform,
        ))
        for name in re.findall(r"DATA_SOURCE\s*=\s*'([^']+)'", read):
            assert f'[{name}]' in body, (platform, name)


def test_formats_read_without_a_file_format_match_the_evidence(rules):
    expect = rules['R19']['expect']
    assert sorted(SQLGenerator.FORMATS_READ_WITHOUT_FILE_FORMAT) == sorted(
        expect['formats_read_without_file_format']
    )


def test_utf16_bulk_insert_keeps_the_certified_encoding_options(rules):
    expect = rules['R02']['expect']
    sql = SQLGenerator().generate_bulk_insert(
        {
            'file_path': 'C:/data/wide.csv',
            'file_name': 'wide.csv',
            'file_type': 'csv',
            'encoding': 'utf-16-le',
            'codepage': '1200',
            'delimiter': ',',
            'has_header': True,
            'columns': [{'name': 'a', 'sql_type': 'INT', 'nullable': True}],
        },
        table_name='sqlfdt_cert_t',
        target_platform='sql_server_2025',
    )
    # The static hypothesis said CODEPAGE 1200 always fails; live evidence
    # disproved it, so one of the two certified forms must still be emitted.
    assert re.search(expect['generated_code_matches'], _code(sql))


def test_single_lob_keyword_follows_live_encoding_evidence(rules):
    for encoding, keyword in rules['R03']['expect']['single_lob_keyword'].items():
        metadata = None if encoding == 'default' else {'encoding': encoding}
        assert SQLGenerator._single_lob_keyword(metadata) == keyword, encoding


def test_use_type_default_is_false_and_explicit(rules):
    expect = rules['R08']['expect']
    generator = SQLGenerator()
    sql = generator.generate_external_file_format(
        {'file_name': 'f.csv', 'file_type': 'csv', 'delimiter': ',', 'encoding': 'utf-8'},
        format_name='sqlfdt_cert_fmt',
        target_platform='azure_sql_db',
    )
    assert f"USE_TYPE_DEFAULT = {expect['default']}" in sql.replace('  ', ' ')


def test_version_attribution_matches_the_engines_that_ran(expected, rules):
    from certification.matrix import LIVE_CERTIFIED_PLATFORMS, STATIC_ONLY_PLATFORMS

    expect = rules['R18']['expect']
    assert set(LIVE_CERTIFIED_PLATFORMS) == set(expect['live_certified_platforms'])
    assert set(STATIC_ONLY_PLATFORMS) == set(expect['static_only_platforms'])
    assert set(expected['static_only_platforms']) == set(STATIC_ONLY_PLATFORMS)


def test_placeholder_script_never_implies_it_is_runnable(rules):
    """H7 / R17.

    A local file cannot be read by Azure SQL Database. The generated script
    therefore carries <storage_account>/<container>/<path> placeholders, and it
    must tell the reader to stage and substitute them. Emitting placeholders
    silently is how someone ends up pasting a script that fails halfway through
    after having already created objects.
    """
    import re

    from external_file_detection.file_detector import FileDetector

    expect = rules['R17']['expect']
    metadata = FileDetector().analyze_file_metadata(
        os.path.join(REPO_ROOT, 'data sample', 'csv', 'sales_scalars.csv')
    )
    script = SQLGenerator().generate_complete_ddl(
        metadata, target_platform='azure_sql_db'
    )

    placeholders = set(re.findall(expect['placeholder_pattern'], script))
    assert placeholders, 'a local file on Azure SQL must produce placeholders'
    assert 'cannot read local file' in script
    assert 'replace the location placeholders' in script
    lowered = script.lower()
    for phrase in expect['forbidden_when_placeholders_present']:
        assert phrase not in lowered, phrase


def test_staged_cloud_script_has_no_placeholders_and_no_staging_notice():
    from external_file_detection.file_detector import FileDetector

    metadata = FileDetector().analyze_file_metadata(
        os.path.join(REPO_ROOT, 'data sample', 'csv', 'sales_scalars.csv')
    )
    script = SQLGenerator().generate_complete_ddl(
        metadata,
        target_platform='azure_sql_db',
        storage_url='https://acct.blob.core.windows.net/raw/sales_scalars.csv',
    )
    assert 'cannot read local file' not in script
    assert '<storage_account>' not in script
    assert '<container>' not in script


def test_blob_paths_keep_their_case(rules):
    """R14: Blob paths are case sensitive (Yellow/ vs yellow/ -> error 13807)."""
    from external_file_detection.file_detector import FileDetector

    assert rules['R14']['expect']['paths_are_case_sensitive'] is True
    metadata = FileDetector().analyze_file_metadata(
        os.path.join(REPO_ROOT, 'data sample', 'csv', 'sales_scalars.csv')
    )
    script = SQLGenerator().generate_complete_ddl(
        metadata,
        target_platform='azure_sql_db',
        storage_url='https://acct.blob.core.windows.net/Raw/Yellow/Sales_Scalars.csv',
    )
    assert 'Yellow/Sales_Scalars.csv' in script
    assert 'yellow/sales_scalars.csv' not in script


# -- fixture metadata --------------------------------------------------------

@pytest.mark.parametrize('fixture', FIXTURES, ids=lambda item: item.key)
def test_every_fixture_generates_on_every_platform(fixture):
    """Real detector output must generate a script on every platform.

    This is breadth, not the crash regression: 11 of the 19 fixtures report
    ``delimiter=None`` because no non-delimited format has one, and they
    exercise the optional-field reads outside the CSV guidance path. The live
    crash itself needed ``file_type='csv'`` *and* ``delimiter=None``, which only
    a failed CSV analysis produces - that is pinned by
    ``test_a_csv_whose_analysis_failed_still_generates``.
    """
    from external_file_detection.file_detector import FileDetector

    path = os.path.join(REPO_ROOT, fixture.path.replace('/', os.sep))
    if not os.path.exists(path):
        pytest.skip(f'fixture not present: {fixture.path}')

    metadata = FileDetector().analyze_file_metadata(path)
    generator = SQLGenerator()
    for platform in SQLGenerator.PLATFORMS:
        statements = generator.generate_all_statements(
            metadata, target_platform=platform)
        assert statements['create_table']
        assert generator.generate_complete_ddl(metadata, target_platform=platform)
        assert generator.generate_best_practices(metadata, target_platform=platform)
