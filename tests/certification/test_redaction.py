"""Redaction is what makes it safe to commit certification evidence.

Anything that leaks a live endpoint, a login, an IP address, a local path or a
token would make the artifacts unpublishable, so each of those has a test.
"""

import pytest

from certification.redaction import (
    PUBLIC_HOSTS,
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


# ---------------------------------------------------------------------------
# Staging hosts in a shareable manifest
# ---------------------------------------------------------------------------
#
# The plain manifest is meant to be attachable to a pull request, so the hosts
# an operator staged fixtures on must not survive it. Pattern redaction was not
# enough: it scrubs the endpoint shapes it was taught and lets everything else
# through, and the shapes that leak are the ones nobody thinks to teach it.

from certification.manifest import _placeholder_hosts  # noqa: E402


LEAKY_SHAPES = [
    # Pattern redaction anchors on the last five labels, so a private endpoint
    # keeps the storage account name in front of the part that matched.
    'contosotenant.privatelink.blob.core.windows.net',
    # Not an Azure shape at all.
    'fileserver.corp.contoso.example',
    # The likely staging host for a VM target.
    'sqlvm01.westeurope.cloudapp.example',
    # Static website endpoint: a different label layout again.
    'contoso.z13.web.core.windows.example',
]


def test_no_staging_host_survives_a_shareable_manifest():
    placeholders = _placeholder_hosts(LEAKY_SHAPES)
    for host in LEAKY_SHAPES:
        assert host not in placeholders
        # Not even the leading label, which is the account or machine name.
        assert not any(host.split('.')[0] in p for p in placeholders)


def test_placeholders_are_positional_and_stable():
    assert _placeholder_hosts(['a.example', 'b.example', 'a.example']) == [
        '[staging-host-0]',
        '[staging-host-1]',
        '[staging-host-0]',
    ]


def test_the_same_host_in_different_case_is_the_same_placeholder():
    assert _placeholder_hosts(['A.Example', 'a.example']) == [
        '[staging-host-0]',
        '[staging-host-0]',
    ]


def test_public_fixture_hosts_are_kept():
    # These belong to Microsoft, are documented, carry no tenant of ours, and
    # keeping them is what makes the plan reproducible by a reader.
    kept = _placeholder_hosts(list(PUBLIC_HOSTS))
    assert kept == list(PUBLIC_HOSTS)


def test_a_public_host_does_not_consume_a_placeholder_index():
    hosts = [PUBLIC_HOSTS[0], 'tenant.example', PUBLIC_HOSTS[1], 'other.example']
    assert _placeholder_hosts(hosts) == [
        PUBLIC_HOSTS[0],
        '[staging-host-0]',
        PUBLIC_HOSTS[1],
        '[staging-host-1]',
    ]


def test_the_count_of_distinct_hosts_is_still_readable():
    # The one fact a reviewer legitimately needs from this field.
    placeholders = _placeholder_hosts(['a.example', 'b.example', 'a.example'])
    assert len({p for p in placeholders if p.startswith('[staging-host-')}) == 2


# ---------------------------------------------------------------------------
# The last-resort crash handler
# ---------------------------------------------------------------------------
#
# Everything this harness writes to disk goes through the redactor, so the one
# remaining way for an endpoint to reach a console or a CI log is an unhandled
# exception. A driver's message routinely echoes the connection target back.

import argparse  # noqa: E402

from certification.__main__ import main as cert_main  # noqa: E402


def _exploding_command(message):
    def func(args):
        raise RuntimeError(message)

    namespace = argparse.Namespace(func=func)
    return namespace


def test_a_crash_scrubs_the_host_even_when_it_is_not_an_azure_shape(monkeypatch, capsys):
    host = 'sqlvm01.westeurope.cloudapp.example'
    namespace = _exploding_command(f'connection to {host} failed')
    namespace.host = host
    namespace.database = 'warehouse_prod'
    namespace.user = 'certops'
    monkeypatch.setattr(
        'certification.__main__.build_parser',
        lambda: type('P', (), {'parse_args': staticmethod(lambda argv: namespace)})(),
    )

    assert cert_main([]) == 2

    err = capsys.readouterr().err
    assert host not in err
    assert 'warehouse_prod' not in err
    assert 'certops' not in err
    assert 'RuntimeError' in err


def test_a_crash_without_connection_arguments_still_redacts_patterns(monkeypatch, capsys):
    # `plan` has no --host/--database/--user, so the handler falls back to
    # patterns alone. Those still cover the shapes it does know.
    namespace = _exploding_command('failed at 10.1.2.3 for tenant.database.windows.net')
    monkeypatch.setattr(
        'certification.__main__.build_parser',
        lambda: type('P', (), {'parse_args': staticmethod(lambda argv: namespace)})(),
    )

    assert cert_main([]) == 2

    err = capsys.readouterr().err
    assert '10.1.2.3' not in err
    assert 'tenant.database.windows.net' not in err


def test_a_crash_does_not_print_a_traceback(monkeypatch, capsys):
    # A chained traceback re-prints the driver's own message, which is the thing
    # being redacted.
    namespace = _exploding_command('boom')
    monkeypatch.setattr(
        'certification.__main__.build_parser',
        lambda: type('P', (), {'parse_args': staticmethod(lambda argv: namespace)})(),
    )

    assert cert_main([]) == 2
    assert 'Traceback' not in capsys.readouterr().err


def test_a_crash_scrubs_values_that_came_from_the_environment(monkeypatch, capsys):
    # The documented way to configure a run is SQLFDT_CERT_HOST and friends;
    # --host and the rest are overrides with no defaults. Seeding the handler
    # from `args` alone left it doing nothing on the normal path, because
    # `args.host` is None there and the redactor `execute` builds from the
    # resolved settings is local to it.
    host = 'sql2025vm.corp.example'
    monkeypatch.setenv('SQLFDT_CERT_HOST', host)
    monkeypatch.setenv('SQLFDT_CERT_DATABASE', 'warehouse_prod')
    monkeypatch.setenv('SQLFDT_CERT_USER', 'certops')

    namespace = _exploding_command(
        f'connection to {host} for warehouse_prod as certops failed'
    )
    monkeypatch.setattr(
        'certification.__main__.build_parser',
        lambda: type('P', (), {'parse_args': staticmethod(lambda argv: namespace)})(),
    )

    assert cert_main([]) == 2

    err = capsys.readouterr().err
    assert host not in err
    assert 'warehouse_prod' not in err
    assert 'certops' not in err
