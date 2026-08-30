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
    for file_type in rules['R07']['expect']['file_types']:
        assert file_type in NO_EXTERNAL_FORMAT_FILE_TYPES


def test_ddl_only_formats_are_not_claimed_as_data_certified(rules):
    # ORC and Delta both had their DDL accepted and their data path unverified.
    assert 'ORC' in {f.upper() for f in DDL_ONLY_CERTIFIED_FORMATS}
    assert rules['R12']['expect']['data_path_certified'] is False
    assert rules['R11']['expect']['data_path_certified'] is False


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
