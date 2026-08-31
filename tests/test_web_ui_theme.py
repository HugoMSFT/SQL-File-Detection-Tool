"""Tests for the reworked web UI: theme, controls and public dataset routes."""

import json
import os
import re
import shutil
import tempfile
import unittest
from unittest.mock import patch

from external_file_detection import public_data
from external_file_detection.web_gui import ExternalFileDetectionWebGUI


TEMPLATE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'external_file_detection', 'templates', 'index.html',
)


def _template_text():
    with open(TEMPLATE, encoding='utf-8') as handle:
        return handle.read()


class TestThemeMarkup(unittest.TestCase):
    """The theme must be driven by tokens, not hard-coded colours."""

    @classmethod
    def setUpClass(cls):
        cls.html = _template_text()

    def test_theme_is_applied_before_first_paint(self):
        head = self.html[:self.html.index('<style>')]
        self.assertIn("localStorage.getItem('efd-theme')", head)
        self.assertIn('prefers-color-scheme', head)
        self.assertIn("setAttribute('data-theme'", head)

    def test_light_and_dark_token_blocks_exist(self):
        self.assertIn(':root {', self.html)
        self.assertIn('html[data-theme="light"] {', self.html)
        self.assertIn('color-scheme: dark;', self.html)
        self.assertIn('color-scheme: light;', self.html)

    def test_every_token_has_both_a_dark_and_a_light_value(self):
        dark = self.html[self.html.index(':root {'):]
        dark = dark[:dark.index('}')]
        light = self.html[self.html.index('html[data-theme="light"] {'):]
        light = light[:light.index('}')]
        dark_names = set(re.findall(r'(--c-[a-z0-9-]+):', dark))
        light_names = set(re.findall(r'(--c-[a-z0-9-]+):', light))
        self.assertTrue(dark_names)
        self.assertEqual(dark_names, light_names)

    def test_no_hard_coded_colours_outside_the_token_blocks(self):
        start = self.html.index('/* ---- theme tokens')
        end = self.html.index('/* ---- header ---- */')
        body = self.html[:start] + self.html[end:]
        leftovers = re.findall(
            r'(?<![&\w])#[0-9a-fA-F]{3,8}\b|rgba\(\s*\d', body
        )
        # The one permitted literal is the translucent hover on the header
        # toggle, which sits on the fixed accent gradient in both themes.
        self.assertEqual(
            [x for x in leftovers if x != 'rgba(2'], [],
            'hard-coded colours will not adapt to the light theme',
        )

    def test_every_token_used_is_declared(self):
        declared = set(re.findall(r'(--c-[a-z0-9-]+):', self.html))
        used = set(re.findall(r'var\((--c-[a-z0-9-]+)\)', self.html))
        self.assertTrue(used)
        self.assertEqual(used - declared, set())

    def test_toggle_button_is_accessible(self):
        self.assertIn('id="themeToggle"', self.html)
        self.assertIn('aria-pressed="false"', self.html)
        self.assertIn('aria-label="Switch to light theme"', self.html)
        self.assertIn('onclick="toggleTheme()"', self.html)
        # aria-pressed, label, title, icon and text all move together.
        self.assertIn("btn.setAttribute('aria-pressed'", self.html)
        self.assertIn("btn.setAttribute('aria-label', hint)", self.html)
        self.assertIn('btn.title = hint;', self.html)
        self.assertIn("label.textContent = isLight ? 'Light' : 'Dark'",
                      self.html)

    def test_choice_is_persisted(self):
        self.assertIn("window.localStorage.setItem('efd-theme', next)",
                      self.html)


class TestSettingsControls(unittest.TestCase):
    """Table name and storage location controls."""

    @classmethod
    def setUpClass(cls):
        cls.html = _template_text()

    def test_target_table_is_explicitly_labelled_and_explained(self):
        self.assertIn('Target table (optional)', self.html)
        self.assertIn('placeholder="derived from file name"', self.html)
        self.assertIn('aria-describedby="tableNameHelp"', self.html)
        self.assertIn('Blank = derived from the file name', self.html)
        self.assertNotIn('placeholder="auto-detected"', self.html)

    def test_derived_table_name_is_displayed_not_prefilled(self):
        self.assertIn('id="derivedTableName"', self.html)
        self.assertIn('function showDerivedTableName', self.html)
        # The derived name is shown as help text, never written into the input.
        self.assertNotIn("inpTableName').value = d.derived_table_name",
                         self.html)

    def test_single_storage_url_field_replaces_three_inputs(self):
        self.assertIn('id="inpStorageUrl"', self.html)
        self.assertIn('Data URL / storage location', self.html)
        for removed in ('inpStorageAccount', 'inpStorageContainer',
                        'inpStoragePath', 'composeStorageUrl'):
            self.assertNotIn(removed, self.html)

    def test_storage_url_is_sent_verbatim(self):
        self.assertIn('const su = currentStorageUrl();', self.html)
        self.assertIn("url += '&storage_url=' + encodeURIComponent(su)",
                      self.html)

    def test_storage_url_feedback_mentions_staging(self):
        self.assertIn('stage the file first', self.html)

    def test_public_dataset_action_is_visible(self):
        self.assertIn('id="btnPublicDataset"', self.html)
        self.assertIn('Public dataset URL', self.html)
        self.assertIn('id="publicDatasetModal"', self.html)
        self.assertIn('/api/public_dataset/resolve', self.html)
        self.assertIn('/api/public_dataset/candidate', self.html)
        self.assertIn('/api/public_dataset/fetch', self.html)

    def test_candidate_urls_are_not_interpolated_into_handlers(self):
        """Hostile URLs must not be able to break out of an attribute."""
        self.assertIn('function pdAppendItem', self.html)
        self.assertIn("button.addEventListener('click', handler)", self.html)
        self.assertNotIn('onclick="usePublicCandidate', self.html)
        self.assertNotIn('onclick="resolvePublicDataset(\'', self.html)

    def test_platform_compat_matches_implementation(self):
        from external_file_detection.sql_generator import SQLGenerator

        block = self.html[self.html.index('const PLATFORM_TAB_COMPAT'):]
        block = block[:block.index('};')]
        for platform in SQLGenerator.PLATFORMS:
            self.assertIn(platform + ':', block)
            entry = block[block.index(platform + ':'):]
            entry = entry[:entry.index('}')]
            # External tables are generated for every platform, with format
            # support handled per file type.
            self.assertIn("ext_table: 'green'", entry)
        # Only Fabric SQL DB lacks BULK INSERT.
        self.assertEqual(block.count("bulk_insert: 'red'"), 1)

    def test_ext_table_format_map_matches_generator(self):
        from external_file_detection.sql_generator import SQLGenerator

        block = self.html[self.html.index('const EXT_TABLE_FORMAT_PLATFORMS'):]
        block = block[:block.index('};')]
        for file_type, key in (('csv', 'DELIMITEDTEXT'),
                               ('parquet', 'PARQUET'),
                               ('delta', 'DELTA'),
                               ('json', 'JSON')):
            listed = re.search(file_type + r':\s*\[(.*?)\]', block,
                               re.DOTALL).group(1)
            names = set(re.findall(r"'([a-z0-9_]+)'", listed))
            self.assertEqual(
                names, set(SQLGenerator.EXTERNAL_FORMAT_PLATFORMS[key]),
                f'{file_type} tab dots disagree with the SQL generator',
            )

    def test_no_stale_synapse_only_guidance(self):
        quickstart = self.html[self.html.index('const TAB_QUICKSTART'):]
        quickstart = quickstart[:quickstart.index('\n        };')]
        self.assertNotIn("best: 'Synapse, SQL Server'", quickstart)
        self.assertIn('Fabric SQL Database has no BULK INSERT', quickstart)


class TestPublicDatasetRoutes(unittest.TestCase):
    """API surface for the public dataset workflow."""

    def setUp(self):
        self.test_root = tempfile.mkdtemp()
        self.web_gui = ExternalFileDetectionWebGUI(root_dir=self.test_root)
        self.web_gui.app.config['TESTING'] = True
        self.client = self.web_gui.app.test_client()

    def tearDown(self):
        try:
            self.web_gui._upload_tempdir.cleanup()
        except Exception:
            pass
        shutil.rmtree(self.test_root, ignore_errors=True)

    def test_resolve_rejects_http(self):
        response = self.client.post('/api/public_dataset/resolve',
                                    json={'url': 'http://example.com/a.csv'})
        self.assertEqual(response.status_code, 400)
        payload = json.loads(response.data)
        self.assertFalse(payload['success'])
        self.assertEqual(payload['code'], 'scheme_not_allowed')

    def test_resolve_rejects_missing_url(self):
        response = self.client.post('/api/public_dataset/resolve', json={})
        self.assertEqual(response.status_code, 400)
        self.assertFalse(json.loads(response.data)['success'])

    def test_resolve_returns_structured_result(self):
        with patch.object(public_data, 'resolve_public_url',
                          return_value={'kind': 'data',
                                        'url': 'https://x/y.csv'}):
            response = self.client.post('/api/public_dataset/resolve',
                                        json={'url': 'https://x/y.csv'})
        self.assertEqual(response.status_code, 200)
        payload = json.loads(response.data)
        self.assertTrue(payload['success'])
        self.assertEqual(payload['kind'], 'data')

    def test_fetch_downloads_analyses_and_registers_the_file(self):
        def fake_download(url, destination_dir, **kwargs):
            path = os.path.join(destination_dir, 'sample.csv')
            with open(path, 'w', encoding='utf-8') as handle:
                handle.write('id,name\n1,Ada\n2,Grace\n')
            return {'path': path, 'file_name': 'sample.csv', 'bytes': 24,
                    'source_url': url, 'final_url': url}

        url = 'https://acct.blob.core.windows.net/c/sample.csv'
        with patch.object(public_data, 'download_data_file', fake_download):
            response = self.client.post('/api/public_dataset/fetch',
                                        json={'url': url})
        self.assertEqual(response.status_code, 200)
        payload = json.loads(response.data)
        self.assertTrue(payload['success'])
        self.assertEqual(payload['file']['file_type'], 'csv')
        self.assertEqual(payload['file']['source_url'], url)
        # An Azure Blob URL keeps its storage semantics.
        self.assertEqual(payload['storage_url'], url)
        self.assertFalse(payload['staging_required'])

        listed = self.client.get('/api/files')
        if listed.status_code == 200:
            self.assertIn(b'sample.csv', listed.data)

    def test_fetch_from_a_random_host_requires_staging(self):
        def fake_download(url, destination_dir, **kwargs):
            path = os.path.join(destination_dir, 'sample.csv')
            with open(path, 'w', encoding='utf-8') as handle:
                handle.write('id\n1\n')
            return {'path': path, 'file_name': 'sample.csv', 'bytes': 5,
                    'source_url': url, 'final_url': url}

        with patch.object(public_data, 'download_data_file', fake_download):
            response = self.client.post(
                '/api/public_dataset/fetch',
                json={'url': 'https://example.com/sample.csv'},
            )
        payload = json.loads(response.data)
        self.assertTrue(payload['success'])
        self.assertIsNone(payload['storage_url'])
        self.assertTrue(payload['staging_required'])

    def test_fetch_cleans_up_when_the_download_fails(self):
        before = set(os.listdir(self.web_gui._upload_root))
        error = public_data.PublicDataError('too big', status=413,
                                            code='too_large')
        with patch.object(public_data, 'download_data_file',
                          side_effect=error):
            response = self.client.post(
                '/api/public_dataset/fetch',
                json={'url': 'https://example.com/sample.csv'},
            )
        self.assertEqual(response.status_code, 413)
        payload = json.loads(response.data)
        self.assertEqual(payload['code'], 'too_large')
        leftover = []
        for session_dir in os.listdir(self.web_gui._upload_root):
            if session_dir in before:
                continue
            leftover.extend(
                os.listdir(os.path.join(self.web_gui._upload_root,
                                        session_dir))
            )
        self.assertEqual(leftover, [])

    def test_candidate_reports_storage_url_when_listing_fails(self):
        error = public_data.PublicDataError('no listing', status=502,
                                            code='listing_failed')
        url = 'abs://c@acct.blob.core.windows.net/folder/*.parquet'
        with patch.object(public_data, 'first_supported_blob',
                          side_effect=error):
            response = self.client.post('/api/public_dataset/candidate',
                                        json={'url': url})
        self.assertEqual(response.status_code, 502)
        payload = json.loads(response.data)
        self.assertEqual(payload['storage_url'], url)


class TestSqlDdlContract(unittest.TestCase):
    """/api/sql_ddl reports the names it actually used."""

    def setUp(self):
        self.test_root = tempfile.mkdtemp()
        self.csv_path = os.path.join(self.test_root, '2024 sales.csv')
        with open(self.csv_path, 'w', encoding='utf-8') as handle:
            handle.write('id,amount\n1,10\n2,20\n')
        self.web_gui = ExternalFileDetectionWebGUI(root_dir=self.test_root)
        self.web_gui.app.config['TESTING'] = True
        self.client = self.web_gui.app.test_client()
        self.client.post('/api/analyze_files',
                         json={'files': [self.csv_path]})

    def tearDown(self):
        try:
            self.web_gui._upload_tempdir.cleanup()
        except Exception:
            pass
        shutil.rmtree(self.test_root, ignore_errors=True)

    def _ddl(self, **params):
        from urllib.parse import quote, urlencode

        query = urlencode(params)
        return json.loads(self.client.get(
            '/api/sql_ddl/' + quote(self.csv_path.lstrip('/'), safe='/')
            + ('?' + query if query else '')
        ).data)

    def test_derived_name_is_reported(self):
        payload = self._ddl()
        self.assertTrue(payload['success'])
        self.assertEqual(payload['derived_table_name'], 'col_2024_sales')
        self.assertEqual(payload['resolved_table_name'], 'col_2024_sales')

    def test_override_is_reported_and_used(self):
        payload = self._ddl(table_name='CuratedSales')
        self.assertEqual(payload['resolved_table_name'], 'CuratedSales')
        self.assertEqual(payload['derived_table_name'], 'col_2024_sales')
        self.assertIn('CuratedSales', payload['statements']['create_table'])

    def test_invalid_platform_falls_back_to_the_default(self):
        payload = self._ddl(target_platform='not_a_platform')
        self.assertTrue(payload['success'])
        self.assertIn('CREATE TABLE', payload['statements']['create_table'])

    def test_storage_url_is_echoed(self):
        url = 'abs://c@acct.blob.core.windows.net/f/2024 sales.csv'
        payload = self._ddl(storage_url=url)
        self.assertEqual(payload['resolved_storage_url'], url)


if __name__ == '__main__':
    unittest.main()
