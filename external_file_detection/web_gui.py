"""Web-based GUI for the SQL File Detection Tool.

Provides a user-friendly local web interface for:
- Selecting files or folders (local disk or Azure Blob Storage)
- Previewing file metadata
- Generating T-SQL DDL statements for the selected target platform
"""

import hmac
import os
import io
import json
import logging
import secrets
import shutil
import uuid
import time
import tempfile
import threading
from typing import Dict, List, Any, Optional
from pathlib import Path
from urllib.parse import unquote

logger = logging.getLogger(__name__)

try:
    from flask import Flask, render_template, request, jsonify, session, send_file
    from werkzeug.utils import secure_filename
    FLASK_AVAILABLE = True
except ImportError:
    FLASK_AVAILABLE = False

from . import azure_auth
from . import public_data
from .external_file_detector import ExternalFileDetectorApp
from .file_detector import FileDetector
from .sql_generator import DEFAULT_TARGET_PLATFORM, SQLGenerator
from . import __product_name__, __version__


# Maximum upload size: 200 MB
MAX_UPLOAD_SIZE = 200 * 1024 * 1024

#: Environment variable the VS Code extension uses to hand this process its
#: control-endpoint secret. It is read once at start-up and never echoed.
CONTROL_TOKEN_ENV = 'SQLFDT_CONTROL_TOKEN'

#: Header carrying the control secret on ``/api/control/*`` requests.
CONTROL_TOKEN_HEADER = 'X-Control-Token'

#: Header carrying the per-browser-session token on state-changing Azure
#: endpoints, so another local origin cannot drive this app through the user's
#: browser.
CSRF_HEADER = 'X-SQLFDT-Session'


# Hosts that keep the server bound to the local machine only.
_LOOPBACK_HOSTS = {'127.0.0.1', 'localhost', '::1'}


def _is_within_root(path: str, root: str) -> bool:
    """Return whether *path* resolves to *root* or one of its descendants."""
    resolved_path = os.path.normcase(os.path.realpath(os.path.abspath(path)))
    resolved_root = os.path.normcase(os.path.realpath(os.path.abspath(root)))
    try:
        return os.path.commonpath([resolved_root, resolved_path]) == resolved_root
    except ValueError:
        return False


def _paths_equal(left: str, right: str) -> bool:
    """Compare local paths canonically while preserving remote URL semantics."""
    if '://' in left or '://' in right:
        return left == right
    return os.path.normcase(os.path.realpath(os.path.abspath(left))) == (
        os.path.normcase(os.path.realpath(os.path.abspath(right)))
    )


def _decode_route_path(file_path: str) -> str:
    """Restore an absolute local path captured by Flask's path converter."""
    decoded = unquote(file_path)
    if os.path.isabs(decoded):
        return decoded
    return os.path.join(os.path.sep, decoded)


def _directory_size(directory_path: str) -> int:
    """Return the total size of non-hidden files under a table directory."""
    return sum(
        os.path.getsize(os.path.join(root, filename))
        for root, _, filenames in os.walk(directory_path)
        for filename in filenames
        if not filename.startswith('.')
    )


def _safe_debug(host: str, debug: bool) -> bool:
    """Return whether Flask debug mode may be enabled for the given host.

    Flask/Werkzeug debug mode exposes an interactive debugger that allows
    arbitrary code execution. It is only safe on a loopback interface. When
    the server is bound to a non-loopback host (e.g. 0.0.0.0 or a public IP),
    refuse to enable debug so the RCE console is never reachable from the
    network. ``host=None`` uses Flask's default loopback binding and is safe;
    an empty string binds to all interfaces and is treated as non-loopback.
    """
    if not debug:
        return False
    if host is None:
        return True
    if host.lower() not in _LOOPBACK_HOSTS:
        logger.warning(
            "Refusing to enable Flask debug mode while bound to non-loopback "
            "host %r; the interactive debugger allows remote code execution. "
            "Run on 127.0.0.1 to use debug mode.", host)
        return False
    return True


def _validate_bind_host(host: str) -> None:
    """Keep the unauthenticated development server on loopback interfaces."""
    if host is None or host.lower() in _LOOPBACK_HOSTS:
        return
    raise ValueError(
        "The built-in web server is loopback-only because its filesystem APIs "
        "do not provide authentication. Deploy create_app() behind an "
        "authenticated reverse proxy for remote access."
    )


def _validate_path(path: str, root_dir: str = None,
                   allow_files: bool = True, allow_dirs: bool = True) -> str:
    """
    Validate and sanitize a path to prevent path injection attacks.
    
    Args:
        path: Path to validate
        root_dir: If set, only paths underneath this root are allowed.
        allow_files: Whether to allow file paths
        allow_dirs: Whether to allow directory paths
        
    Returns:
        Sanitized absolute path
        
    Raises:
        ValueError: If path is invalid or unsafe
    """
    if not path:
        raise ValueError("Path cannot be empty")
    
    # Resolve symlinks and normalize the path
    normalized_path = os.path.realpath(os.path.abspath(path))
    
    # Root directory constraint (after symlink resolution)
    root = os.path.realpath(os.path.abspath(root_dir or os.getcwd()))
    if not _is_within_root(normalized_path, root):
        raise ValueError("Path is outside the allowed root directory")
    
    # Check if path exists
    if not os.path.exists(normalized_path):
        raise ValueError("Path does not exist")
    
    # Check if it's a file or directory as requested
    if os.path.isfile(normalized_path) and not allow_files:
        raise ValueError("File path not allowed")
    
    if os.path.isdir(normalized_path) and not allow_dirs:
        raise ValueError("Directory path not allowed")
    
    # Ensure path components don't contain traversal or illegal characters
    if '..' in Path(path).parts or any(c in normalized_path for c in '<>|?*'):
        raise ValueError("Path contains unsafe characters")
    
    return normalized_path


def _clean_results(results):
    """Recursively clean results for JSON serialization (NaN/Inf → None)."""
    if isinstance(results, float):
        import math
        if math.isnan(results) or math.isinf(results):
            return None
        return results
    if isinstance(results, dict):
        return {k: _clean_results(v) for k, v in results.items()}
    elif isinstance(results, list):
        return [_clean_results(item) for item in results]
    elif isinstance(results, tuple):
        return [_clean_results(item) for item in results]
    elif isinstance(results, (str, int, bool, type(None))):
        return results
    else:
        return str(results)


def _error_response(message: str, status: int):
    """Return a consistent JSON API error payload.

    Every message is redacted so that a SAS query string, connection string or
    account key embedded in an SDK exception can never reach the client.
    """
    return jsonify({'success': False,
                    'error': azure_auth.redact(message)}), status


def _safe_error(exc: Exception) -> str:
    """Render *exc* as text with any credential material removed."""
    return azure_auth.redact(str(exc))


def _azure_extras_available() -> bool:
    """Return whether the optional Azure SDKs are importable."""
    try:  # pragma: no cover - depends on the installed extras
        import azure.storage.blob  # noqa: F401
        import azure.identity  # noqa: F401
    except ImportError:
        return False
    return True


def _page_size(raw: Any) -> int:
    """Clamp a caller-supplied page size into a safe range."""
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return azure_auth.DEFAULT_PAGE_SIZE
    return max(1, min(value, azure_auth.MAX_PAGE_SIZE))


def _requested_target_platform(source: Any) -> str:
    """Read a validated target platform from a request payload."""
    requested = None
    if source is not None:
        try:
            requested = source.get('target_platform')
        except AttributeError:
            requested = None
    return SQLGenerator.normalize_platform(requested)


class ExternalFileDetectionWebGUI:
    """Local web application for the SQL File Detection Tool."""

    def __init__(self, root_dir: str = None, control_token: str = None):
        """Initialize the web GUI application.

        Args:
            root_dir: If set, restrict all file access to this directory tree.
            control_token: Secret required by ``/api/control/*``. Defaults to
                ``$SQLFDT_CONTROL_TOKEN`` or a fresh random per-process value.
        """
        if not FLASK_AVAILABLE:
            raise ImportError("Flask is required for the web GUI. Install with: pip install flask")
        
        self._root_dir = root_dir
            
        self.app = Flask(__name__, template_folder='templates', static_folder=None)
        self.app.config['MAX_CONTENT_LENGTH'] = MAX_UPLOAD_SIZE
        self.app.secret_key = os.environ.get('FLASK_SECRET_KEY', os.urandom(24).hex())
        self.app.config['SESSION_COOKIE_HTTPONLY'] = True
        self.app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
        self._upload_tempdir = tempfile.TemporaryDirectory(prefix='sqlfdt_web_')
        self._upload_root = self._upload_tempdir.name
        self.detector_app = ExternalFileDetectorApp()
        self.file_detector = FileDetector()
        self.sql_generator = self.detector_app.sql_generator

        # Control endpoint secret. A cryptographically random per-process
        # value is used when the host process did not supply one, so the
        # endpoints are never open by accident.
        self._control_token = (
            control_token
            or os.environ.get(CONTROL_TOKEN_ENV)
            or secrets.token_urlsafe(32)
        )
        # The environment copy is dropped once read so it cannot leak into a
        # child process or a crash dump of this app's environment.
        os.environ.pop(CONTROL_TOKEN_ENV, None)

        # Tokens brokered by the VS Code Microsoft authentication provider.
        self._vscode_tokens = azure_auth.VSCodeTokenStore()
        # Live Azure Storage connections, one per browser session.
        self._azure_connections = azure_auth.ConnectionRegistry()

        # Thread-safe per-session file store
        self._sessions_lock = threading.Lock()
        self._sessions: Dict[str, Dict[str, Any]] = {}
        self._session_ttl = 3600  # 1 hour TTL
        self._retired_upload_dirs: Dict[str, float] = {}
        
        self.setup_routes()

    # --- control / CSRF helpers ---

    @property
    def control_token(self) -> str:
        """Return the control-endpoint secret (for the launching process)."""
        return self._control_token

    def _control_authorized(self) -> bool:
        """Constant-time check of the control-endpoint secret."""
        supplied = request.headers.get(CONTROL_TOKEN_HEADER, '')
        if not supplied:
            return False
        return hmac.compare_digest(str(supplied), self._control_token)

    def _session_token(self) -> str:
        """Return (or create) the per-browser-session request token."""
        token = session.get('csrf')
        if not token:
            token = secrets.token_urlsafe(32)
            session['csrf'] = token
        return token

    def _session_token_valid(self) -> bool:
        supplied = request.headers.get(CSRF_HEADER, '')
        expected = session.get('csrf')
        if not supplied or not expected:
            return False
        return hmac.compare_digest(str(supplied), str(expected))


    # --- thread-safe session helpers ---

    def _sid(self) -> str:
        """Return (or create) a per-browser session id."""
        if 'sid' not in session:
            session['sid'] = uuid.uuid4().hex
        return session['sid']

    def _get_files(self) -> List[Dict[str, Any]]:
        sid = self._sid()
        stale_upload_dirs: List[str] = []
        with self._sessions_lock:
            stale_upload_dirs.extend(self._cleanup_expired_sessions())
            entry = self._sessions.setdefault(
                sid, {'files': [], 'upload_dirs': [], 'ts': time.time()}
            )
            entry['ts'] = time.time()
            files = list(entry['files'])
        self._remove_upload_dirs(stale_upload_dirs)
        return files

    def _set_files(self, files: List[Dict[str, Any]],
                   upload_dirs: Optional[List[str]] = None) -> None:
        sid = self._sid()
        stale_upload_dirs: List[str] = []
        with self._sessions_lock:
            previous = self._sessions.get(
                sid, {'files': [], 'upload_dirs': [], 'ts': 0}
            )
            if upload_dirs is None:
                retained_upload_dirs = list(previous.get('upload_dirs', []))
            else:
                retained_upload_dirs = list(upload_dirs)
                now = time.time()
                for path in previous.get('upload_dirs', []):
                    if path not in retained_upload_dirs:
                        self._retired_upload_dirs[path] = now
            self._sessions[sid] = {
                'files': list(files),
                'upload_dirs': retained_upload_dirs,
                'ts': time.time(),
            }
            stale_upload_dirs.extend(self._cleanup_expired_sessions())
        self._remove_upload_dirs(stale_upload_dirs)

    def _cleanup_expired_sessions(self) -> List[str]:
        """Remove expired session entries and return their upload directories."""
        now = time.time()
        expired = [k for k, v in self._sessions.items()
                   if now - v.get('ts', 0) > self._session_ttl]
        upload_dirs: List[str] = []
        for k in expired:
            entry = self._sessions[k]
            for path in entry.get('upload_dirs', []):
                self._retired_upload_dirs[path] = min(
                    self._retired_upload_dirs.get(path, now),
                    entry.get('ts', now),
                )
            del self._sessions[k]
        retired = [
            path
            for path, retired_at in self._retired_upload_dirs.items()
            if now - retired_at > self._session_ttl
        ]
        for path in retired:
            del self._retired_upload_dirs[path]
        upload_dirs.extend(retired)
        return upload_dirs

    def _remove_upload_dirs(self, paths: List[str]) -> None:
        upload_root = os.path.realpath(self._upload_root)
        for path in set(paths):
            resolved = os.path.realpath(path)
            inside_root = _is_within_root(resolved, upload_root)
            if (
                inside_root
                and os.path.normcase(resolved) != os.path.normcase(upload_root)
            ):
                shutil.rmtree(resolved, ignore_errors=True)

    def _session_upload_dirs(self) -> List[str]:
        """Return the upload directories currently owned by this session."""
        sid = self._sid()
        with self._sessions_lock:
            entry = self._sessions.get(sid) or {}
            return list(entry.get('upload_dirs', []))

    def _new_upload_dir(self) -> str:
        session_root = os.path.join(self._upload_root, self._sid())
        os.makedirs(session_root, exist_ok=True)
        return tempfile.mkdtemp(prefix='batch_', dir=session_root)

    @staticmethod
    def _upload_destination(upload_dir: str, filename: str):
        safe_name = secure_filename(Path(filename).name)
        if not safe_name:
            raise ValueError('Upload filename is invalid')
        unique_name = f'{uuid.uuid4().hex}_{safe_name}'
        return os.path.join(upload_dir, unique_name), safe_name

    def _analyze_uploads(self, uploaded_files) -> tuple:
        """Persist and analyze uploaded files for either upload endpoint."""
        upload_dir = self._new_upload_dir()
        analyzed: List[Dict[str, Any]] = []
        for uploaded_file in uploaded_files:
            if not uploaded_file.filename:
                continue
            destination = None
            try:
                destination, safe_name = self._upload_destination(
                    upload_dir, uploaded_file.filename
                )
                uploaded_file.save(destination)
                metadata = self.file_detector.analyze_file_metadata(
                    destination
                )
                metadata['file_name'] = safe_name
                metadata['uploaded'] = True
                analyzed.append(metadata)
            except Exception as e:
                analyzed.append({
                    'file_path': destination or uploaded_file.filename,
                    'file_name': (
                        secure_filename(uploaded_file.filename) or 'upload'
                    ),
                    'file_type': 'error',
                    'file_size': 0,
                    'error': f'Analysis failed: {type(e).__name__}: {e}',
                })
        return analyzed, upload_dir

    def _validate_file_data_path(self, file_data: Dict[str, Any],
                                 allow_dirs: bool = False) -> str:
        file_path = file_data['file_path']
        resolved = os.path.realpath(os.path.abspath(file_path))
        upload_root = os.path.realpath(self._upload_root)
        is_upload = _is_within_root(resolved, upload_root)
        allowed_root = upload_root if is_upload else self._root_dir
        return _validate_path(
            file_path,
            root_dir=allowed_root,
            allow_files=True,
            allow_dirs=allow_dirs,
        )

    def _find_file_data(self, file_path: str) -> Optional[Dict[str, Any]]:
        return next(
            (
                item for item in self._get_files()
                if _paths_equal(item.get('file_path', ''), file_path)
            ),
            None,
        )

    def _table_file_type(self, path: str) -> Optional[str]:
        """Return the supported table type for a local directory."""
        if self.file_detector.is_delta_table_directory(path):
            return 'delta'
        if self.file_detector.is_iceberg_table_directory(path):
            return 'iceberg'
        return None

    def setup_routes(self):
        """Set up Flask routes."""
        
        @self.app.route('/')
        def index():
            """Main page."""
            return render_template(
                'index.html',
                app_config={
                    'sessionToken': self._session_token(),
                    'defaultPlatform': DEFAULT_TARGET_PLATFORM,
                    'productName': __product_name__,
                    'productVersion': __version__,
                    'azureExtras': _azure_extras_available(),
                    'authModes': [
                        {'value': mode,
                         'label': azure_auth.AUTH_MODE_LABELS.get(mode, mode)}
                        for mode in azure_auth.AUTH_MODES
                    ],
                },
                session_token=self._session_token(),
                default_platform=DEFAULT_TARGET_PLATFORM,
                product_name=__product_name__,
                product_version=__version__,
            )

        @self.app.route('/api/health')
        def health():
            """Liveness probe used by the VS Code extension before opening."""
            return jsonify({
                'status': 'ok',
                'product': __product_name__,
                'version': __version__,
                'default_platform': DEFAULT_TARGET_PLATFORM,
                'platforms': list(SQLGenerator.PLATFORMS),
                'azure_extras': _azure_extras_available(),
            })

        @self.app.route('/api/session')
        def session_info():
            """Return the per-session request token for this browser."""
            return jsonify({
                'success': True,
                'session_token': self._session_token(),
                'default_platform': DEFAULT_TARGET_PLATFORM,
            })

        # ---- protected control endpoints (VS Code extension only) ----

        @self.app.route('/api/control/azure/token', methods=['POST'])
        def control_azure_token():
            """Accept a Microsoft Entra ID token brokered by VS Code.

            The token only ever travels in this request body over loopback and
            is held in memory. It is never written to a setting, a log line, a
            URL or a response.
            """
            if not self._control_authorized():
                return _error_response('Control token rejected', 403)
            data = request.get_json(silent=True) or {}
            try:
                self._vscode_tokens.set_tokens(
                    storage_token=data.get('storage_token') or '',
                    storage_expires_on=data.get('storage_expires_on'),
                    arm_token=data.get('arm_token') or None,
                    arm_expires_on=data.get('arm_expires_on'),
                    account=data.get('identity') or data.get('account') or '',
                    tenant_id=data.get('tenant_id') or '',
                )
            except azure_auth.AzureAuthError as exc:
                return jsonify({'success': False, 'error': exc.message,
                                'code': exc.code}), exc.status
            return jsonify({'success': True,
                            'status': self._vscode_tokens.status()})

        @self.app.route('/api/control/azure/signout', methods=['POST'])
        def control_azure_signout():
            """Forget every brokered token and close every connection."""
            if not self._control_authorized():
                return _error_response('Control token rejected', 403)
            self._vscode_tokens.clear()
            self._azure_connections.clear()
            return jsonify({'success': True,
                            'status': self._vscode_tokens.status()})

        @self.app.route('/api/control/status')
        def control_status():
            """Report brokered-token status without revealing any secret."""
            if not self._control_authorized():
                return _error_response('Control token rejected', 403)
            return jsonify({'success': True,
                            'status': self._vscode_tokens.status()})

        @self.app.route('/api/initial_path')
        def initial_path():
            """Return the initial browse path (cwd or configured root)."""
            path = self._root_dir or os.getcwd()
            return jsonify({'success': True, 'path': path})
            
        # ---- Azure Storage explorer ----

        def _azure_guard():
            """Reject Azure requests that lack the per-session token."""
            if not self._session_token_valid():
                return _error_response(
                    'Session token missing or invalid. Reload the page.', 403
                )
            return None

        @self.app.route('/api/azure/status')
        def azure_status():
            """Report the current Azure connection without any secret."""
            guard = _azure_guard()
            if guard is not None:
                return guard
            connection = self._azure_connections.get(self._sid())
            payload = {
                'success': True,
                'azure_extras': _azure_extras_available(),
                'vscode': self._vscode_tokens.status(),
                'modes': [
                    {'id': mode, 'label': azure_auth.AUTH_MODE_LABELS[mode]}
                    for mode in azure_auth.AUTH_MODES
                ],
            }
            payload['connection'] = (
                connection.describe() if connection
                else {'connected': False}
            )
            return jsonify(payload)

        @self.app.route('/api/azure/connect', methods=['POST'])
        def azure_connect():
            """Attach to Azure Storage using an explicitly chosen mode."""
            guard = _azure_guard()
            if guard is not None:
                return guard
            data = request.get_json(silent=True) or {}
            mode = str(data.get('mode') or '')
            try:
                connection = azure_auth.connect(
                    mode,
                    account_name=data.get('account_name') or None,
                    sas=data.get('sas') or None,
                    connection_string=data.get('connection_string') or None,
                    account_key=data.get('account_key') or None,
                    client_id=data.get('client_id') or None,
                    tenant_id=data.get('tenant_id') or None,
                    token_store=self._vscode_tokens,
                )
            except azure_auth.AzureAuthError as exc:
                return jsonify({'success': False, 'error': exc.message,
                                'code': exc.code}), exc.status
            except Exception:
                logger.exception('Error in /api/azure/connect')
                return _error_response('Server error connecting to Azure', 500)
            self._azure_connections.set(self._sid(), connection)
            logger.info('Connected to Azure Storage using mode %s.',
                        azure_auth.redact(mode))
            return jsonify({'success': True,
                            'connection': connection.describe()})

        @self.app.route('/api/azure/disconnect', methods=['POST'])
        def azure_disconnect():
            """Drop the connection and forget every secret it held."""
            guard = _azure_guard()
            if guard is not None:
                return guard
            removed = self._azure_connections.remove(self._sid())
            return jsonify({'success': True, 'was_connected': removed,
                            'connection': {'connected': False}})

        @self.app.route('/api/azure/subscriptions')
        def azure_subscriptions():
            """List subscriptions when an ARM token is available."""
            guard = _azure_guard()
            if guard is not None:
                return guard
            try:
                connection = self._azure_connections.require(self._sid())
                token = connection.arm_token()
                if not token:
                    return jsonify({
                        'success': True,
                        'subscriptions': [],
                        'available': False,
                        'reason': (
                            'Subscription enumeration is unavailable for this '
                            'sign-in. Enter a storage account name to browse '
                            'it directly.'
                        ),
                    })
                subscriptions = azure_auth.list_subscriptions(token)
            except azure_auth.AzureAuthError as exc:
                return jsonify({'success': False, 'error': exc.message,
                                'code': exc.code}), exc.status
            except Exception:
                logger.exception('Error in /api/azure/subscriptions')
                return _error_response('Server error listing subscriptions',
                                       500)
            return jsonify({'success': True, 'available': True,
                            'subscriptions': subscriptions})

        @self.app.route('/api/azure/storage-accounts')
        def azure_storage_accounts():
            """List the storage accounts in a subscription."""
            guard = _azure_guard()
            if guard is not None:
                return guard
            try:
                connection = self._azure_connections.require(self._sid())
                token = connection.arm_token()
                if not token:
                    raise azure_auth.AzureAuthError(
                        'This sign-in cannot enumerate storage accounts. '
                        'Enter the account name directly.',
                        code='arm_unavailable', status=409,
                    )
                accounts = azure_auth.list_storage_accounts(
                    token, request.args.get('subscription_id', '')
                )
            except azure_auth.AzureAuthError as exc:
                return jsonify({'success': False, 'error': exc.message,
                                'code': exc.code}), exc.status
            except Exception:
                logger.exception('Error in /api/azure/storage-accounts')
                return _error_response('Server error listing accounts', 500)
            return jsonify({'success': True, 'accounts': accounts})

        @self.app.route('/api/azure/containers')
        def azure_containers():
            """List blob containers for the selected storage account."""
            guard = _azure_guard()
            if guard is not None:
                return guard
            try:
                connection = self._azure_connections.require(self._sid())
                result = azure_auth.list_containers(
                    connection,
                    account_name=request.args.get('account') or None,
                    page_size=_page_size(request.args.get('page_size')),
                    continuation=request.args.get('continuation') or None,
                )
            except azure_auth.AzureAuthError as exc:
                return jsonify({'success': False, 'error': exc.message,
                                'code': exc.code}), exc.status
            except Exception:
                logger.exception('Error in /api/azure/containers')
                return _error_response('Server error listing containers', 500)
            return jsonify({'success': True, **result})

        @self.app.route('/api/azure/blobs')
        def azure_blobs():
            """List one page of folders and blobs under a prefix."""
            guard = _azure_guard()
            if guard is not None:
                return guard
            try:
                connection = self._azure_connections.require(self._sid())
                result = azure_auth.list_blobs(
                    connection,
                    container=request.args.get('container', ''),
                    prefix=request.args.get('prefix', ''),
                    account_name=request.args.get('account') or None,
                    page_size=_page_size(request.args.get('page_size')),
                    continuation=request.args.get('continuation') or None,
                )
            except azure_auth.AzureAuthError as exc:
                return jsonify({'success': False, 'error': exc.message,
                                'code': exc.code}), exc.status
            except Exception:
                logger.exception('Error in /api/azure/blobs')
                return _error_response('Server error listing blobs', 500)
            return jsonify({'success': True, **result})

        @self.app.route('/api/azure/analyze', methods=['POST'])
        def azure_analyze():
            """Download one blob through the active connection and analyse it."""
            guard = _azure_guard()
            if guard is not None:
                return guard
            data = request.get_json(silent=True) or {}
            container = data.get('container', '')
            blob_name = data.get('blob', '')
            account = data.get('account') or None
            upload_dir = None
            try:
                connection = self._azure_connections.require(self._sid())
                resolved_account = account or connection.account_name
                upload_dir = self._new_upload_dir()
                safe_name = secure_filename(Path(str(blob_name)).name) or 'blob'
                destination = os.path.join(
                    upload_dir, f'{uuid.uuid4().hex}_{safe_name}'
                )
                azure_auth.download_blob(
                    connection, container, str(blob_name), destination,
                    account_name=account,
                )
                metadata = self.file_detector.analyze_file_metadata(destination)
                metadata['file_name'] = safe_name
                metadata['uploaded'] = True
                storage_url = azure_auth.storage_url_for(
                    resolved_account, container, str(blob_name)
                )
                metadata['storage_url'] = storage_url
                # Displayed paths never carry a SAS query string.
                metadata['source_display'] = azure_auth.redact_url(
                    azure_auth.blob_url(resolved_account, container,
                                        str(blob_name))
                )
                self._set_files(
                    self._get_files() + [metadata],
                    upload_dirs=self._session_upload_dirs() + [upload_dir],
                )
            except azure_auth.AzureAuthError as exc:
                if upload_dir:
                    self._remove_upload_dirs([upload_dir])
                return jsonify({'success': False, 'error': exc.message,
                                'code': exc.code}), exc.status
            except Exception:
                if upload_dir:
                    self._remove_upload_dirs([upload_dir])
                logger.exception('Error in /api/azure/analyze')
                return _error_response('Server error analysing blob', 500)
            return jsonify(_clean_results({
                'success': True,
                'file': metadata,
                'storage_url': storage_url,
            }))

        @self.app.route('/api/browse')
        def browse_files():
            """Browse files in a directory."""
            path = request.args.get('path', '') or self._root_dir or os.getcwd()
            try:
                # Validate and sanitize the path to prevent path injection
                path = _validate_path(path, root_dir=self._root_dir, allow_files=False, allow_dirs=True)
                
                items = []
                
                # Add parent directory option if not at root
                parent = os.path.dirname(path)
                browse_root = os.path.realpath(
                    os.path.abspath(self._root_dir or os.getcwd())
                )
                if (
                    os.path.normcase(path) != os.path.normcase(browse_root)
                    and _is_within_root(parent, browse_root)
                ):
                    items.append({
                        'name': '..',
                        'path': parent,
                        'type': 'directory',
                        'size': 0
                    })
                
                # List directory contents
                for item in sorted(os.listdir(path)):
                    item_path = os.path.join(path, item)
                    if os.path.isdir(item_path):
                        table_type = self._table_file_type(item_path)
                        if table_type:
                            items.append({
                                'name': item,
                                'path': item_path,
                                'type': 'delta_table',
                                'file_type': table_type,
                                'size': _directory_size(item_path),
                            })
                        else:
                            items.append({
                                'name': item,
                                'path': item_path,
                                'type': 'directory',
                                'size': 0
                            })
                    else:
                        # Check if file is supported
                        file_type = self.file_detector.detect_file_type(item_path)
                        if file_type != 'unknown':
                            size = os.path.getsize(item_path) if os.path.exists(item_path) else 0
                            items.append({
                                'name': item,
                                'path': item_path,
                                'type': 'file',
                                'file_type': file_type,
                                'size': size
                            })
                
                return jsonify({
                    'success': True,
                    'current_path': path,
                    'items': items
                })
                
            except ValueError as e:
                return _error_response(f'Directory not accessible: {e}', 400)
            except PermissionError:
                return _error_response(
                    f'Permission denied: cannot read {path}', 403
                )
            except Exception:
                logger.exception('Error in /api/browse')
                return _error_response('Server error accessing directory', 500)
                
        @self.app.route('/api/analyze_files', methods=['POST'])
        def analyze_files():
            """Analyze selected files."""
            try:
                data = request.get_json()
                if not data:
                    return _error_response('Invalid request data', 400)
                    
                file_paths = data.get('files', [])
                
                if not file_paths:
                    return _error_response('No files provided', 400)
                
                # Build new file list
                analyzed: List[Dict[str, Any]] = []
                
                # Analyze each file
                for file_path in file_paths:
                    try:
                        # Validate and sanitize file path
                        # Allow dirs for Delta/Iceberg tables
                        table_type = (
                            self._table_file_type(file_path)
                            if os.path.isdir(file_path)
                            else None
                        )
                        file_path = _validate_path(file_path, root_dir=self._root_dir,
                                                    allow_files=True,
                                                   allow_dirs=table_type is not None)
                        
                        metadata = self.file_detector.analyze_file_metadata(file_path)
                        analyzed.append(metadata)
                    except ValueError as e:
                        analyzed.append({
                            'file_path': file_path,
                            'file_type': 'error',
                            'file_size': 0,
                            'error': f'Invalid path: {e}'
                        })
                    except PermissionError as e:
                        analyzed.append({
                            'file_path': file_path,
                            'file_type': 'error',
                            'file_size': 0,
                            'error': f'Permission denied: {e}'
                        })
                    except Exception as e:
                        analyzed.append({
                            'file_path': file_path,
                            'file_type': 'error',
                            'file_size': 0,
                            'error': f'Analysis failed: {type(e).__name__}: {e}'
                        })
                
                self._set_files(analyzed, upload_dirs=[])
                return jsonify(_clean_results({
                    'success': True,
                    'files': analyzed,
                    'count': len(analyzed)
                }))
                
            except Exception:
                logger.exception('Error in /api/analyze_files')
                return _error_response('Server error processing request', 500)

        @self.app.route('/api/upload', methods=['POST'])
        def upload_files():
            """Accept uploaded files, persist them for the session, and analyze them."""
            upload_dir = None
            try:
                uploaded = request.files.getlist('files')
                if not uploaded:
                    return jsonify({
                        'success': False, 'error': 'No files uploaded'
                    }), 400

                analyzed, upload_dir = self._analyze_uploads(uploaded)

                if not analyzed:
                    self._remove_upload_dirs([upload_dir])
                    return jsonify({
                        'success': False,
                        'error': 'No valid files uploaded',
                    }), 400

                self._set_files(analyzed, upload_dirs=[upload_dir])
                return jsonify(_clean_results({
                    'success': True,
                    'files': analyzed,
                    'count': len(analyzed)
                }))
            except Exception:
                if upload_dir:
                    self._remove_upload_dirs([upload_dir])
                logger.exception('Error in /api/upload')
                return jsonify({
                    'success': False,
                    'error': 'Server error processing upload',
                }), 500

        @self.app.route('/api/analyze_folder', methods=['POST'])
        def analyze_folder():
            """Analyze all supported files in a folder."""
            try:
                data = request.get_json()
                if not data:
                    return _error_response('Invalid request data', 400)
                    
                folder_path = data.get('folder')
                
                if not folder_path:
                    return _error_response('No folder provided', 400)
                
                # Validate and sanitize folder path
                folder_path = _validate_path(folder_path, root_dir=self._root_dir, allow_files=False, allow_dirs=True)
                
                # Scan directory
                scanned = self.file_detector.scan_directory(folder_path)
                self._set_files(scanned, upload_dirs=[])
                
                return jsonify({
                    'success': True,
                    'files': scanned,
                    'count': len(scanned)
                })
                
            except ValueError:
                return _error_response('Folder not accessible', 400)
            except PermissionError:
                return _error_response('Folder not accessible', 403)
            except Exception:
                logger.exception('Error in /api/analyze_folder')
                return _error_response('Server error processing request', 500)
                
        @self.app.route('/api/preview/<path:file_path>')
        def preview_file(file_path):
            """Get file preview."""
            try:
                file_path = _decode_route_path(file_path)
                
                file_data = self._find_file_data(file_path)
                        
                if not file_data:
                    return _error_response(
                        'File not found in current analysis', 404
                    )
                    
                if 'error' in file_data:
                    return _error_response(
                        'Cannot preview file with errors', 422
                    )
                
                preview_content = self._generate_preview_content(file_data)
                
                return jsonify({
                    'success': True,
                    'preview': preview_content,
                    'file_type': file_data.get('file_type', 'unknown')
                })
                
            except Exception:
                logger.exception('Error in /api/preview')
                return _error_response('Server error generating preview', 500)
                
        @self.app.route('/api/sql_ddl/<path:file_path>')
        def get_sql_ddl(file_path):
            """Get SQL DDL for a file."""
            try:
                file_path = _decode_route_path(file_path)
                data_source = request.args.get('data_source', 'MyDataSource')
                schema_name = request.args.get('schema', 'dbo')
                target_platform = _requested_target_platform(request.args)
                table_name = request.args.get('table_name', '') or None
                storage_url = request.args.get('storage_url', '') or None
                schema_overrides_raw = request.args.get('schema_overrides', '')
                schema_overrides = None
                if schema_overrides_raw:
                    try:
                        schema_overrides = json.loads(schema_overrides_raw)
                    except (json.JSONDecodeError, TypeError):
                        return _error_response(
                            'schema_overrides must be valid JSON', 400
                        )
                    if not isinstance(schema_overrides, dict):
                        return _error_response(
                            'schema_overrides must be a JSON object', 400
                        )
                
                file_data = self._find_file_data(file_path)
                        
                if not file_data:
                    return _error_response(
                        'File not found in current analysis', 404
                    )
                    
                if 'error' in file_data:
                    return _error_response(
                        'Cannot generate SQL DDL for file with errors', 422
                    )

                # Apply schema overrides if provided
                gen_metadata = dict(file_data)
                if schema_overrides and gen_metadata.get('schema'):
                    new_schema = []
                    original_nullable = set(
                        gen_metadata.get('nullable_columns') or []
                    )
                    new_nullable = []
                    for col_name, col_type in gen_metadata['schema']:
                        ov = schema_overrides.get(col_name, {})
                        if not isinstance(ov, dict):
                            return _error_response(
                                f'Override for {col_name} must be an object',
                                400,
                            )
                        # Skip excluded columns
                        if ov.get('excluded'):
                            continue
                        new_name = ov.get('colName', col_name)
                        new_type = col_type  # keep original detected type
                        new_schema.append((new_name, new_type))
                        is_nullable = ov.get(
                            'nullable', col_name in original_nullable
                        )
                        if is_nullable:
                            new_nullable.append(new_name)
                        # Store SQL type override
                        if 'sqlType' in ov:
                            gen_metadata.setdefault('sql_type_overrides', {})[new_name] = ov['sqlType']
                    gen_metadata['schema'] = new_schema
                    gen_metadata['nullable_columns'] = new_nullable
                
                # Generate all SQL statement types
                all_stmts = self.detector_app.sql_generator.generate_all_statements(
                    gen_metadata,
                    table_name=table_name,
                    data_source=data_source,
                    location=file_data.get(
                        'file_name', os.path.basename(file_data['file_path'])
                    ),
                    schema_name=schema_name,
                    target_platform=target_platform,
                    storage_url=storage_url,
                )

                return jsonify({
                    'success': True,
                    'sql_ddl': all_stmts.get('create_external_table', ''),  # legacy
                    'statements': all_stmts,
                    'resolved_table_name': SQLGenerator.resolve_table_name(
                        gen_metadata, table_name
                    ),
                    'derived_table_name': SQLGenerator.resolve_table_name(
                        gen_metadata, None
                    ),
                    'resolved_storage_url': storage_url,
                })

            except (TypeError, ValueError) as e:
                return _error_response(str(e), 400)
            except Exception:
                logger.exception('Error in /api/sql_ddl')
                return _error_response('Server error generating SQL DDL', 500)
                
        @self.app.route('/api/file_details/<path:file_path>')
        def get_file_details(file_path):
            """Get detailed file information."""
            try:
                file_path = _decode_route_path(file_path)
                
                file_data = self._find_file_data(file_path)
                        
                if not file_data:
                    return _error_response(
                        'File not found in current analysis', 404
                    )
                
                return jsonify({
                    'success': True,
                    'details': file_data
                })
                
            except Exception:
                logger.exception('Error in /api/file_details')
                return _error_response(
                    'Server error retrieving file details', 500
                )

        @self.app.route('/api/preview_table/<path:file_path>')
        def preview_table(file_path):
            """Return tabular preview data (columns + rows) for the file."""
            try:
                file_path = _decode_route_path(file_path)
                # Validate first
                file_data = self._find_file_data(file_path)
                if not file_data:
                    return jsonify({
                        'success': False,
                        'error': 'File not found in current analysis',
                    }), 404
                safe_path = self._validate_file_data_path(
                    file_data, allow_dirs=True
                )
                rows = max(
                    1, min(int(request.args.get('rows', 100)), 10000)
                )
                data = self.file_detector.get_preview_data(safe_path, max_rows=rows)
                return jsonify(_clean_results({'success': True, **data}))
            except ValueError as e:
                return _error_response(str(e), 400)
            except PermissionError as e:
                return _error_response(str(e), 403)
            except Exception:
                logger.exception('Error in /api/preview_table')
                return _error_response('Server error generating preview', 500)

        @self.app.route('/api/analyze_file', methods=['POST'])
        def analyze_single_file():
            """Analyse a single file by path and return full metadata + all SQL."""
            try:
                data = request.get_json()
                if not data:
                    return _error_response('Invalid request', 400)
                file_path = data.get('file_path', '')
                data_source = data.get('data_source', 'MyDataSource')
                table_type = (
                    self._table_file_type(file_path)
                    if os.path.isdir(file_path)
                    else None
                )
                safe_path = _validate_path(
                    file_path,
                    root_dir=self._root_dir,
                    allow_files=True,
                    allow_dirs=table_type is not None,
                )
                metadata = self.file_detector.analyze_file_metadata(safe_path)
                statements = self.detector_app.sql_generator.generate_all_statements(
                    metadata,
                    data_source=data_source,
                    target_platform=_requested_target_platform(data),
                )
                # Store in session
                current = self._get_files()
                existing = next((i for i, f in enumerate(current)
                                 if f['file_path'] == safe_path), None)
                if existing is not None:
                    current[existing] = metadata
                else:
                    current.append(metadata)
                self._set_files(current)
                return jsonify({'success': True, 'metadata': metadata, 'statements': statements})
            except ValueError as e:
                return _error_response(str(e), 400)
            except PermissionError as e:
                return _error_response(str(e), 403)
            except Exception:
                logger.exception('Error in /api/analyze_file')
                return _error_response('Server error analyzing file', 500)

        # ---- Routes consolidated from web_ui.py ----

        @self.app.route('/api/supported-types', methods=['GET'])
        def supported_types():
            """Return supported file types."""
            return jsonify({'types': self.detector_app.get_supported_file_types()})

        @self.app.route('/api/analyze-upload', methods=['POST'])
        def analyze_upload():
            """Analyze uploaded files (web_ui-compatible endpoint)."""
            if 'files' not in request.files:
                return jsonify({'error': 'No files uploaded'}), 400

            upload_dir = None
            try:
                analyzed, upload_dir = self._analyze_uploads(
                    request.files.getlist('files')
                )
                if not analyzed:
                    self._remove_upload_dirs([upload_dir])
                    return _error_response('No valid files uploaded', 400)

                self._set_files(analyzed, upload_dirs=[upload_dir])
                data_source = request.form.get('data_source', '')
                target_platform = _requested_target_platform(request.form)
                results = []
                for metadata in analyzed:
                    file_name = metadata.get('file_name', 'upload')
                    if 'error' in metadata:
                        results.append({
                            'file_name': file_name,
                            'error': metadata['error'],
                            'success': False,
                        })
                        continue
                    try:
                        table_name = self.detector_app._generate_table_name(
                            file_name
                        )
                        ddl = self.sql_generator.generate_complete_ddl(
                            metadata,
                            table_name,
                            data_source or None,
                            location=None,
                            target_platform=target_platform,
                        )
                        results.append({
                            'file_name': file_name,
                            'metadata': _clean_results(metadata),
                            'sql_ddl': ddl,
                            'table_name': table_name,
                            'success': True,
                        })
                    except Exception as e:
                        results.append({
                            'file_name': file_name,
                            'error': _safe_error(e),
                            'success': False,
                        })
                return jsonify({
                    'results': results,
                    'total': len(results),
                })
            except Exception:
                if upload_dir:
                    self._remove_upload_dirs([upload_dir])
                logger.exception('Error in /api/analyze-upload')
                return _error_response('Server error processing upload', 500)

        @self.app.route('/api/public_dataset/resolve', methods=['POST'])
        def public_dataset_resolve():
            """Classify a public HTTPS URL without downloading any data."""
            data = request.get_json(silent=True) or {}
            url = (data.get('url') or '').strip()
            try:
                resolved = public_data.resolve_public_url(url)
            except public_data.PublicDataError as exc:
                return jsonify({
                    'success': False,
                    'error': exc.message,
                    'code': exc.code,
                }), exc.status
            except Exception:
                logger.exception('Error in /api/public_dataset/resolve')
                return _error_response('Server error resolving URL', 500)
            resolved['success'] = True
            return jsonify(resolved)

        @self.app.route('/api/public_dataset/candidate', methods=['POST'])
        def public_dataset_candidate():
            """Resolve a folder/wildcard candidate to a representative file."""
            data = request.get_json(silent=True) or {}
            url = (data.get('url') or '').strip()
            try:
                blob = public_data.first_supported_blob(url)
            except public_data.PublicDataError as exc:
                return jsonify({
                    'success': False,
                    'error': exc.message,
                    'code': exc.code,
                    'storage_url': public_data.storage_url_for(url),
                }), exc.status
            except Exception:
                logger.exception('Error in /api/public_dataset/candidate')
                return _error_response('Server error listing container', 500)
            if not blob:
                return jsonify({
                    'success': False,
                    'error': (
                        'No publicly listed supported data file was found '
                        'under that location.'
                    ),
                    'code': 'no_data_candidate',
                    'storage_url': public_data.storage_url_for(url),
                }), 422
            return jsonify({
                'success': True,
                'representative': blob,
                'storage_url': public_data.storage_url_for(url),
            })

        @self.app.route('/api/public_dataset/fetch', methods=['POST'])
        def public_dataset_fetch():
            """Download, analyze and register one public data file."""
            data = request.get_json(silent=True) or {}
            url = (data.get('url') or '').strip()
            # The URL kept for SQL generation may differ from the URL we
            # download: Open Datasets documents abs:// locations that SQL can
            # read directly while we fetch one representative file over HTTPS.
            documented = (data.get('storage_url') or '').strip() or None

            upload_dir = None
            try:
                upload_dir = self._new_upload_dir()
                downloaded = public_data.download_data_file(url, upload_dir)
                metadata = self.file_detector.analyze_file_metadata(
                    downloaded['path']
                )
                metadata['file_name'] = downloaded['file_name']
                metadata['uploaded'] = True
                metadata['source_url'] = url
                storage_url = (
                    documented
                    or public_data.storage_url_for(url)
                )
                if storage_url:
                    metadata['storage_url'] = storage_url
                self._set_files(
                    self._get_files() + [metadata],
                    upload_dirs=self._session_upload_dirs() + [upload_dir],
                )
                return jsonify({
                    'success': True,
                    'file': _clean_results(metadata),
                    'bytes': downloaded['bytes'],
                    'storage_url': storage_url,
                    'staging_required': not storage_url,
                })
            except public_data.PublicDataError as exc:
                if upload_dir:
                    self._remove_upload_dirs([upload_dir])
                return jsonify({
                    'success': False,
                    'error': exc.message,
                    'code': exc.code,
                }), exc.status
            except Exception:
                if upload_dir:
                    self._remove_upload_dirs([upload_dir])
                logger.exception('Error in /api/public_dataset/fetch')
                return _error_response('Server error downloading file', 500)

        @self.app.route('/api/analyze-path', methods=['POST'])
        def analyze_path():
            """Analyze files at a local or remote path."""
            data = request.get_json()
            if not data or 'path' not in data:
                return jsonify({'error': 'No path specified'}), 400

            location = data['path']
            if not isinstance(location, str) or not location.strip():
                return jsonify({'error': 'Path cannot be empty'}), 400
            location = location.strip()
            if len(location) > 2048:
                return jsonify({'error': 'Path too long'}), 400

            # For local paths, use full symlink-resolving validation
            is_remote = location.startswith(('s3://', 'azure://', 'https://'))
            if not is_remote:
                try:
                    location = _validate_path(location, root_dir=self._root_dir,
                                              allow_files=True, allow_dirs=True)
                except ValueError as e:
                    return jsonify({'error': _safe_error(e)}), 400

            data_source = data.get('data_source', '')
            storage_config = {}
            for src_key, dst_key in [
                ('aws_access_key_id', 'aws_access_key_id'),
                ('aws_secret_access_key', 'aws_secret_access_key'),
                ('aws_region', 'region_name'),
                ('azure_account_name', 'azure_account_name'),
                ('azure_account_key', 'azure_account_key'),
                ('azure_connection_string', 'azure_connection_string'),
                ('azure_sas_token', 'azure_sas_token'),
                ('azure_auth_mode', 'azure_auth_mode'),
            ]:
                if data.get(src_key):
                    storage_config[dst_key] = data[src_key]

            # Reuse the session's attached Azure connection when the caller did
            # not pass explicit credentials, so browsing and analysing share
            # one authenticated client.
            if is_remote and not any(
                key.startswith('azure_') for key in storage_config
            ):
                connection = self._azure_connections.get(self._sid())
                if connection is not None:
                    storage_config['azure_connection'] = connection

            try:
                app_instance = ExternalFileDetectorApp(storage_config)
                results = app_instance.analyze_location(
                    location,
                    data_source if data_source else None,
                    target_platform=_requested_target_platform(data),
                )
                clean_results = _clean_results(results)
                return jsonify(clean_results)
            except Exception as e:
                return jsonify({'error': _safe_error(e)}), 500

        @self.app.route('/api/generate-data-source', methods=['POST'])
        def generate_data_source():
            """Generate CREATE EXTERNAL DATA SOURCE DDL."""
            data = request.get_json()
            if not data:
                return jsonify({'error': 'No data provided'}), 400

            required = ['name', 'storage_type', 'location']
            missing = [f for f in required if f not in data]
            if missing:
                return jsonify({'error': f"Missing required fields: {', '.join(missing)}"}), 400

            try:
                ddl = self.detector_app.generate_data_source_ddl(
                    data['name'], data['storage_type'],
                    data['location'], data.get('credential'),
                    _requested_target_platform(data),
                )
                return jsonify({'sql_ddl': ddl})
            except Exception as e:
                return jsonify({'error': _safe_error(e)}), 500

        @self.app.route('/api/generate-ddl', methods=['POST'])
        def generate_ddl():
            """Generate DDL from manual metadata input."""
            data = request.get_json()
            if not data:
                return jsonify({'error': 'No data provided'}), 400

            columns = data.get('columns', [])
            metadata = {
                'file_type': data.get('file_type', 'csv'),
                'file_path': data.get('location', ''),
                'schema': [(col['name'], col['type']) for col in columns] if columns else None,
                'delimiter': data.get('delimiter', ','),
                'has_header': data.get('has_header', True),
                'encoding': data.get('encoding', 'utf-8'),
                'compression': data.get('compression'),
            }

            try:
                ddl = self.sql_generator.generate_complete_ddl(
                    metadata,
                    data.get('table_name', 'data_table'),
                    data.get('data_source'),
                    data.get('location') or None,
                    target_platform=_requested_target_platform(data),
                    storage_url=data.get('storage_url') or None,
                )
                return jsonify({'sql_ddl': ddl})
            except Exception as e:
                return jsonify({'error': _safe_error(e)}), 500

        @self.app.route('/api/export', methods=['POST'])
        def export_results():
            """Export results as a downloadable file."""
            data = request.get_json()
            if not data or 'content' not in data:
                return jsonify({'error': 'No content provided'}), 400

            fmt = data.get('format', 'sql')
            content = data['content']
            if fmt not in {'sql', 'json'}:
                return jsonify({'error': 'Unsupported export format'}), 400
            if not isinstance(content, str):
                return jsonify({'error': 'Export content must be text'}), 400

            payload = io.BytesIO(content.encode('utf-8'))

            return send_file(
                payload, as_attachment=True,
                download_name=f'sql_file_detection.{fmt}',
                mimetype='text/plain' if fmt == 'sql' else 'application/json',
            )

    def _generate_preview_content(self, file_data: Dict[str, Any]) -> str:
        """Generate preview content for a file (legacy text fallback)."""
        file_type = file_data.get('file_type', 'unknown')
        encoding = file_data.get('encoding') or 'utf-8'
        if encoding == 'binary':
            encoding = 'utf-8'

        try:
            allow_dirs = file_type in ('delta', 'iceberg')
            file_path = self._validate_file_data_path(
                file_data, allow_dirs=allow_dirs
            )

            if file_type in ('csv', 'text', 'json'):
                with open(file_path, 'r', encoding=encoding, errors='replace') as f:
                    content = f.read(5001)
                if len(content) > 5000:
                    return content[:5000] + '\n... (truncated)'
                return content

            if file_type in ('parquet', 'delta', 'iceberg', 'excel'):
                preview = self.file_detector.get_preview_data(
                    file_path, max_rows=10
                )
                if preview.get('error'):
                    return f"Error loading preview: {preview['error']}"
                return json.dumps(_clean_results(preview), indent=2)

            return f"Preview not available for {file_type} files"
        except (ValueError, PermissionError):
            return "File not accessible"
        except Exception:
            logger.exception('Error generating legacy preview')
            return "Error loading preview"
    
    @staticmethod
    def format_file_size(size_bytes: int) -> str:
        """Format file size in human readable format."""
        if size_bytes == 0:
            return "0 B"
        
        units = ['B', 'KB', 'MB', 'GB']
        i = 0
        while size_bytes >= 1024 and i < len(units) - 1:
            size_bytes /= 1024
            i += 1
            
        return f"{size_bytes:.1f} {units[i]}"
        
    def run(self, host='127.0.0.1', port=5000, debug=False):
        """Run the web application."""
        _validate_bind_host(host)
        # Ensure templates directory exists
        templates_dir = os.path.join(os.path.dirname(__file__), 'templates')
        os.makedirs(templates_dir, exist_ok=True)
        
        index_path = os.path.join(templates_dir, 'index.html')
        if not os.path.exists(index_path):
            raise FileNotFoundError(
                f"Template not found at {index_path}. "
                "Please ensure templates/index.html is present in the package."
            )
        
        debug = _safe_debug(host, debug)
        print(f"Starting {__product_name__}...")
        print(f"Default SQL target platform: "
              f"{SQLGenerator.PLATFORM_LABELS[DEFAULT_TARGET_PLATFORM]}")
        print(f"Open your browser and go to: http://{host}:{port}")

        try:
            self.app.run(host=host, port=port, debug=debug)
        finally:
            # Never leave live credentials behind when the server stops.
            self._azure_connections.clear()
            self._vscode_tokens.clear()


#: Product-named alias. ``ExternalFileDetectionWebGUI`` is kept because it is
#: part of the published API of earlier releases.
SQLFileDetectionWebGUI = ExternalFileDetectionWebGUI


def main():
    """Run the web GUI application."""
    if not FLASK_AVAILABLE:
        print("Error: Flask is required for the web GUI.")
        print("Install with: pip install flask")
        return
        
    import argparse
    parser = argparse.ArgumentParser(
        description=f'{__product_name__} web interface')
    parser.add_argument('--root-dir', default=None,
                        help='Restrict file browsing to this directory tree')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=5000)
    parser.add_argument('--debug', action='store_true')
    args = parser.parse_args()
    
    app = ExternalFileDetectionWebGUI(root_dir=args.root_dir)
    app.run(host=args.host, port=args.port, debug=args.debug)


if __name__ == '__main__':
    main()
