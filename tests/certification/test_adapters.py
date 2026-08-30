"""The database adapter must connect the way the manual proof connected.

Two live blockers came out of this file. The first was that the ``pymssql``
path built its arguments by hand and never looked at
``ConnectionSettings.encrypt``: ``pymssql.connect`` has no ``encrypt``
parameter, so the setting was silently dropped and the harness negotiated
whatever FreeTDS defaulted to, while the connection that had actually been
proven by hand required encryption. The second was that driver values reached
the report writer as ``bytes`` and took ``json.dump`` down after a completed
run.

Nothing here opens a socket. The connection arguments are asserted against a
stand-in module, so the test states what the harness *would* send.
"""

import os

import pytest

from certification.adapters import (
    APPLICATION_NAME,
    AdapterUnavailable,
    Connection,
    ConnectionSettings,
    _error_number,
    _pymssql_kwargs,
    connect,
    is_transient_connect_error,
)


class _FakePymssql:
    """A ``pymssql`` stand-in that records how it was called."""

    def __init__(self, *, supports_encryption=True):
        self.calls = []
        self._supports_encryption = supports_encryption

    def connect(self, **kwargs):
        if not self._supports_encryption and 'encryption' in kwargs:
            raise TypeError("connect() got an unexpected keyword argument 'encryption'")
        self.calls.append(kwargs)
        return _FakeRaw()


class _FakeRaw:
    def cursor(self):
        raise AssertionError('the connection test must never run a statement')

    def close(self):
        pass


def _settings(**overrides):
    base = dict(
        host='cert.example.invalid',
        database='certdb',
        user='certuser',
        port=1433,
    )
    base.update(overrides)
    return ConnectionSettings(**base)


# -- encryption --------------------------------------------------------------

def test_encrypt_true_requires_encryption_on_the_wire():
    module = _FakePymssql()

    kwargs = _pymssql_kwargs(module, _settings(encrypt=True))

    assert kwargs['encryption'] == 'require'


def test_encrypt_false_asks_for_encryption_off_rather_than_omitting_it():
    # Omitting the parameter would leave the driver default in charge, which is
    # the bug this file exists to prevent - in either direction.
    module = _FakePymssql()

    kwargs = _pymssql_kwargs(module, _settings(encrypt=False))

    assert kwargs['encryption'] == 'off'


def test_an_old_driver_fails_loudly_rather_than_connecting_unencrypted():
    class _NoEncryption:
        def connect(self, server=None, port=None, user=None, password=None,
                    database=None, login_timeout=None, autocommit=None,
                    charset=None, appname=None):
            raise AssertionError('must not be reached')

    with pytest.raises(AdapterUnavailable) as excinfo:
        _pymssql_kwargs(_NoEncryption(), _settings(encrypt=True))

    message = str(excinfo.value)
    assert 'pymssql' in message
    assert 'unencrypted' in message


def test_an_old_driver_is_still_usable_when_encryption_was_not_asked_for():
    class _NoEncryption:
        def connect(self, server=None, port=None, user=None, password=None,
                    database=None, login_timeout=None, autocommit=None,
                    charset=None, appname=None):
            raise AssertionError('must not be reached')

    kwargs = _pymssql_kwargs(_NoEncryption(), _settings(encrypt=False))

    assert 'encryption' not in kwargs


def test_an_uninspectable_driver_is_still_asked_for_encryption():
    # `pymssql.connect` is a Cython function and some builds carry no usable
    # signature. "Unknown" must not be read as "unsupported".
    class _Opaque:
        connect = dict.update  # a C slot wrapper: inspect.signature raises

    kwargs = _pymssql_kwargs(_Opaque(), _settings(encrypt=True))

    assert kwargs['encryption'] == 'require'


def test_a_forwarding_driver_wrapper_counts_as_accepting_encryption():
    # A signature ending in **kwargs accepts any name, so it must not be read
    # as "encryption is missing" and downgraded.
    class _Forwarding:
        def connect(self, **kwargs):
            return None

    kwargs = _pymssql_kwargs(_Forwarding(), _settings(encrypt=True))

    assert kwargs['encryption'] == 'require'


# -- fidelity and identification ---------------------------------------------

def test_connection_asks_for_utf8_so_japanese_and_emoji_survive():
    kwargs = _pymssql_kwargs(_FakePymssql(), _settings())

    assert kwargs['charset'] == 'UTF-8'


def test_connection_identifies_itself_without_naming_the_environment():
    kwargs = _pymssql_kwargs(_FakePymssql(), _settings())

    assert kwargs['appname'] == APPLICATION_NAME
    assert 'cert.example.invalid' not in APPLICATION_NAME
    assert 'certuser' not in APPLICATION_NAME


def test_settings_carry_through_to_the_driver():
    kwargs = _pymssql_kwargs(_FakePymssql(), _settings(port=14330, login_timeout=7))

    assert kwargs['server'] == 'cert.example.invalid'
    assert kwargs['database'] == 'certdb'
    assert kwargs['user'] == 'certuser'
    assert kwargs['port'] == '14330'
    assert kwargs['login_timeout'] == 7
    assert kwargs['autocommit'] is True


def test_the_password_is_not_part_of_the_reusable_argument_dictionary():
    # The kwargs dict is built, inspected and could be logged by a future
    # caller; the password is passed separately, at the call, on purpose.
    kwargs = _pymssql_kwargs(_FakePymssql(), _settings())

    assert 'password' not in kwargs
    assert not any('secret' in str(v) for v in kwargs.values())


def test_connect_sends_the_password_and_the_encryption_setting_together(monkeypatch):
    module = _FakePymssql()
    monkeypatch.setitem(__import__('sys').modules, 'pymssql', module)

    connection = connect(_settings(encrypt=True), 'not-a-real-password',
                         driver='pymssql')

    assert isinstance(connection, Connection)
    assert connection.driver == 'pymssql'
    sent = module.calls[0]
    assert sent['encryption'] == 'require'
    assert sent['password'] == 'not-a-real-password'


def test_connect_failure_never_echoes_the_connection_arguments(monkeypatch):
    class _Exploding:
        def connect(self, **kwargs):
            raise RuntimeError(
                'login failed for cert.example.invalid user certuser '
                'password not-a-real-password'
            )

    monkeypatch.setitem(__import__('sys').modules, 'pymssql', _Exploding())

    with pytest.raises(AdapterUnavailable) as excinfo:
        connect(_settings(), 'not-a-real-password', driver='pymssql')

    message = str(excinfo.value)
    assert 'not-a-real-password' not in message
    assert 'certuser' not in message
    assert 'cert.example.invalid' not in message


# -- retry classification ----------------------------------------------------
#
# Retrying a login is how an account gets locked out, so the classifier has to
# see the error number whatever shape the driver reports it in. pymssql puts an
# int first in `args`; pyodbc puts a SQLSTATE string first and parenthesises the
# native number inside the message.

@pytest.mark.parametrize('exc', [
    Exception(18456, b"Login failed for user 'certuser'."),
    Exception(
        '42000',
        "[42000] [Microsoft][ODBC Driver 18 for SQL Server](18456) "
        "Login failed for user 'certuser'.",
    ),
    AdapterUnavailable('could not connect using pymssql: number=18456', [18456]),
])
def test_a_login_failure_is_never_retried(exc):
    assert is_transient_connect_error(exc) is False


@pytest.mark.parametrize('exc', [
    Exception(20003, b'Adaptive Server connection timed out'),
    Exception('HYT00', '[HYT00] [Microsoft][ODBC Driver 18] Login timeout expired'),
    TimeoutError('timed out'),
    ConnectionResetError('connection reset by peer'),
])
def test_a_transport_failure_is_retried(exc):
    assert is_transient_connect_error(exc) is True


def test_an_unclassifiable_failure_fails_closed():
    """Better to stop and report than to spend four attempts on a maybe-login."""
    assert is_transient_connect_error(Exception('something went wrong')) is False


def test_a_permanent_adapter_condition_is_not_retried():
    exc = AdapterUnavailable('no driver installed', permanent=True)
    assert is_transient_connect_error(exc) is False


def test_a_driver_that_cannot_encrypt_is_permanent_through_connect(monkeypatch):
    """The condition used to be swallowed by connect() and then retried."""
    fake = _FakePymssql(supports_encryption=False)

    def _reflect(**kwargs):
        raise TypeError("unexpected keyword argument 'encryption'")

    fake.connect = _reflect
    monkeypatch.setitem(__import__('sys').modules, 'pymssql', fake)
    with pytest.raises(AdapterUnavailable) as excinfo:
        connect(_settings(), 'not-a-real-password', driver='pymssql')
    assert is_transient_connect_error(excinfo.value) is False


def test_pyodbc_shaped_error_numbers_are_recovered():
    exc = Exception('42000', '[42000] [Microsoft][ODBC Driver 18](102) Incorrect syntax.')
    assert _error_number(exc) == 102


# -- optional live smoke -----------------------------------------------------

@pytest.mark.skipif(
    not os.environ.get('SQLFDT_CERT_ADAPTER_SMOKE'),
    reason='set SQLFDT_CERT_ADAPTER_SMOKE with the usual connection environment '
           'to run one encrypted round trip',
)
def test_adapter_smoke_round_trip():  # pragma: no cover - opt-in, credentialed
    from certification.adapters import take_password

    settings = ConnectionSettings.from_env()
    with connect(settings, take_password(prompt=False)) as connection:
        result = connection.execute('SELECT 1 AS one;')
    assert result.rows == [(1,)]


# -- mixed driver candidates -------------------------------------------------

class _FakePyodbcWithoutADriver:
    """pyodbc is importable but no Microsoft ODBC driver is installed."""

    @staticmethod
    def drivers():
        return ['SQLite3 ODBC Driver']

    @staticmethod
    def connect(*_args, **_kwargs):
        raise AssertionError('must not be reached: there is no usable driver')


class _FakePymssqlThatTimesOut:
    @staticmethod
    def connect(**_kwargs):
        raise OSError(20009, b'DB-Lib error: Net-Lib error 10060 connection timed out')


def _mixed_candidates(monkeypatch):
    """pymssql times out; pyodbc is present but has no driver to offer."""
    modules = __import__('sys').modules
    monkeypatch.setitem(modules, 'pymssql', _FakePymssqlThatTimesOut())
    monkeypatch.setitem(modules, 'pyodbc', _FakePyodbcWithoutADriver())


def test_a_transient_driver_and_a_missing_one_stay_retryable(monkeypatch):
    """The failure that cost a live run.

    pymssql timed out - the same connection had worked by hand a minute
    earlier - and pyodbc reported that no ODBC driver was installed. Permanence
    was OR-ed across the two, so the pair was called permanent and the retry
    that would have succeeded never happened.
    """
    _mixed_candidates(monkeypatch)
    with pytest.raises(AdapterUnavailable) as excinfo:
        connect(_settings(), 'not-a-real-password')
    assert excinfo.value.permanent is False
    assert is_transient_connect_error(excinfo.value) is True


def test_an_auth_failure_beside_a_missing_driver_stays_permanent(monkeypatch):
    """Retrying cannot fix the candidate that will not budge."""
    class _LoginFailed:
        @staticmethod
        def connect(**_kwargs):
            raise OSError(18456, b"Login failed for user 'x'.")

    modules = __import__('sys').modules
    monkeypatch.setitem(modules, 'pymssql', _LoginFailed())
    monkeypatch.setitem(modules, 'pyodbc', _FakePyodbcWithoutADriver())
    with pytest.raises(AdapterUnavailable) as excinfo:
        connect(_settings(), 'not-a-real-password')
    assert is_transient_connect_error(excinfo.value) is False


def test_every_candidate_permanent_stays_permanent(monkeypatch):
    class _AlsoNoDriver:
        @staticmethod
        def connect(**_kwargs):
            raise AdapterUnavailable('no driver', permanent=True)

    modules = __import__('sys').modules
    monkeypatch.setitem(modules, 'pymssql', _AlsoNoDriver())
    monkeypatch.setitem(modules, 'pyodbc', _FakePyodbcWithoutADriver())
    with pytest.raises(AdapterUnavailable) as excinfo:
        connect(_settings(), 'not-a-real-password')
    assert excinfo.value.permanent is True
    assert is_transient_connect_error(excinfo.value) is False


def test_the_aggregate_never_repeats_the_drivers_own_message(monkeypatch):
    _mixed_candidates(monkeypatch)
    with pytest.raises(AdapterUnavailable) as excinfo:
        connect(_settings(), 'not-a-real-password')
    text = str(excinfo.value)
    assert 'Net-Lib' not in text
    assert "b'" not in text
    assert 'not-a-real-password' not in text


def test_a_mixed_failure_is_actually_retried(monkeypatch):
    """Classification is only worth anything if the retry loop acts on it."""
    from certification.adapters import connect_with_retry

    _mixed_candidates(monkeypatch)
    slept = []
    with pytest.raises(AdapterUnavailable):
        connect_with_retry(
            _settings(), 'not-a-real-password',
            attempts=3, backoff=(0.0,), sleep=slept.append,
        )
    assert len(slept) == 2, 'a retryable aggregate must be retried'


# -- the nested (number, bytes) shape ----------------------------------------

FAILOVER_MESSAGE = (
    b"Database 'contoso_warehouse' on server 'sqldemo-server' is not currently available. "
    b'Please retry the connection later. If the problem persists, contact '
    b'customer support. (40613) DB-Lib error message 20002, severity 9'
)


def _nested_failover():
    """Exactly what pymssql raised on the live Azure run.

    One argument, and that argument is the ``(number, message)`` pair. Reading
    ``args`` a single level deep found no int and no text at all.
    """
    return OSError((40613, FAILOVER_MESSAGE))


def test_the_nested_pair_still_yields_its_error_number():
    assert _error_number(_nested_failover()) == 40613


def test_a_gateway_failover_is_transient():
    assert is_transient_connect_error(_nested_failover()) is True


def test_the_flat_pair_behaves_identically():
    flat = OSError(40613, FAILOVER_MESSAGE)
    assert _error_number(flat) == 40613
    assert is_transient_connect_error(flat) is True


def test_a_nested_login_failure_is_still_permanent():
    """Flattening must not turn an auth failure into four login attempts."""
    nested = OSError((18456, b"Login failed for user 'certuser'."))
    assert _error_number(nested) == 18456
    assert is_transient_connect_error(nested) is False


def test_a_doubly_nested_pair_is_still_read():
    assert _error_number(OSError(((40613, FAILOVER_MESSAGE),))) == 40613


def test_flattening_is_bounded_against_a_self_referential_argument():
    from certification.adapters import flatten_exception_args

    args = []
    args.append(args)
    exc = OSError(args)
    assert flatten_exception_args(exc) == []


def test_40613_is_named_rather_than_left_to_the_default():
    from certification.adapters import TRANSIENT_ERROR_NUMBERS
    from certification.adapters import AUTH_ERROR_NUMBERS as auth

    assert 40613 in TRANSIENT_ERROR_NUMBERS
    assert not (TRANSIENT_ERROR_NUMBERS & auth)


def test_a_failover_on_the_first_attempt_connects_on_the_second(monkeypatch):
    """The whole point: attempt 1 fails with 40613, attempt 2 succeeds.

    This is the manual behaviour the parent reproduced by hand - one failure,
    then a clean connection five seconds later - which the harness had been
    turning into a permanent AdapterUnavailable.
    """
    from certification.adapters import connect_with_retry

    class _FlakyPymssql:
        def __init__(self):
            self.attempts = 0

        def connect(self, **_kwargs):
            self.attempts += 1
            if self.attempts == 1:
                raise OSError((40613, FAILOVER_MESSAGE))
            return _FakeRaw()

    flaky = _FlakyPymssql()
    monkeypatch.setitem(__import__('sys').modules, 'pymssql', flaky)
    slept = []

    connection, log = connect_with_retry(
        _settings(), 'not-a-real-password',
        driver='pymssql', backoff=(0.0,), sleep=slept.append,
    )

    assert flaky.attempts == 2
    assert connection is not None
    assert len(slept) == 1
    assert log[0].startswith('attempt 1:')
    assert 'number=40613' in log[0]
    assert 'permanent' not in log[0]
    assert log[-1] == 'attempt 2: connected'


def test_the_attempt_log_never_carries_the_servers_message(monkeypatch):
    from certification.adapters import connect_with_retry

    class _AlwaysFailingOver:
        @staticmethod
        def connect(**_kwargs):
            raise OSError((40613, FAILOVER_MESSAGE))

    monkeypatch.setitem(__import__('sys').modules, 'pymssql', _AlwaysFailingOver())
    with pytest.raises(AdapterUnavailable) as excinfo:
        connect_with_retry(
            _settings(), 'not-a-real-password',
            driver='pymssql', attempts=2, backoff=(0.0,), sleep=lambda _s: None,
        )

    text = str(excinfo.value)
    assert 'number=40613' in text
    assert 'contoso_warehouse' not in text
    assert 'sqldemo-server' not in text
    assert "b'" not in text
    assert 'not-a-real-password' not in text
