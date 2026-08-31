"""Tests for the Azure Storage and control endpoints of the web GUI.

Everything here is mocked; no test contacts Azure or opens a sign-in prompt.
"""

import json
import os
import shutil
import tempfile
import time
import types
import unittest
from unittest.mock import patch

from external_file_detection import azure_auth
from external_file_detection.sql_generator import DEFAULT_TARGET_PLATFORM
from external_file_detection.web_gui import (
    CONTROL_TOKEN_ENV,
    CONTROL_TOKEN_HEADER,
    CSRF_HEADER,
    SQLFileDetectionWebGUI,
)

JWT = (
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.'
    'eyJzdWIiOiIxMjM0NTY3ODkwIiwiZXhwIjo5OTk5OTk5OTk5fQ.'
    'S1gnaTuReDaCtEdVaLuE0123456789'
)
CONTROL_TOKEN = 'control-token-for-tests-0123456789'


class _AzureRouteTestCase(unittest.TestCase):
    """Shared fixture: a test client plus a valid per-session token."""

    def setUp(self):
        self.test_root = tempfile.mkdtemp()
        self.gui = SQLFileDetectionWebGUI(
            root_dir=self.test_root, control_token=CONTROL_TOKEN
        )
        self.app = self.gui.app
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()
        response = self.client.get('/api/session')
        self.session_token = response.get_json()['session_token']

    def tearDown(self):
        try:
            self.gui._azure_connections.clear()
            self.gui._vscode_tokens.clear()
        finally:
            shutil.rmtree(self.test_root, ignore_errors=True)

    def headers(self):
        return {CSRF_HEADER: self.session_token}

    def control_headers(self):
        return {CONTROL_TOKEN_HEADER: CONTROL_TOKEN}

    def connect_anonymous(self, account='acct'):
        response = self.client.post(
            '/api/azure/connect',
            json={'mode': azure_auth.AUTH_ANONYMOUS, 'account_name': account},
            headers=self.headers(),
        )
        self.assertEqual(response.status_code, 200, response.data)
        return response.get_json()


class TestHealthAndSession(_AzureRouteTestCase):
    """The probe the VS Code extension waits on, plus session bootstrap."""

    def test_health_reports_the_azure_sql_default(self):
        payload = self.client.get('/api/health').get_json()
        self.assertEqual(payload['status'], 'ok')
        self.assertEqual(payload['default_platform'], 'azure_sql_db')
        self.assertEqual(payload['default_platform'], DEFAULT_TARGET_PLATFORM)
        self.assertEqual(payload['product'], 'SQL File Detection Tool')
        self.assertIn('azure_sql_db', payload['platforms'])

    def test_health_needs_no_session_token(self):
        self.assertEqual(self.client.get('/api/health').status_code, 200)

    def test_session_endpoint_returns_a_token_and_the_default(self):
        payload = self.client.get('/api/session').get_json()
        self.assertTrue(payload['session_token'])
        self.assertGreaterEqual(len(payload['session_token']), 32)
        self.assertEqual(payload['default_platform'], 'azure_sql_db')

    def test_the_control_token_is_removed_from_the_environment(self):
        os.environ[CONTROL_TOKEN_ENV] = 'from-environment-0123456789'
        try:
            gui = SQLFileDetectionWebGUI(root_dir=self.test_root)
            self.assertNotIn(CONTROL_TOKEN_ENV, os.environ)
            self.assertTrue(gui._control_token)
        finally:
            os.environ.pop(CONTROL_TOKEN_ENV, None)


class TestControlEndpoints(_AzureRouteTestCase):
    """The loopback control channel used to broker VS Code tokens."""

    def token_body(self, expires_in=3600):
        return {
            'storage_token': JWT,
            'storage_expires_on': time.time() + expires_in,
            'arm_token': JWT,
            'arm_expires_on': time.time() + expires_in,
            'identity': 'user@contoso.com',
            'tenant_id': 'contoso.onmicrosoft.com',
        }

    def test_missing_control_token_is_rejected(self):
        response = self.client.post('/api/control/azure/token',
                                    json=self.token_body())
        self.assertEqual(response.status_code, 403)

    def test_wrong_control_token_is_rejected(self):
        response = self.client.post(
            '/api/control/azure/token', json=self.token_body(),
            headers={CONTROL_TOKEN_HEADER: 'not-the-real-token'},
        )
        self.assertEqual(response.status_code, 403)

    def test_a_session_token_does_not_open_the_control_channel(self):
        response = self.client.post(
            '/api/control/azure/token', json=self.token_body(),
            headers=self.headers(),
        )
        self.assertEqual(response.status_code, 403)

    def test_a_valid_control_token_stores_the_brokered_token(self):
        response = self.client.post(
            '/api/control/azure/token', json=self.token_body(),
            headers=self.control_headers(),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload['success'])
        self.assertTrue(payload['status']['available'])
        self.assertEqual(payload['status']['account'], 'user@contoso.com')

    def test_the_response_never_echoes_the_token(self):
        response = self.client.post(
            '/api/control/azure/token', json=self.token_body(),
            headers=self.control_headers(),
        )
        self.assertNotIn(JWT.encode(), response.data)

    def test_an_expired_token_is_reported_as_unavailable(self):
        self.client.post(
            '/api/control/azure/token', json=self.token_body(expires_in=-60),
            headers=self.control_headers(),
        )
        status = self.client.get('/api/control/status',
                                 headers=self.control_headers()).get_json()
        self.assertFalse(status['status']['available'])

    def test_an_empty_token_is_rejected(self):
        body = self.token_body()
        body['storage_token'] = ''
        response = self.client.post(
            '/api/control/azure/token', json=body,
            headers=self.control_headers(),
        )
        self.assertGreaterEqual(response.status_code, 400)

    def test_sign_out_clears_tokens_and_connections(self):
        self.client.post('/api/control/azure/token', json=self.token_body(),
                         headers=self.control_headers())
        self.connect_anonymous()

        response = self.client.post('/api/control/azure/signout',
                                    headers=self.control_headers())
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()['status']['available'])

        status = self.client.get('/api/azure/status',
                                 headers=self.headers()).get_json()
        self.assertFalse(status['connection']['connected'])

    def test_sign_out_requires_the_control_token(self):
        self.assertEqual(
            self.client.post('/api/control/azure/signout').status_code, 403
        )

    def test_control_status_requires_the_control_token(self):
        self.assertEqual(self.client.get('/api/control/status').status_code, 403)


class TestAzureCsrfGuard(_AzureRouteTestCase):
    """Every Azure route must demand the per-session token."""

    GETS = [
        '/api/azure/status',
        '/api/azure/subscriptions',
        '/api/azure/storage-accounts',
        '/api/azure/containers',
        '/api/azure/blobs',
    ]
    POSTS = [
        '/api/azure/connect',
        '/api/azure/disconnect',
        '/api/azure/analyze',
    ]

    def test_get_routes_reject_a_missing_session_token(self):
        for route in self.GETS:
            with self.subTest(route=route):
                self.assertEqual(self.client.get(route).status_code, 403)

    def test_post_routes_reject_a_missing_session_token(self):
        for route in self.POSTS:
            with self.subTest(route=route):
                self.assertEqual(
                    self.client.post(route, json={}).status_code, 403
                )

    def test_routes_reject_a_forged_session_token(self):
        forged = {CSRF_HEADER: 'a' * len(self.session_token)}
        for route in self.GETS:
            with self.subTest(route=route):
                self.assertEqual(
                    self.client.get(route, headers=forged).status_code, 403
                )

    def test_a_valid_session_token_is_accepted(self):
        response = self.client.get('/api/azure/status', headers=self.headers())
        self.assertEqual(response.status_code, 200)


class TestAzureConnectRoute(_AzureRouteTestCase):
    """Connecting through each auth mode, all mocked."""

    def test_status_lists_every_supported_mode(self):
        payload = self.client.get('/api/azure/status',
                                  headers=self.headers()).get_json()
        listed = {mode['id'] for mode in payload['modes']}
        self.assertEqual(listed, set(azure_auth.AUTH_MODES))
        self.assertFalse(payload['connection']['connected'])

    def test_connect_rejects_an_unknown_mode(self):
        response = self.client.post('/api/azure/connect',
                                    json={'mode': 'made-up'},
                                    headers=self.headers())
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()['code'], 'unsupported_mode')

    def test_connect_with_sas_never_echoes_the_signature(self):
        sas = ('https://acct.blob.core.windows.net/data'
               '?sv=2022-11-02&sr=c&sp=rl&sig=SeCrEtSiGnAtUrE123')
        response = self.client.post(
            '/api/azure/connect',
            json={'mode': azure_auth.AUTH_SAS, 'sas': sas},
            headers=self.headers(),
        )
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(b'SeCrEtSiGnAtUrE123', response.data)
        self.assertIn(b'acct', response.data)

    def test_connect_with_a_connection_string_never_echoes_the_key(self):
        response = self.client.post(
            '/api/azure/connect',
            json={
                'mode': azure_auth.AUTH_CONNECTION_STRING,
                'connection_string': (
                    'DefaultEndpointsProtocol=https;AccountName=acct;'
                    'AccountKey=c2VjcmV0S2V5MTIzNDU2;'
                    'EndpointSuffix=core.windows.net'
                ),
            },
            headers=self.headers(),
        )
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(b'c2VjcmV0S2V5MTIzNDU2', response.data)

    def test_connect_with_an_account_key_never_echoes_the_key(self):
        response = self.client.post(
            '/api/azure/connect',
            json={'mode': azure_auth.AUTH_ACCOUNT_KEY,
                  'account_name': 'acct',
                  'account_key': 'c2VjcmV0S2V5MTIzNDU2'},
            headers=self.headers(),
        )
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(b'c2VjcmV0S2V5MTIzNDU2', response.data)

    def test_connect_with_an_invalid_account_name_is_rejected(self):
        response = self.client.post(
            '/api/azure/connect',
            json={'mode': azure_auth.AUTH_ANONYMOUS,
                  'account_name': 'Not A Valid Name'},
            headers=self.headers(),
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()['code'], 'invalid_account_name')

    def test_connect_with_vscode_token_fails_without_a_brokered_token(self):
        response = self.client.post(
            '/api/azure/connect',
            json={'mode': azure_auth.AUTH_VSCODE_TOKEN},
            headers=self.headers(),
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()['code'], 'no_vscode_token')

    def test_connect_with_vscode_token_after_the_extension_signs_in(self):
        self.client.post(
            '/api/control/azure/token',
            json={'storage_token': JWT,
                  'storage_expires_on': time.time() + 3600,
                  'arm_token': JWT,
                  'arm_expires_on': time.time() + 3600,
                  'identity': 'user@contoso.com'},
            headers=self.control_headers(),
        )
        response = self.client.post(
            '/api/azure/connect',
            json={'mode': azure_auth.AUTH_VSCODE_TOKEN,
                  'account_name': 'acct'},
            headers=self.headers(),
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertNotIn(JWT.encode(), response.data)
        self.assertIn(b'user@contoso.com', response.data)

    def test_a_failed_entra_sign_in_is_not_downgraded(self):
        def _fail(*args, **kwargs):
            raise azure_auth.AzureAuthError(
                'Microsoft Entra ID sign-in failed.',
                code='entra_sign_in_failed', status=401,
            )

        with patch.object(azure_auth, 'connect', side_effect=_fail):
            response = self.client.post(
                '/api/azure/connect',
                json={'mode': azure_auth.AUTH_ENTRA_DEFAULT},
                headers=self.headers(),
            )
        self.assertEqual(response.status_code, 401)
        self.assertFalse(response.get_json()['success'])

    def test_disconnect_forgets_the_connection(self):
        self.connect_anonymous()
        response = self.client.post('/api/azure/disconnect',
                                    headers=self.headers())
        self.assertTrue(response.get_json()['was_connected'])
        status = self.client.get('/api/azure/status',
                                 headers=self.headers()).get_json()
        self.assertFalse(status['connection']['connected'])

    def test_connections_are_isolated_per_browser_session(self):
        self.connect_anonymous()
        other = self.app.test_client()
        other_token = other.get('/api/session').get_json()['session_token']
        status = other.get(
            '/api/azure/status', headers={CSRF_HEADER: other_token}
        ).get_json()
        self.assertFalse(status['connection']['connected'])


class TestAzureBrowsing(_AzureRouteTestCase):
    """Container/blob listing, paging and error mapping."""

    def test_containers_require_a_connection(self):
        response = self.client.get('/api/azure/containers',
                                   headers=self.headers())
        self.assertEqual(response.status_code, 409)

    def test_containers_are_listed_and_paged(self):
        self.connect_anonymous()
        result = {'containers': [{'name': 'data'}], 'continuation': 'next'}
        with patch.object(azure_auth, 'list_containers',
                          return_value=result) as mocked:
            response = self.client.get(
                '/api/azure/containers?page_size=25', headers=self.headers()
            )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload['containers'], [{'name': 'data'}])
        self.assertEqual(payload['continuation'], 'next')
        self.assertEqual(mocked.call_args.kwargs['page_size'], 25)

    def test_blobs_are_listed_with_the_prefix_and_continuation(self):
        self.connect_anonymous()
        result = {'folders': [], 'blobs': [], 'continuation': None,
                  'container': 'data', 'prefix': 'raw/'}
        with patch.object(azure_auth, 'list_blobs',
                          return_value=result) as mocked:
            response = self.client.get(
                '/api/azure/blobs?container=data&prefix=raw/&continuation=abc',
                headers=self.headers(),
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(mocked.call_args.kwargs['prefix'], 'raw/')
        self.assertEqual(mocked.call_args.kwargs['continuation'], 'abc')

    def test_an_authorization_failure_is_surfaced_with_guidance(self):
        self.connect_anonymous()
        error = azure_auth.AzureAuthError(
            'Access denied. Grant Storage Blob Data Reader.',
            code='authorization_failed', status=403,
        )
        with patch.object(azure_auth, 'list_containers', side_effect=error):
            response = self.client.get('/api/azure/containers',
                                       headers=self.headers())
        self.assertEqual(response.status_code, 403)
        self.assertIn('Storage Blob Data Reader',
                      response.get_json()['error'])

    def test_an_unexpected_error_does_not_leak_internals(self):
        self.connect_anonymous()
        secret = 'AccountKey=c2VjcmV0S2V5MTIzNDU2'
        with patch.object(azure_auth, 'list_containers',
                          side_effect=RuntimeError(secret)):
            response = self.client.get('/api/azure/containers',
                                       headers=self.headers())
        self.assertEqual(response.status_code, 500)
        self.assertNotIn(b'c2VjcmV0S2V5MTIzNDU2', response.data)

    def test_subscriptions_degrade_gracefully_without_an_arm_token(self):
        self.connect_anonymous()
        response = self.client.get('/api/azure/subscriptions',
                                   headers=self.headers())
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertFalse(payload['available'])
        self.assertEqual(payload['subscriptions'], [])

    def test_storage_accounts_need_an_arm_token(self):
        self.connect_anonymous()
        response = self.client.get('/api/azure/storage-accounts',
                                   headers=self.headers())
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()['code'], 'arm_unavailable')

    def test_analyze_reports_the_abs_url_and_redacts_the_source(self):
        self.connect_anonymous()
        sample = os.path.join(self.test_root, 'sales.csv')
        with open(sample, 'w', encoding='utf-8') as handle:
            handle.write('id,name\n1,Ada\n')

        def _download(connection, container, blob, destination, **kwargs):
            shutil.copyfile(sample, destination)
            return os.path.getsize(destination)

        with patch.object(azure_auth, 'download_blob', side_effect=_download):
            response = self.client.post(
                '/api/azure/analyze',
                json={'container': 'data', 'blob': 'raw/sales.csv'},
                headers=self.headers(),
            )
        self.assertEqual(response.status_code, 200, response.data)
        payload = response.get_json()
        self.assertEqual(
            payload['storage_url'],
            'abs://data@acct.blob.core.windows.net/raw/sales.csv',
        )
        self.assertNotIn('?', payload['file']['source_display'])


if __name__ == '__main__':
    unittest.main()


class TestErrorRedaction(_AzureRouteTestCase):
    """No route may echo credential material lifted from an SDK exception."""

    SAS_URL = ('https://acct.blob.core.windows.net/data?restype=container'
               '&comp=list&sv=2022-11-02&se=2030-01-01&sig=SuPeRsEcReTsIg%3D')
    CONNECTION_STRING = ('DefaultEndpointsProtocol=https;AccountName=acct;'
                         'AccountKey=Ab1' + 'Q' * 40 + '==;'
                         'EndpointSuffix=core.windows.net')

    def assert_no_secret(self, body):
        self.assertNotIn('SuPeRsEcReTsIg', body)
        self.assertNotIn('sig=SuPeRsEcReTsIg', body)
        self.assertNotIn('Q' * 40, body)

    def test_analyze_path_redacts_a_sas_url_in_an_sdk_failure(self):
        boom = Exception(
            f'Connection aborted while requesting {self.SAS_URL}'
        )
        with patch('external_file_detection.web_gui.ExternalFileDetectorApp',
                   side_effect=boom):
            response = self.client.post(
                '/api/analyze-path',
                json={'path': 'https://acct.blob.core.windows.net/data',
                      'azure_sas_token': '?sv=2022-11-02&sig=SuPeRsEcReTsIg'},
                headers=self.headers(),
            )
        self.assertEqual(response.status_code, 500)
        body = response.get_data(as_text=True)
        self.assert_no_secret(body)
        self.assertIn('redacted', body)

    def test_analyze_path_redacts_a_connection_string_in_a_failure(self):
        boom = Exception(f'Invalid credentials: {self.CONNECTION_STRING}')
        with patch('external_file_detection.web_gui.ExternalFileDetectorApp',
                   side_effect=boom):
            response = self.client.post(
                '/api/analyze-path',
                json={'path': 'https://acct.blob.core.windows.net/data',
                      'azure_connection_string': self.CONNECTION_STRING},
                headers=self.headers(),
            )
        self.assertEqual(response.status_code, 500)
        self.assert_no_secret(response.get_data(as_text=True))

    def test_error_response_helper_redacts(self):
        from external_file_detection.web_gui import _error_response
        with self.app.test_request_context():
            payload, status = _error_response(
                f'failed for {self.SAS_URL}', 400
            )
        self.assertEqual(status, 400)
        self.assert_no_secret(payload.get_data(as_text=True))

    def test_safe_error_helper_redacts(self):
        from external_file_detection.web_gui import _safe_error
        rendered = _safe_error(Exception(self.CONNECTION_STRING))
        self.assert_no_secret(rendered)