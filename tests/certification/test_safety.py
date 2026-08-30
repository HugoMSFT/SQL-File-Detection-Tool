"""The safety gate is the only thing standing between a generated script and a
production TPC-H database. These tests pin its refusals.

Every test states the real-world accident it prevents. A test that only
restates the implementation would pass just as happily against a broken gate.
"""

import re

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


# ---------------------------------------------------------------------------
# Object lists
# ---------------------------------------------------------------------------
#
# DROP TABLE, DROP VIEW, DROP EXTERNAL TABLE, DROP SCHEMA and TRUNCATE TABLE all
# take a comma-separated list. Every scope rule captures one name per verb, so a
# statement whose *first* target was legitimately run-owned carried every later
# name straight past the scope check - schema scoping, prefix scoping and the
# foreign-database check alike. `DROP TABLE [<run>].[<owned>], [sales].[invoices]`
# was allowed with no violations at all.
#
# Only the two text-wide scans still applied, so `dbo` and the TPC-H names stayed
# safe and every other schema on the instance did not. That is the whole of
# application data on a normal Azure SQL database.

import certification.safety as safety_module  # noqa: E402


LIST_EXPLOITS = (
    'DROP TABLE [{s}].[{t}], [sales].[invoices];',
    'DROP TABLE IF EXISTS [{s}].[{t}],[sales].[invoices],[hr].[salary];',
    'DROP TABLE [{s}].[{t}], sales.invoices;',
    'DROP VIEW [{s}].[{t}], [sales].[v];',
    'DROP EXTERNAL TABLE [{s}].[{t}], [sales].[v];',
    'DROP SCHEMA [{s}], [sales];',
    'TRUNCATE TABLE [{s}].[{t}], [sales].[x];',
)


def _owned(identity):
    return {'s': identity.schema, 't': identity.name('c01', 'tbl')}


@pytest.mark.parametrize('template', LIST_EXPLOITS)
def test_a_foreign_object_hidden_in_a_list_is_refused(identity, policy, template):
    report = evaluate_batch(template.format(**_owned(identity)), policy=policy)
    assert not report.allowed, template


def test_a_three_part_name_in_a_list_cannot_reach_another_database(identity, policy):
    sql = 'DROP TABLE [{s}].[{t}], [prod].[sales].[invoices];'.format(**_owned(identity))
    assert not evaluate_batch(sql, policy=policy).allowed


@pytest.mark.parametrize('template', LIST_EXPLOITS)
def test_the_scope_walk_stands_without_the_shape_rule(identity, policy, template, monkeypatch):
    # Two independent defences, so each is tested with the other removed. The
    # shape rule refuses multi-object statements outright; this proves the scope
    # check would still catch the foreign object if that rule were ever relaxed.
    monkeypatch.setattr(
        safety_module,
        '_FORBIDDEN',
        tuple(rule for rule in safety_module._FORBIDDEN if rule[0] != 'MULTI_TARGET'),
    )
    report = evaluate_batch(template.format(**_owned(identity)), policy=policy)
    assert not report.allowed, template
    assert 'MULTI_TARGET' not in {v.code for v in report.violations}


def test_every_name_in_a_list_is_recorded_as_a_target(identity, policy):
    sql = 'DROP TABLE [{s}].[{t}], [sales].[invoices];'.format(**_owned(identity))
    report = evaluate_batch(sql, policy=policy)
    names = [name for _kind, name in report.targets]
    assert '[sales].[invoices]' in names


def test_a_list_of_objects_this_run_owns_is_still_refused(identity, policy):
    # Not a scope problem - the cleanup planner emits one statement per object
    # so that each outcome can be recorded on its own, so the shape is refused
    # even when every name in it is ours.
    owned = _owned(identity)
    sql = f'DROP TABLE [{owned["s"]}].[{owned["t"]}], [{owned["s"]}].[{owned["t"]}2];'
    assert not evaluate_batch(sql, policy=policy).allowed


@pytest.mark.parametrize('sql', [
    'DROP TABLE [{s}].[{t}];',
    'DROP TABLE IF EXISTS [{s}].[{t}];',
    'DROP EXTERNAL TABLE [{s}].[{t}];',
    'DROP SCHEMA [{s}];',
    'TRUNCATE TABLE [{s}].[{t}];',
    'CREATE TABLE [{s}].[{t}] (a INT, b INT, c NVARCHAR(50));',
    'INSERT INTO [{s}].[{t}] (a, b) VALUES (1, 2);',
    'SELECT a, b, c FROM [{s}].[{t}];',
])
def test_a_comma_in_a_column_list_is_not_an_object_list(identity, policy, sql):
    report = evaluate_batch(sql.format(**_owned(identity)), policy=policy)
    assert report.allowed, [v.code for v in report.violations]


def test_select_into_without_whitespace_before_from_is_scope_checked(policy):
    # T-SQL does not require whitespace after the target, so `\s+FROM` missed
    # both of these and let them create an object outside the run schema that
    # cleanup - which only removes names the run owns - would never take away.
    assert not evaluate_batch(
        'SELECT * INTO [sales].[victim]FROM sys.objects;', policy=policy
    ).allowed
    assert not evaluate_batch(
        'SELECT * INTO [sales].[victim](a)FROM sys.objects;', policy=policy
    ).allowed


def test_select_into_an_owned_table_still_passes(identity, policy):
    owned = _owned(identity)
    sql = f'SELECT * INTO [{owned["s"]}].[{owned["t"]}2] FROM [{owned["s"]}].[{owned["t"]}];'
    assert evaluate_batch(sql, policy=policy).allowed


# ---------------------------------------------------------------------------
# Escaped delimiters inside a quoted identifier
# ---------------------------------------------------------------------------
#
# `_IDENT` used to terminate a bracketed name at the first `]`, which is the
# middle of the name as far as the server is concerned. Both object-list
# defences are built on that grammar, so both failed on the same input and the
# two-defence design gave no redundancy at all. The masker in `batches.py`
# always got this right; its lesson had simply not been carried across.

ESCAPED_DELIMITER_EXPLOITS = [
    'DROP TABLE IF EXISTS [{s}].[{t}]]x], [sales].[invoices];',
    'DROP VIEW IF EXISTS [{s}].[{t}]]x], [sales].[v];',
    'DROP TABLE IF EXISTS [{s}].[{t}]]x], [prod].[sales].[invoices];',
    'DROP TABLE IF EXISTS [{s}].[{t}]]x], [sales].[a], [hr].[b], [fin].[c];',
    'DROP TABLE IF EXISTS [{s}]."{t}""x", [sales].[invoices];',
    'TRUNCATE TABLE [{s}].[{t}]]x], [sales].[x];',
]


@pytest.mark.parametrize('template', ESCAPED_DELIMITER_EXPLOITS)
def test_an_escaped_delimiter_cannot_hide_the_rest_of_a_list(
    identity, policy, template
):
    report = evaluate_batch(template.format(**_owned(identity)), policy=policy)
    assert not report.allowed, template


def test_the_escape_aware_grammar_stands_without_the_shape_rule(
    identity, policy, monkeypatch
):
    # The scope walk must reach the foreign name on its own. If only
    # MULTI_TARGET is refusing these, a statement shape nobody thought to list
    # would sail straight through.
    import certification.safety as safety

    monkeypatch.setattr(
        safety,
        '_FORBIDDEN',
        tuple(rule for rule in safety._FORBIDDEN if rule[0] != 'MULTI_TARGET'),
    )
    owned = _owned(identity)
    report = evaluate_batch(
        f'DROP TABLE IF EXISTS [{owned["s"]}].[{owned["t"]}]]x], [sales].[invoices];',
        policy=policy,
    )
    assert 'FOREIGN_SCHEMA' in report.codes


def test_an_escaped_bracket_in_an_owned_name_is_still_allowed(identity, policy):
    # The fix must not turn the generators' own escaping convention into a
    # refusal: `escapeIdentifier`/`_escape_identifier` emit `]]` by design.
    owned = _owned(identity)
    report = evaluate_batch(
        f'CREATE TABLE [{owned["s"]}].[{owned["t"]}]]odd] (a INT);', policy=policy
    )
    assert report.allowed, [v.code for v in report.violations]


def test_a_name_split_keeps_an_escaped_delimiter(identity):
    from certification.safety import _split_qualified

    assert _split_qualified('[a]]x].[b]') == ['a]x', 'b']
    assert _split_qualified('"a""x"."b"') == ['a"x', 'b']
    assert _split_qualified('[sales].[in.voice]') == ['sales', 'in.voice']


def test_a_statement_whose_target_list_cannot_be_parsed_fails_closed(
    identity, policy, monkeypatch
):
    # A future grammar gap must become a refusal, not a silent pass.
    import certification.safety as safety

    monkeypatch.setattr(
        safety,
        '_FORBIDDEN',
        tuple(rule for rule in safety._FORBIDDEN if rule[0] != 'MULTI_TARGET'),
    )
    monkeypatch.setattr(safety, '_LIST_HEAD_RE', re.compile(r'(?P<name>ZZZ_NEVER)'))
    owned = _owned(identity)
    report = evaluate_batch(
        f'DROP TABLE [{owned["s"]}].[{owned["t"]}];', policy=policy
    )
    assert 'UNPARSED_TARGET_LIST' in report.codes


# ---------------------------------------------------------------------------
# A statement head can no longer be swallowed by the previous line
# ---------------------------------------------------------------------------
#
# Layer 1's line scan separated its two words with `\s+`, which matches a
# newline, and it *consumed* the second word. `BEGIN` alone on a line therefore
# absorbed the next line's verb, and `finditer` resumed past it, so that verb
# was never head-checked. `BEGIN` is an allowed simple head that both
# generators emit on its own line, so this was a normal shape.

SWALLOWED_HEAD_EXPLOITS = [
    'BEGIN\n    ALTER TABLE [sales].[t] DROP COLUMN [c]\nEND',
    'IF 1 = 1 BEGIN ALTER TABLE [sales].[t] DROP COLUMN [c] END',
    'IF 1 = 1 BEGIN ALTER TABLE [sales].[t] ALTER COLUMN [c] INT NOT NULL END',
    'IF 1 = 1 BEGIN ALTER SCHEMA [sales] TRANSFER [hr].[salary] END',
    'IF 1 = 1 BEGIN ALTER INDEX ALL ON [sales].[t] DISABLE END',
    'IF 1 = 1 BEGIN DROP INDEX [ix] ON [sales].[t] END',
    'BEGIN\n    DROP SYNONYM [sales].[s]\nEND',
]


@pytest.mark.parametrize('sql', SWALLOWED_HEAD_EXPLOITS)
def test_a_verb_after_begin_is_still_judged(policy, sql):
    report = evaluate_batch(sql, policy=policy)
    assert not report.allowed, sql


def test_the_head_scan_no_longer_consumes_the_next_line(policy):
    # The mechanism, not just the outcome: the second line must remain a scan
    # position of its own.
    report = evaluate_batch(
        'BEGIN\n    ALTER TABLE [sales].[t] DROP COLUMN [c]\nEND', policy=policy
    )
    assert 'STATEMENT_NOT_ALLOWED' in report.codes


@pytest.mark.parametrize('sql', SWALLOWED_HEAD_EXPLOITS)
def test_alter_and_unmanaged_drops_are_refused_without_layer_one(
    policy, sql, monkeypatch
):
    # Layer 1 is position dependent. These verbs must not depend on it.
    import certification.safety as safety

    monkeypatch.setattr(safety, '_head_violations', lambda masked, upper: [])
    report = evaluate_batch(sql, policy=policy)
    assert not report.allowed, sql


def test_create_or_alter_view_is_not_caught_by_the_alter_rule(identity, policy):
    owned = _owned(identity)
    report = evaluate_batch(
        f'CREATE OR ALTER VIEW [{owned["s"]}].[{owned["t"]}] AS SELECT 1 AS [a];',
        policy=policy,
    )
    assert 'ALTER_OBJECT' not in report.codes


def test_every_list_verb_scope_checks_its_second_name(identity, policy):
    # T-SQL treats the last three as single-object statements, so the server
    # would reject the comma anyway. The invariant "every name in a statement
    # is scope-checked" must not rest on the server's grammar.
    owned = _owned(identity)
    prefix = identity.prefix
    for sql in (
        f'DROP EXTERNAL FILE FORMAT [{prefix}ff], [sales_fmt];',
        f'DROP EXTERNAL DATA SOURCE [{prefix}ds], [sales_ds];',
        f'DROP DATABASE SCOPED CREDENTIAL [{prefix}cr], [sales_cred];',
    ):
        report = evaluate_batch(sql, policy=policy)
        assert not report.allowed, sql


# ---------------------------------------------------------------------------
# A Unicode letter is a legal identifier character
# ---------------------------------------------------------------------------
#
# `_IDENT`'s unquoted alternative was `[A-Za-z_@#][A-Za-z0-9_@#$]*`, but T-SQL
# regular identifiers accept Unicode letters. A single non-ASCII letter
# therefore truncated the name, and that one truncation defeated every layer at
# once: the truncated head is genuinely run-owned so the scope check passed, the
# comma was no longer adjacent to a complete name so the shape rule never fired,
# and the tail check was a denylist of three characters that did not include it.
# A Cyrillic homoglyph makes the payload invisible in review.

UNICODE_TRUNCATION_EXPLOITS = [
    'DROP TABLE {s}.{t}\u00e9, [sales].[invoices];',
    'DROP TABLE {s}.{t}\u00e9, [prod].[sales].[invoices];',
    'DROP TABLE {s}.{t}\u00e9, [s1].[t1], [s2].[t2], [s3].[t3];',
    'DROP VIEW {s}.{t}\u00e9, [sales].[v];',
    'TRUNCATE TABLE {s}.{t}\u00e9, [sales].[x];',
    'DROP SCHEMA {s}\u00e9, [sales];',
    'DROP TABLE [{s}].{t}\u00e9, [sales].[invoices];',
    'DROP TABLE {s}.{t}\u4e2d, [sales].[invoices];',
    'DROP TABLE {s}.{t}\u03b1, [sales].[invoices];',
    'DROP TABLE {s}.{t}\u0430, [sales].[invoices];',
    'DROP TABLE {s}.{t}\u0301, [sales].[invoices];',
]


@pytest.mark.parametrize('template', UNICODE_TRUNCATION_EXPLOITS)
def test_a_unicode_letter_cannot_truncate_a_name(identity, policy, template):
    report = evaluate_batch(template.format(**_owned(identity)), policy=policy)
    assert not report.allowed, ascii(template)


def test_a_unicode_name_is_scope_checked_not_ignored(identity, policy):
    # The widened grammar has to produce a real scope verdict, not merely fail
    # to match. A foreign Unicode name must be refused on its own.
    assert 'FOREIGN_SCHEMA' in evaluate_batch(
        'DROP TABLE [sales].caf\u00e9;', policy=policy
    ).codes


def test_an_owned_unicode_name_is_still_allowed(identity, policy):
    owned = _owned(identity)
    report = evaluate_batch(
        f'CREATE TABLE [{owned["s"]}].[{owned["t"]}caf\u00e9] (a INT);', policy=policy
    )
    assert report.allowed, [v.code for v in report.violations]


def test_the_tail_check_is_an_allowlist_not_a_denylist(identity, policy, monkeypatch):
    # The backstop has to catch a desync character nobody has thought of yet.
    # It began as a denylist of `]`, `"` and `,` and a Unicode letter walked
    # straight past it. With the shape rule removed, an unparsed tail must still
    # be refused on its own.
    import certification.safety as safety

    monkeypatch.setattr(
        safety,
        '_FORBIDDEN',
        tuple(rule for rule in safety._FORBIDDEN if rule[0] != 'MULTI_TARGET'),
    )
    # Patch the compiled pattern, not `_IDENT`: the regexes are built from it at
    # import time, so rebinding the string alone changes nothing.
    monkeypatch.setattr(
        safety, '_LIST_HEAD_RE', re.compile(r'(?P<name>[A-Za-z_.0-9\[\]]{1,128})')
    )
    owned = _owned(identity)
    report = evaluate_batch(
        f'DROP TABLE {owned["s"]}.{owned["t"]}\u00e9, [sales].[invoices];',
        policy=policy,
    )
    assert 'UNPARSED_TARGET_LIST' in report.codes


@pytest.mark.parametrize('sql', [
    'DROP TABLE IF EXISTS [{s}].[{t}];',
    'DROP TABLE [{s}].[{t}]\nDROP TABLE [{s}].[{t}2]',
    'DROP TABLE [{s}].[{t}]\nGO',
    'DROP TABLE [{s}].[{t}] -- remove the load target\n',
    'DROP SCHEMA [{s}];',
    'TRUNCATE TABLE [{s}].[{t}];',
    'TRUNCATE TABLE [{s}].[{t}] WITH (PARTITIONS (1));',
    'DROP TABLE {s}.{t};',
    'DROP TABLE IF EXISTS [{s}].[{t}]',
])
def test_the_tail_allowlist_does_not_refuse_real_shapes(identity, policy, sql):
    report = evaluate_batch(sql.format(**_owned(identity)), policy=policy)
    assert report.allowed, [v.code for v in report.violations]


def test_the_generated_cleanup_script_passes_the_gate(identity, policy):
    # The tail allowlist and the widened grammar both sit on the cleanup path.
    from certification import manifest
    from certification.safety import evaluate_script

    batches, reports = evaluate_script(
        manifest.cleanup_script(identity, drop_database=False), policy
    )
    assert batches
    assert all(report.allowed for report in reports), [
        [v.code for v in r.violations] for r in reports
    ]


def test_the_identifier_grammar_does_not_backtrack_pathologically():
    # Both bracket alternatives are first-character-disjoint, so matching is
    # effectively deterministic. Pin it with a timing check rather than by eye.
    import time

    from certification.safety import _IDENT

    pattern = re.compile(_IDENT)
    timings = []
    for size in (2000, 8000, 32000):
        probe = '[' + 'a]]' * size
        start = time.perf_counter()
        pattern.match(probe)
        timings.append(time.perf_counter() - start)
    assert timings[-1] < 1.0, timings


# ---------------------------------------------------------------------------
# The gate and the server must read a name the same way.
#
# Every breach found in this file so far was one parser disagreeing with the
# other about where an identifier ended. These three close the remaining places
# where that could still happen, none of which had a working exploit -- the
# point is to stop the disagreement existing at all rather than to argue each
# time about whether it is currently reachable.
# ---------------------------------------------------------------------------

OMITTED_PART_NAMES = [
    '[{schema}]..[{obj}]',
    '[{schema}]...[{obj}]',
    '{schema}..{obj}',
]


@pytest.mark.parametrize('template', OMITTED_PART_NAMES)
def test_an_omitted_name_part_is_refused_rather_than_normalised(identity, policy, template):
    # `a..b` is schema+object to a naive split but database + defaulted schema
    # + object to the server, and `a...b` reaches a linked server. Dropping the
    # empty parts silently made the gate agree with neither.
    name = template.format(schema=identity.schema, obj=identity.name('c01', 'tbl'))
    report = evaluate_batch(f'DROP TABLE {name};', policy)
    assert not report.allowed
    assert 'EMPTY_QUALIFIER_PART' in report.codes


def test_a_fully_qualified_owned_name_is_still_allowed(identity, policy):
    # The empty-part rule must not catch ordinary qualification.
    name = f'[{identity.database}].[{identity.schema}].[{identity.name("c01", "tbl")}]'
    report = evaluate_batch(f'DROP TABLE {name};', policy)
    assert report.allowed, [v.code for v in report.violations]


def test_the_tail_allowlist_does_not_admit_an_opening_parenthesis(identity, policy):
    # `(` was in the allowlist with no emitter behind it. No list verb is ever
    # followed by a parenthesis against the object name, and the shape that
    # looked like a counterexample is admitted by the space before WITH.
    owned = f'[{identity.schema}].[{identity.name("c01", "tbl")}]'
    report = evaluate_batch(f'DROP TABLE {owned}(, [sales].[invoices];', policy)
    assert not report.allowed
    assert 'UNPARSED_TARGET_LIST' in report.codes

    partitions = evaluate_batch(f'TRUNCATE TABLE {owned} WITH (PARTITIONS (1));', policy)
    assert partitions.allowed, [v.code for v in partitions.violations]


@pytest.mark.parametrize('lead', ['\u00e9', '\u4e2d', '\u0430', '\u00c5'])
def test_a_batch_opening_with_a_unicode_letter_is_head_checked(policy, lead):
    # The batch scan required an ASCII first character, so such a batch matched
    # nothing and was never head-checked at all. It must fail closed like any
    # other verb the scanner cannot name.
    report = evaluate_batch(f'{lead}xec [sales].[invoices];', policy)
    assert not report.allowed
    assert 'UNKNOWN_STATEMENT' in report.codes