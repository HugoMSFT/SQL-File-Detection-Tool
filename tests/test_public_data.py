"""Tests for the public dataset resolver and downloader.

Every test uses a mocked opener; nothing here touches the network.
"""

import io
import os
import socket

import pytest

from external_file_detection import public_data


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class _FakeResponse:
    def __init__(self, body: bytes, headers=None):
        self._stream = io.BytesIO(body)
        self.headers = dict(headers or {})
        self.closed = False

    def read(self, size=-1):
        return self._stream.read(size)

    def close(self):
        self.closed = True


class _FakeOpener:
    """Returns a canned response and records the URLs it was asked for."""

    def __init__(self, body=b'', headers=None, error=None):
        self.body = body
        self.headers = headers or {}
        self.error = error
        self.urls = []

    def open(self, request, timeout=None):
        self.urls.append(request.full_url)
        if self.error is not None:
            raise self.error
        return _FakeResponse(self.body, self.headers)


@pytest.fixture()
def public_dns(monkeypatch):
    """Make every host name resolve to a public address."""
    monkeypatch.setattr(
        public_data, '_resolve_host', lambda hostname: ['93.184.216.34']
    )


# ---------------------------------------------------------------------------
# URL validation / SSRF hardening
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('url', [
    'http://example.com/data.csv',
    'ftp://example.com/data.csv',
    'file:///etc/passwd',
])
def test_non_https_schemes_are_rejected(url):
    with pytest.raises(public_data.PublicDataError) as excinfo:
        public_data.validate_public_https_url(url)
    assert excinfo.value.status == 400


def test_credentials_in_url_are_rejected(public_dns):
    with pytest.raises(public_data.PublicDataError) as excinfo:
        public_data.validate_public_https_url(
            'https://user:secret@example.com/data.csv'
        )
    assert excinfo.value.code == 'credentials_not_allowed'


@pytest.mark.parametrize('host', [
    'localhost',
    'app.localhost',
    'localhost.localdomain',
])
def test_localhost_names_are_rejected(host):
    with pytest.raises(public_data.PublicDataError) as excinfo:
        public_data.validate_public_https_url(f'https://{host}/data.csv')
    assert excinfo.value.code == 'host_not_allowed'


@pytest.mark.parametrize('literal', [
    '127.0.0.1',
    '10.1.2.3',
    '192.168.0.5',
    '172.16.5.4',
    '169.254.169.254',    # cloud metadata service
    '0.0.0.0',
    '224.0.0.1',
    '240.0.0.1',
    '[::1]',
    '[fe80::1]',
    '[fc00::1]',
    '[::]',
    '[::ffff:127.0.0.1]',
])
def test_private_ip_literals_are_rejected(literal):
    with pytest.raises(public_data.PublicDataError) as excinfo:
        public_data.validate_public_https_url(f'https://{literal}/data.csv')
    assert excinfo.value.code == 'host_not_allowed'


def test_public_ip_literal_is_accepted():
    parsed = public_data.validate_public_https_url(
        'https://93.184.216.34/data.csv'
    )
    assert parsed.hostname == '93.184.216.34'


def test_hostname_resolving_to_private_address_is_rejected(monkeypatch):
    monkeypatch.setattr(
        public_data, '_resolve_host', lambda hostname: ['10.0.0.7']
    )
    with pytest.raises(public_data.PublicDataError) as excinfo:
        public_data.validate_public_https_url('https://evil.example/x.csv')
    assert excinfo.value.code == 'host_not_allowed'


def test_hostname_with_any_private_address_is_rejected(monkeypatch):
    """A mixed public/private DNS answer must still be refused."""
    monkeypatch.setattr(
        public_data,
        '_resolve_host',
        lambda hostname: ['93.184.216.34', '127.0.0.1'],
    )
    with pytest.raises(public_data.PublicDataError):
        public_data.validate_public_https_url('https://rebind.example/x.csv')


def test_dns_failure_is_reported(monkeypatch):
    def boom(hostname):
        raise socket.gaierror('no such host')

    monkeypatch.setattr(public_data, 'socket', socket)
    monkeypatch.setattr(
        public_data, 'getattr', getattr, raising=False
    )
    monkeypatch.setattr(
        public_data.socket, 'getaddrinfo',
        lambda *a, **k: (_ for _ in ()).throw(socket.gaierror('nope')),
    )
    with pytest.raises(public_data.PublicDataError) as excinfo:
        public_data.validate_public_https_url('https://missing.example/x.csv')
    assert excinfo.value.code == 'dns_failure'
    del boom


def test_overlong_url_is_rejected():
    with pytest.raises(public_data.PublicDataError):
        public_data.validate_public_https_url(
            'https://example.com/' + 'a' * 4000
        )


# ---------------------------------------------------------------------------
# Redirect handling
# ---------------------------------------------------------------------------

def test_redirect_to_private_address_is_rejected(monkeypatch, tmp_path):
    import urllib.error

    hosts = {
        'files.example.com': ['93.184.216.34'],
        'internal.example.com': ['169.254.169.254'],
    }
    monkeypatch.setattr(public_data, '_resolve_host', lambda h: hosts[h])

    class _Redirector:
        def __init__(self):
            self.calls = 0

        def open(self, request, timeout=None):
            self.calls += 1
            raise urllib.error.HTTPError(
                request.full_url, 302, 'Found',
                {'Location': 'https://internal.example.com/secret.csv'},
                None,
            )

    with pytest.raises(public_data.PublicDataError) as excinfo:
        public_data.download_data_file(
            'https://files.example.com/data.csv', str(tmp_path),
            opener=_Redirector(),
        )
    assert excinfo.value.code == 'host_not_allowed'
    assert not list(tmp_path.iterdir())


def test_redirect_loop_is_capped(monkeypatch, tmp_path, public_dns):
    import urllib.error

    class _Looper:
        def __init__(self):
            self.calls = 0

        def open(self, request, timeout=None):
            self.calls += 1
            raise urllib.error.HTTPError(
                request.full_url, 302, 'Found',
                {'Location': 'https://example.com/next.csv'}, None,
            )

    looper = _Looper()
    with pytest.raises(public_data.PublicDataError) as excinfo:
        public_data.download_data_file(
            'https://example.com/data.csv', str(tmp_path), opener=looper
        )
    assert excinfo.value.code == 'too_many_redirects'
    assert looper.calls == public_data.MAX_REDIRECTS + 1


# ---------------------------------------------------------------------------
# Download limits and file safety
# ---------------------------------------------------------------------------

def test_declared_content_length_over_cap_is_rejected(tmp_path, public_dns):
    opener = _FakeOpener(b'x' * 10, {'Content-Length': '999999999'})
    with pytest.raises(public_data.PublicDataError) as excinfo:
        public_data.download_data_file(
            'https://example.com/big.csv', str(tmp_path),
            max_bytes=1024, opener=opener,
        )
    assert excinfo.value.code == 'too_large'
    assert not list(tmp_path.iterdir())


def test_streamed_body_over_cap_is_rejected(tmp_path, public_dns):
    """A lying/absent Content-Length must not defeat the byte cap."""
    opener = _FakeOpener(b'x' * 5000)
    with pytest.raises(public_data.PublicDataError) as excinfo:
        public_data.download_data_file(
            'https://example.com/big.csv', str(tmp_path),
            max_bytes=1000, opener=opener,
        )
    assert excinfo.value.code == 'too_large'
    assert not list(tmp_path.iterdir()), 'partial download must be removed'


def test_empty_response_is_rejected(tmp_path, public_dns):
    opener = _FakeOpener(b'')
    with pytest.raises(public_data.PublicDataError) as excinfo:
        public_data.download_data_file(
            'https://example.com/empty.csv', str(tmp_path), opener=opener
        )
    assert excinfo.value.code == 'empty_response'
    assert not list(tmp_path.iterdir())


def test_unsupported_extension_is_rejected(tmp_path, public_dns):
    with pytest.raises(public_data.PublicDataError) as excinfo:
        public_data.download_data_file(
            'https://example.com/installer.exe', str(tmp_path),
            opener=_FakeOpener(b'MZ'),
        )
    assert excinfo.value.code == 'unsupported_type'


def test_download_writes_inside_destination(tmp_path, public_dns):
    opener = _FakeOpener(b'a,b\n1,2\n')
    result = public_data.download_data_file(
        'https://example.com/data/sample.csv', str(tmp_path), opener=opener
    )
    assert result['file_name'] == 'sample.csv'
    assert result['bytes'] == 8
    assert os.path.dirname(os.path.realpath(result['path'])) == \
        os.path.realpath(str(tmp_path))
    assert open(result['path'], 'rb').read() == b'a,b\n1,2\n'


@pytest.mark.parametrize('header,expected', [
    ('attachment; filename="../../evil.csv"', 'evil.csv'),
    ('attachment; filename=".."', 'sample.csv'),
    ('attachment; filename="C:\\\\windows\\\\sys.csv"', 'sys.csv'),
])
def test_content_disposition_names_are_sanitised(tmp_path, public_dns,
                                                 header, expected):
    opener = _FakeOpener(b'a\n1\n', {'Content-Disposition': header})
    result = public_data.download_data_file(
        'https://example.com/sample.csv', str(tmp_path), opener=opener
    )
    assert result['file_name'] == expected
    assert os.path.dirname(os.path.realpath(result['path'])) == \
        os.path.realpath(str(tmp_path))


@pytest.mark.parametrize('raw,expected', [
    ('../../etc/passwd', 'passwd'),
    ('a b?c.csv', 'a_b_c.csv'),
    ('', 'dataset'),
    ('...', 'dataset'),
])
def test_safe_file_name(raw, expected):
    assert public_data.safe_file_name(raw) == expected


# ---------------------------------------------------------------------------
# Microsoft Learn allowlist and parsing
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('url,expected', [
    ('https://learn.microsoft.com/en-us/azure/open-datasets/dataset-catalog',
     True),
    ('https://learn.microsoft.com/en-us/azure/open-datasets/dataset-taxi',
     True),
    ('https://learn.microsoft.com/en-us/azure/storage/blobs/overview', False),
    ('https://evil.example/en-us/azure/open-datasets/dataset-catalog', False),
    ('https://learn.microsoft.com.evil.example/azure/open-datasets/x', False),
    ('http://learn.microsoft.com/en-us/azure/open-datasets/x', False),
])
def test_learn_allowlist(url, expected):
    assert public_data.is_learn_open_datasets_url(url) is expected


CATALOG_HTML = """
<html><head><title>Dataset catalog | Microsoft Learn</title></head><body>
<a href="/en-us/azure/open-datasets/dataset-taxi-yellow">NYC Taxi Yellow</a>
<a href="/en-us/azure/open-datasets/dataset-us-labor-force">US Labor Force</a>
<a href="/en-us/azure/open-datasets/dataset-catalog">This page</a>
<a href="https://example.com/off-site.html">Off site</a>
<a href="/en-us/azure/storage/overview">Other docs</a>
</body></html>
"""

DATASET_HTML = """
<html><head><title>NYC Taxi Yellow | Microsoft Learn</title></head><body>
<pre><code>
SELECT TOP 10 * FROM OPENROWSET(
    BULK 'abs://nyctlc@azureopendatastorage.blob.core.windows.net/yellow/*.parquet',
    FORMAT = 'parquet') AS taxi;
</code></pre>
<code>https://azureopendatastorage.blob.core.windows.net/nyctlc/yellow/sample.parquet</code>
<code>https://example.com/not-a-data-file.html</code>
</body></html>
"""


def test_parse_catalog_page_lists_sibling_datasets():
    datasets = public_data.parse_catalog_page(
        CATALOG_HTML,
        'https://learn.microsoft.com/en-us/azure/open-datasets/dataset-catalog',
    )
    slugs = [item['slug'] for item in datasets]
    assert slugs == ['dataset-taxi-yellow', 'dataset-us-labor-force']
    assert datasets[0]['name'] == 'NYC Taxi Yellow'


def test_parse_dataset_page_finds_candidates():
    page = public_data.parse_dataset_page(
        DATASET_HTML,
        'https://learn.microsoft.com/en-us/azure/open-datasets/dataset-taxi-yellow',
    )
    assert page['title'] == 'NYC Taxi Yellow'
    urls = [c['url'] for c in page['candidates']]
    assert any(u.startswith('abs://nyctlc@') for u in urls)
    assert any(u.endswith('sample.parquet') for u in urls)
    # An HTML page on a random host is never offered as data.
    assert not any('not-a-data-file.html' in u for u in urls)

    wildcard = next(c for c in page['candidates'] if c['scheme'] == 'abs')
    assert wildcard['wildcard'] is True
    assert wildcard['downloadable'] is False

    direct = next(c for c in page['candidates']
                  if c['url'].endswith('sample.parquet'))
    assert direct['downloadable'] is True


def test_resolve_catalog_page(public_dns):
    opener = _FakeOpener(CATALOG_HTML.encode('utf-8'),
                         {'Content-Type': 'text/html; charset=utf-8'})
    result = public_data.resolve_public_url(
        'https://learn.microsoft.com/en-us/azure/open-datasets/dataset-catalog',
        opener=opener,
    )
    assert result['kind'] == 'catalog'
    assert len(result['datasets']) == 2


def test_resolve_dataset_page(public_dns):
    opener = _FakeOpener(DATASET_HTML.encode('utf-8'),
                         {'Content-Type': 'text/html'})
    result = public_data.resolve_public_url(
        'https://learn.microsoft.com/en-us/azure/open-datasets/dataset-taxi-yellow',
        opener=opener,
    )
    assert result['kind'] == 'dataset'
    assert result['candidates']


def test_resolve_direct_data_url(public_dns):
    result = public_data.resolve_public_url(
        'https://azureopendatastorage.blob.core.windows.net/nyctlc/x.parquet'
    )
    assert result['kind'] == 'data'
    assert result['extension'] == '.parquet'
    assert result['azure_storage'] is True


def test_resolve_html_page_outside_allowlist_is_rejected(public_dns):
    with pytest.raises(public_data.PublicDataError) as excinfo:
        public_data.resolve_public_url('https://example.com/page.html')
    assert excinfo.value.code == 'unsupported_type'


def test_learn_page_without_candidates_is_reported(public_dns):
    html = '<html><head><title>Empty</title></head><body></body></html>'
    opener = _FakeOpener(html.encode('utf-8'), {'Content-Type': 'text/html'})
    with pytest.raises(public_data.PublicDataError) as excinfo:
        public_data.resolve_public_url(
            'https://learn.microsoft.com/en-us/azure/open-datasets/dataset-x',
            opener=opener,
        )
    assert excinfo.value.code == 'no_data_candidate'


def test_oversized_html_is_rejected(public_dns):
    opener = _FakeOpener(b'<html>' + b'x' * 5000 + b'</html>')
    with pytest.raises(public_data.PublicDataError) as excinfo:
        public_data.fetch_text('https://learn.microsoft.com/x', cap=1000,
                               opener=opener)
    assert excinfo.value.code == 'too_large'


# ---------------------------------------------------------------------------
# Azure storage helpers
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('url,expected', [
    ('abs://nyctlc@azureopendatastorage.blob.core.windows.net/yellow/*.parquet',
     ('https://azureopendatastorage.blob.core.windows.net', 'nyctlc',
      'yellow/*.parquet')),
    ('https://acct.blob.core.windows.net/container/folder/file.csv',
     ('https://acct.blob.core.windows.net', 'container', 'folder/file.csv')),
    ('adls://c@acct.dfs.core.windows.net/p/f.parquet',
     ('https://acct.blob.core.windows.net', 'c', 'p/f.parquet')),
    ('https://example.com/data.csv', None),
    ('s3://bucket/key.csv', None),
])
def test_azure_blob_parts(url, expected):
    assert public_data.azure_blob_parts(url) == expected


@pytest.mark.parametrize('prefix,expected', [
    ('yellow/*.parquet', 'yellow/'),
    ('yellow/puYear=2019/*.parquet', 'yellow/puYear=2019/'),
    ('*.parquet', ''),
    ('yellow/file.parquet', 'yellow/file.parquet'),
])
def test_listable_prefix(prefix, expected):
    assert public_data._listable_prefix(prefix) == expected


LISTING_XML = b"""<?xml version="1.0" encoding="utf-8"?>
<EnumerationResults>
  <Blobs>
    <Blob><Name>yellow/_SUCCESS</Name>
      <Properties><Content-Length>0</Content-Length></Properties></Blob>
    <Blob><Name>yellow/notes.md</Name>
      <Properties><Content-Length>120</Content-Length></Properties></Blob>
    <Blob><Name>yellow/part-0.parquet</Name>
      <Properties><Content-Length>4096</Content-Length></Properties></Blob>
  </Blobs>
</EnumerationResults>
"""


def test_first_supported_blob_skips_unsupported_and_empty(public_dns):
    opener = _FakeOpener(LISTING_XML, {'Content-Type': 'application/xml'})
    blob = public_data.first_supported_blob(
        'abs://nyctlc@azureopendatastorage.blob.core.windows.net/yellow/*.parquet',
        opener=opener,
    )
    assert blob['name'] == 'yellow/part-0.parquet'
    assert blob['url'].startswith(
        'https://azureopendatastorage.blob.core.windows.net/nyctlc/'
    )
    listing_request = opener.urls[0]
    assert 'restype=container' in listing_request
    assert 'comp=list' in listing_request
    assert 'prefix=yellow%2F' in listing_request


def test_first_supported_blob_skips_oversized(public_dns):
    opener = _FakeOpener(LISTING_XML)
    assert public_data.first_supported_blob(
        'abs://c@acct.blob.core.windows.net/yellow/*.parquet',
        max_bytes=10, opener=opener,
    ) is None


def test_list_public_blobs_rejects_non_azure(public_dns):
    with pytest.raises(public_data.PublicDataError) as excinfo:
        public_data.list_public_blobs('https://example.com/data/')
    assert excinfo.value.code == 'not_azure_storage'


@pytest.mark.parametrize('url,expected', [
    ('abs://c@acct.blob.core.windows.net/f.parquet',
     'abs://c@acct.blob.core.windows.net/f.parquet'),
    ('s3://bucket/key.csv', 's3://bucket/key.csv'),
    ('https://acct.blob.core.windows.net/c/f.csv',
     'https://acct.blob.core.windows.net/c/f.csv'),
    # A random public web server is not readable by any SQL engine.
    ('https://example.com/data.csv', None),
    ('https://raw.githubusercontent.com/o/r/main/data.csv', None),
])
def test_storage_url_for(url, expected):
    assert public_data.storage_url_for(url) == expected


def test_release_skips_close_when_the_error_has_no_body():
    """An HTTPError built without a body has nothing to close.

    Python 3.10+ quietly substitutes an empty ``BytesIO`` for a ``None`` body,
    so ``close()`` is harmless there and this bug is invisible. Python 3.9
    leaves ``fp`` as ``None`` and never runs the parent ``__init__``, so
    ``close()`` resolves through ``tempfile._TemporaryFileWrapper.__getattr__``,
    which reads ``self.__dict__['file']`` and raises ``KeyError: 'file'``. That
    escaped ``_open`` and destroyed the redirect verdict it was meant to
    support. The 3.9 shape is reproduced here so the guard is pinned on every
    interpreter rather than only on the one that happens to break.
    """
    import urllib.error

    class _Python39Shape(urllib.error.HTTPError):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.fp = None

        def close(self):
            raise KeyError('file')

    error = _Python39Shape('https://example.com/x', 302, 'Found',
                           {'Location': 'https://example.com/y'}, None)

    public_data._release(error)  # must not raise


def test_release_closes_a_body_when_there_is_one():
    import io
    import urllib.error

    closed = []

    class _Body(io.BytesIO):
        def close(self):
            closed.append(True)
            super().close()

    error = urllib.error.HTTPError('https://example.com/x', 502, 'Bad Gateway',
                                   {}, _Body(b'boom'))
    public_data._release(error)
    assert closed == [True]


def test_redirect_validation_survives_a_bodyless_error(monkeypatch, tmp_path):
    """The redirect verdict must reach the caller, not a KeyError from close.

    This is the end-to-end shape of the Python 3.9 failure: a transport that
    reports a redirect with no payload, whose per-hop SSRF check must still be
    the thing that decides the outcome.
    """
    import urllib.error

    hosts = {
        'files.example.com': ['93.184.216.34'],
        'internal.example.com': ['169.254.169.254'],
    }
    monkeypatch.setattr(public_data, '_resolve_host', lambda h: hosts[h])

    class _BodylessRedirector:
        def open(self, request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 302, 'Found',
                {'Location': 'https://internal.example.com/secret.csv'},
                None,
            )

    with pytest.raises(public_data.PublicDataError) as excinfo:
        public_data.download_data_file(
            'https://files.example.com/data.csv', str(tmp_path),
            opener=_BodylessRedirector(),
        )
    assert excinfo.value.code == 'host_not_allowed'
    assert not list(tmp_path.iterdir())