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
import inspect
import os
import re
import socket
import sys
import time
from dataclasses import dataclass, replace
from typing import Any, Dict, FrozenSet, List, Optional, Sequence, Tuple

from .redaction import normalize_value

#: Reported to the engine so a certification session is identifiable in
#: ``sys.dm_exec_sessions``. Names the tool, nothing about the environment.
APPLICATION_NAME = 'sqlfdt-certification'

#: Environment variable *names* the harness reads. Values never appear in code,
#: documentation, artifacts or commit history.
ENV_HOST = 'SQLFDT_CERT_HOST'
ENV_PORT = 'SQLFDT_CERT_PORT'
ENV_DATABASE = 'SQLFDT_CERT_DATABASE'
ENV_USER = 'SQLFDT_CERT_USER'
ENV_PASSWORD = 'SQLFDT_CERT_PASSWORD'


class AdapterUnavailable(RuntimeError):
    """No usable driver is installed, or none of them could connect.

    ``error_numbers`` carries the SQL error numbers the drivers reported. The
    driver's own message is deliberately dropped - it routinely echoes the whole
    connection string, login included - but the *number* is both safe and the
    only reliable way to tell a login failure from a network blip.

    ``permanent`` marks a condition that waiting cannot fix - no driver
    installed, a driver that cannot honour the required encryption, a disposed
    factory - so the retry loop stops immediately instead of sleeping through
    three pointless attempts.

    ``transient`` is the opposite assertion, and it exists because aggregating
    several candidate drivers loses information. A run once tried pymssql, got a
    transport timeout, tried pyodbc, found no ODBC driver installed, and
    reported the pair as permanent - so the retry that would have succeeded on
    the second attempt never happened. When one candidate failed in a way worth
    retrying, the aggregate says so explicitly rather than leaving
    :func:`is_transient_connect_error` to re-derive it from a message that no
    longer contains the driver's text.
    """

    def __init__(
        self,
        message: str,
        error_numbers: Sequence[int] = (),
        *,
        permanent: bool = False,
        transient: bool = False,
    ) -> None:
        super().__init__(message)
        self.error_numbers: Tuple[int, ...] = tuple(error_numbers)
        self.permanent = permanent
        self.transient = transient


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
                'missing connection settings; set ' + ', '.join(missing),
                permanent=True,
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
        f'no password supplied; set {ENV_PASSWORD} or pipe it on standard input',
        permanent=True,
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

    def execute(
        self,
        sql: str,
        params: Optional[Sequence[Any]] = None,
        *,
        textual: bool = False,
    ) -> QueryResult:
        """Run one statement and return values that an artifact can hold.

        Every cell is normalised on the way out. Drivers return ``bytes``,
        ``Decimal`` and ``datetime`` objects that no serialiser here accepts,
        and a run that discovered that at report-writing time lost the evidence
        it had just spent a live connection gathering. ``textual=True`` says the
        statement returns engine text, so byte strings are decoded rather than
        rendered as a binary literal.
        """
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
                rows = [
                    tuple(normalize_value(value, textual=textual) for value in row)
                    for row in cursor.fetchall()
                ]
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


def _connect_parameters(module: Any) -> Optional[frozenset]:
    """Names ``module.connect`` accepts, or ``None`` if that cannot be decided.

    ``pymssql.connect`` is a Cython function; on some builds it carries a usable
    signature and on others it does not. ``None`` means "unknown", so the caller
    decides rather than assuming a parameter is missing. A signature that ends
    in ``**kwargs`` accepts any name at all, which is also "unknown".
    """
    try:
        parameters = inspect.signature(module.connect).parameters
    except (TypeError, ValueError):  # pragma: no cover - build specific
        return None
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters.values()):
        return None
    return frozenset(parameters)


def _pymssql_kwargs(module: Any, settings: 'ConnectionSettings') -> Dict[str, Any]:
    """Build ``pymssql.connect`` arguments, honouring the encryption setting.

    This is the whole reason the function exists. ``pymssql.connect`` has no
    ``encrypt`` or ``trust_server_certificate`` parameter, so passing the
    dataclass through unchanged silently ignored both and opened a connection
    on whatever FreeTDS negotiated by default. The encryption parameter arrived
    in pymssql 2.3; if the installed build predates it and encryption was asked
    for, that is a hard failure rather than a quiet downgrade.

    ``charset`` matters for fidelity, not comfort: the matrix asserts Japanese
    and emoji round-trips, and the default single-byte charset mangles them.
    ``appname`` makes the harness identifiable in ``sys.dm_exec_sessions`` while
    naming nothing sensitive.
    """
    kwargs: Dict[str, Any] = {
        'server': settings.host,
        'port': str(settings.port),
        'user': settings.user,
        'database': settings.database,
        'login_timeout': settings.login_timeout,
        'autocommit': True,
        'charset': 'UTF-8',
        'appname': APPLICATION_NAME,
    }
    supported = _connect_parameters(module)
    if supported is not None and 'encryption' not in supported:
        if settings.encrypt:
            raise AdapterUnavailable(
                'the installed pymssql has no encryption parameter; install '
                'pymssql 2.3 or newer, or pyodbc, rather than connecting '
                'unencrypted',
                permanent=True,
            )
        return kwargs
    kwargs['encryption'] = 'require' if settings.encrypt else 'off'
    return kwargs


#: SQL error numbers that mean "the credentials or the database name are wrong".
#: Retrying any of these is pointless and, for a login failure, actively harmful:
#: a few automatic retries are how an account gets locked out. They are matched
#: by number rather than by message so a localised server cannot defeat the check.
AUTH_ERROR_NUMBERS: FrozenSet[int] = frozenset({
    18456,  # login failed for user
    18452,  # login from an untrusted domain
    40615,  # Azure SQL: client IP not allowed by the firewall
    40532,  # Azure SQL: login must be in the form user@server
    4060,   # cannot open the requested database
    916,    # principal cannot access the database
    18470,  # login disabled
})

#: SQL error numbers that mean "this endpoint is momentarily busy, ask again".
#:
#: 40613 is the one that cost a live Azure run. The gateway answers "Database
#: '<db>' on server '<srv>' is not currently available. Please retry the
#: connection later" while it moves a replica; the same connection succeeds
#: seconds later, and a manual attempt proved exactly that - attempt 1 failed
#: with 40613, attempt 2 passed after five seconds. The harness had classified
#: it permanent and never asked again.
TRANSIENT_ERROR_NUMBERS: FrozenSet[int] = frozenset({
    40613,  # database is not currently available - gateway failover
    40197,  # the service encountered an error processing your request
    40501,  # the service is currently busy
    40540,  # the service encountered an error - retry
    40549,  # session terminated: long-running transaction
    40550,  # session terminated: too many locks
    40551,  # session terminated: excessive TEMPDB usage
    40552,  # session terminated: excessive transaction log usage
    40553,  # session terminated: excessive memory usage
    49918,  # cannot process request: not enough resources
    49919,  # cannot process create or update request: too many operations
    49920,  # cannot process request: too many operations
    10928,  # resource ID limit reached
    10929,  # minimum guarantee not met, server busy
    10053,  # transport-level error: connection aborted
    10054,  # transport-level error: connection reset by peer
    10060,  # network-related error: connection timed out
    233,    # no process on the other end of the pipe
    64,     # connection was successfully established but then failed
    20,     # the instance does not support encryption / handshake blip
    4221,   # login to read-secondary failed: replica not available
    615,    # could not find database ID - momentary during failover
    913,    # could not find database ID
    921,    # database has not been recovered yet
})

#: How many times a *transient* connect failure is retried, and how long to wait.
#: Bounded on purpose: an unbounded retry turns a dead endpoint into a hang, and
#: the whole point of this harness is that a run either produces evidence or says
#: plainly why it could not.
CONNECT_ATTEMPTS = 4
CONNECT_BACKOFF_S = (1.0, 3.0, 7.0)


#: A native SQL error number as pyodbc reports it. pyodbc raises
#: ``Error(sqlstate, message)`` with both args as strings and the native number
#: parenthesised inside the message - `[42000] [Microsoft][ODBC ...](18456)
#: Login failed for user 'x'.` - so the number has to be read out of the text.
#: pymssql, by contrast, puts it first in ``args`` as an int.
_NATIVE_NUMBER_RE = re.compile(r'\((\d{3,5})\)')


def _numbers_from_text(text: str) -> List[int]:
    """Every native error number parenthesised in a driver message."""
    return [int(m) for m in _NATIVE_NUMBER_RE.findall(text or '')]


def flatten_exception_args(exc: BaseException, _depth: int = 0) -> List[Any]:
    """Every leaf argument of an exception, however the driver nested them.

    pymssql does not always raise ``OperationalError(number, message)``. A live
    Azure SQL failover produced::

        OperationalError.args == ((40613, b'Database ... Please retry ...'),)

    - a single argument that is itself the ``(number, bytes)`` pair. Scanning
    ``args`` one level deep found no int and no text, so the number was never
    read, the failure was classified permanent, and the retry that would have
    succeeded never happened. Flattening first makes the nested and the flat
    shapes indistinguishable to every caller.

    The recursion is depth-bounded because an exception argument can, in
    principle, contain itself.
    """
    leaves: List[Any] = []
    if _depth > 4:
        return leaves
    for value in getattr(exc, 'args', ()) or ():
        leaves.extend(_flatten_value(value, _depth + 1))
    return leaves


def _flatten_value(value: Any, depth: int) -> List[Any]:
    if depth > 4:
        return []
    if isinstance(value, (bytes, bytearray, memoryview, str)):
        return [value]
    if isinstance(value, (tuple, list)):
        leaves: List[Any] = []
        for item in value:
            leaves.extend(_flatten_value(item, depth + 1))
        return leaves
    return [value]


def _numbers_from_exception(exc: BaseException) -> List[int]:
    """Every error number an exception carries, nested arguments included."""
    numbers = [int(n) for n in (getattr(exc, 'error_numbers', ()) or ())]
    if numbers:
        return numbers
    for value in flatten_exception_args(exc):
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            numbers.append(value)
            continue
        text = (
            bytes(value).decode('utf-8', 'replace')
            if isinstance(value, (bytes, bytearray, memoryview)) else value
        )
        if isinstance(text, str):
            numbers.extend(_numbers_from_text(text))
    return numbers


def _error_number(exc: BaseException) -> Optional[int]:
    """The SQL error number a driver reported, if it reported one.

    pymssql puts it first in ``args``; pyodbc embeds it in the message text.
    :class:`AdapterUnavailable` carries the numbers it collected from the
    drivers it tried, because its own message is deliberately free of driver
    text.
    """
    carried = getattr(exc, 'error_numbers', ()) or ()
    if carried:
        return int(carried[0])
    numbers = _numbers_from_exception(exc)
    return numbers[0] if numbers else None


def is_transient_connect_error(exc: BaseException) -> bool:
    """True when retrying the connection could plausibly help.

    Anything that names an authentication, firewall or database-selection
    problem is permanent by definition, so it returns False and the caller
    fails immediately - a few automatic retries are how an account gets locked
    out. A TCP timeout, a reset, a DNS blip or an Azure SQL gateway
    mid-failover is transient.

    It fails *closed*: a failure whose number could not be read at all is
    treated as permanent. Guessing wrong in the other direction spends four
    login attempts on what may be a bad password.

    A failure that reported *several* numbers is permanent if any of them is an
    auth error: retrying cannot fix the one that will not budge.
    """
    if isinstance(exc, AdapterUnavailable) and getattr(exc, 'permanent', False):
        return False
    if isinstance(exc, AdapterUnavailable) and getattr(exc, 'transient', False):
        # An aggregate that already classified its candidates. Re-deriving the
        # answer from its message would fail closed, because the message
        # deliberately carries no driver text to derive it from.
        return not any(
            int(n) in AUTH_ERROR_NUMBERS
            for n in (getattr(exc, 'error_numbers', ()) or ())
        )
    numbers = [int(n) for n in (getattr(exc, 'error_numbers', ()) or ())]
    if not numbers:
        numbers = _numbers_from_exception(exc)
    if any(n in AUTH_ERROR_NUMBERS for n in numbers):
        return False
    if any(n in TRANSIENT_ERROR_NUMBERS for n in numbers):
        # Named explicitly rather than left to the permissive default below, so
        # a gateway failover stays retryable even if the surrounding logic is
        # ever tightened.
        return True
    if not numbers:
        # Unclassifiable. Fail closed rather than retry what may be a login.
        return _looks_like_transport_failure(exc)
    return True


#: Phrases that identify a failure as transport-level even when no driver
#: number came with it. Matching is on the exception text, so it is a
#: best-effort widening of the fail-closed default rather than the primary
#: signal.
_TRANSPORT_PHRASES = (
    'timed out', 'timeout', 'connection reset', 'reset by peer',
    'connection refused', 'temporarily unavailable', 'name or service not known',
    'getaddrinfo', 'network is unreachable', 'broken pipe', 'eof',
    'server is not found or not accessible', 'unable to connect',
)


def _looks_like_transport_failure(exc: BaseException) -> bool:
    if isinstance(exc, (TimeoutError, ConnectionError, socket.timeout, socket.error)):
        return True
    text = str(exc).lower()
    if 'login failed' in text or 'password' in text:
        return False
    return any(phrase in text for phrase in _TRANSPORT_PHRASES)


def connect_with_retry(
    settings: ConnectionSettings,
    password: str,
    *,
    driver: Optional[str] = None,
    attempts: int = CONNECT_ATTEMPTS,
    backoff: Sequence[float] = CONNECT_BACKOFF_S,
    sleep: Any = None,
) -> Tuple[Connection, List[str]]:
    """Connect, retrying only transient failures, and report sanitised attempts.

    Azure SQL Database front-ends fail over, and a connection that succeeded by
    hand a minute earlier can time out on the next try. Losing a whole
    certification run to that is not evidence of anything. The returned list
    carries one line per attempt naming the exception type and the SQL error
    number only - never the host, the login, the password or the driver's
    message, which routinely echoes the connection string back.

    The chained cause is dropped deliberately (``from None``). Attaching the
    driver exception puts its message back in the traceback, and an uncaught
    ``AdapterUnavailable`` then prints to stderr everything this function just
    took care to leave out. The per-attempt log above already carries the only
    facts the harness needs.
    """
    sleeper = sleep if sleep is not None else time.sleep
    attempt_log: List[str] = []
    for attempt in range(1, max(1, attempts) + 1):
        try:
            connection = connect(settings, password, driver=driver)
            if attempt > 1:
                attempt_log.append(f'attempt {attempt}: connected')
            return connection, attempt_log
        except Exception as exc:
            number = _error_number(exc)
            transient = is_transient_connect_error(exc)
            attempt_log.append(
                f'attempt {attempt}: {type(exc).__name__}'
                + (f' number={number}' if number is not None else '')
                + ('' if transient else ' (permanent, not retried)')
            )
            if not transient or attempt >= max(1, attempts):
                break
            delay = backoff[min(attempt - 1, len(backoff) - 1)] if backoff else 0
            sleeper(delay)
    raise AdapterUnavailable(
        'could not connect after ' + str(len(attempt_log)) + ' attempt(s): '
        + '; '.join(attempt_log)
    ) from None  # noqa: B904 - deliberate, see the docstring


class SessionFactory:
    """Opens connections to one server, holding the password for reconnects.

    A SQL Server run needs more than one connection: the disposable run database
    is created from ``master``, every scoped statement must then run *inside*
    that database, and the drop has to happen from ``master`` again because a
    database cannot drop itself. That means the password outlives the first
    connect, which is exactly the thing the rest of this module works to avoid,
    so it is held here and nowhere else:

    * it lives in one private attribute of one object with a known lifetime;
    * :meth:`dispose` overwrites and drops it, and is called from a ``finally``;
    * it is never an attribute of a :class:`Connection`, never a default
      argument, never part of ``repr`` and never written to an artifact.
    """

    __slots__ = ('_settings', '_password', '_driver', 'attempts_log')

    def __init__(
        self,
        settings: ConnectionSettings,
        password: str,
        *,
        driver: Optional[str] = None,
    ) -> None:
        self._settings = settings
        self._password = password
        self._driver = driver
        self.attempts_log: List[str] = []

    def __repr__(self) -> str:  # pragma: no cover - defensive
        return f'<SessionFactory database={self._settings.database!r}>'

    @property
    def default_database(self) -> str:
        return self._settings.database

    def connect(self, database: Optional[str] = None) -> Connection:
        """Open a connection, optionally to a different database on the same server."""
        if self._password is None:
            raise AdapterUnavailable(
                'this session factory has already been disposed', permanent=True,
            )
        settings = self._settings
        if database and database != settings.database:
            settings = replace(settings, database=database)
        connection, log = connect_with_retry(
            settings, self._password, driver=self._driver
        )
        self.attempts_log.extend(log)
        return connection

    def dispose(self) -> None:
        """Forget the password. Safe to call more than once."""
        self._password = None


def connect(settings: ConnectionSettings, password: str, *, driver: Optional[str] = None) -> Connection:
    """Open an encrypted connection using the first available driver."""
    candidates = [driver] if driver else available_drivers()
    if not candidates:
        raise AdapterUnavailable(
            'install pymssql or pyodbc in the runner environment; the harness '
            'itself has no database dependency',
            permanent=True,
        )
    errors: List[str] = []
    numbers: List[int] = []
    # Candidates are classified one by one and combined at the end. Combining as
    # we go loses the distinction: a pymssql transport timeout followed by "no
    # ODBC driver installed" is not a permanent failure, it is a retryable one
    # whose second driver happens to be missing.
    candidate_permanent: List[bool] = []
    candidate_transient: List[bool] = []
    for name in candidates:
        try:
            if name == 'pymssql':
                import pymssql  # noqa: WPS433

                kwargs = _pymssql_kwargs(pymssql, settings)
                raw = pymssql.connect(password=password, **kwargs)
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
        except AdapterUnavailable as exc:
            # Raised by this module, not by a driver: it carries no connection
            # string, and its own permanence is already known. Preserving that
            # flag is what stops "this pymssql cannot encrypt" being retried
            # four times.
            candidate_permanent.append(exc.permanent)
            candidate_transient.append(
                not exc.permanent and is_transient_connect_error(exc)
            )
            numbers.extend(exc.error_numbers)
            errors.append(f'{name}: {exc}')
        except Exception as exc:  # pragma: no cover - environment specific
            # The message can echo the connection string, so never let it out.
            # The SQL error number is safe and is what tells a login failure
            # (never retry) from a transport blip (worth one more try).
            number = _error_number(exc)
            if number is not None:
                numbers.append(number)
            transient = is_transient_connect_error(exc)
            candidate_permanent.append(not transient)
            candidate_transient.append(transient)
            errors.append(
                f'{name}: {type(exc).__name__}'
                + (f' number={number}' if number is not None else '')
                + ('' if transient else ' (permanent)')
            )
    # Retry if any candidate is worth retrying. Permanent only when every one of
    # them was permanent - otherwise a missing second driver silently converts a
    # recoverable timeout into a dead run.
    raise AdapterUnavailable(
        'could not connect using ' + ', '.join(errors),
        numbers,
        permanent=bool(candidate_permanent) and all(candidate_permanent),
        transient=any(candidate_transient),
    )


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
    raise AdapterUnavailable(
        'no Microsoft ODBC driver for SQL Server is installed', permanent=True,
    )


# ---------------------------------------------------------------------------
# Inventory queries
# ---------------------------------------------------------------------------

#: The database a SQL Server session connects to in order to create or drop the
#: disposable run database. A database cannot drop itself, so this connection is
#: unavoidable - but nothing scoped is ever created here, which is why the run
#: database exists in the first place.
ADMIN_DATABASE = 'master'

#: Catalog existence checks, keyed by the object kinds
#: :func:`~.manifest.explicit_cleanup_statements` understands. This is how a DDL
#: cell is judged: a ``CREATE`` that raised nothing and left the object in the
#: catalog succeeded, and asking it for a row count instead - which is what the
#: first live run did - fails a cell whose DDL was perfectly correct.
#:
#: ``{schema}`` and ``{name}`` are only ever filled with names
#: :class:`~.runid.RunIdentity` has already accepted as its own, which is a
#: closed ``[a-z0-9_]`` shape, so there is no free text here to inject.
CATALOG_PRESENCE_QUERIES: Dict[str, str] = {
    'table': (
        'SELECT COUNT(*) FROM sys.tables AS t '
        'JOIN sys.schemas AS s ON s.schema_id = t.schema_id '
        # sys.tables lists external tables too. Without this an external table
        # answers a presence check for a regular one, which is how the cleanup
        # planner ended up issuing a DROP TABLE for an object it had already
        # dropped with DROP EXTERNAL TABLE.
        'WHERE t.is_external = 0 '
        "AND s.name = '{schema}' AND t.name = '{name}'"
    ),
    'external table': (
        'SELECT COUNT(*) FROM sys.external_tables AS t '
        'JOIN sys.schemas AS s ON s.schema_id = t.schema_id '
        "WHERE s.name = '{schema}' AND t.name = '{name}'"
    ),
    'view': (
        'SELECT COUNT(*) FROM sys.views AS v '
        'JOIN sys.schemas AS s ON s.schema_id = v.schema_id '
        "WHERE s.name = '{schema}' AND v.name = '{name}'"
    ),
    'external file format': (
        "SELECT COUNT(*) FROM sys.external_file_formats WHERE name = '{name}'"
    ),
    'external data source': (
        "SELECT COUNT(*) FROM sys.external_data_sources WHERE name = '{name}'"
    ),
    'database scoped credential': (
        "SELECT COUNT(*) FROM sys.database_scoped_credentials WHERE name = '{name}'"
    ),
    'schema': "SELECT COUNT(*) FROM sys.schemas WHERE name = '{name}'",
}

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
        'JOIN sys.schemas AS s ON s.schema_id = t.schema_id '
        # An external table is a row in sys.tables as well as in
        # sys.external_tables. Inventorying it as both kinds made the cleanup
        # planner emit DROP EXTERNAL TABLE and then DROP TABLE for the same
        # object, and the second one failed with 3701 on an object the first had
        # already removed - a run that cleaned up perfectly reporting 34 of 36
        # statements successful.
        "WHERE t.is_external = 0 AND s.name = '{schema}'"
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
