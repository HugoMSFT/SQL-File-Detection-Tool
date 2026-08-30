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


# -- TRUNCATE: the one admitted destructive statement ------------------------

def test_allows_truncate_of_a_table_this_run_created(identity, policy):
    """The generated complete document empties its own load target.

    Without this the document doubles its rows on a second run, and a count
    that silently went 150 -> 300 is worse than an error. The narrow shape is
    what makes it acceptable: the name still has to be this run's.
    """
    table = f'[{identity.schema}].[{identity.name("c28", "csv")}]'
    report = evaluate_batch(f'TRUNCATE TABLE {table};', policy)
    assert report.allowed, report.as_dict()
    assert ('truncate target', table) in report.targets


def test_refuses_truncate_of_a_table_this_run_did_not_create(identity, policy):
    sql = f'TRUNCATE TABLE [{identity.schema}].[staging_table];'
    assert 'UNPREFIXED_TARGET' in codes(sql, policy)


def test_refuses_truncate_of_dbo(policy):
    # The accident this whole gate exists for.
    assert 'FORBIDDEN_SCHEMA_DBO' in codes('TRUNCATE TABLE [dbo].[orders];', policy)


def test_refuses_truncate_of_a_tpch_table(policy):
    assert 'PROTECTED_OBJECT' in codes('TRUNCATE TABLE orders;', policy)


@pytest.mark.parametrize(
    'sql',
    [
        'TRUNCATE TABLE;',
        'TRUNCATE TABLE @target;',
        "DELETE FROM [s].[t];",
        "UPDATE [s].[t] SET a = 1;",
        "MERGE [s].[t] AS x USING [s].[u] AS y ON 1 = 1;",
    ],
)
def test_widening_truncate_did_not_widen_anything_else(sql, policy):
    """Admitting one shape must not admit the family.

    ``TRUNCATE TABLE <name>`` is allowed; a bare TRUNCATE, a variable target
    and every other mutating verb stay refused.
    """
    assert not evaluate_batch(sql, policy).allowed, sql


def test_a_truncate_hidden_after_a_legitimate_statement_is_still_scoped(identity, policy):
    sql = (
        f'CREATE TABLE [{identity.schema}].[{identity.name("c28", "csv")}] (id INT);\n'
        'TRUNCATE TABLE [dbo].[lineitem];'
    )
    assert not evaluate_batch(sql, policy).allowed


# ---------------------------------------------------------------------------
# Cleanup must survive its own gate
# ---------------------------------------------------------------------------
#
# The gate refusing a cleanup statement is worse than the gate refusing a cell:
# a refused cell produces a BLOCKED verdict that somebody reads, while a refused
# DROP leaves an object on a live server and the only trace is a residue count.
# That is exactly what happened - `\bDROP\s+DATABASE\b` also matches `DROP
# DATABASE SCOPED CREDENTIAL`, so both managed-identity credentials survived a
# run that reported itself clean, and had to be removed by hand afterwards.

from certification.manifest import (  # noqa: E402
    CLEANUP_ORDER,
    explicit_cleanup_statements,
)


def cleanup_for_every_kind(identity):
    """One representative object of every kind the cleanup planner knows."""
    inventory = {
        kind: [identity.prefix + kind.replace(' ', '_')] for kind in CLEANUP_ORDER
    }
    inventory['schema'] = [identity.schema]
    return inventory


def test_every_cleanup_kind_survives_the_gate(identity, policy):
    statements = explicit_cleanup_statements(identity, cleanup_for_every_kind(identity))
    assert len(statements) == len(CLEANUP_ORDER), statements
    refused = {s: codes(s, policy) for s in statements if not evaluate_batch(s, policy).allowed}
    assert refused == {}, refused


def test_dropping_a_scoped_credential_is_not_dropping_a_database(identity, policy):
    sql = f'DROP DATABASE SCOPED CREDENTIAL [{identity.name("c26", "cred")}];'
    report = evaluate_batch(sql, policy)
    assert report.allowed, report.as_dict()
    assert 'DROP_DATABASE' not in report.codes


def test_dropping_a_real_database_is_still_refused(policy):
    assert 'DROP_DATABASE' in codes('DROP DATABASE [tpch];', policy)


def test_altering_a_scoped_credential_is_refused_before_layer_two(policy):
    # The DROP exception is narrow on purpose. ALTER gets no equivalent: layer 1
    # refuses every ALTER outright, nothing the harness generates alters a
    # credential, and widening the rule for a statement that is never emitted
    # would trade a real guarantee for nothing.
    assert 'STATEMENT_NOT_ALLOWED' in codes(
        "ALTER DATABASE SCOPED CREDENTIAL [anything] WITH IDENTITY = 'MANAGED IDENTITY';",
        policy,
    )


def test_altering_database_scoped_configuration_is_still_refused(policy):
    # DATABASE SCOPED CONFIGURATION really does mutate a database setting.
    assert 'ALTER_DATABASE' in codes(
        'ALTER DATABASE SCOPED CONFIGURATION SET MAXDOP = 1;', policy
    )


def test_a_cleanup_statement_for_someone_elses_object_is_refused(identity, policy):
    # The inventory is read off a live server. If it ever came back with an
    # object the run did not create, the gate is the last thing between that
    # name and a DROP.
    assert not evaluate_batch(
        'DROP EXTERNAL DATA SOURCE [prod_lake];', policy
    ).allowed


# ---------------------------------------------------------------------------
# One object, one DROP
# ---------------------------------------------------------------------------
#
# Catalog views overlap. An external table is a row in `sys.external_tables`
# and, because it is still a table, a row in `sys.tables`. The inventory read
# both, the planner saw the same name under two kinds, and cleanup issued
# `DROP EXTERNAL TABLE` followed by `DROP TABLE` for an object that no longer
# existed - error 3701. Nothing was left behind, but a run that cleaned up
# perfectly reported 34 of 36 statements successful, and a cleanup report nobody
# can read as "all good" is a cleanup report nobody reads.

from certification.adapters import INVENTORY_QUERIES  # noqa: E402


def test_an_external_table_is_dropped_once(identity):
    name = identity.name('c17', 'ext')
    inventory = {'external table': [name], 'table': [name]}

    statements = explicit_cleanup_statements(identity, inventory)

    assert statements == [f'DROP EXTERNAL TABLE [{identity.schema}].[{name}];']


def test_the_more_specific_kind_wins(identity):
    # CLEANUP_ORDER puts external tables first, which is both the dependency
    # order and the right answer here: DROP TABLE does not remove an external
    # table.
    name = identity.name('c28', 'ext')
    statements = explicit_cleanup_statements(
        identity, {'table': [name], 'external table': [name]}
    )
    assert 'DROP EXTERNAL TABLE' in statements[0]
    assert len(statements) == 1


def test_two_different_objects_still_get_two_drops(identity):
    external = identity.name('c17', 'ext')
    regular = identity.name('c17', 'stage')
    statements = explicit_cleanup_statements(
        identity, {'external table': [external], 'table': [regular]}
    )
    assert len(statements) == 2


def test_a_name_reused_across_scopes_is_not_deduplicated(identity):
    # A file format and a table are in different namespaces, so the same name
    # under both kinds is two real objects.
    name = identity.name('c20', 'shared')
    statements = explicit_cleanup_statements(
        identity, {'external file format': [name], 'table': [name]}
    )
    assert len(statements) == 2


def test_the_table_inventory_excludes_external_tables():
    # The deduplication above is a second line of defence. This is the first:
    # the inventory should not report an external table as a table at all.
    assert 'is_external = 0' in INVENTORY_QUERIES['table']
    assert 'is_external' not in INVENTORY_QUERIES['external table']


def test_case_folding_does_not_smuggle_a_second_drop(identity):
    name = identity.name('c17', 'ext')
    statements = explicit_cleanup_statements(
        identity, {'external table': [name], 'table': [name.upper()]}
    )
    assert len(statements) == 1
