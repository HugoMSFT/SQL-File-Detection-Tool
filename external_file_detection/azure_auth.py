"""Azure Storage authentication and browsing, Azure Storage Explorer style.

The tool offers the same attach options a user expects from Azure Storage
Explorer, expressed here as explicit, typed authentication modes instead of an
implicit credential chain:

``entra_default``
    ``DefaultAzureCredential`` reusing an existing developer sign-in (Azure
    CLI, Azure PowerShell, VS Code). Intended for local/standalone use only.
``entra_interactive``
    An explicit interactive browser sign-in with persistent token caching
    where the platform supports it.
``managed_identity``
    ``ManagedIdentityCredential``, optionally user-assigned via
    ``AZURE_CLIENT_ID``. This is the *only* Entra mode recommended for
    production hosting, because it is deterministic.
``vscode_token``
    An access token brokered by the VS Code Microsoft authentication
    provider and handed to this process over a protected control endpoint.
``sas``
    A shared access signature URL or token.
``connection_string``
    A storage account connection string.
``account_key``
    Account name plus account key (least preferred).
``anonymous``
    Public read access, used only when explicitly requested.

Security rules enforced throughout this module:

* Secrets live in memory only. They are never logged, never written to disk,
  never placed in a URL that is returned to a caller, and never echoed back in
  an API response or an exception message.
* :func:`redact` scrubs SAS query strings, connection strings and bearer
  tokens out of any text before it is displayed or logged.
* A failed Entra sign-in is never silently downgraded to anonymous or key
  based access.
"""

import json
import logging
import os
import re
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qsl, quote, urlencode, urlparse

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------
# Authentication modes
# --------------------------------------------------------------------------

AUTH_ENTRA_DEFAULT = 'entra_default'
AUTH_ENTRA_INTERACTIVE = 'entra_interactive'
AUTH_MANAGED_IDENTITY = 'managed_identity'
AUTH_VSCODE_TOKEN = 'vscode_token'
AUTH_SAS = 'sas'
AUTH_CONNECTION_STRING = 'connection_string'
AUTH_ACCOUNT_KEY = 'account_key'
AUTH_ANONYMOUS = 'anonymous'

AUTH_MODES = (
    AUTH_ENTRA_DEFAULT,
    AUTH_ENTRA_INTERACTIVE,
    AUTH_MANAGED_IDENTITY,
    AUTH_VSCODE_TOKEN,
    AUTH_SAS,
    AUTH_CONNECTION_STRING,
    AUTH_ACCOUNT_KEY,
    AUTH_ANONYMOUS,
)

AUTH_MODE_LABELS = {
    AUTH_ENTRA_DEFAULT: 'Microsoft Entra ID (existing developer sign-in)',
    AUTH_ENTRA_INTERACTIVE: 'Microsoft Entra ID (interactive browser sign-in)',
    AUTH_MANAGED_IDENTITY: 'Managed identity',
    AUTH_VSCODE_TOKEN: 'Microsoft Entra ID (VS Code sign-in)',
    AUTH_SAS: 'Shared access signature (SAS)',
    AUTH_CONNECTION_STRING: 'Connection string',
    AUTH_ACCOUNT_KEY: 'Account name and key',
    AUTH_ANONYMOUS: 'Anonymous (public container)',
}

#: Modes that authenticate with Microsoft Entra ID rather than a shared secret.
ENTRA_MODES = frozenset({
    AUTH_ENTRA_DEFAULT,
    AUTH_ENTRA_INTERACTIVE,
    AUTH_MANAGED_IDENTITY,
    AUTH_VSCODE_TOKEN,
})

#: Modes that carry a secret the user supplied directly.
SECRET_MODES = frozenset({
    AUTH_SAS,
    AUTH_CONNECTION_STRING,
    AUTH_ACCOUNT_KEY,
})

STORAGE_SCOPE = 'https://storage.azure.com/.default'
ARM_SCOPE = 'https://management.azure.com/.default'
ARM_ENDPOINT = 'https://management.azure.com'

#: Seconds of headroom applied when deciding whether a token is still usable.
TOKEN_EXPIRY_SKEW_SECONDS = 300

#: Connections are dropped after this many seconds of inactivity so that
#: secrets never linger in memory for a whole day.
CONNECTION_TTL_SECONDS = 3600

#: Upper bound on blobs returned by a single listing page.
MAX_PAGE_SIZE = 200
DEFAULT_PAGE_SIZE = 100


class AzureAuthError(Exception):
    """A user-facing Azure authentication or browsing failure.

    The message is always safe to show: callers must build it from redacted
    text only.
    """

    def __init__(self, message: str, code: str = 'azure_auth_error',
                 status: int = 400):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


# --------------------------------------------------------------------------
# Redaction
# --------------------------------------------------------------------------

#: SAS query parameters that either are the signature or narrow it enough to
#: be worth hiding.
_SAS_SENSITIVE_KEYS = frozenset({
    'sig', 'sig_', 'skoid', 'sktid', 'skt', 'ske', 'sks', 'skv', 'se', 'st',
    'sp', 'sv', 'sr', 'si', 'spr', 'srt', 'ss', 'sip', 'sdd',
})

_REDACTED = '[redacted]'

_CONNECTION_SECRET_RE = re.compile(
    r'(?i)\b(AccountKey|SharedAccessSignature|SharedAccessKey|Password|Secret)'
    r'\s*=\s*[^;\s"\']+'
)
_BEARER_RE = re.compile(r'(?i)\bBearer\s+[A-Za-z0-9\-._~+/]+=*')
_JWT_RE = re.compile(r'\beyJ[A-Za-z0-9\-_]{8,}\.[A-Za-z0-9\-_]{8,}\.[A-Za-z0-9\-_]*')
_SIG_QUERY_RE = re.compile(r'(?i)([?&](?:sig|skoid|sktid|sks|si)=)[^&\s]*')


def redact(value: Any) -> str:
    """Return *value* as text with any recognisable secret removed.

    Handles SAS query strings, connection strings, bearer headers and raw
    JWTs. Used for every string this module logs or returns.
    """
    if value is None:
        return ''
    text = str(value)
    text = _CONNECTION_SECRET_RE.sub(lambda m: f'{m.group(1)}={_REDACTED}', text)
    text = _BEARER_RE.sub(f'Bearer {_REDACTED}', text)
    text = _JWT_RE.sub(_REDACTED, text)
    text = _SIG_QUERY_RE.sub(lambda m: f'{m.group(1)}{_REDACTED}', text)
    return text


def redact_url(url: Optional[str]) -> str:
    """Return *url* with the whole query string replaced when it looks signed.

    A SAS URL is only safe to display without its query string, because every
    component of the signature is sensitive in combination.
    """
    if not url:
        return ''
    text = str(url)
    base, sep, query = text.partition('?')
    if not sep:
        return redact(text)
    keys = {key.lower() for key, _ in parse_qsl(query, keep_blank_values=True)}
    if keys & _SAS_SENSITIVE_KEYS:
        return f'{base}?{_REDACTED}'
    return redact(text)


def mask_tail(secret: Optional[str], keep: int = 4) -> str:
    """Return a non-reversible hint such as ``****abcd`` for status display."""
    if not secret:
        return ''
    text = str(secret)
    if len(text) <= keep:
        return '*' * len(text)
    return '*' * 4 + text[-keep:]


# --------------------------------------------------------------------------
# Access tokens
# --------------------------------------------------------------------------

class AccessTokenRecord:
    """An Entra access token plus its absolute expiry (epoch seconds)."""

    __slots__ = ('_token', 'expires_on')

    def __init__(self, token: str, expires_on: Optional[float]):
        if not token or not isinstance(token, str):
            raise AzureAuthError('Access token is missing or malformed.',
                                 code='invalid_token')
        try:
            expiry = float(expires_on) if expires_on is not None else 0.0
        except (TypeError, ValueError):
            raise AzureAuthError('Access token expiry is malformed.',
                                 code='invalid_token') from None
        self._token = token
        self.expires_on = expiry

    @property
    def token(self) -> str:
        """Return the raw token. Never log or serialise the result."""
        return self._token

    def seconds_remaining(self, now: Optional[float] = None) -> float:
        reference = time.time() if now is None else now
        return self.expires_on - reference

    def is_expired(self, now: Optional[float] = None,
                   skew: float = TOKEN_EXPIRY_SKEW_SECONDS) -> bool:
        """Return True when the token is expired or within *skew* of expiry."""
        if not self.expires_on:
            # An unknown expiry is treated as already expired so the caller is
            # forced to refresh rather than send a token that may be stale.
            return True
        return self.seconds_remaining(now) <= skew

    def describe(self) -> Dict[str, Any]:
        """Return non-secret metadata about the token."""
        return {
            'expires_on': self.expires_on,
            'seconds_remaining': max(0, int(self.seconds_remaining())),
            'expired': self.is_expired(),
        }

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f'<AccessTokenRecord expires_on={self.expires_on} token=[redacted]>'

    __str__ = __repr__


def _access_token_class():
    """Return ``azure.core.credentials.AccessToken`` or a local stand-in."""
    try:  # pragma: no cover - depends on optional dependency
        from azure.core.credentials import AccessToken
        return AccessToken
    except ImportError:  # pragma: no cover - exercised without azure extras
        from collections import namedtuple
        return namedtuple('AccessToken', ['token', 'expires_on'])


class StaticTokenCredential:
    """Minimal ``TokenCredential`` wrapping an externally brokered token.

    The Azure SDKs only require ``get_token(*scopes, **kwargs)`` returning an
    object with ``token`` and ``expires_on``. This adapter lets a token
    obtained by the VS Code Microsoft authentication provider drive the Azure
    Storage SDK without this process ever performing an interactive sign-in.
    """

    def __init__(self, record: AccessTokenRecord,
                 refresh_hint: str = 'Sign in again from VS Code.'):
        self._record = record
        self._refresh_hint = refresh_hint
        self._lock = threading.Lock()

    def update(self, record: AccessTokenRecord) -> None:
        """Replace the held token, e.g. after VS Code refreshed it."""
        with self._lock:
            self._record = record

    @property
    def record(self) -> AccessTokenRecord:
        with self._lock:
            return self._record

    def get_token(self, *scopes: str, **kwargs: Any):
        with self._lock:
            record = self._record
        if record.is_expired():
            raise AzureAuthError(
                f'The Microsoft Entra ID access token has expired. '
                f'{self._refresh_hint}',
                code='token_expired',
                status=401,
            )
        return _access_token_class()(record.token, int(record.expires_on))

    # ``azure-core`` calls ``close`` on credentials used as context managers.
    def close(self) -> None:  # pragma: no cover - trivial
        return None

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return '<StaticTokenCredential token=[redacted]>'

    __str__ = __repr__


class VSCodeTokenStore:
    """Process-wide store for tokens pushed by the VS Code extension.

    Tokens arrive through an authenticated control endpoint, are held in
    memory only, and are cleared on sign-out or extension shutdown.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._storage: Optional[AccessTokenRecord] = None
        self._arm: Optional[AccessTokenRecord] = None
        self._account: str = ''
        self._tenant_id: str = ''
        self._credential: Optional[StaticTokenCredential] = None

    def set_tokens(self, storage_token: str, storage_expires_on: Any,
                   arm_token: Optional[str] = None,
                   arm_expires_on: Any = None,
                   account: str = '', tenant_id: str = '') -> None:
        storage_record = AccessTokenRecord(storage_token, storage_expires_on)
        arm_record = (
            AccessTokenRecord(arm_token, arm_expires_on) if arm_token else None
        )
        with self._lock:
            self._storage = storage_record
            self._arm = arm_record
            self._account = str(account or '')
            self._tenant_id = str(tenant_id or '')
            if self._credential is None:
                self._credential = StaticTokenCredential(storage_record)
            else:
                self._credential.update(storage_record)
        logger.info(
            'Received a Microsoft Entra ID token from VS Code for %s.',
            redact(account) or 'the signed-in account',
        )

    def clear(self) -> None:
        with self._lock:
            self._storage = None
            self._arm = None
            self._account = ''
            self._tenant_id = ''
            self._credential = None

    @property
    def credential(self) -> Optional[StaticTokenCredential]:
        with self._lock:
            return self._credential

    def storage_record(self) -> Optional[AccessTokenRecord]:
        with self._lock:
            return self._storage

    def arm_record(self) -> Optional[AccessTokenRecord]:
        with self._lock:
            return self._arm

    def status(self) -> Dict[str, Any]:
        """Return non-secret status suitable for an API response."""
        with self._lock:
            storage, arm = self._storage, self._arm
            account, tenant = self._account, self._tenant_id
        live = bool(storage and not storage.is_expired())
        return {
            'available': live,
            'signed_in': live,
            'has_storage_token': storage is not None,
            'has_arm_token': arm is not None,
            'storage_token': storage.describe() if storage else None,
            'arm_token': arm.describe() if arm else None,
            'account': account,
            'tenant_id': tenant,
        }


# --------------------------------------------------------------------------
# Credential construction
# --------------------------------------------------------------------------

def _require_azure_identity():
    try:
        import azure.identity as identity
        return identity
    except ImportError as exc:  # pragma: no cover - depends on extras
        raise AzureAuthError(
            'Microsoft Entra ID sign-in needs the Azure extras. Install them '
            'with: pip install "sql-file-detection-tool[azure]"',
            code='azure_identity_missing',
            status=501,
        ) from exc


def _require_azure_storage():
    try:
        from azure.storage.blob import BlobServiceClient
        return BlobServiceClient
    except ImportError as exc:  # pragma: no cover - depends on extras
        raise AzureAuthError(
            'Azure Storage browsing needs the Azure extras. Install them '
            'with: pip install "sql-file-detection-tool[azure]"',
            code='azure_storage_missing',
            status=501,
        ) from exc


def build_entra_credential(mode: str,
                           client_id: Optional[str] = None,
                           tenant_id: Optional[str] = None,
                           token_store: Optional[VSCodeTokenStore] = None):
    """Return an Azure ``TokenCredential`` for an Entra *mode*.

    ``entra_default`` is deliberately restricted to local/developer use; the
    production guidance is ``managed_identity``, which selects
    ``ManagedIdentityCredential`` explicitly instead of relying on an
    unpredictable credential chain.
    """
    if mode == AUTH_VSCODE_TOKEN:
        credential = token_store.credential if token_store else None
        if credential is None:
            raise AzureAuthError(
                'VS Code has not supplied a Microsoft Entra ID token yet. Run '
                '"SQL File Detection Tool: Connect to Azure Storage" first.',
                code='no_vscode_token',
                status=401,
            )
        if credential.record.is_expired():
            raise AzureAuthError(
                'The Microsoft Entra ID token from VS Code has expired. '
                'Connect to Azure Storage again.',
                code='token_expired',
                status=401,
            )
        return credential

    identity = _require_azure_identity()

    if mode == AUTH_MANAGED_IDENTITY:
        assigned = client_id or os.environ.get('AZURE_CLIENT_ID') or None
        if assigned:
            return identity.ManagedIdentityCredential(client_id=assigned)
        return identity.ManagedIdentityCredential()

    if mode == AUTH_ENTRA_INTERACTIVE:
        kwargs: Dict[str, Any] = {}
        if tenant_id:
            kwargs['tenant_id'] = tenant_id
        if client_id:
            kwargs['client_id'] = client_id
        try:
            # Persist the refresh token in the OS-protected cache when the
            # platform supports it so repeat sign-ins are silent.
            from azure.identity import TokenCachePersistenceOptions
            kwargs['cache_persistence_options'] = TokenCachePersistenceOptions(
                name='sql-file-detection-tool',
                allow_unencrypted_storage=False,
            )
        except ImportError:  # pragma: no cover - older azure-identity
            pass
        try:
            return identity.InteractiveBrowserCredential(**kwargs)
        except (TypeError, ValueError):
            kwargs.pop('cache_persistence_options', None)
            return identity.InteractiveBrowserCredential(**kwargs)

    if mode == AUTH_ENTRA_DEFAULT:
        return identity.DefaultAzureCredential(
            exclude_interactive_browser_credential=True,
        )

    raise AzureAuthError(f'Unsupported Entra sign-in mode: {redact(mode)}',
                         code='unsupported_mode')


# --------------------------------------------------------------------------
# SAS / connection string parsing
# --------------------------------------------------------------------------

def parse_sas_input(value: str) -> Tuple[Optional[str], Optional[str], str]:
    """Split a SAS URL or bare SAS token.

    Returns ``(account_name, container, sas_token)``. ``sas_token`` never
    carries a leading ``?``. Raises :class:`AzureAuthError` with a redacted
    message when the input is not usable.
    """
    text = (value or '').strip()
    if not text:
        raise AzureAuthError('Enter a SAS URL or SAS token.',
                             code='sas_missing')

    if text.lower().startswith(('http://', 'https://')):
        parsed = urlparse(text)
        host = (parsed.hostname or '').lower()
        if not host.endswith('.blob.core.windows.net'):
            raise AzureAuthError(
                'A SAS URL must point at a *.blob.core.windows.net host.',
                code='sas_host',
            )
        if parsed.scheme.lower() != 'https':
            raise AzureAuthError('A SAS URL must use https.', code='sas_scheme')
        account = host.split('.', 1)[0]
        container = parsed.path.lstrip('/').split('/', 1)[0] or None
        token = (parsed.query or '').lstrip('?')
        if not token:
            raise AzureAuthError(
                'That URL has no SAS token in its query string.',
                code='sas_missing',
            )
        return account, container, token

    token = text.lstrip('?')
    keys = {key.lower() for key, _ in parse_qsl(token, keep_blank_values=True)}
    if 'sig' not in keys:
        raise AzureAuthError(
            'That does not look like a SAS token (no signature found).',
            code='sas_invalid',
        )
    return None, None, token


def parse_connection_string(value: str) -> Tuple[Optional[str], Dict[str, str]]:
    """Return ``(account_name, parts)`` for a storage connection string."""
    text = (value or '').strip()
    if not text:
        raise AzureAuthError('Enter a connection string.',
                             code='connection_string_missing')
    parts: Dict[str, str] = {}
    for segment in text.split(';'):
        if not segment.strip():
            continue
        key, sep, val = segment.partition('=')
        if not sep:
            raise AzureAuthError(
                'That connection string is malformed.',
                code='connection_string_invalid',
            )
        parts[key.strip().lower()] = val.strip()
    account = parts.get('accountname')
    if not account and 'blobendpoint' in parts:
        host = (urlparse(parts['blobendpoint']).hostname or '').lower()
        if host.endswith('.blob.core.windows.net'):
            account = host.split('.', 1)[0]
    if not account:
        raise AzureAuthError(
            'That connection string does not name a storage account.',
            code='connection_string_invalid',
        )
    if not (parts.get('accountkey') or parts.get('sharedaccesssignature')):
        raise AzureAuthError(
            'That connection string carries no account key or SAS.',
            code='connection_string_invalid',
        )
    return account, parts


def validate_account_name(value: Optional[str]) -> str:
    """Validate an Azure Storage account name."""
    name = (value or '').strip().lower()
    if not re.fullmatch(r'[a-z0-9]{3,24}', name):
        raise AzureAuthError(
            'Storage account names are 3-24 lowercase letters or digits.',
            code='invalid_account_name',
        )
    return name


def validate_container_name(value: Optional[str]) -> str:
    """Validate an Azure Blob container name."""
    name = (value or '').strip()
    if not re.fullmatch(r'[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?', name):
        raise AzureAuthError(
            'Container names are 3-63 lowercase letters, digits or hyphens.',
            code='invalid_container_name',
        )
    return name


# --------------------------------------------------------------------------
# ARM REST helpers (no extra SDK dependency)
# --------------------------------------------------------------------------

def _arm_get(path: str, token: str, api_version: str,
             timeout: float = 20.0) -> Dict[str, Any]:
    """Perform an authenticated ARM GET and return the decoded JSON body."""
    import urllib.error
    import urllib.request

    separator = '&' if '?' in path else '?'
    url = f'{ARM_ENDPOINT}{path}{separator}{urlencode({"api-version": api_version})}'
    request = urllib.request.Request(url, method='GET')
    request.add_header('Authorization', f'Bearer {token}')
    request.add_header('Accept', 'application/json')
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read(8 * 1024 * 1024)
    except urllib.error.HTTPError as exc:
        status = exc.code
        if status in (401, 403):
            raise AzureAuthError(
                'Azure Resource Manager rejected the token. Sign in again, or '
                'browse a known storage account directly.',
                code='arm_forbidden',
                status=403,
            ) from None
        raise AzureAuthError(
            f'Azure Resource Manager returned HTTP {status}.',
            code='arm_error',
            status=502,
        ) from None
    except urllib.error.URLError as exc:
        raise AzureAuthError(
            f'Could not reach Azure Resource Manager: {redact(exc.reason)}',
            code='arm_unreachable',
            status=502,
        ) from None
    try:
        return json.loads(payload.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise AzureAuthError('Azure Resource Manager sent an unreadable reply.',
                             code='arm_error', status=502) from None


def list_subscriptions(arm_token: str) -> List[Dict[str, str]]:
    """Return the subscriptions the ARM token can see."""
    body = _arm_get('/subscriptions', arm_token, '2022-12-01')
    subscriptions = []
    for item in body.get('value') or []:
        subscription_id = item.get('subscriptionId')
        if not subscription_id:
            continue
        subscriptions.append({
            'id': subscription_id,
            'name': item.get('displayName') or subscription_id,
            'state': item.get('state') or '',
        })
    subscriptions.sort(key=lambda entry: entry['name'].lower())
    return subscriptions


def list_storage_accounts(arm_token: str,
                          subscription_id: str) -> List[Dict[str, str]]:
    """Return the storage accounts in *subscription_id*."""
    if not re.fullmatch(r'[0-9a-fA-F-]{8,64}', subscription_id or ''):
        raise AzureAuthError('That subscription id is not valid.',
                             code='invalid_subscription')
    body = _arm_get(
        f'/subscriptions/{quote(subscription_id, safe="")}'
        f'/providers/Microsoft.Storage/storageAccounts',
        arm_token,
        '2023-01-01',
    )
    accounts = []
    for item in body.get('value') or []:
        name = item.get('name')
        if not name:
            continue
        accounts.append({
            'name': name,
            'location': item.get('location') or '',
            'kind': item.get('kind') or '',
            'resource_group': _resource_group_of(item.get('id') or ''),
        })
    accounts.sort(key=lambda entry: entry['name'].lower())
    return accounts


def _resource_group_of(resource_id: str) -> str:
    match = re.search(r'/resourceGroups/([^/]+)/', resource_id or '',
                      re.IGNORECASE)
    return match.group(1) if match else ''


# --------------------------------------------------------------------------
# Connections
# --------------------------------------------------------------------------

class AzureConnection:
    """A live, in-memory Azure Storage connection for one user session."""

    def __init__(self, mode: str, account_name: Optional[str] = None,
                 credential: Any = None,
                 connection_string: Optional[str] = None,
                 sas_token: Optional[str] = None,
                 account_key: Optional[str] = None,
                 arm_token: Optional[AccessTokenRecord] = None,
                 identity_label: str = '',
                 default_container: Optional[str] = None):
        self.mode = mode
        self.account_name = account_name
        self.identity_label = identity_label
        self.default_container = default_container
        self.created_at = time.time()
        self.last_used = self.created_at
        self._credential = credential
        self._connection_string = connection_string
        self._sas_token = sas_token
        self._account_key = account_key
        self._arm_token = arm_token
        self._clients: Dict[str, Any] = {}
        self._lock = threading.Lock()
        self._closed = False

    # -- metadata ---------------------------------------------------------

    @property
    def is_entra(self) -> bool:
        return self.mode in ENTRA_MODES

    def arm_token(self) -> Optional[str]:
        """Return the ARM token when one is available and still valid."""
        record = self._arm_token
        if record is None or record.is_expired():
            return None
        return record.token

    def describe(self) -> Dict[str, Any]:
        """Return status for the UI. Contains no secret material."""
        info: Dict[str, Any] = {
            'connected': not self._closed,
            'mode': self.mode,
            'mode_label': AUTH_MODE_LABELS.get(self.mode, self.mode),
            'account_name': self.account_name or '',
            'identity': redact(self.identity_label),
            'is_entra': self.is_entra,
            'uses_secret': self.mode in SECRET_MODES,
            'default_container': self.default_container or '',
            'can_list_subscriptions': self.arm_token() is not None,
            'connected_at': self.created_at,
        }
        if self.mode == AUTH_SAS:
            info['credential_hint'] = mask_tail(self._sas_token)
        elif self.mode == AUTH_ACCOUNT_KEY:
            info['credential_hint'] = mask_tail(self._account_key)
        elif self.mode == AUTH_CONNECTION_STRING:
            info['credential_hint'] = _REDACTED
        else:
            info['credential_hint'] = ''
        if self._arm_token is not None:
            info['arm_token'] = self._arm_token.describe()
        return info

    # -- clients ----------------------------------------------------------

    def blob_service_client(self, account_name: Optional[str] = None):
        """Return a cached ``BlobServiceClient`` for *account_name*."""
        BlobServiceClient = _require_azure_storage()
        if self._closed:
            raise AzureAuthError(
                'This Azure connection was closed. Connect again.',
                code='not_connected', status=409)
        target = account_name or self.account_name
        if self.mode in (AUTH_CONNECTION_STRING,):
            target = self.account_name
        if not target:
            raise AzureAuthError('Choose a storage account first.',
                                 code='no_account', status=400)
        target = validate_account_name(target)

        with self._lock:
            if self._closed:
                raise AzureAuthError(
                    'This Azure connection was closed. Connect again.',
                    code='not_connected', status=409)
            client = self._clients.get(target)
            if client is not None:
                self.last_used = time.time()
                return client

        account_url = f'https://{target}.blob.core.windows.net'
        if self.mode == AUTH_CONNECTION_STRING:
            credential = self._connection_string
        elif self.mode == AUTH_SAS:
            credential = self._sas_token
        elif self.mode == AUTH_ACCOUNT_KEY:
            credential = self._account_key
        elif self.mode == AUTH_ANONYMOUS:
            credential = None
        else:
            credential = self._credential

        # ``credential=None`` means anonymous access in the Storage SDK. Never
        # let a cleared credential silently downgrade an authenticated mode.
        if self.mode != AUTH_ANONYMOUS and credential is None:
            raise AzureAuthError(
                'This Azure connection is no longer authenticated. '
                'Connect again.',
                code='not_connected', status=409)

        if self.mode == AUTH_CONNECTION_STRING:
            client = BlobServiceClient.from_connection_string(credential)
        else:
            client = BlobServiceClient(account_url, credential=credential)

        with self._lock:
            if self._closed:
                try:
                    client.close()
                except Exception:  # pragma: no cover - best effort cleanup
                    logger.debug('Ignoring error while closing a blob client.')
                raise AzureAuthError(
                    'This Azure connection was closed. Connect again.',
                    code='not_connected', status=409)
            self._clients[target] = client
            self.last_used = time.time()
        return client

    def close(self) -> None:
        """Drop every client and forget all secret material."""
        with self._lock:
            self._closed = True
            clients = list(self._clients.values())
            self._clients.clear()
            self._credential = None
            self._connection_string = None
            self._sas_token = None
            self._account_key = None
            self._arm_token = None
        for client in clients:
            try:
                client.close()
            except Exception:  # pragma: no cover - best effort cleanup
                logger.debug('Ignoring error while closing a blob client.')

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f'<AzureConnection mode={self.mode} account={self.account_name}>'

    __str__ = __repr__


def connect(mode: str, *, account_name: Optional[str] = None,
            sas: Optional[str] = None,
            connection_string: Optional[str] = None,
            account_key: Optional[str] = None,
            client_id: Optional[str] = None,
            tenant_id: Optional[str] = None,
            token_store: Optional[VSCodeTokenStore] = None) -> AzureConnection:
    """Create an :class:`AzureConnection` for *mode*.

    Failures raise :class:`AzureAuthError`; an Entra failure is never
    downgraded to anonymous or shared-key access.
    """
    if mode not in AUTH_MODES:
        raise AzureAuthError(f'Unknown sign-in mode: {redact(mode)}',
                             code='unsupported_mode')

    if mode == AUTH_SAS:
        parsed_account, container, token = parse_sas_input(sas or '')
        resolved = account_name or parsed_account
        if not resolved:
            raise AzureAuthError(
                'A bare SAS token also needs the storage account name.',
                code='sas_account_required',
            )
        return AzureConnection(
            mode, account_name=validate_account_name(resolved),
            sas_token=token, default_container=container,
            identity_label='Shared access signature',
        )

    if mode == AUTH_CONNECTION_STRING:
        resolved, _parts = parse_connection_string(connection_string or '')
        return AzureConnection(
            mode, account_name=validate_account_name(resolved),
            connection_string=(connection_string or '').strip(),
            identity_label='Connection string',
        )

    if mode == AUTH_ACCOUNT_KEY:
        resolved = validate_account_name(account_name)
        key = (account_key or '').strip()
        if not key:
            raise AzureAuthError('Enter the storage account key.',
                                 code='account_key_missing')
        return AzureConnection(
            mode, account_name=resolved, account_key=key,
            identity_label='Shared key',
        )

    if mode == AUTH_ANONYMOUS:
        resolved = validate_account_name(account_name)
        return AzureConnection(
            mode, account_name=resolved,
            identity_label='Anonymous (public read)',
        )

    credential = build_entra_credential(
        mode, client_id=client_id, tenant_id=tenant_id,
        token_store=token_store,
    )
    identity_label = AUTH_MODE_LABELS.get(mode, mode)
    arm_record: Optional[AccessTokenRecord] = None
    if mode == AUTH_VSCODE_TOKEN:
        arm_record = token_store.arm_record() if token_store else None
        status = token_store.status() if token_store else {}
        if status.get('account'):
            identity_label = str(status['account'])
    else:
        # Fail loudly here rather than pretending the sign-in worked and
        # surfacing a confusing error on the first listing call.
        _require_storage_token(credential, mode)
        arm_record = _try_arm_token(credential)

    resolved_account = (
        validate_account_name(account_name) if account_name else None
    )
    return AzureConnection(
        mode, account_name=resolved_account, credential=credential,
        arm_token=arm_record, identity_label=identity_label,
    )


def _require_storage_token(credential: Any, mode: str) -> None:
    """Verify the credential can mint an Azure Storage token.

    Raises :class:`AzureAuthError` on failure. The sign-in is never quietly
    downgraded to anonymous or shared-key access.
    """
    try:
        credential.get_token(STORAGE_SCOPE)
    except AzureAuthError:
        raise
    except Exception as exc:
        label = AUTH_MODE_LABELS.get(mode, mode)
        raise AzureAuthError(
            f'Microsoft Entra ID sign-in failed for "{label}": '
            f'{redact(exc)}',
            code='entra_sign_in_failed',
            status=401,
        ) from None


def _try_arm_token(credential: Any) -> Optional[AccessTokenRecord]:
    """Best-effort ARM token so subscription enumeration can be offered.

    A failure here only removes the subscription picker; storage browsing by
    account name still works, and the sign-in is *not* downgraded.
    """
    try:
        token = credential.get_token(ARM_SCOPE)
    except AzureAuthError:
        raise
    except Exception as exc:
        logger.info('Subscription enumeration unavailable: %s',
                    redact(type(exc).__name__))
        return None
    try:
        return AccessTokenRecord(token.token, token.expires_on)
    except AzureAuthError:
        return None


class ConnectionRegistry:
    """In-memory registry of live connections, keyed by browser session id."""

    def __init__(self, ttl_seconds: float = CONNECTION_TTL_SECONDS):
        self._lock = threading.Lock()
        self._entries: Dict[str, AzureConnection] = {}
        self._ttl = ttl_seconds

    def set(self, key: str, connection: AzureConnection) -> None:
        previous = None
        with self._lock:
            previous = self._entries.get(key)
            self._entries[key] = connection
        if previous is not None:
            previous.close()
        self.purge_expired()

    def get(self, key: str) -> Optional[AzureConnection]:
        self.purge_expired()
        with self._lock:
            connection = self._entries.get(key)
            if connection is not None:
                connection.last_used = time.time()
            return connection

    def require(self, key: str) -> AzureConnection:
        connection = self.get(key)
        if connection is None:
            raise AzureAuthError(
                'Not connected to Azure Storage. Choose a sign-in method '
                'first.',
                code='not_connected',
                status=409,
            )
        return connection

    def remove(self, key: str) -> bool:
        with self._lock:
            connection = self._entries.pop(key, None)
        if connection is None:
            return False
        connection.close()
        return True

    def purge_expired(self, now: Optional[float] = None) -> int:
        reference = time.time() if now is None else now
        with self._lock:
            stale = [
                key for key, entry in self._entries.items()
                if reference - entry.last_used > self._ttl
            ]
            dropped = [self._entries.pop(key) for key in stale]
        for connection in dropped:
            connection.close()
        return len(dropped)

    def clear(self) -> None:
        with self._lock:
            connections = list(self._entries.values())
            self._entries.clear()
        for connection in connections:
            connection.close()


# --------------------------------------------------------------------------
# Browsing
# --------------------------------------------------------------------------

SUPPORTED_BLOB_SUFFIXES = (
    '.csv', '.tsv', '.txt', '.json', '.jsonl', '.ndjson',
    '.parquet', '.pq', '.orc', '.xlsx', '.xls',
)


def _blob_is_supported(name: str) -> bool:
    lowered = (name or '').lower()
    return lowered.endswith(SUPPORTED_BLOB_SUFFIXES)


def list_containers(connection: AzureConnection,
                    account_name: Optional[str] = None,
                    page_size: int = DEFAULT_PAGE_SIZE,
                    continuation: Optional[str] = None) -> Dict[str, Any]:
    """List blob containers with bounded paging."""
    size = max(1, min(int(page_size or DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE))
    client = connection.blob_service_client(account_name)
    try:
        pager = client.list_containers(results_per_page=size).by_page(
            continuation_token=continuation or None
        )
        page = next(pager)
        containers = [
            {'name': item['name'] if isinstance(item, dict) else item.name}
            for item in page
        ]
        next_token = pager.continuation_token
    except AzureAuthError:
        raise
    except StopIteration:
        return {'containers': [], 'continuation': None}
    except Exception as exc:
        raise _browse_error(exc, 'list containers') from None
    return {'containers': containers, 'continuation': next_token or None}


def list_blobs(connection: AzureConnection, container: str,
               prefix: str = '', account_name: Optional[str] = None,
               page_size: int = DEFAULT_PAGE_SIZE,
               continuation: Optional[str] = None) -> Dict[str, Any]:
    """List one bounded page of folders and blobs under *prefix*."""
    size = max(1, min(int(page_size or DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE))
    container_name = validate_container_name(container)
    safe_prefix = (prefix or '').lstrip('/')
    if '..' in safe_prefix.split('/'):
        raise AzureAuthError('That prefix is not valid.',
                             code='invalid_prefix')
    client = connection.blob_service_client(account_name)
    account = account_name or connection.account_name
    try:
        container_client = client.get_container_client(container_name)
        pager = container_client.walk_blobs(
            name_starts_with=safe_prefix or None,
            delimiter='/',
            results_per_page=size,
        ).by_page(continuation_token=continuation or None)
        page = next(pager)
        folders: List[Dict[str, Any]] = []
        blobs: List[Dict[str, Any]] = []
        for item in page:
            name = getattr(item, 'name', None)
            if name is None and isinstance(item, dict):
                name = item.get('name')
            if not name:
                continue
            if str(name).endswith('/'):
                folders.append({
                    'name': str(name)[len(safe_prefix):].strip('/'),
                    'prefix': str(name),
                })
                continue
            blobs.append({
                'name': str(name)[len(safe_prefix):],
                'path': str(name),
                'size': int(getattr(item, 'size', 0) or 0),
                'supported': _blob_is_supported(str(name)),
                'url': blob_url(account, container_name, str(name)),
            })
        next_token = pager.continuation_token
    except AzureAuthError:
        raise
    except StopIteration:
        return {
            'folders': [], 'blobs': [], 'continuation': None,
            'container': container_name, 'prefix': safe_prefix,
        }
    except Exception as exc:
        raise _browse_error(exc, 'list blobs') from None
    return {
        'folders': folders,
        'blobs': blobs,
        'continuation': next_token or None,
        'container': container_name,
        'prefix': safe_prefix,
    }


def blob_url(account_name: Optional[str], container: str, blob_name: str) -> str:
    """Return the plain (unsigned) HTTPS URL of a blob."""
    if not account_name:
        return ''
    return (
        f'https://{account_name}.blob.core.windows.net/'
        f'{quote(container, safe="")}/{quote(blob_name, safe="/")}'
    )


def storage_url_for(account_name: Optional[str], container: str,
                    blob_name: str) -> str:
    """Return the ``abs://`` location the generated SQL should reference."""
    if not account_name:
        return ''
    path = quote(blob_name, safe='/')
    return (
        f'abs://{quote(container, safe="")}@{account_name}'
        f'.blob.core.windows.net/{path}'
    )


def download_blob(connection: AzureConnection, container: str, blob_name: str,
                  destination: str,
                  account_name: Optional[str] = None,
                  max_bytes: int = 256 * 1024 * 1024) -> int:
    """Download one blob to *destination*, refusing oversized payloads."""
    container_name = validate_container_name(container)
    if not blob_name or blob_name.endswith('/'):
        raise AzureAuthError('Choose a blob, not a folder.',
                             code='invalid_blob')
    client = connection.blob_service_client(account_name)
    try:
        blob_client = client.get_blob_client(container_name, blob_name)
        properties = blob_client.get_blob_properties()
        size = int(getattr(properties, 'size', 0) or 0)
        if size > max_bytes:
            raise AzureAuthError(
                f'That blob is {size:,} bytes, larger than the '
                f'{max_bytes:,} byte download limit.',
                code='blob_too_large',
                status=413,
            )
        with open(destination, 'wb') as handle:
            blob_client.download_blob().readinto(handle)
    except AzureAuthError:
        raise
    except Exception as exc:
        raise _browse_error(exc, 'download blob') from None
    return size


def _browse_error(exc: Exception, action: str) -> AzureAuthError:
    """Convert an Azure SDK exception into a safe, specific error."""
    status = int(getattr(exc, 'status_code', 0) or 0)
    detail = redact(getattr(exc, 'reason', '') or type(exc).__name__)
    if status in (401, 403):
        return AzureAuthError(
            f'Access denied when trying to {action}. Grant the signed-in '
            f'identity the Storage Blob Data Reader role on the account, or '
            f'use a credential with permission.',
            code='forbidden',
            status=403,
        )
    if status == 404:
        return AzureAuthError(f'Not found when trying to {action}.',
                              code='not_found', status=404)
    if status:
        return AzureAuthError(
            f'Azure Storage returned HTTP {status} while trying to {action}.',
            code='storage_error',
            status=502,
        )
    return AzureAuthError(
        f'Could not {action}: {detail}',
        code='storage_error',
        status=502,
    )
