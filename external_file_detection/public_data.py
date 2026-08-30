"""Fetch and resolve public HTTPS datasets for the web UI.

Two very different jobs live here and are deliberately kept apart:

``resolve_public_url``
    Decide *what* a user-supplied URL is: a directly downloadable data file,
    an Azure Open Datasets catalog page, an Azure Open Datasets detail page,
    or something we refuse to touch.  Catalog/detail HTML is only ever
    parsed - never analysed as data.

``download_data_file``
    Stream a single supported data file to a caller-owned directory under
    strict size, time and redirect limits.

Security rules enforced on every request, including every redirect hop:

* ``https://`` only.
* No credentials embedded in the URL.
* The host must resolve exclusively to global unicast addresses.  Loopback,
  private, link-local, multicast, reserved and unspecified IPv4/IPv6
  addresses are rejected.
* At most :data:`MAX_REDIRECTS` redirects, each revalidated from scratch.
* ``Content-Length`` is rejected up front when it exceeds the cap, and the
  streamed body is capped again while reading.
* Separate connect/read timeouts.
* Catalog HTML discovery is restricted to the allowlisted Microsoft Learn
  path prefix.
* Downloaded names are sanitised and written only inside the caller's
  directory; partial files are removed when anything fails.

Only the standard library is used.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# --- limits -----------------------------------------------------------
MAX_REDIRECTS = 5
REQUEST_TIMEOUT_SECONDS = 15
MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024      # matches MAX_UPLOAD_SIZE
MAX_HTML_BYTES = 4 * 1024 * 1024            # catalog pages are far smaller
USER_AGENT = 'SQLExternalFileDetector/public-dataset-resolver'

# --- allowlists -------------------------------------------------------
LEARN_HOST = 'learn.microsoft.com'
LEARN_PATH_MARKER = '/azure/open-datasets/'

# Extensions the detector can actually analyse from a downloaded file.
SUPPORTED_DATA_EXTENSIONS = (
    '.csv', '.tsv', '.json', '.jsonl', '.ndjson', '.parquet', '.snappy',
    '.orc', '.txt', '.xlsx', '.xls',
)

# Storage schemes that SQL Server / Azure SQL can virtualise directly.
VIRTUALISABLE_SCHEMES = ('abs', 'adls', 'abfss', 'wasbs', 's3', 'azure')

_AZURE_BLOB_HOST_RE = re.compile(
    r'^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.(blob|dfs)\.core\.windows\.net$',
    re.IGNORECASE,
)

_STORAGE_URL_RE = re.compile(
    r'\b(?:abfss|abs|adls|wasbs|https)://[^\s"\'<>()\[\]]+',
    re.IGNORECASE,
)


class PublicDataError(Exception):
    """A user-visible failure with an HTTP-ish status code."""

    def __init__(self, message: str, status: int = 400,
                 code: str = 'invalid_request'):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


# ---------------------------------------------------------------------------
# URL validation
# ---------------------------------------------------------------------------

def _reject(message: str, status: int = 400,
            code: str = 'invalid_request') -> None:
    raise PublicDataError(message, status=status, code=code)


def _address_is_public(address: str) -> bool:
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return False
    if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped:
        parsed = parsed.ipv4_mapped
    return not (
        parsed.is_private
        or parsed.is_loopback
        or parsed.is_link_local
        or parsed.is_multicast
        or parsed.is_reserved
        or parsed.is_unspecified
    )


def _resolve_host(hostname: str) -> List[str]:
    try:
        infos = socket.getaddrinfo(hostname, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        _reject(f'Could not resolve host "{hostname}": {exc}',
                status=400, code='dns_failure')
        return []                                     # pragma: no cover
    return sorted({info[4][0] for info in infos})


def validate_public_https_url(url: str) -> urllib.parse.ParseResult:
    """Validate *url* and return its parsed form, or raise PublicDataError."""
    if not url or not isinstance(url, str):
        _reject('A URL is required.')

    url = url.strip()
    if len(url) > 2048:
        _reject('URL is too long.')

    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError as exc:
        _reject(f'URL could not be parsed: {exc}')
        raise                                          # pragma: no cover

    if parsed.scheme.lower() != 'https':
        _reject('Only https:// URLs are supported.', code='scheme_not_allowed')
    if parsed.username or parsed.password or '@' in (parsed.netloc.rsplit(
            ':', 1)[0] if parsed.netloc else ''):
        _reject('URLs must not contain credentials.',
                code='credentials_not_allowed')

    hostname = parsed.hostname
    if not hostname:
        _reject('URL is missing a host name.')
    if hostname.lower() in ('localhost', 'localhost.localdomain') \
            or hostname.lower().endswith('.localhost'):
        _reject('Local host names are not allowed.',
                code='host_not_allowed')

    # A literal IP is checked directly; a name is checked after resolution.
    try:
        ipaddress.ip_address(hostname.strip('[]'))
        literal = True
    except ValueError:
        literal = False

    if literal:
        if not _address_is_public(hostname.strip('[]')):
            _reject('That IP address is not publicly routable.',
                    code='host_not_allowed')
    else:
        addresses = _resolve_host(hostname)
        if not addresses:
            _reject(f'Could not resolve host "{hostname}".',
                    code='dns_failure')
        for address in addresses:
            if not _address_is_public(address):
                _reject(
                    f'Host "{hostname}" resolves to a non-public address '
                    f'({address}).',
                    code='host_not_allowed',
                )

    return urllib.parse.urlparse(url)


def is_learn_open_datasets_url(url: str) -> bool:
    """True when *url* is inside the allowlisted Open Datasets doc path."""
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    if parsed.scheme.lower() != 'https':
        return False
    host = (parsed.hostname or '').lower()
    if host != LEARN_HOST:
        return False
    return LEARN_PATH_MARKER in parsed.path.lower()


# ---------------------------------------------------------------------------
# HTTP with per-hop revalidation
# ---------------------------------------------------------------------------

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Suppress automatic redirects so each hop can be revalidated."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _open(url: str, accept: str, opener=None):
    """Open *url*, revalidating the target of every redirect."""
    current = url
    for _hop in range(MAX_REDIRECTS + 1):
        validate_public_https_url(current)
        request = urllib.request.Request(
            current,
            headers={'User-Agent': USER_AGENT, 'Accept': accept},
            method='GET',
        )
        try:
            return (opener or _OPENER).open(
                request, timeout=REQUEST_TIMEOUT_SECONDS), current
        except urllib.error.HTTPError as exc:
            if exc.code in (301, 302, 303, 307, 308):
                location = exc.headers.get('Location')
                exc.close()
                if not location:
                    _reject('Redirect response had no Location header.',
                            status=502, code='bad_redirect')
                current = urllib.parse.urljoin(current, location)
                continue
            detail = f'{exc.code} {exc.reason}'
            exc.close()
            _reject(f'The server returned {detail}.', status=502,
                    code='upstream_error')
        except urllib.error.URLError as exc:
            _reject(f'Could not reach the server: {exc.reason}', status=502,
                    code='upstream_error')
        except (socket.timeout, TimeoutError):
            _reject('The request timed out.', status=504, code='timeout')
    _reject(f'More than {MAX_REDIRECTS} redirects.', status=502,
            code='too_many_redirects')
    raise AssertionError('unreachable')                # pragma: no cover


def _checked_content_length(response, cap: int) -> None:
    raw = response.headers.get('Content-Length')
    if not raw:
        return
    try:
        declared = int(raw)
    except (TypeError, ValueError):
        return
    if declared > cap:
        _reject(
            f'The file is {declared:,} bytes, over the {cap:,} byte limit.',
            status=413, code='too_large',
        )


def fetch_text(url: str, cap: int = MAX_HTML_BYTES, opener=None) -> str:
    """Download a bounded amount of text (used for catalog pages only)."""
    response, _final_url = _open(url, 'text/html,application/xhtml+xml',
                                 opener=opener)
    try:
        _checked_content_length(response, cap)
        payload = response.read(cap + 1)
        content_type = response.headers.get('Content-Type', '')
    except (socket.timeout, TimeoutError):
        _reject('The request timed out.', status=504, code='timeout')
        raise                                          # pragma: no cover
    finally:
        response.close()

    if len(payload) > cap:
        _reject(f'The page is larger than the {cap:,} byte limit.',
                status=413, code='too_large')
    charset = 'utf-8'
    match = re.search(r'charset=([\w-]+)', content_type, re.IGNORECASE)
    if match:
        charset = match.group(1)
    try:
        return payload.decode(charset, errors='replace')
    except LookupError:
        return payload.decode('utf-8', errors='replace')


# ---------------------------------------------------------------------------
# File name handling
# ---------------------------------------------------------------------------

_SAFE_NAME_RE = re.compile(r'[^A-Za-z0-9._-]+')


def safe_file_name(candidate: str, fallback: str = 'dataset') -> str:
    """Reduce *candidate* to a flat, safe file name."""
    name = os.path.basename((candidate or '').replace('\\', '/').strip())
    name = urllib.parse.unquote(name)
    name = os.path.basename(name.replace('\\', '/'))
    name = _SAFE_NAME_RE.sub('_', name).strip('._')
    if not name or name in ('.', '..'):
        name = fallback
    return name[:120]

def _name_from_content_disposition(header: str) -> Optional[str]:
    if not header:
        return None
    match = re.search(r"filename\*=(?:UTF-8'')?([^;]+)", header,
                      re.IGNORECASE)
    if not match:
        match = re.search(r'filename="?([^";]+)"?', header, re.IGNORECASE)
    if not match:
        return None
    sanitised = safe_file_name(match.group(1).strip(), fallback='')
    return sanitised or None


def data_extension(url_or_name: str) -> Optional[str]:
    """Return the supported data extension of *url_or_name*, if any."""
    path = urllib.parse.urlsplit(url_or_name).path if '://' in url_or_name \
        else url_or_name
    lowered = path.lower()
    for extension in SUPPORTED_DATA_EXTENSIONS:
        if lowered.endswith(extension):
            return extension
    return None


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def download_data_file(url: str, destination_dir: str,
                       max_bytes: int = MAX_DOWNLOAD_BYTES,
                       opener=None) -> Dict[str, Any]:
    """Stream a supported data file from *url* into *destination_dir*.

    The caller owns ``destination_dir`` and must have created it inside a
    trusted root; nothing here ever writes outside it.
    """
    parsed = validate_public_https_url(url)
    destination_root = os.path.realpath(destination_dir)
    if not os.path.isdir(destination_root):
        raise ValueError('destination_dir must be an existing directory')

    extension = data_extension(url)
    if extension is None:
        _reject(
            'That URL does not point at a supported data file. Supported '
            'extensions: ' + ', '.join(SUPPORTED_DATA_EXTENSIONS) + '.',
            code='unsupported_type',
        )

    response, final_url = _open(url, 'application/octet-stream',
                                opener=opener)
    try:
        _checked_content_length(response, max_bytes)
        name = (_name_from_content_disposition(
            response.headers.get('Content-Disposition', ''))
            or safe_file_name(os.path.basename(parsed.path)))
        if data_extension(name) is None:
            name = f'{name}{extension}'

        target = os.path.join(destination_root, name)
        if not os.path.realpath(os.path.dirname(target)) == destination_root:
            _reject('Refusing to write outside the session directory.',
                    status=500, code='unsafe_path')

        written = 0
        try:
            with open(target, 'wb') as handle:
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > max_bytes:
                        raise PublicDataError(
                            f'The download exceeded the {max_bytes:,} byte '
                            f'limit.', status=413, code='too_large')
                    handle.write(chunk)
        except (PublicDataError, OSError, socket.timeout, TimeoutError):
            if os.path.exists(target):
                os.remove(target)
            raise
        if written == 0:
            os.remove(target)
            _reject('The server returned an empty file.', status=502,
                    code='empty_response')
    except (socket.timeout, TimeoutError):
        _reject('The download timed out.', status=504, code='timeout')
        raise                                          # pragma: no cover
    finally:
        response.close()

    return {
        'path': target,
        'file_name': name,
        'bytes': written,
        'source_url': url,
        'final_url': final_url,
    }


# ---------------------------------------------------------------------------
# Microsoft Learn Open Datasets parsing
# ---------------------------------------------------------------------------

class _LearnLinkParser(HTMLParser):
    """Collect in-catalog dataset links and their visible text."""

    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.links: List[Tuple[str, str]] = []
        self._href: Optional[str] = None
        self._text: List[str] = []

    def handle_starttag(self, tag, attrs):
        if tag != 'a':
            return
        href = dict(attrs).get('href')
        if not href:
            return
        absolute = urllib.parse.urljoin(self.base_url, href)
        absolute = absolute.split('#', 1)[0]
        if is_learn_open_datasets_url(absolute):
            self._href = absolute
            self._text = []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag == 'a' and self._href is not None:
            label = ' '.join(''.join(self._text).split())
            self.links.append((self._href, label))
            self._href = None
            self._text = []


class _LearnTextParser(HTMLParser):
    """Extract page title plus the text of code blocks."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ''
        self.code_text: List[str] = []
        self._in_title = False
        self._in_code = 0

    def handle_starttag(self, tag, attrs):
        if tag == 'title':
            self._in_title = True
        elif tag in ('code', 'pre'):
            self._in_code += 1

    def handle_endtag(self, tag):
        if tag == 'title':
            self._in_title = False
        elif tag in ('code', 'pre') and self._in_code:
            self._in_code -= 1

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif self._in_code:
            self.code_text.append(data)


def _dedupe(items: List[Dict[str, Any]], key: str) -> List[Dict[str, Any]]:
    seen = set()
    unique = []
    for item in items:
        if item[key] in seen:
            continue
        seen.add(item[key])
        unique.append(item)
    return unique


def parse_catalog_page(html: str, base_url: str) -> List[Dict[str, str]]:
    """Return the dataset detail pages linked from a catalog page."""
    parser = _LearnLinkParser(base_url)
    parser.feed(html)

    base_path = urllib.parse.urlsplit(base_url).path.rstrip('/').lower()
    datasets = []
    for href, label in parser.links:
        path = urllib.parse.urlsplit(href).path.rstrip('/')
        if path.lower() == base_path:
            continue
        slug = path.rsplit('/', 1)[-1]
        if not slug or slug == 'dataset-catalog':
            continue
        datasets.append({
            'url': href,
            'name': label or slug.replace('-', ' ').title(),
            'slug': slug,
        })
    return _dedupe(datasets, 'url')


def parse_dataset_page(html: str, page_url: str) -> Dict[str, Any]:
    """Extract downloadable / virtualisable data candidates from a page."""
    parser = _LearnTextParser()
    parser.feed(html)

    title = ' '.join(parser.title.split()).split('|')[0].strip()
    blob = '\n'.join(parser.code_text)

    candidates: List[Dict[str, Any]] = []
    for raw in _STORAGE_URL_RE.findall(blob):
        url = raw.rstrip('.,;:\'")')
        scheme = url.split('://', 1)[0].lower()
        extension = data_extension(url)
        has_wildcard = '*' in url or '?' in url

        if scheme == 'https':
            host = (urllib.parse.urlsplit(url).hostname or '')
            if not _AZURE_BLOB_HOST_RE.match(host) and extension is None:
                continue
            kind = 'download' if (extension and not has_wildcard) else 'folder'
        elif scheme in VIRTUALISABLE_SCHEMES:
            kind = 'virtualise'
        else:
            continue

        candidates.append({
            'url': url,
            'scheme': scheme,
            'kind': kind,
            'extension': extension,
            'wildcard': has_wildcard,
            'downloadable': kind == 'download',
        })

    return {
        'title': title or page_url.rstrip('/').rsplit('/', 1)[-1],
        'page_url': page_url,
        'candidates': _dedupe(candidates, 'url'),
    }


# ---------------------------------------------------------------------------
# Top-level resolver
# ---------------------------------------------------------------------------

def resolve_public_url(url: str, opener=None) -> Dict[str, Any]:
    """Classify *url* and return what the UI should do next.

    Result ``kind`` is one of:

    ``data``
        A directly downloadable supported data file.
    ``catalog``
        An Open Datasets catalog page; ``datasets`` lists detail pages.
    ``dataset``
        An Open Datasets detail page; ``candidates`` lists data locations.
    """
    validate_public_https_url(url)

    if is_learn_open_datasets_url(url):
        html = fetch_text(url, opener=opener)
        datasets = parse_catalog_page(html, url)
        page = parse_dataset_page(html, url)

        # A catalog page links to many siblings and exposes no data URLs of
        # its own; a detail page is the other way round.
        if datasets and not page['candidates']:
            return {
                'kind': 'catalog',
                'url': url,
                'title': page['title'],
                'datasets': datasets,
            }
        if not page['candidates']:
            _reject(
                'That Microsoft Learn page does not document a downloadable '
                'or virtualisable data location.',
                status=422, code='no_data_candidate',
            )
        return {
            'kind': 'dataset',
            'url': url,
            'title': page['title'],
            'candidates': page['candidates'],
            'datasets': datasets,
        }

    extension = data_extension(url)
    if extension is None:
        _reject(
            'That URL is not a supported data file and is not an Azure Open '
            'Datasets page. Supported extensions: '
            + ', '.join(SUPPORTED_DATA_EXTENSIONS) + '.',
            code='unsupported_type',
        )

    host = (urllib.parse.urlsplit(url).hostname or '')
    return {
        'kind': 'data',
        'url': url,
        'extension': extension,
        'file_name': safe_file_name(
            os.path.basename(urllib.parse.urlsplit(url).path)),
        'azure_storage': bool(_AZURE_BLOB_HOST_RE.match(host)),
    }


def storage_url_for(url: str) -> Optional[str]:
    """Return a storage URL SQL can use, or ``None`` when staging is needed.

    Only Azure Blob / ADLS endpoints are reported: an arbitrary public web
    server cannot be read by SQL Server, Azure SQL or Fabric, and pretending
    otherwise would produce a script that never runs.
    """
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return None
    scheme = parsed.scheme.lower()
    if scheme in VIRTUALISABLE_SCHEMES:
        return url
    if scheme != 'https':
        return None
    if _AZURE_BLOB_HOST_RE.match(parsed.hostname or ''):
        return url
    return None


# ---------------------------------------------------------------------------
# Bounded anonymous Azure Blob listing (folder / wildcard candidates)
# ---------------------------------------------------------------------------

MAX_BLOB_LIST_RESULTS = 200


def azure_blob_parts(url: str) -> Optional[Tuple[str, str, str]]:
    """Split an Azure storage URL into ``(https_root, container, prefix)``.

    Accepts ``https://acct.blob.core.windows.net/container/path`` as well as
    the ``abs://``/``adls://``/``abfss://``/``wasbs://`` forms that put the
    container in the user-info position.  Returns ``None`` when *url* is not
    an Azure storage location.
    """
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return None

    scheme = parsed.scheme.lower()
    host = parsed.hostname or ''
    path = parsed.path.lstrip('/')

    if scheme == 'https':
        if not _AZURE_BLOB_HOST_RE.match(host):
            return None
        container, _, prefix = path.partition('/')
    elif scheme in ('abs', 'adls', 'abfss', 'wasbs'):
        if not _AZURE_BLOB_HOST_RE.match(host):
            return None
        container = parsed.username or ''
        prefix = path
        if not container:
            container, _, prefix = path.partition('/')
    else:
        return None

    if not container:
        return None
    account = host.split('.', 1)[0]
    return f'https://{account}.blob.core.windows.net', container, prefix


def _listable_prefix(prefix: str) -> str:
    """Trim a wildcard/pattern suffix down to a literal listing prefix."""
    for index, char in enumerate(prefix):
        if char in '*?[':
            return prefix[:index].rsplit('/', 1)[0] + '/' if '/' in \
                prefix[:index] else ''
    return prefix


def list_public_blobs(url: str, max_results: int = MAX_BLOB_LIST_RESULTS,
                      opener=None) -> List[Dict[str, Any]]:
    """List a bounded page of blobs under a public (anonymous) container.

    Only used to find one representative file for metadata analysis; the
    documented dataset URL is what ends up in the generated SQL.
    """
    import xml.etree.ElementTree as ElementTree

    parts = azure_blob_parts(url)
    if parts is None:
        _reject('That location is not an Azure Blob or ADLS URL.',
                code='not_azure_storage')
        return []                                      # pragma: no cover
    root, container, prefix = parts

    query = urllib.parse.urlencode({
        'restype': 'container',
        'comp': 'list',
        'prefix': _listable_prefix(prefix),
        'maxresults': max(1, min(int(max_results), MAX_BLOB_LIST_RESULTS)),
    })
    listing_url = f'{root}/{urllib.parse.quote(container)}?{query}'
    xml_text = fetch_text(listing_url, opener=opener)

    try:
        tree = ElementTree.fromstring(xml_text)
    except ElementTree.ParseError:
        _reject('The container listing response could not be parsed. The '
                'container may not allow anonymous listing.',
                status=502, code='listing_failed')
        return []                                      # pragma: no cover

    blobs: List[Dict[str, Any]] = []
    for blob in tree.iter('Blob'):
        name_element = blob.find('Name')
        if name_element is None or not name_element.text:
            continue
        name = name_element.text
        size_element = blob.find('./Properties/Content-Length')
        try:
            size = int(size_element.text) if size_element is not None and \
                size_element.text else None
        except (TypeError, ValueError):
            size = None
        blobs.append({
            'name': name,
            'size': size,
            'url': f'{root}/{urllib.parse.quote(container)}/'
                   f'{urllib.parse.quote(name)}',
            'extension': data_extension(name),
        })
    return blobs


def first_supported_blob(url: str, max_results: int = MAX_BLOB_LIST_RESULTS,
                         max_bytes: int = MAX_DOWNLOAD_BYTES,
                         opener=None) -> Optional[Dict[str, Any]]:
    """Return the first publicly listed, supported, small-enough blob."""
    for blob in list_public_blobs(url, max_results=max_results,
                                  opener=opener):
        if not blob['extension']:
            continue
        if blob['size'] is not None and blob['size'] > max_bytes:
            continue
        if blob['size'] == 0:
            continue
        return blob
    return None