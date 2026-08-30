"""Redaction is what makes it safe to commit certification evidence.

Anything that leaks a live endpoint, a login, an IP address, a local path or a
token would make the artifacts unpublishable, so each of those has a test.
"""

import pytest

from certification.redaction import (
    Redactor,
    assert_no_secrets,
    secret_findings,
)


def test_redacts_ipv4_addresses():
    assert '203.0.113.7' not in Redactor().redact('server 203.0.113.7,1433')


def test_redacts_windows_and_unc_paths():
    redacted = Redactor().redact(r"BULK 'C:\Users\alice\data\f.csv'")
    assert 'alice' not in redacted
    assert r'\\fileserver\share\f.csv' not in Redactor().redact(
        r"BULK '\\fileserver\share\f.csv'"
    )


def test_redacts_extra_literals_longest_first():
    # A login of "sa" is too short to redact safely; a server name is not.
    redactor = Redactor(extra_literals=('sqldemo-server', 'sqldemo-server.database.windows.net'))
    out = redactor.redact('host sqldemo-server.database.windows.net user sqldemo-server')
    assert 'sqldemo-server' not in out


def test_keeps_documented_public_hosts_readable():
    # Evidence is worthless if the maintained public fixture URL is scrubbed:
    # the whole point is that a reader can re-run it.
    text = 'https://azcliprod.blob.core.windows.net/cli/vm/aliases.json'
    assert 'azcliprod.blob.core.windows.net' in Redactor().redact(text)


def test_redact_obj_walks_nested_structures():
    out = Redactor().redact_obj({'a': ['203.0.113.7'], 'b': {'c': '203.0.113.7'}})
    assert '203.0.113.7' not in repr(out)


@pytest.mark.parametrize(
    'text',
    [
        "SECRET = 'sv=2022-11-02&sig=AbCdEf0123456789%2Babcdef'",
        'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123',
        "PASSWORD = 'hunter2hunter2'",
        'Password=superSecretValue;',
    ],
)
def test_detects_secret_shaped_material(text):
    assert secret_findings(text)


@pytest.mark.parametrize(
    'text',
    [
        "SECRET = '<SAS_token_without_leading_?>'",
        "PASSWORD = '<strong_password>'",
        "WITH (IDENTITY = 'MANAGED IDENTITY')",
    ],
)
def test_placeholders_are_not_secrets(text):
    assert secret_findings(text) == []


def test_secret_excerpt_never_reproduces_the_secret():
    finding = secret_findings("SECRET = 'sig=AbCdEf0123456789abcdef'")[0]
    assert 'AbCdEf0123456789abcdef' not in finding.excerpt
    assert 'chars>' in finding.excerpt


def test_assert_no_secrets_raises_with_the_kind_only():
    with pytest.raises(ValueError) as excinfo:
        assert_no_secrets("SECRET = 'sig=AbCdEf0123456789abcdef'", context='cell C01')
    message = str(excinfo.value)
    assert 'cell C01' in message
    assert 'AbCdEf0123456789abcdef' not in message


# -- Azure SQL session tracing IDs -------------------------------------------

def test_a_session_tracing_id_does_not_reach_an_artifact():
    """The real 40613 message ends with one, and it identifies the connection."""
    redactor = Redactor()
    text = (
        "Database 'x' on server 'y' is not currently available. Please retry "
        'the connection later. If the problem persists, contact customer '
        'support, and provide them the session tracing ID of '
        '{2B8A1C4E-9F03-4D2A-B7E1-556677889900}.'
    )

    out = redactor.redact(text)

    assert '2B8A1C4E' not in out
    assert '556677889900' not in out
    assert 'not currently available' in out, 'the useful part must survive'


def test_a_hex_session_id_is_redacted_too():
    out = Redactor().redact('Login timeout expired. Session ID: 0x3F2A9C11D4')
    assert '3F2A9C11D4' not in out


def test_an_ordinary_guid_in_a_run_id_is_left_alone():
    # Run identities are ours and appear in every artifact by design.
    out = Redactor().redact('run 0123abcd used schema sqlfdt_cert_0123abcd')
    assert 'sqlfdt_cert_0123abcd' in out


# ---------------------------------------------------------------------------
# Common names are not identifiers
# ---------------------------------------------------------------------------
#
# The extra literals are whatever the operator put in the environment. A run
# against `master` used to blank the word out of every "master key" message in
# the evidence, which destroys the record the harness exists to produce and
# protects nobody: `master` is called `master` on every SQL Server ever
# installed.

from certification.redaction import (  # noqa: E402
    NON_SECRET_LITERALS,
    _usable_literals,
)


@pytest.mark.parametrize('name', sorted(NON_SECRET_LITERALS))
def test_a_common_name_is_not_redacted(name):
    redactor = Redactor(extra_literals=(name,))
    text = f'CREATE MASTER KEY failed while connected to {name}'
    assert redactor.redact(text) == text


def test_a_system_database_name_survives_inside_a_sentence():
    redactor = Redactor(extra_literals=('master',))
    assert 'master key' in redactor.redact(
        'Please create a master key in the database or open the master key'
    ).lower()


def test_a_real_login_is_still_redacted():
    redactor = Redactor(extra_literals=('certops_svc',))
    assert 'certops_svc' not in redactor.redact('login failed for user certops_svc')


def test_a_two_character_literal_is_ignored():
    # Substituting a fragment that short would rewrite ordinary SQL.
    assert _usable_literals(('ab', 'abc', 'abcd')) == {'abcd'}


def test_case_does_not_smuggle_a_common_name_past_the_exclusion():
    assert _usable_literals(('Master', 'TEMPDB')) == set()
