"""The safety gate is the only thing standing between a generated script and a
production TPC-H database. These tests pin its refusals.

Every test states the real-world accident it prevents. A test that only
restates the implementation would pass just as happily against a broken gate.
"""

import pytest

from certification.safety import evaluate_batch


def codes(sql, policy):
    return evaluate_batch(sql, policy).codes


def test_allows_a_correctly_prefixed_target(identity, policy):
    sql = (
        f'CREATE TABLE [{identity.schema}].[{identity.name("c01", "csv")}] '
        f'(id INT NOT NULL);'
    )
    report = evaluate_batch(sql, policy)
    assert report.allowed, report.as_dict()
    assert report.targets == [
        ('table', f'[{identity.schema}].[{identity.name("c01", "csv")}]')
    ]


def test_refuses_dbo_anywhere(policy):
    # dbo.orders is a real TPC-H table on the certification server. Nothing the
    # harness generates has any business naming dbo at all.
    assert 'FORBIDDEN_SCHEMA_DBO' in codes('SELECT * FROM [dbo].[foo];', policy)


@pytest.mark.parametrize(
    'name', ['orders', 'lineitem', 'customer', 'part', 'partsupp', 'supplier']
)
def test_refuses_tpch_tables_in_object_position(name, policy):
    assert 'PROTECTED_OBJECT' in codes(f'DROP TABLE {name};', policy)


def test_allows_tpch_words_as_column_names(identity, policy):
    # A CSV column called "customer" is completely ordinary. Refusing it would
    # make the gate so noisy that people would start bypassing it.
    sql = (
        f'CREATE TABLE [{identity.schema}].[{identity.name("c01", "csv")}] '
        f'(customer NVARCHAR(50) NULL, orders INT NULL);'
    )
    report = evaluate_batch(sql, policy)
    assert report.allowed, report.as_dict()


def test_refuses_unprefixed_target(identity, policy):
    sql = f'CREATE TABLE [{identity.schema}].[staging_table] (id INT);'
    assert 'UNPREFIXED_TARGET' in codes(sql, policy)


@pytest.mark.parametrize(
    'sql',
    [
        'DROP DATABASE contoso_warehouse;',
        'ALTER DATABASE contoso_warehouse SET READ_ONLY;',
        'BACKUP DATABASE contoso_warehouse TO DISK = N\'x.bak\';',
        'RESTORE DATABASE contoso_warehouse FROM DISK = N\'x.bak\';',
        'sp_configure \'polybase enabled\', 1;',
        'SHUTDOWN;',
        'EXEC xp_cmdshell \'dir\';',
    ],
)
def test_refuses_destructive_and_server_level_statements(sql, policy):
    report = evaluate_batch(sql, policy)
    assert not report.allowed, sql


def test_create_database_scoped_credential_is_not_create_database(identity, policy):
    # The obvious regex for CREATE DATABASE also matches CREATE DATABASE SCOPED
    # CREDENTIAL, which would block every cloud cell for no reason.
    sql = (
        f"CREATE DATABASE SCOPED CREDENTIAL [{identity.name('c01', 'cred')}] "
        f"WITH IDENTITY = 'MANAGED IDENTITY';"
    )
    report = evaluate_batch(sql, policy)
    assert report.allowed, report.as_dict()


def test_create_database_itself_is_refused_by_default(identity, policy):
    sql = f'CREATE DATABASE [{identity.database}];'
    assert not evaluate_batch(sql, policy).allowed


def test_create_database_allowed_only_for_the_disposable_name(identity):
    from certification.safety import SafetyPolicy

    permissive = SafetyPolicy(identity, allow_create_database=True)
    assert evaluate_batch(f'CREATE DATABASE [{identity.database}];', permissive).allowed
    assert not evaluate_batch('CREATE DATABASE [contoso_warehouse];', permissive).allowed


def test_placeholders_block_execution_but_are_not_violations(identity, policy):
    target = f'[{identity.schema}].[{identity.name("c01", "csv")}]'
    report = evaluate_batch(
        f"BULK INSERT {target} FROM '<path>/f.csv';", policy
    )
    assert report.placeholders == ['<path>']
    assert report.requires_substitution
    assert not report.allowed


def test_placeholders_inside_comments_do_not_block(identity, policy):
    # Guidance comments legitimately show <storage_account> to the reader. Those
    # characters never reach the server, so treating them as unresolved
    # placeholders would wrongly mark good SQL NOT_EXECUTABLE.
    sql = (
        '-- Replace https://<storage_account>.blob.core.windows.net/<container>\n'
        f'CREATE TABLE [{identity.schema}].[{identity.name("c01", "csv")}] (id INT);'
    )
    report = evaluate_batch(sql, policy)
    assert report.placeholders == []
    assert report.allowed, report.as_dict()


def test_secret_shaped_material_is_refused(identity, policy):
    sql = (
        f"CREATE DATABASE SCOPED CREDENTIAL [{identity.name('c01', 'cred')}] "
        "WITH IDENTITY = 'SHARED ACCESS SIGNATURE', "
        "SECRET = 'sv=2022-11-02&ss=b&srt=sco&sp=r&sig=AbCdEf0123456789%2Babcdef';"
    )
    assert 'SECRET_MATERIAL' in codes(sql, policy)


def test_host_allowlist_refuses_unknown_endpoints(identity, policy):
    sql = (
        f"CREATE EXTERNAL DATA SOURCE [{identity.name('c01', 'src')}] "
        "WITH (LOCATION = 'https://evil.blob.core.windows.net/c');"
    )
    assert 'FOREIGN_HOST' in codes(sql, policy)
