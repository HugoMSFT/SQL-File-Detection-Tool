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
    _pymssql_kwargs,
    connect,
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
