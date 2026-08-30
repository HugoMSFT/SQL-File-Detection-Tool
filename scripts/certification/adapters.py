"""Optional database adapters.

The harness has no hard database dependency. ``pymssql`` and ``pyodbc`` are
imported lazily and only by :mod:`execute`, so planning, safety checking and
reporting all work on a machine with no driver installed — which is exactly the
machine that should be building the plan.

Credential handling is the point of this module:

* endpoint, database and login name arrive as ordinary parameters (environment
  variables or CLI flags);
* the password arrives **only** through an environment variable, standard input
  or an OS secret lookup, and is removed from ``os.environ`` the moment it is
  read, so a child process or a crash dump cannot pick it up;
* the password is never stored on the connection object, never logged, and
  never written to an artifact.
"""

from __future__ import annotations

import getpass
import os
import sys
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

#: Environment variable *names* the harness reads. Values never appear in code,
#: documentation, artifacts or commit history.
ENV_HOST = 'SQLFDT_CERT_HOST'
ENV_PORT = 'SQLFDT_CERT_PORT'
ENV_DATABASE = 'SQLFDT_CERT_DATABASE'
ENV_USER = 'SQLFDT_CERT_USER'
ENV_PASSWORD = 'SQLFDT_CERT_PASSWORD'


class AdapterUnavailable(RuntimeError):
    """No usable driver is installed."""


@dataclass
class ConnectionSettings:
    """Everything needed to connect, minus the password."""

    host: str
    database: str
    user: str
    port: int = 1433
    encrypt: bool = True
    trust_server_certificate: bool = False
    login_timeout: int = 30

    @classmethod
    def from_env(cls, **overrides: Any) -> 'ConnectionSettings':
        settings = cls(
            host=overrides.get('host') or os.environ.get(ENV_HOST, ''),
            database=overrides.get('database') or os.environ.get(ENV_DATABASE, ''),
            user=overrides.get('user') or os.environ.get(ENV_USER, ''),
            port=int(overrides.get('port') or os.environ.get(ENV_PORT, '1433')),
        )
        missing = [
            name
            for name, value in (
                (ENV_HOST, settings.host),
                (ENV_DATABASE, settings.database),
                (ENV_USER, settings.user),
            )
            if not value
        ]
        if missing:
            raise AdapterUnavailable(
                'missing connection settings; set ' + ', '.join(missing)
            )
        return settings

    def redaction_literals(self) -> Tuple[str, ...]:
        """Values a :class:`~.redaction.Redactor` must scrub from artifacts."""
        return tuple(v for v in (self.host, self.user, self.database) if v)


def take_password(*, prompt: bool = True) -> str:
    """Read the password once and remove it from the process environment.

    Order of preference: ``SQLFDT_CERT_PASSWORD`` (popped, not read), then
    standard input if it is a pipe, then an interactive prompt. There is no
    fourth option and no file-based option on purpose.
    """
    password = os.environ.pop(ENV_PASSWORD, None)
    if password:
        return password
    if not sys.stdin.isatty():
        piped = sys.stdin.readline().rstrip('\r\n')
        if piped:
            return piped
    if prompt:
        return getpass.getpass('certification login password: ')
    raise AdapterUnavailable(
        f'no password supplied; set {ENV_PASSWORD} or pipe it on standard input'
    )


@dataclass
class QueryResult:
    columns: List[str]
    rows: List[Tuple[Any, ...]]

    @property
    def row_count(self) -> int:
        return len(self.rows)

    @property
    def column_count(self) -> int:
        return len(self.columns)


class Connection:
    """Thin wrapper over whichever driver is available."""

    def __init__(self, raw: Any, driver: str) -> None:
        self._raw = raw
        self.driver = driver

    def execute(self, sql: str, params: Optional[Sequence[Any]] = None) -> QueryResult:
        cursor = self._raw.cursor()
        try:
            if params:
                cursor.execute(sql, tuple(params))
            else:
                cursor.execute(sql)
            columns: List[str] = []
            rows: List[Tuple[Any, ...]] = []
            if cursor.description:
                columns = [str(d[0]) for d in cursor.description]
                rows = [tuple(r) for r in cursor.fetchall()]
            return QueryResult(columns=columns, rows=rows)
        finally:
            cursor.close()

    def commit(self) -> None:
        try:
            self._raw.commit()
        except Exception:  # pragma: no cover - driver specific
            pass

    def close(self) -> None:
        try:
            self._raw.close()
        except Exception:  # pragma: no cover - driver specific
            pass

    def __enter__(self) -> 'Connection':
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()


def available_drivers() -> List[str]:
    found: List[str] = []
    for name in ('pymssql', 'pyodbc'):
        try:
            __import__(name)
        except ImportError:
            continue
        found.append(name)
    return found


def connect(settings: ConnectionSettings, password: str, *, driver: Optional[str] = None) -> Connection:
    """Open an encrypted connection using the first available driver."""
    candidates = [driver] if driver else available_drivers()
    if not candidates:
        raise AdapterUnavailable(
            'install pymssql or pyodbc in the runner environment; the harness '
            'itself has no database dependency'
        )
    errors: List[str] = []
    for name in candidates:
        try:
            if name == 'pymssql':
                import pymssql  # noqa: WPS433

                raw = pymssql.connect(
                    server=settings.host,
                    port=str(settings.port),
                    user=settings.user,
                    password=password,
                    database=settings.database,
                    login_timeout=settings.login_timeout,
                    autocommit=True,
                )
                return Connection(raw, 'pymssql')
            if name == 'pyodbc':
                import pyodbc  # noqa: WPS433

                odbc_driver = _first_odbc_driver(pyodbc)
                conn_str = (
                    f'DRIVER={{{odbc_driver}}};'
                    f'SERVER={settings.host},{settings.port};'
                    f'DATABASE={settings.database};'
                    f'UID={settings.user};'
                    f'PWD={password};'
                    f'Encrypt={"yes" if settings.encrypt else "no"};'
                    f'TrustServerCertificate='
                    f'{"yes" if settings.trust_server_certificate else "no"};'
                    f'Connection Timeout={settings.login_timeout};'
                )
                raw = pyodbc.connect(conn_str, autocommit=True)
                return Connection(raw, 'pyodbc')
        except Exception as exc:  # pragma: no cover - environment specific
            # The message can echo the connection string, so never let it out.
            errors.append(f'{name}: {type(exc).__name__}')
    raise AdapterUnavailable('could not connect using ' + ', '.join(errors))


def _first_odbc_driver(pyodbc_module: Any) -> str:  # pragma: no cover - env specific
    preferred = [
        'ODBC Driver 18 for SQL Server',
        'ODBC Driver 17 for SQL Server',
        'SQL Server Native Client 11.0',
    ]
    installed = set(pyodbc_module.drivers())
    for name in preferred:
        if name in installed:
            return name
    raise AdapterUnavailable('no Microsoft ODBC driver for SQL Server is installed')


# ---------------------------------------------------------------------------
# Inventory queries
# ---------------------------------------------------------------------------

#: Read-only probes captured before any DDL, so the report can state what the
#: engine actually was rather than what the plan assumed.
ENGINE_PROBES: Dict[str, str] = {
    'version': 'SELECT @@VERSION;',
    'edition': "SELECT SERVERPROPERTY('Edition');",
    'engine_edition': "SELECT SERVERPROPERTY('EngineEdition');",
    'product_version': "SELECT SERVERPROPERTY('ProductVersion');",
    'product_major': "SELECT SERVERPROPERTY('ProductMajorVersion');",
    'collation': 'SELECT DATABASEPROPERTYEX(DB_NAME(), \'Collation\');',
    'compatibility_level': 'SELECT compatibility_level FROM sys.databases WHERE database_id = DB_ID();',
    'updateability': "SELECT DATABASEPROPERTYEX(DB_NAME(), 'Updateability');",
    'polybase': "SELECT SERVERPROPERTY('IsPolyBaseInstalled');",
    'master_key_count': 'SELECT COUNT(*) FROM sys.symmetric_keys WHERE name = \'##MS_DatabaseMasterKey##\';',
}

#: Inventories keyed by the object kinds :func:`~.manifest.explicit_cleanup_statements`
#: understands. ``{schema}`` is filled with the run schema, which
#: :class:`~.runid.RunIdentity` has already constrained to
#: ``sqlfdt_cert_[0-9a-f]{8}`` — there is no free text to inject.
INVENTORY_QUERIES: Dict[str, str] = {
    'external table': (
        'SELECT t.name FROM sys.external_tables AS t '
        "JOIN sys.schemas AS s ON s.schema_id = t.schema_id WHERE s.name = '{schema}'"
    ),
    'table': (
        'SELECT t.name FROM sys.tables AS t '
        "JOIN sys.schemas AS s ON s.schema_id = t.schema_id WHERE s.name = '{schema}'"
    ),
    'view': (
        'SELECT v.name FROM sys.views AS v '
        "JOIN sys.schemas AS s ON s.schema_id = v.schema_id WHERE s.name = '{schema}'"
    ),
    'external file format': 'SELECT name FROM sys.external_file_formats',
    'external data source': 'SELECT name FROM sys.external_data_sources',
    'database scoped credential': 'SELECT name FROM sys.database_scoped_credentials',
    'schema': 'SELECT name FROM sys.schemas',
}
