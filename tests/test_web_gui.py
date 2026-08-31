"""Tests for web GUI functionality."""

import unittest
import io
import json
import os
import shutil
import tempfile
import time
from unittest.mock import patch, MagicMock
from urllib.parse import quote

from external_file_detection.web_gui import ExternalFileDetectionWebGUI


class TestWebGUI(unittest.TestCase):
    """Test web GUI functionality."""
    
    def setUp(self):
        """Set up test fixtures."""
        # Use temp dir as root so test temp files pass path validation
        self.test_root = tempfile.mkdtemp()
        self.web_gui = ExternalFileDetectionWebGUI(root_dir=self.test_root)
        self.app = self.web_gui.app
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()
        
        # Create test data
        self.test_files = [
            {
                'file_path': '/test/sample.csv',
                'file_type': 'csv',
                'file_size': 100,
                'schema': [('id', 'int64'), ('name', 'object')],
                'has_header': True
            },
            {
                'file_path': '/test/sample.json',
                'file_type': 'json',
                'file_size': 200,
                'schema': [('id', 'int64'), ('data', 'object')]
            }
        ]
        
    def tearDown(self):
        """Remove temp directories so tests do not leak them."""
        _cleanup_gui(self.web_gui)
        shutil.rmtree(self.test_root, ignore_errors=True)

    def test_home_page(self):
        """Test home page loads correctly."""
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'SQL File Detection Tool', response.data)
        self.assertIn(b'Best Practices', response.data)
        self.assertIn(b'Schema Editor', response.data)
        self.assertIn(b"adls://", response.data)

    def test_home_page_defaults_to_azure_sql_database(self):
        """The rendered page must advertise the Azure SQL Database default."""
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        body = response.data.decode('utf-8')
        marker = '<script id="appConfig" type="application/json">'
        start = body.index(marker) + len(marker)
        config = json.loads(body[start:body.index('</script>', start)])
        self.assertEqual(config['defaultPlatform'], 'azure_sql_db')
        self.assertTrue(config['sessionToken'])

    def test_initial_path_api(self):
        """Test /api/initial_path returns a valid directory."""
        response = self.client.get('/api/initial_path')
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        self.assertTrue(data['success'])
        self.assertIn('path', data)
        self.assertTrue(len(data['path']) > 0)
        
    def test_browse_files_api(self):
        """Test browse files API endpoint."""
        with patch('os.listdir') as mock_listdir, \
             patch('os.path.isdir') as mock_isdir, \
             patch('os.path.getsize') as mock_getsize, \
             patch('os.path.exists') as mock_exists, \
             patch('os.path.abspath') as mock_abspath:
            
            mock_listdir.return_value = ['file1.csv', 'file2.json', 'folder1']
            mock_isdir.side_effect = lambda x: x.endswith('folder1')
            mock_getsize.return_value = 100
            mock_exists.return_value = True
            mock_abspath.return_value = '/test'
            
            response = self.client.get('/api/browse?path=/test')
            self.assertEqual(response.status_code, 200)
            
            data = json.loads(response.data)
            self.assertTrue(data['success'])
            # On Windows os.path.abspath('/test') returns '\\test' or 'C:\\test'
            self.assertIn('test', data['current_path'])
            
            # Should have files and folders
            items = data['items']
            self.assertTrue(any(item['type'] == 'file' for item in items))
            self.assertTrue(any(item['type'] == 'directory' for item in items))
            
    def test_analyze_files_api(self):
        """Test analyze files API endpoint."""
        # Mock the file detector and path validation
        with patch.object(self.web_gui.file_detector, 'analyze_file_metadata') as mock_analyze, \
             patch('os.path.exists') as mock_exists, \
             patch('os.path.isfile') as mock_isfile, \
             patch('os.path.abspath') as mock_abspath:
            
            mock_analyze.return_value = self.test_files[0]
            mock_exists.return_value = True
            mock_isfile.return_value = True
            mock_abspath.return_value = '/test/sample.csv'
            
            response = self.client.post('/api/analyze_files', 
                                      json={'files': ['/test/sample.csv']})
            self.assertEqual(response.status_code, 200)
            
            data = json.loads(response.data)
            self.assertTrue(data['success'])
            self.assertEqual(data['count'], 1)
            self.assertEqual(len(data['files']), 1)
            
    def test_analyze_folder_api(self):
        """Test analyze folder API endpoint."""
        # Mock the file detector and path validation
        with patch.object(self.web_gui.file_detector, 'scan_directory') as mock_scan, \
             patch('os.path.exists') as mock_exists, \
             patch('os.path.isdir') as mock_isdir, \
             patch('os.path.abspath') as mock_abspath:
            
            mock_scan.return_value = self.test_files
            mock_exists.return_value = True
            mock_isdir.return_value = True
            mock_abspath.return_value = '/test'
            
            response = self.client.post('/api/analyze_folder', 
                                      json={'folder': '/test'})
            self.assertEqual(response.status_code, 200)
            
            data = json.loads(response.data)
            self.assertTrue(data['success'])
            self.assertEqual(data['count'], 2)
            self.assertEqual(len(data['files']), 2)
            
    def _create_csv(self, content='id,name\n1,John\n2,Jane\n', name='test.csv'):
        """Create a CSV file inside test_root."""
        path = os.path.join(self.test_root, name)
        with open(path, 'w') as f:
            f.write(content)
        return path

    def test_preview_api(self):
        """Test file preview API via analyze-first flow."""
        csv_path = self._create_csv()

        resp = self.client.post('/api/analyze_files', json={'files': [csv_path]})
        self.assertEqual(resp.status_code, 200)
        data = json.loads(resp.data)
        stored_path = data['files'][0]['file_path']

        from urllib.parse import quote
        resp2 = self.client.get('/api/preview/' + quote(stored_path.lstrip('/'), safe='/'))
        self.assertEqual(resp2.status_code, 200)
        data2 = json.loads(resp2.data)
        self.assertTrue(data2['success'])
        self.assertIn('id,name', data2['preview'])

    def test_sql_ddl_api(self):
        """Test SQL DDL API via analyze-first flow."""
        csv_path = self._create_csv()

        resp = self.client.post('/api/analyze_files', json={'files': [csv_path]})
        self.assertEqual(resp.status_code, 200)
        data = json.loads(resp.data)
        stored_path = data['files'][0]['file_path']

        from urllib.parse import quote
        resp2 = self.client.get(
            '/api/sql_ddl/' + quote(stored_path.lstrip('/'), safe='/') +
            '?data_source=TestDS&target_platform=sql_server_2022')
        self.assertEqual(resp2.status_code, 200)
        data2 = json.loads(resp2.data)
        self.assertTrue(data2['success'])
        self.assertIn('statements', data2)

    def test_data_source_api_uses_modern_adls_connector(self):
        """SQL Server 2022 Azure data sources use adls:// without TYPE."""
        response = self.client.post(
            '/api/generate-data-source',
            json={
                'name': 'LakeDS',
                'storage_type': 'azure',
                'location': (
                    'https://account.dfs.core.windows.net/'
                    'container/folder/sample.parquet'
                ),
                'credential': 'LakeCredential',
                'target_platform': 'sql_server_2022',
            },
        )

        self.assertEqual(response.status_code, 200)
        ddl = json.loads(response.data)['sql_ddl']
        self.assertIn(
            "LOCATION = 'adls://container@account.dfs.core.windows.net'",
            ddl,
        )
        self.assertNotIn('TYPE = HADOOP', ddl)
        self.assertNotIn("LOCATION = 'https://", ddl)

    def test_file_details_api(self):
        """Test file details API via analyze-first flow."""
        csv_path = self._create_csv()

        resp = self.client.post('/api/analyze_files', json={'files': [csv_path]})
        self.assertEqual(resp.status_code, 200)
        data = json.loads(resp.data)
        stored_path = data['files'][0]['file_path']

        from urllib.parse import quote
        resp2 = self.client.get('/api/file_details/' + quote(stored_path.lstrip('/'), safe='/'))
        self.assertEqual(resp2.status_code, 200)
        data2 = json.loads(resp2.data)
        self.assertTrue(data2['success'])
        self.assertEqual(data2['details']['file_type'], 'csv')
        
    def test_preview_content_generation(self):
        """Test preview content generation for different file types."""
        # Test CSV preview
        csv_path = self._create_csv('id,name\n1,John\n2,Jane\n', 'preview_test.csv')
        csv_file = {
            'file_path': csv_path,
            'file_type': 'csv'
        }
        preview = self.web_gui._generate_preview_content(csv_file)
        self.assertIn('id,name', preview)
        self.assertIn('1,John', preview)

        # Test JSON preview
        json_path = os.path.join(self.test_root, 'preview_test.json')
        with open(json_path, 'w') as f:
            json.dump([{'id': 1, 'name': 'John'}], f)
        json_file = {
            'file_path': json_path,
            'file_type': 'json'
        }
        preview = self.web_gui._generate_preview_content(json_file)
        self.assertIn('"id": 1', preview)
        self.assertIn('"name": "John"', preview)
            
    def test_format_file_size(self):
        """Test file size formatting."""
        self.assertEqual(ExternalFileDetectionWebGUI.format_file_size(0), "0 B")
        self.assertEqual(ExternalFileDetectionWebGUI.format_file_size(1023), "1023.0 B")
        self.assertEqual(ExternalFileDetectionWebGUI.format_file_size(1024), "1.0 KB")
        self.assertEqual(ExternalFileDetectionWebGUI.format_file_size(1024 * 1024), "1.0 MB")
        self.assertEqual(ExternalFileDetectionWebGUI.format_file_size(1024 * 1024 * 1024), "1.0 GB")
        
    def test_error_handling(self):
        """Test error handling in API endpoints."""
        # Test preview with unregistered file
        response = self.client.get('/api/preview/nonexistent_file.csv')
        self.assertEqual(response.status_code, 404)
        data = json.loads(response.data)
        self.assertFalse(data['success'])
        self.assertIn('not found', data['error'].lower())

        # Test analyze with non-existent file
        response = self.client.post('/api/analyze_files',
                                    json={'files': ['/nonexistent/path/file.csv']})
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        self.assertTrue(data['success'])  # request itself succeeds
        self.assertEqual(data['files'][0]['file_type'], 'error')

        # Test analyze with no files
        response = self.client.post('/api/analyze_files', json={'files': []})
        self.assertEqual(response.status_code, 400)
        data = json.loads(response.data)
        self.assertFalse(data['success'])

    def test_uploaded_file_persists_for_preview(self):
        response = self.client.post('/api/upload', data={
            'files': (io.BytesIO(b'id,name\n1,Alice\n'), 'upload.csv'),
        }, content_type='multipart/form-data')

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        stored_path = data['files'][0]['file_path']
        self.assertTrue(os.path.exists(stored_path))
        self.assertEqual(data['files'][0]['file_name'], 'upload.csv')

        from urllib.parse import quote
        preview_url = '/api/preview_table/' + quote(
            stored_path.replace('\\', '/').lstrip('/'), safe='/'
        )
        preview = self.client.get(preview_url)

        self.assertEqual(preview.status_code, 200)
        self.assertTrue(preview.get_json()['success'])

    def test_compatibility_upload_keeps_returned_path_alive(self):
        response = self.client.post('/api/analyze-upload', data={
            'files': (io.BytesIO(b'id,name\n1,Alice\n'), 'legacy.csv'),
        }, content_type='multipart/form-data')

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        stored_path = data['results'][0]['metadata']['file_path']
        self.assertTrue(data['results'][0]['success'])
        self.assertTrue(os.path.exists(stored_path))

    def test_replaced_upload_batch_is_retired_before_cleanup(self):
        first = self.client.post('/api/upload', data={
            'files': (io.BytesIO(b'id\n1\n'), 'first.csv'),
        }, content_type='multipart/form-data').get_json()
        first_path = first['files'][0]['file_path']
        first_dir = os.path.dirname(first_path)

        self.client.post('/api/upload', data={
            'files': (io.BytesIO(b'id\n2\n'), 'second.csv'),
        }, content_type='multipart/form-data')

        self.assertTrue(os.path.exists(first_path))
        with self.web_gui._sessions_lock:
            self.web_gui._retired_upload_dirs[first_dir] = (
                time.time() - self.web_gui._session_ttl - 1
            )
        with self.app.test_request_context('/'):
            self.web_gui._get_files()
        self.assertFalse(os.path.exists(first_dir))

    def test_binary_legacy_preview_uses_bounded_detector_preview(self):
        parquet_path = os.path.join(self.test_root, 'bounded.parquet')
        with open(parquet_path, 'wb') as handle:
            handle.write(b'PAR1')
        preview_data = {
            'columns': [{'name': 'id', 'type': 'int64'}],
            'rows': [[1]],
            'total_rows': 1,
            'truncated': False,
        }

        with patch.object(
            self.web_gui.file_detector,
            'get_preview_data',
            return_value=preview_data,
        ) as get_preview:
            content = self.web_gui._generate_preview_content({
                'file_path': parquet_path,
                'file_type': 'parquet',
                'encoding': 'binary',
            })

        get_preview.assert_called_once_with(
            os.path.realpath(os.path.abspath(parquet_path)), max_rows=10
        )
        self.assertIn('"rows"', content)
        self.assertIn('[\n      1\n    ]', content)

    def test_sql_ddl_api_via_analyze_flow(self):
        """Test SQL DDL generation after analysing real files."""
        csv_path = self._create_csv('id,name,age\n1,Alice,30\n2,Bob,25\n', 'flow_test.csv')

        # First analyse the file
        resp = self.client.post('/api/analyze_files',
                                json={'files': [csv_path]})
        self.assertEqual(resp.status_code, 200)
        data = json.loads(resp.data)
        self.assertTrue(data['success'])

        # Use the stored file_path (which is os.path.abspath-normalised)
        stored_path = data['files'][0]['file_path']

        # Now request DDL using the exact stored path
        from urllib.parse import quote
        resp2 = self.client.get(
            '/api/sql_ddl/' + quote(stored_path.lstrip('/'), safe='/') +
            '?target_platform=sql_server_2022&schema=dbo&data_source=DS')
        self.assertEqual(resp2.status_code, 200)
        data2 = json.loads(resp2.data)
        self.assertTrue(data2['success'])
        stmts = data2.get('statements', {})
        self.assertIn('create_table', stmts)
        self.assertIn('best_practices', stmts)
        self.assertIn('CREATE TABLE', stmts['create_table'])
        self.assertIn('RECOMMENDED PATH', stmts['best_practices'])
        self.assertIn('VALIDATION SQL AFTER LOAD', stmts['best_practices'])
        # SQL Server mode should NOT have DISTRIBUTION clause
        self.assertNotIn('DISTRIBUTION', stmts['create_table'])

    def test_sql_ddl_api_best_practices_for_fabric(self):
        """Best practices payload should include Fabric-specific guidance."""
        json_path = os.path.join(self.test_root, 'fabric_payload.json')
        with open(json_path, 'w') as f:
            json.dump([{'id': 1, 'payload': {'x': 1}}], f)

        try:
            resp = self.client.post('/api/analyze_files', json={'files': [json_path]})
            self.assertEqual(resp.status_code, 200)
            stored_path = json.loads(resp.data)['files'][0]['file_path']

            from urllib.parse import quote
            resp2 = self.client.get(
                '/api/sql_ddl/' + quote(stored_path.lstrip('/'), safe='/') +
                '?target_platform=fabric_sql_db&schema=dbo&data_source=DS')
            self.assertEqual(resp2.status_code, 200)
            data2 = json.loads(resp2.data)
            self.assertTrue(data2['success'])
            bp = data2['statements']['best_practices']
            self.assertIn('Best option', bp)
            self.assertIn('OPENROWSET', bp)
        finally:
            os.unlink(json_path)

    def test_preview_table_api(self):
        """Test /api/preview_table returns columnar data."""
        csv_path = self._create_csv('x,y\n1,hello\n2,world\n', 'preview_tbl.csv')

        # Analyse first
        self.client.post('/api/analyze_files', json={'files': [csv_path]})
        # Preview
        resp = self.client.get('/api/preview_table/' + csv_path.lstrip('/').replace('\\', '/') + '?rows=10')
        self.assertEqual(resp.status_code, 200)
        data = json.loads(resp.data)
        self.assertTrue(data['success'])
        self.assertEqual(len(data['columns']), 2)
        self.assertEqual(len(data['rows']), 2)

    def test_preview_table_caps_rows(self):
        """Test that /api/preview_table caps rows at 10000."""
        csv_path = self._create_csv('x,y\n1,a\n2,b\n', 'cap_test.csv')
        self.client.post('/api/analyze_files', json={'files': [csv_path]})
        # Request absurdly high row count — should be silently capped
        resp = self.client.get('/api/preview_table/' + csv_path.lstrip('/').replace('\\', '/') + '?rows=999999')
        self.assertEqual(resp.status_code, 200)
        data = json.loads(resp.data)
        self.assertTrue(data['success'])

    def test_encoding_warning_in_metadata(self):
        """Test that encoding_warning field can be present in metadata."""
        csv_path = self._create_csv()
        resp = self.client.post('/api/analyze_files', json={'files': [csv_path]})
        data = json.loads(resp.data)
        # encoding_warning may or may not appear depending on chardet confidence
        # but the metadata structure must be valid
        self.assertTrue(data['success'])
        self.assertIn('encoding_confidence', data['files'][0])


def _cleanup_gui(gui):
    """Release the GUI's upload TemporaryDirectory if it has one."""
    tmpdir = getattr(gui, '_upload_tempdir', None)
    if tmpdir is not None:
        try:
            tmpdir.cleanup()
        except Exception:
            pass


class TestPathContainmentRoutes(unittest.TestCase):
    """Real filesystem tests (no os.path mocking) for root containment.

    The other test classes patch os.path.* globally, which neutralises the
    containment checks. These tests use genuine temp directories so the
    validation logic is actually exercised.
    """

    def setUp(self):
        self.test_root = tempfile.mkdtemp(prefix='efd_root_')
        self.outside_root = tempfile.mkdtemp(prefix='efd_outside_')

        self.inside_csv = os.path.join(self.test_root, 'inside.csv')
        with io.open(self.inside_csv, 'w', encoding='utf-8') as fh:
            fh.write('id,name\n1,alice\n')

        self.outside_csv = os.path.join(self.outside_root, 'outside.csv')
        with io.open(self.outside_csv, 'w', encoding='utf-8') as fh:
            fh.write('id,name\n1,mallory\n')

        self.web_gui = ExternalFileDetectionWebGUI(root_dir=self.test_root)
        self.app = self.web_gui.app
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()

    def tearDown(self):
        _cleanup_gui(self.web_gui)
        shutil.rmtree(self.test_root, ignore_errors=True)
        shutil.rmtree(self.outside_root, ignore_errors=True)

    def test_browse_rejects_outside_root(self):
        resp = self.client.get('/api/browse',
                               query_string={'path': self.outside_root})
        self.assertEqual(resp.status_code, 400)
        data = json.loads(resp.data)
        self.assertFalse(data['success'])

    def test_browse_allows_inside_root(self):
        resp = self.client.get('/api/browse',
                               query_string={'path': self.test_root})
        self.assertEqual(resp.status_code, 200)
        data = json.loads(resp.data)
        self.assertTrue(data['success'])

    def test_browse_rejects_traversal_outside_root(self):
        traversal = os.path.join(self.test_root, '..', '..')
        resp = self.client.get('/api/browse', query_string={'path': traversal})
        self.assertEqual(resp.status_code, 400)

    def test_analyze_file_rejects_outside_root(self):
        resp = self.client.post('/api/analyze_file',
                                json={'file_path': self.outside_csv})
        self.assertEqual(resp.status_code, 400)
        data = json.loads(resp.data)
        self.assertFalse(data['success'])

    def test_analyze_file_accepts_inside_root(self):
        resp = self.client.post('/api/analyze_file',
                                json={'file_path': self.inside_csv})
        self.assertEqual(resp.status_code, 200)
        data = json.loads(resp.data)
        self.assertTrue(data['success'])

    def test_analyze_files_reports_error_for_outside_root(self):
        resp = self.client.post('/api/analyze_files',
                                json={'files': [self.outside_csv]})
        data = json.loads(resp.data)
        results = data.get('results') or data.get('files') or []
        self.assertTrue(results, data)
        self.assertIn('error', results[0])

    def test_preview_table_rejects_stored_outside_root_entry(self):
        """A poisoned session entry must still be re-validated on preview."""
        # Establish a session, then tamper with the stored entry.
        self.client.post('/api/analyze_files', json={'files': [self.inside_csv]})
        for entry in self.web_gui._sessions.values():
            for stored in entry['files']:
                stored['file_path'] = self.outside_csv

        route_path = quote(
            self.outside_csv.replace(os.sep, '/').lstrip('/'), safe='/:')
        resp = self.client.get('/api/preview_table/' + route_path)
        self.assertIn(resp.status_code, (400, 403, 404))
        self.assertFalse(json.loads(resp.data)['success'])

    def test_symlink_inside_root_pointing_outside_is_rejected(self):
        link = os.path.join(self.test_root, 'link.csv')
        try:
            os.symlink(self.outside_csv, link)
        except (OSError, NotImplementedError, AttributeError) as exc:
            raise unittest.SkipTest(f'cannot create symlinks here: {exc}')
        if not os.path.islink(link):
            raise unittest.SkipTest('symlink not created')

        resp = self.client.post('/api/analyze_file', json={'file_path': link})
        self.assertEqual(resp.status_code, 400, resp.data)
        self.assertFalse(json.loads(resp.data)['success'])


class TestSafeDebug(unittest.TestCase):
    """Test the _safe_debug guard that prevents remote debug-console RCE."""

    def test_debug_allowed_on_loopback(self):
        from external_file_detection.web_gui import _safe_debug
        for host in ('127.0.0.1', 'localhost', '::1', None):
            self.assertTrue(_safe_debug(host, True),
                            f"debug should be allowed on loopback host {host!r}")

    def test_debug_disabled_on_non_loopback(self):
        from external_file_detection.web_gui import _safe_debug
        # '' binds to all interfaces in Flask, so it must fail closed too.
        for host in ('0.0.0.0', '192.168.1.10', '::', ''):
            self.assertFalse(_safe_debug(host, True),
                             f"debug must be disabled on non-loopback host {host!r}")

    def test_debug_off_stays_off(self):
        from external_file_detection.web_gui import _safe_debug
        self.assertFalse(_safe_debug('127.0.0.1', False))
        self.assertFalse(_safe_debug('0.0.0.0', False))

    def test_builtin_server_rejects_non_loopback_bind(self):
        from external_file_detection.web_gui import _validate_bind_host

        _validate_bind_host('127.0.0.1')
        with self.assertRaises(ValueError):
            _validate_bind_host('0.0.0.0')


class TestSchemaEditorEscaping(unittest.TestCase):
    """Guard against XSS regressions in the schema-editor template."""

    def _template(self):
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        path = os.path.join(here, 'external_file_detection', 'templates', 'index.html')
        with open(path, 'r', encoding='utf-8') as fh:
            return fh.read()

    def test_escattr_helper_present(self):
        tpl = self._template()
        self.assertIn('function escAttr(', tpl)
        # escAttr must escape both quote characters
        self.assertIn("replace(/\"/g, '&quot;')", tpl)
        self.assertIn("replace(/'/g, '&#39;')", tpl)

    def test_schema_editor_attributes_use_escattr(self):
        tpl = self._template()
        # The schema-editor column inputs interpolate untrusted column names
        # into HTML attributes; those must use escAttr, never esc.
        self.assertIn("data-col=\"' + escAttr(name)", tpl)
        self.assertIn("value=\"' + escAttr(ov.colName || name)", tpl)
        self.assertIn("<option value=\"' + escAttr(t)", tpl)
        self.assertNotIn("data-col=\"' + esc(name)", tpl)


if __name__ == '__main__':
    unittest.main()