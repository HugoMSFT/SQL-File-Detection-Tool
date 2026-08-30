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


def test_escaped_bracket_cannot_smuggle_a_dbo_drop_past_the_gate(policy, identity):
    """The masker used to end a bracketed name at the first ], so a column
    called [a]]'b] left an unbalanced quote, blanked the rest of the batch and
    made every scan look at nothing. The DROP below has to be seen.
    """
    sql = (
        'CREATE TABLE [{schema}].[{prefix}t] (\n'
        "    [a]]'b] INT,\n"
        '    [c] INT\n'
        ');\n'
        'DROP TABLE [dbo].[orders];\n'
    ).format(schema=identity.schema, prefix=identity.prefix)
    verdict = evaluate_batch(sql, policy)
    codes = {v.code for v in verdict.violations}
    assert verdict.allowed is False
    assert 'FORBIDDEN_SCHEMA_DBO' in codes
    assert 'PROTECTED_OBJECT' in codes


def test_cleanup_names_are_filtered_and_bracket_escaped(identity):
    """Cleanup names come off a live server, not out of the plan."""
    from certification.manifest import explicit_cleanup_statements

    hostile = identity.prefix + "x] ; DROP TABLE dbo.orders --"
    statements = explicit_cleanup_statements(
        identity,
        {
            'external file format': [hostile, identity.prefix + 'fmt'],
            'table': ['someone_elses_table'],
        },
    )
    assert statements == [
        'DROP EXTERNAL FILE FORMAT [{}fmt];'.format(identity.prefix)
    ]
    assert not identity.owns(hostile)
    assert not identity.owns('someone_elses_table')


def test_cleanup_statements_pass_their_own_safety_gate(identity, policy):
    from certification.manifest import explicit_cleanup_statements

    statements = explicit_cleanup_statements(
        identity,
        {
            'table': [identity.prefix + 'boundary'],
            'external data source': [identity.prefix + 'src'],
            'schema': [identity.schema],
        },
    )
    assert statements
    for statement in statements:
        assert evaluate_batch(statement, policy).allowed, statement


def test_unknown_statement_verbs_fail_closed(policy):
    # An unrecognised verb at a statement boundary must be refused rather than
    # ignored: the scanner cannot reason about a statement it cannot name.
    report = evaluate_batch('FROBNICATE [sqlfdt_cert_ab12cd34_t];', policy)
    assert not report.allowed
    assert 'UNKNOWN_STATEMENT' in report.codes


def test_ordinary_continuation_lines_are_not_mistaken_for_statements(policy):
    sql = (
        "SELECT TOP (100) *\n"
        "FROM OPENROWSET(\n"
        "    BULK 'sales.csv',\n"
        "    DATA_SOURCE = 'sqlfdt_cert_ab12cd34_ds'\n"
        ") WITH (\n"
        "    [amount] DECIMAL(18, 4)\n"
        ") AS [result];\n"
    )
    report = evaluate_batch(sql, policy)
    assert report.allowed, report.codes
