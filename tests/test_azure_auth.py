"""Tests for Azure Storage authentication, redaction and browsing.

Every test uses mocks: nothing here contacts Azure or opens an interactive
sign-in prompt.
"""

import base64
import json
import time
import types
from unittest.mock import MagicMock, patch

import pytest

from external_file_detection import azure_auth


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------

CONNECTION_STRING = (
    'DefaultEndpointsProtocol=https;AccountName=acct;'
    'AccountKey=c2VjcmV0S2V5MTIzNDU2Nzg5;EndpointSuffix=core.windows.net'
)
SAS_URL = (
    'https://acct.blob.core.windows.net/data/sales.csv'
    '?sv=2022-11-02&se=2030-01-01T00%3A00%3A00Z&sr=b&sp=r&sig=AbCd%2Fef123456'
)
JWT = (
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.'
    'eyJzdWIiOiIxMjM0NTY3ODkwIiwiZXhwIjo5OTk5OTk5OTk5fQ.'
    'S1gnaTuReDaCtEdVaLuE0123456789'
)


def test_redact_hides_account_key():
    result = azure_auth.redact(CONNECTION_STRING)
    assert 'c2VjcmV0S2V5MTIzNDU2Nzg5' not in result
    assert 'AccountName=acct' in result


def test_redact_hides_sas_signature():
    result = azure_auth.redact(SAS_URL)
    assert 'AbCd%2Fef123456' not in result
    assert 'acct.blob.core.windows.net' in result


def test_redact_hides_bearer_tokens_and_raw_jwts():
    assert JWT not in azure_auth.redact('Authorization: Bearer ' + JWT)
    assert JWT not in azure_auth.redact(JWT)


def test_redact_url_drops_the_whole_signed_query_string():
    result = azure_auth.redact_url(SAS_URL)
    assert '?' not in result or 'sig' not in result
    assert result.startswith('https://acct.blob.core.windows.net/data/sales.csv')


def test_redact_url_keeps_a_harmless_query_string():
    plain = 'https://acct.blob.core.windows.net/data/sales.csv?comp=list'
    assert azure_auth.redact_url(plain) == plain


def test_mask_tail_is_not_reversible():
    masked = azure_auth.mask_tail('supersecretvalue')
    assert 'supersecret' not in masked
    assert masked.endswith('alue')


def test_redact_handles_non_string_values():
    assert azure_auth.redact(None) == ''
    assert azure_auth.redact(42) == '42'


# ---------------------------------------------------------------------------
# Access token records and expiry
# ---------------------------------------------------------------------------

def test_access_token_record_never_leaks_the_token():
    record = azure_auth.AccessTokenRecord(JWT, time.time() + 3600)
    assert JWT not in repr(record)
    assert JWT not in str(record)
    assert record.token == JWT


def test_access_token_record_rejects_an_empty_token():
    with pytest.raises(azure_auth.AzureAuthError):
        azure_auth.AccessTokenRecord('', time.time() + 3600)


def test_access_token_expiry_uses_a_skew():
    now = time.time()
    fresh = azure_auth.AccessTokenRecord(JWT, now + 3600)
    assert not fresh.is_expired(now=now)

    # Inside the skew window the token counts as expired so it is refreshed.
    nearly = azure_auth.AccessTokenRecord(JWT, now + 60)
    assert nearly.is_expired(now=now)

    stale = azure_auth.AccessTokenRecord(JWT, now - 1)
    assert stale.is_expired(now=now)


def test_unknown_expiry_is_treated_as_expired():
    record = azure_auth.AccessTokenRecord(JWT, None)
    assert record.is_expired()


def test_static_credential_refuses_to_hand_out_an_expired_token():
    credential = azure_auth.StaticTokenCredential(
        azure_auth.AccessTokenRecord(JWT, time.time() - 10)
    )
    with pytest.raises(azure_auth.AzureAuthError) as excinfo:
        credential.get_token(azure_auth.STORAGE_SCOPE)
    assert JWT not in str(excinfo.value)


def test_static_credential_returns_a_live_token():
    credential = azure_auth.StaticTokenCredential(
        azure_auth.AccessTokenRecord(JWT, time.time() + 3600)
    )
    token = credential.get_token(azure_auth.STORAGE_SCOPE)
    assert token.token == JWT


# ---------------------------------------------------------------------------
# VS Code token store
# ---------------------------------------------------------------------------

def test_token_store_round_trip_and_status_redaction():
    store = azure_auth.VSCodeTokenStore()
    assert store.status()['available'] is False

    store.set_tokens(
        storage_token=JWT,
        storage_expires_on=time.time() + 3600,
        arm_token=JWT,
        arm_expires_on=time.time() + 3600,
        account='user@contoso.com',
    )
    status = store.status()
    assert status['available'] is True
    assert status['account'] == 'user@contoso.com'
    assert JWT not in repr(status)

    store.clear()
    assert store.status()['available'] is False
    assert store.credential is None


def test_token_store_reports_expired_tokens_as_unavailable():
    store = azure_auth.VSCodeTokenStore()
    store.set_tokens(storage_token=JWT, storage_expires_on=time.time() - 10)
    assert store.status()['available'] is False


# ---------------------------------------------------------------------------
# Parsing and validation
# ---------------------------------------------------------------------------

def test_parse_sas_url_extracts_account_and_container():
    account, container, sas = azure_auth.parse_sas_input(SAS_URL)
    assert account == 'acct'
    assert container == 'data'
    assert sas.startswith('sv=')
    assert not sas.startswith('?')


def test_parse_bare_sas_token():
    account, container, sas = azure_auth.parse_sas_input(
        '?sv=2022-11-02&sig=AbCd%2Fef'
    )
    assert account is None
    assert container is None
    assert sas == 'sv=2022-11-02&sig=AbCd%2Fef'


def test_parse_sas_rejects_empty_input():
    with pytest.raises(azure_auth.AzureAuthError):
        azure_auth.parse_sas_input('   ')


def test_parse_connection_string_extracts_the_account():
    account, parts = azure_auth.parse_connection_string(CONNECTION_STRING)
    assert account == 'acct'
    assert parts['accountkey'] == 'c2VjcmV0S2V5MTIzNDU2Nzg5'


def test_parse_connection_string_errors_are_redacted():
    with pytest.raises(azure_auth.AzureAuthError) as excinfo:
        azure_auth.parse_connection_string('AccountKey=c2VjcmV0S2V5MTIzNDU2Nzg5')
    assert 'c2VjcmV0S2V5MTIzNDU2Nzg5' not in str(excinfo.value)


@pytest.mark.parametrize('name', ['ab', 'has-dash', 'x' * 25, '', 'has space'])
def test_validate_account_name_rejects_invalid_names(name):
    with pytest.raises(azure_auth.AzureAuthError):
        azure_auth.validate_account_name(name)


def test_validate_account_name_normalises_case():
    assert azure_auth.validate_account_name('MyAccount01') == 'myaccount01'


@pytest.mark.parametrize('name', ['A', 'UPPER', 'has_underscore', '-lead', ''])
def test_validate_container_name_rejects_invalid_names(name):
    with pytest.raises(azure_auth.AzureAuthError):
        azure_auth.validate_container_name(name)


# ---------------------------------------------------------------------------
# connect() — one test per auth mode, all mocked
# ---------------------------------------------------------------------------

class _FakeCredential:
    """A credential that always mints a token."""

    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs

    def get_token(self, *scopes, **kwargs):
        return types.SimpleNamespace(token=JWT, expires_on=int(time.time()) + 3600)


class _FailingCredential:
    def __init__(self, *args, **kwargs):
        pass

    def get_token(self, *scopes, **kwargs):
        raise RuntimeError('no credential available: AccountKey=c2VjcmV0')


@pytest.fixture
def fake_identity(monkeypatch):
    """Pretend azure-identity is installed and hand back fake credentials."""
    module = types.SimpleNamespace(
        DefaultAzureCredential=_FakeCredential,
        InteractiveBrowserCredential=_FakeCredential,
        ManagedIdentityCredential=_FakeCredential,
        TokenCachePersistenceOptions=lambda **kw: kw,
    )
    monkeypatch.setattr(azure_auth, '_require_azure_identity', lambda: module)
    return module


def test_connect_entra_default_uses_the_developer_credential_chain(fake_identity):
    connection = azure_auth.connect(azure_auth.AUTH_ENTRA_DEFAULT)
    assert connection.mode == azure_auth.AUTH_ENTRA_DEFAULT
    described = connection.describe()
    assert described['connected'] is True
    assert JWT not in repr(described)


def test_connect_entra_interactive_builds_an_interactive_credential(fake_identity):
    connection = azure_auth.connect(
        azure_auth.AUTH_ENTRA_INTERACTIVE, tenant_id='contoso.onmicrosoft.com'
    )
    assert connection.mode == azure_auth.AUTH_ENTRA_INTERACTIVE


def test_connect_managed_identity_is_explicit(fake_identity):
    connection = azure_auth.connect(
        azure_auth.AUTH_MANAGED_IDENTITY, client_id='11111111-1111-1111-1111-111111111111'
    )
    assert connection.mode == azure_auth.AUTH_MANAGED_IDENTITY


def test_connect_never_downgrades_a_failed_entra_sign_in(monkeypatch):
    module = types.SimpleNamespace(
        DefaultAzureCredential=_FailingCredential,
        InteractiveBrowserCredential=_FailingCredential,
        ManagedIdentityCredential=_FailingCredential,
    )
    monkeypatch.setattr(azure_auth, '_require_azure_identity', lambda: module)
    with pytest.raises(azure_auth.AzureAuthError) as excinfo:
        azure_auth.connect(azure_auth.AUTH_ENTRA_DEFAULT)
    assert excinfo.value.code == 'entra_sign_in_failed'
    assert excinfo.value.status == 401
    # The underlying exception text carried a secret; it must not surface.
    assert 'c2VjcmV0' not in str(excinfo.value)


def test_connect_vscode_token_requires_a_brokered_token():
    store = azure_auth.VSCodeTokenStore()
    with pytest.raises(azure_auth.AzureAuthError) as excinfo:
        azure_auth.connect(azure_auth.AUTH_VSCODE_TOKEN, token_store=store)
    assert excinfo.value.status in (401, 409)


def test_connect_vscode_token_uses_the_brokered_credential():
    store = azure_auth.VSCodeTokenStore()
    store.set_tokens(
        storage_token=JWT,
        storage_expires_on=time.time() + 3600,
        arm_token=JWT,
        arm_expires_on=time.time() + 3600,
        account='user@contoso.com',
    )
    connection = azure_auth.connect(
        azure_auth.AUTH_VSCODE_TOKEN, account_name='acct', token_store=store
    )
    assert connection.mode == azure_auth.AUTH_VSCODE_TOKEN
    assert connection.arm_token() == JWT
    assert JWT not in repr(connection.describe())


def test_connect_sas_extracts_the_account_and_hides_the_signature():
    connection = azure_auth.connect(azure_auth.AUTH_SAS, sas=SAS_URL)
    assert connection.account_name == 'acct'
    described = connection.describe()
    assert 'AbCd%2Fef123456' not in repr(described)


def test_connect_connection_string_hides_the_key():
    connection = azure_auth.connect(
        azure_auth.AUTH_CONNECTION_STRING, connection_string=CONNECTION_STRING
    )
    assert connection.account_name == 'acct'
    assert 'c2VjcmV0S2V5MTIzNDU2Nzg5' not in repr(connection.describe())


def test_connect_account_key_hides_the_key():
    connection = azure_auth.connect(
        azure_auth.AUTH_ACCOUNT_KEY, account_name='acct',
        account_key='c2VjcmV0S2V5MTIzNDU2Nzg5',
    )
    assert connection.account_name == 'acct'
    assert 'c2VjcmV0S2V5MTIzNDU2Nzg5' not in repr(connection.describe())


def test_connect_anonymous_needs_only_an_account_name():
    connection = azure_auth.connect(azure_auth.AUTH_ANONYMOUS, account_name='acct')
    assert connection.mode == azure_auth.AUTH_ANONYMOUS
    assert connection.arm_token() is None


def test_connect_rejects_an_unknown_mode():
    with pytest.raises(azure_auth.AzureAuthError) as excinfo:
        azure_auth.connect('totally-made-up')
    assert excinfo.value.code == 'unsupported_mode'


def test_every_declared_mode_has_a_label():
    for mode in azure_auth.AUTH_MODES:
        assert azure_auth.AUTH_MODE_LABELS[mode]


# ---------------------------------------------------------------------------
# Connection registry
# ---------------------------------------------------------------------------

def _connection():
    return azure_auth.connect(azure_auth.AUTH_ANONYMOUS, account_name='acct')


def test_registry_isolates_sessions():
    registry = azure_auth.ConnectionRegistry()
    first, second = _connection(), _connection()
    registry.set('session-a', first)
    registry.set('session-b', second)
    assert registry.get('session-a') is first
    assert registry.get('session-b') is second
    assert registry.get('session-c') is None


def test_registry_require_raises_for_an_unknown_session():
    registry = azure_auth.ConnectionRegistry()
    with pytest.raises(azure_auth.AzureAuthError) as excinfo:
        registry.require('nobody')
    assert excinfo.value.status == 409


def test_registry_purges_expired_connections():
    registry = azure_auth.ConnectionRegistry(ttl_seconds=1)
    registry.set('session-a', _connection())
    assert registry.purge_expired(now=time.time() + 10) == 1
    assert registry.get('session-a') is None


def test_registry_remove_and_clear():
    registry = azure_auth.ConnectionRegistry()
    registry.set('session-a', _connection())
    assert registry.remove('session-a') is True
    assert registry.remove('session-a') is False
    registry.set('session-b', _connection())
    registry.clear()
    assert registry.get('session-b') is None


# ---------------------------------------------------------------------------
# Bounded listing / paging
# ---------------------------------------------------------------------------

class _FakePager:
    """Minimal stand-in for the SDK's ``by_page()`` iterator."""

    def __init__(self, pages, continuation=None):
        self._pages = iter(pages)
        self.continuation_token = continuation

    def __iter__(self):
        return self

    def __next__(self):
        return next(self._pages)


class _FakeItemPaged:
    """Minimal stand-in for ``ItemPaged``."""

    def __init__(self, items, continuation=None):
        self._items = items
        self._continuation = continuation
        self.by_page_kwargs = None

    def by_page(self, continuation_token=None):
        self.by_page_kwargs = {'continuation_token': continuation_token}
        return _FakePager([list(self._items)], self._continuation)


def _paged(items, continuation=None):
    return _FakeItemPaged(items, continuation)


def test_list_containers_is_bounded_and_pages():
    connection = _connection()
    client = MagicMock()
    client.list_containers.return_value = _paged(
        [types.SimpleNamespace(name='data'), types.SimpleNamespace(name='logs')],
        continuation='next-page-token',
    )
    with patch.object(azure_auth.AzureConnection, 'blob_service_client',
                      return_value=client):
        result = azure_auth.list_containers(connection, page_size=2)
    assert [c['name'] for c in result['containers']] == ['data', 'logs']
    assert result['continuation'] == 'next-page-token'
    client.list_containers.assert_called_once()
    assert client.list_containers.call_args.kwargs['results_per_page'] == 2


def test_list_containers_clamps_an_oversized_page_size():
    connection = _connection()
    client = MagicMock()
    client.list_containers.return_value = _paged([])
    with patch.object(azure_auth.AzureConnection, 'blob_service_client',
                      return_value=client):
        azure_auth.list_containers(connection, page_size=10 ** 6)
    assert (client.list_containers.call_args.kwargs['results_per_page']
            <= azure_auth.MAX_PAGE_SIZE)


def test_list_blobs_splits_folders_from_blobs():
    connection = _connection()
    blob = types.SimpleNamespace(name='raw/sales.csv', size=1024)
    folder = types.SimpleNamespace(name='raw/nested/')
    container_client = MagicMock()
    container_client.walk_blobs.return_value = _paged([folder, blob])
    client = MagicMock()
    client.get_container_client.return_value = container_client
    with patch.object(azure_auth.AzureConnection, 'blob_service_client',
                      return_value=client):
        result = azure_auth.list_blobs(connection, container='data', prefix='raw/')
    assert [f['prefix'] for f in result['folders']] == ['raw/nested/']
    assert result['blobs'][0]['path'] == 'raw/sales.csv'
    assert result['blobs'][0]['supported'] is True


def test_list_blobs_marks_unsupported_types():
    connection = _connection()
    blob = types.SimpleNamespace(name='notes.docx', size=10)
    container_client = MagicMock()
    container_client.walk_blobs.return_value = _paged([blob])
    client = MagicMock()
    client.get_container_client.return_value = container_client
    with patch.object(azure_auth.AzureConnection, 'blob_service_client',
                      return_value=client):
        result = azure_auth.list_blobs(connection, container='data')
    assert result['blobs'][0]['supported'] is False


def test_list_blobs_validates_the_container_name():
    connection = _connection()
    with pytest.raises(azure_auth.AzureAuthError):
        azure_auth.list_blobs(connection, container='NOT VALID')


# ---------------------------------------------------------------------------
# Error mapping
# ---------------------------------------------------------------------------

class _HttpError(Exception):
    def __init__(self, status_code, reason=''):
        super().__init__(reason)
        self.status_code = status_code
        self.reason = reason


@pytest.mark.parametrize('status,fragment', [
    (401, 'Storage Blob Data Reader'),
    (403, 'Storage Blob Data Reader'),
    (404, 'not found'),
])
def test_browse_errors_are_specific_and_actionable(status, fragment):
    error = azure_auth._browse_error(_HttpError(status), 'listing blobs')
    assert fragment.lower() in error.message.lower()


def test_browse_errors_never_leak_secrets():
    error = azure_auth._browse_error(
        _HttpError(500, 'failed with AccountKey=c2VjcmV0S2V5'), 'listing blobs'
    )
    assert 'c2VjcmV0S2V5' not in error.message


def test_list_containers_wraps_sdk_failures():
    connection = _connection()
    client = MagicMock()
    client.list_containers.side_effect = _HttpError(403, 'forbidden')
    with patch.object(azure_auth.AzureConnection, 'blob_service_client',
                      return_value=client):
        with pytest.raises(azure_auth.AzureAuthError) as excinfo:
            azure_auth.list_containers(connection)
    assert excinfo.value.status == 403


# ---------------------------------------------------------------------------
# URL construction
# ---------------------------------------------------------------------------

def test_storage_url_uses_the_abs_scheme_for_azure_sql():
    url = azure_auth.storage_url_for('acct', 'data', 'raw/sales.csv')
    assert url == 'abs://data@acct.blob.core.windows.net/raw/sales.csv'


def test_blob_url_is_unsigned():
    url = azure_auth.blob_url('acct', 'data', 'raw/sales.csv')
    assert url == 'https://acct.blob.core.windows.net/data/raw/sales.csv'
    assert '?' not in url


def test_download_blob_enforces_a_size_cap():
    connection = _connection()
    blob_client = MagicMock()
    blob_client.get_blob_properties.return_value = types.SimpleNamespace(
        size=10 ** 12
    )
    client = MagicMock()
    client.get_blob_client.return_value = blob_client
    with patch.object(azure_auth.AzureConnection, 'blob_service_client',
                      return_value=client):
        with pytest.raises(azure_auth.AzureAuthError) as excinfo:
            azure_auth.download_blob(
                connection, 'data', 'huge.parquet', 'ignored.tmp'
            )
    assert 'larger than' in excinfo.value.message.lower()


# ---------------------------------------------------------------------------
# A closed connection must never downgrade to anonymous access
# ---------------------------------------------------------------------------

def _sas_connection():
    return azure_auth.connect(
        azure_auth.AUTH_SAS,
        account_name='acct',
        sas='?sv=2022-11-02&sig=abcdefg123',
    )


def test_closed_connection_refuses_to_build_a_client():
    connection = _sas_connection()
    connection.close()
    fake_sdk = MagicMock()
    with patch.object(azure_auth, '_require_azure_storage', return_value=fake_sdk):
        with pytest.raises(azure_auth.AzureAuthError) as excinfo:
            connection.blob_service_client('acct')
    assert excinfo.value.code == 'not_connected'
    assert excinfo.value.status == 409
    # The SDK must never have been asked for an anonymous client.
    fake_sdk.assert_not_called()
    fake_sdk.from_connection_string.assert_not_called()


def test_closed_connection_reports_itself_disconnected():
    connection = _sas_connection()
    assert connection.describe()['connected'] is True
    connection.close()
    assert connection.describe()['connected'] is False


def test_closed_connection_does_not_leak_its_sas_token():
    connection = _sas_connection()
    connection.close()
    rendered = repr(connection) + json.dumps(connection.describe())
    assert 'abcdefg123' not in rendered
    assert 'sig=' not in rendered


@pytest.mark.parametrize('mode, kwargs', [
    (azure_auth.AUTH_SAS,
     {'account_name': 'acct', 'sas': '?sv=2022-11-02&sig=abcdefg123'}),
    (azure_auth.AUTH_ACCOUNT_KEY,
     {'account_name': 'acct', 'account_key': base64.b64encode(b'k' * 32).decode()}),
])
def test_every_authenticated_mode_refuses_reuse_after_close(mode, kwargs):
    connection = azure_auth.connect(mode, **kwargs)
    connection.close()
    with patch.object(azure_auth, '_require_azure_storage',
                      return_value=MagicMock()):
        with pytest.raises(azure_auth.AzureAuthError) as excinfo:
            connection.blob_service_client('acct')
    assert excinfo.value.code == 'not_connected'


def test_registry_removal_disables_the_underlying_connection():
    registry = azure_auth.ConnectionRegistry()
    connection = _sas_connection()
    registry.set('session-a', connection)
    assert registry.remove('session-a') is True
    with patch.object(azure_auth, '_require_azure_storage',
                      return_value=MagicMock()):
        with pytest.raises(azure_auth.AzureAuthError):
            connection.blob_service_client('acct')


def test_reconnect_closes_the_previous_connection_for_that_session():
    registry = azure_auth.ConnectionRegistry()
    first = _sas_connection()
    registry.set('session-a', first)
    registry.set('session-a', _sas_connection())
    with patch.object(azure_auth, '_require_azure_storage',
                      return_value=MagicMock()):
        with pytest.raises(azure_auth.AzureAuthError):
            first.blob_service_client('acct')


def test_anonymous_connections_still_work_before_close():
    connection = _connection()
    fake_client = object()
    sdk = MagicMock(return_value=fake_client)
    with patch.object(azure_auth, '_require_azure_storage', return_value=sdk):
        assert connection.blob_service_client('acct') is fake_client
    assert sdk.call_args.kwargs['credential'] is None