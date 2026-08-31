"""The complete document has to survive being run twice.

A single statement tab is something you copy into an editor once. The complete
document is something people re-run after fixing a typo three sections down, and
the first live certification run proved what happened when they did: error 46502,
because the external data source the script had just created still existed.

These tests pin both halves of rerun safety - guarded DDL, and a load that does
not double the rows - and they pin the boundary: the individual tabs are *not*
guarded, because a bare CREATE is what a person copying one statement wants.
"""

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from external_file_detection.sql_generator import SQLGenerator  # noqa: E402
from external_file_detection.sql_generator import (  # noqa: E402
    _owns_load_target,
)


CREATE_LINE = re.compile(
    r'^[ \t]*CREATE\s+(?:EXTERNAL\s+DATA\s+SOURCE|EXTERNAL\s+FILE\s+FORMAT'
    r'|DATABASE\s+SCOPED\s+CREDENTIAL|EXTERNAL\s+TABLE|TABLE)\b',
    re.IGNORECASE,
)


def csv_metadata(**overrides):
    metadata = {
        'file_type': 'csv',
        'file_name': 'iris.csv',
        'file_path': 'iris.csv',
        'delimiter': ',',
        'encoding': 'utf-8',
        'codepage': '65001',
        'has_header': True,
        'row_count': 150,
        'column_count': 5,
        'schema': [
            ['sepal_length', 'float64'],
            ['sepal_width', 'float64'],
            ['petal_length', 'float64'],
            ['petal_width', 'float64'],
            ['species', 'object'],
        ],
    }
    metadata.update(overrides)
    return metadata


def complete(metadata=None, **options):
    settings = {
        'table_name': 'cert_iris',
        'schema_name': 'cert_schema',
        'data_source': 'cert_src',
        'target_platform': 'sql_server_2025',
        'storage_url': 'abs://datasets@example.blob.core.windows.net',
        # The document under test here is the owned one: an explicit schema and
        # table the caller named, with rerun truncation asked for. The default
        # document is the subject of TheDefaultDocumentIsNotDestructive below.
        'rerun_truncate': True,
    }
    settings.update(options)
    return SQLGenerator().generate_complete_ddl(metadata or csv_metadata(), **settings)


def live_lines(document, pattern):
    """Lines matching *pattern* that are statements rather than commentary."""
    return [
        line for line in document.split('\n')
        if re.search(pattern, line, re.IGNORECASE) and not line.lstrip().startswith('--')
    ]


def unguarded_creates(document):
    """Every CREATE in *document* that nothing checked for first."""
    lines = document.split('\n')
    offenders = []
    for index, line in enumerate(lines):
        if not CREATE_LINE.match(line):
            continue
        preceding = [
            earlier.strip().upper()
            for earlier in lines[max(0, index - 3):index]
            if earlier.strip()
        ]
        if not any(
            text.startswith('IF NOT EXISTS') or text.startswith('IF OBJECT_ID')
            for text in preceding
        ):
            offenders.append(line.strip())
    return offenders


class CompleteDocumentIsRerunnable(unittest.TestCase):
    def test_every_create_is_guarded(self):
        self.assertEqual([], unguarded_creates(complete()))

    def test_the_guard_names_the_right_catalog(self):
        document = complete()
        self.assertIn(
            "IF NOT EXISTS (SELECT 1 FROM sys.external_data_sources "
            "WHERE name = N'cert_src')",
            document,
        )
        self.assertIn(
            "IF OBJECT_ID(N'[cert_schema].[cert_iris]', N'U') IS NULL", document,
        )

    def test_the_guard_uses_the_unbracketed_name_for_catalog_lookups(self):
        # sys.external_data_sources.name holds cert_src, not [cert_src]: a guard
        # that compared the bracketed form would never match and the CREATE
        # would run every time, which is the bug it exists to prevent.
        document = complete()
        self.assertNotIn("WHERE name = N'[cert_src]'", document)

    def test_the_load_target_is_emptied_before_the_load(self):
        document = complete()
        truncate = document.index('    TRUNCATE TABLE [cert_schema].[cert_iris];')
        load = document.index('BULK INSERT [cert_schema].[cert_iris]')
        self.assertLess(truncate, load)

    def test_the_truncate_is_its_own_batch(self):
        document = complete()
        tail = document[document.index('    TRUNCATE TABLE'):]
        self.assertRegex(tail.split('\n', 2)[1], r'^\s*GO\s*$')

    def test_the_truncate_is_guarded_too(self):
        # On a first run against a database where the table does not exist yet
        # the guard above skipped the CREATE only if it was there; TRUNCATE has
        # no such luxury and would fail on a table that is genuinely absent.
        self.assertIn(
            "IF OBJECT_ID(N'[cert_schema].[cert_iris]', N'U') IS NOT NULL",
            complete(),
        )

    def test_a_commented_load_does_not_trigger_a_truncate(self):
        # The CREATE TABLE section ends with a commented-out QUICK LOAD. If that
        # counted as a load the table would be emptied immediately after being
        # created, which is harmless but says something untrue about the script.
        document = complete()
        quick_load = document.index('QUICK LOAD')
        truncate = document.index('    TRUNCATE TABLE')
        self.assertGreater(truncate, quick_load)

    def test_a_document_with_no_load_gets_no_truncate(self):
        # Parquet has no BULK INSERT path, so there is nothing to double.
        document = complete(csv_metadata(
            file_type='parquet', file_name='data.parquet', file_path='data.parquet',
            delimiter=None, has_header=None,
        ))
        self.assertNotIn('TRUNCATE TABLE', document)

    def test_a_semicolon_inside_a_literal_does_not_end_the_statement(self):
        # A semicolon-delimited CSV puts a semicolon in FIELD_TERMINATOR. If the
        # guard treated that as the end of the CREATE, END would land in the
        # middle of the statement and the script would not parse.
        document = complete(csv_metadata(delimiter=';'))
        self.assertIn("FIELD_TERMINATOR = ';'", document)
        start = document.index('CREATE EXTERNAL FILE FORMAT')
        body = document[start:]
        end_of_statement = body.index(');')
        self.assertNotIn('END', body[:end_of_statement])
        self.assertEqual([], unguarded_creates(document))

    def test_every_begin_has_an_end(self):
        for delimiter in (',', ';', '|', '\t'):
            document = complete(csv_metadata(delimiter=delimiter))
            begins = len(re.findall(r'^\s*BEGIN\s*$', document, re.MULTILINE))
            ends = len(re.findall(r'^\s*END\s*$', document, re.MULTILINE))
            self.assertEqual(begins, ends, f'unbalanced for delimiter {delimiter!r}')
            self.assertGreater(begins, 0)

    def test_an_apostrophe_in_a_column_name_does_not_swallow_the_batch(self):
        # escape_identifier only doubles ']', so a column called "Employee's ID"
        # reaches the guard with a live apostrophe in it. Reading that as the
        # start of a string literal inverts the quote parity for the rest of the
        # scan: the real ';' is missed, the block runs on past a GO, and the
        # first batch ends with an unterminated BEGIN. CSV headers like
        # "Employee's ID" or "Q1'24" produce exactly this.
        document = complete(csv_metadata(schema=[
            ["Employee's ID", 'int64'],
            ["Q1'24", 'float64'],
            ['species', 'object'],
        ]))
        self.assertIn("[Employee's ID]", document)
        begins = len(re.findall(r'^\s*BEGIN\s*$', document, re.MULTILINE))
        ends = len(re.findall(r'^\s*END\s*$', document, re.MULTILINE))
        self.assertEqual(begins, ends)
        self.assertEqual([], unguarded_creates(document))

    def test_no_go_is_ever_indented_into_a_guard_block(self):
        # sqlcmd and SSMS treat an indented GO as a batch separator all the
        # same, so a GO that ended up inside BEGIN/END breaks the document no
        # matter how it is spelled. Nothing the guard wraps may cross one.
        for metadata in (csv_metadata(),
                         csv_metadata(delimiter=';'),
                         csv_metadata(schema=[["it's", 'int64']])):
            document = complete(metadata)
            swallowed = [
                line for line in document.split('\n')
                if line.strip().upper() == 'GO' and line != line.lstrip()
            ]
            self.assertEqual([], swallowed, document[:400])


class TheDefaultDocumentIsNotDestructive(unittest.TestCase):
    """The default target is a guess, and the document must treat it as one.

    A file called ``orders.csv`` derives the table name ``dbo.orders``. That is
    the name a TPC-H warehouse already uses, and it is the name this tool would
    pick for anybody who dropped an export on it. Emptying it because the
    document happened to be run twice is silent data loss, so the live
    ``TRUNCATE`` is opt-in and the default output only ever describes it.
    """

    def default_document(self, **options):
        settings = {
            'target_platform': 'sql_server_2025',
            'storage_url': 'abs://datasets@example.blob.core.windows.net',
        }
        settings.update(options)
        return SQLGenerator().generate_complete_ddl(
            csv_metadata(file_name='orders.csv', file_path='orders.csv'), **settings
        )

    def test_a_default_run_emits_no_live_truncate(self):
        document = self.default_document()
        self.assertEqual([], live_lines(document, r'^\s*TRUNCATE\s+TABLE'))

    def test_the_default_target_is_the_one_that_would_have_been_hit(self):
        # If this stops resolving to dbo.orders the test above stops proving
        # anything, so pin the collision the fix exists for.
        document = self.default_document()
        self.assertIn('[dbo].[orders]', document)

    def test_the_truncate_is_still_offered_as_guidance(self):
        document = self.default_document()
        self.assertIn("-- IF OBJECT_ID(N'[dbo].[orders]', N'U') IS NOT NULL", document)
        self.assertIn('--     TRUNCATE TABLE [dbo].[orders];', document)
        self.assertIn('RERUN SAFETY', document)

    def test_asking_for_it_is_not_enough_in_the_default_schema(self):
        # An explicit table name in dbo is still a name that shares a namespace
        # with everything else in dbo, so the opt-in alone does not unlock it.
        document = self.default_document(table_name='my_orders', rerun_truncate=True)
        self.assertEqual([], live_lines(document, r'^\s*TRUNCATE\s+TABLE'))

    def test_an_explicit_owned_target_unlocks_it(self):
        document = self.default_document(
            table_name='my_orders', schema_name='staging', rerun_truncate=True,
        )
        self.assertEqual(
            ['    TRUNCATE TABLE [staging].[my_orders];'],
            live_lines(document, r'^\s*TRUNCATE\s+TABLE'),
        )

    def test_a_named_target_without_the_opt_in_stays_commented(self):
        document = self.default_document(table_name='my_orders', schema_name='staging')
        self.assertEqual([], live_lines(document, r'^\s*TRUNCATE\s+TABLE'))

    def test_the_guarded_create_still_protects_a_pre_existing_table(self):
        # The other half of not touching someone else's table: the CREATE is
        # skipped rather than attempted, so the document neither errors nor
        # redefines what is already there.
        document = self.default_document()
        self.assertIn("IF OBJECT_ID(N'[dbo].[orders]', N'U') IS NULL", document)

    def test_nothing_in_the_default_document_mutates_existing_rows(self):
        document = self.default_document()
        for verb in (r'^\s*DELETE\b', r'^\s*UPDATE\b', r'^\s*MERGE\b',
                     r'^\s*DROP\s+TABLE\b'):
            self.assertEqual([], live_lines(document, verb), verb)


class OwnershipIsDecidedBeforeAnythingIsEmptied(unittest.TestCase):
    def test_owns_load_target_requires_both_halves(self):
        from external_file_detection.sql_generator import _owns_load_target

        self.assertTrue(_owns_load_target('cert_iris', 'cert_schema'))
        self.assertFalse(_owns_load_target('cert_iris', 'dbo'))
        self.assertFalse(_owns_load_target('cert_iris', 'DBO'))
        self.assertFalse(_owns_load_target('cert_iris', None))
        self.assertFalse(_owns_load_target('', 'cert_schema'))
        self.assertFalse(_owns_load_target(None, 'cert_schema'))
        self.assertFalse(_owns_load_target('   ', 'cert_schema'))


class IndividualTabsAreNotGuarded(unittest.TestCase):
    """The rerun contract belongs to the document, not to every statement."""

    def test_the_create_table_tab_is_a_bare_create(self):
        statements = SQLGenerator().generate_all_statements(
            csv_metadata(), 'cert_iris', 'cert_src', None, 'cert_schema',
            target_platform='sql_server_2025',
        )
        self.assertNotIn('IF OBJECT_ID', statements['create_table'])
        self.assertIn('CREATE TABLE', statements['create_table'])

    def test_the_credential_setup_tab_is_a_bare_create(self):
        statements = SQLGenerator().generate_all_statements(
            csv_metadata(), 'cert_iris', 'cert_src', None, 'cert_schema',
            target_platform='sql_server_2025',
            storage_url='abs://datasets@example.blob.core.windows.net',
        )
        setup = statements['credential_setup']
        self.assertIn('CREATE EXTERNAL DATA SOURCE', setup)
        self.assertNotIn('sys.external_data_sources', setup)


class EveryPlatformStaysRerunnable(unittest.TestCase):
    def test_no_platform_emits_an_unguarded_create(self):
        for platform in SQLGenerator.PLATFORMS:
            document = complete(target_platform=platform)
            self.assertEqual(
                [], unguarded_creates(document), f'{platform} left a bare CREATE',
            )


if __name__ == '__main__':
    unittest.main()


class OwnershipWhitespaceMatchesTheNativeGenerator(unittest.TestCase):
    """``str.strip()`` and JS ``trim()`` are not the same function.

    Python strips U+001C-U+001F and U+0085, which JS keeps; JS strips U+FEFF,
    which Python keeps. Ownership decides whether a ``TRUNCATE`` is emitted live,
    so a disagreement here is a disagreement about whether the generated script
    empties a table the user never asked it to empty. The native side uses
    ``pythonStrip()`` to match this; these cases are mirrored one for one in
    ``src/test/native/completeDocumentRerun.test.ts``.
    """

    PYTHON_ONLY_WHITESPACE = ('\x1c', '\x1d', '\x1e', '\x1f', '\x85')

    def test_dbo_padded_with_python_only_whitespace_is_still_dbo(self):
        for ws in self.PYTHON_ONLY_WHITESPACE:
            with self.subTest(ws=hex(ord(ws))):
                self.assertFalse(_owns_load_target('orders', f'dbo{ws}'))
                self.assertFalse(_owns_load_target('orders', f'{ws}dbo{ws}'))

    def test_a_table_name_of_only_whitespace_is_unnamed(self):
        for ws in self.PYTHON_ONLY_WHITESPACE:
            with self.subTest(ws=hex(ord(ws))):
                self.assertFalse(_owns_load_target(ws, 'cert_run'))

    def test_no_live_truncate_for_a_padded_dbo_schema(self):
        for ws in self.PYTHON_ONLY_WHITESPACE:
            with self.subTest(ws=hex(ord(ws))):
                document = complete(
                    csv_metadata(file_name='orders.csv', file_path='orders.csv'),
                    table_name='orders',
                    schema_name=f'dbo{ws}',
                )
                self.assertEqual(live_lines(document, r'TRUNCATE\s+TABLE'), [])

    def test_a_byte_order_mark_is_not_whitespace(self):
        # Kept by str.strip(), so '\ufeffdbo' is a different schema from 'dbo'
        # and is owned. It escapes to [\ufeffdbo], which OBJECT_ID resolves to
        # nothing, so this is safe as well as consistent.
        self.assertTrue(_owns_load_target('orders', '\ufeffdbo'))

    def test_whitespace_both_languages_agree_on(self):
        self.assertFalse(_owns_load_target('orders', ' \t\r\n\f\vdbo '))
        self.assertTrue(_owns_load_target(' orders ', ' cert_run '))
