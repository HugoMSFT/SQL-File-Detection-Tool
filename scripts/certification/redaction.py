"""Redaction of secrets and environment identifiers.

Two different jobs share this module, and it is worth keeping them apart.

:class:`Redactor` is an *output filter*. Everything the harness writes — JSON
evidence, JUnit XML, Markdown, log lines, error messages coming back from the
server — passes through it, so an artifact can be committed or pasted into a
review without leaking a password, a SAS token, a server hostname, an IP
address or a local absolute path.

:func:`secret_findings` is an *input assertion*. It answers "does this text look
like it contains a live secret?" and is used by the safety gate to refuse to
execute generated SQL that carries real credential material, and by the test
suite to prove the harness cannot emit secret-shaped output.

The distinction matters: the filter is allowed to be aggressive and lossy, the
assertion must be precise enough not to fire on the generator's placeholder
tokens such as ``<SAS_token_without_leading_?>``.
"""

from __future__ import annotations

import datetime
import decimal
import hashlib
import math
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Pattern, Sequence, Set, Tuple

#: Hosts whose names may survive redaction because they are public, documented
#: Microsoft sample data and carry no tenant information.
PUBLIC_HOSTS = (
    'azureopendatastorage.blob.core.windows.net',
    'azureopendatastorage.dfs.core.windows.net',
    # Maintained, anonymously readable Microsoft endpoints used as live
    # certification fixtures. Scrubbing them would make the evidence
    # irreproducible for no privacy gain: they belong to Microsoft, are
    # documented publicly, and carry no tenant of ours.
    'azcliprod.blob.core.windows.net',
    'openvmmghtestresults.blob.core.windows.net',
    'openvmmghtestresults.dfs.core.windows.net',
)

#: Placeholder shapes the generator emits on purpose. These are *not* secrets.
PLACEHOLDER_RE = re.compile(r'<[^<>\n]{1,80}>')

_REDACTION = '[redacted]'

# --------------------------------------------------------------------------
# Output filter
# --------------------------------------------------------------------------

#: (name, pattern, replacement-template). ``\g<0>`` style backreferences let a
#: rule keep the keyword and drop only the value.
_FILTERS: Tuple[Tuple[str, Pattern[str], str], ...] = (
    (
        # Azure SQL's transient-failure messages end with a session tracing ID:
        # "contact customer support, and provide them the session tracing ID of
        # {2B8...}". It identifies the connection, so it does not belong in a
        # committed artifact even though it is not a secret.
        'session_tracing_id',
        re.compile(
            r'\b(session\s+(?:tracing\s+)?id|trace\s+id)\b\s*(?:of|[:=])?\s*'
            r'\{?[0-9A-Fa-f]{8}-?(?:[0-9A-Fa-f]{4}-?){3}[0-9A-Fa-f]{12}\}?'
            r'|\bsession\s+id\s*[:=]\s*0x[0-9A-Fa-f]+',
            re.IGNORECASE,
        ),
        'session tracing ID ' + _REDACTION,
    ),
    (
        'sql_secret',
        re.compile(r"(\bSECRET\s*=\s*)'(?:[^']|'')*'", re.IGNORECASE),
        r"\1'" + _REDACTION + "'",
    ),
    (
        'sql_password',
        re.compile(r"(\b(?:ENCRYPTION\s+BY\s+)?PASSWORD\s*=\s*)'(?:[^']|'')*'", re.IGNORECASE),
        r"\1'" + _REDACTION + "'",
    ),
    (
        'conn_password',
        re.compile(r'\b(PWD|Password)\s*=\s*[^;"\'\s]+', re.IGNORECASE),
        r'\1=' + _REDACTION,
    ),
    (
        'conn_user',
        re.compile(r'\b(UID|User\s*ID)\s*=\s*[^;"\'\s]+', re.IGNORECASE),
        r'\1=' + _REDACTION,
    ),
    (
        'conn_server',
        re.compile(r'\b(Server|Data\s*Source)\s*=\s*[^;"\'\s]+', re.IGNORECASE),
        r'\1=' + _REDACTION,
    ),
    (
        'sas_token',
        re.compile(r'\b(sig|se|st|sp|sv|srt|ss|skoid|sktid|spr)=[A-Za-z0-9%\-_:+/.]{4,}', re.IGNORECASE),
        r'\1=' + _REDACTION,
    ),
    (
        'bearer',
        re.compile(r'\bBearer\s+[A-Za-z0-9._\-]{20,}', re.IGNORECASE),
        'Bearer ' + _REDACTION,
    ),
    (
        'jwt',
        re.compile(r'\beyJ[A-Za-z0-9._\-]{20,}'),
        _REDACTION,
    ),
    (
        'account_key',
        re.compile(r'\b[A-Za-z0-9+/]{60,}={0,2}\b'),
        _REDACTION,
    ),
    (
        'sql_endpoint',
        re.compile(r'\b[A-Za-z0-9\-]+\.database\.windows\.net\b', re.IGNORECASE),
        '[sql-endpoint]',
    ),
    (
        'storage_endpoint',
        re.compile(
            r'\b[A-Za-z0-9\-]+\.(?:blob|dfs|file|queue|table)\.core\.windows\.net\b',
            re.IGNORECASE,
        ),
        '[storage-endpoint]',
    ),
    (
        'ipv4',
        re.compile(r'\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b'),
        '[ip]',
    ),
    (
        'windows_path',
        re.compile(r'\b[A-Za-z]:\\\\?[^\s\'"<>|]{2,}'),
        '[path]',
    ),
    (
        'posix_home',
        re.compile(r'/(?:home|Users)/[^\s\'"<>|]+'),
        '[path]',
    ),
    (
        'unc_path',
        re.compile(r'\\\\[A-Za-z0-9._\-]+\\[^\s\'"<>|]+'),
        '[unc-path]',
    ),
)


# --------------------------------------------------------------------------
# Value normalisation
# --------------------------------------------------------------------------

#: Longest binary prefix written out literally. Thirty-two bytes reproduces the
#: VARBINARY fixtures the matrix asserts on while keeping an unexpected blob
#: from ever reaching an artifact in full.
MAX_BINARY_PREFIX = 32

#: Longest rendering of a value with no better representation than ``str()``.
MAX_TEXT = 512


def _binary_literal(raw: bytes) -> str:
    if len(raw) <= MAX_BINARY_PREFIX:
        return '0x' + raw.hex().upper()
    digest = hashlib.sha256(raw).hexdigest()[:16]
    return (
        '0x' + raw[:MAX_BINARY_PREFIX].hex().upper()
        + f'... [{len(raw)} bytes, sha256 {digest}]'
    )


def normalize_value(value: Any, *, textual: bool = False) -> Any:
    """Coerce a driver value into something JSON, XML and Markdown can carry.

    Database drivers return ``bytes``, ``Decimal``, ``datetime`` and UUID
    objects. ``json.dump`` refuses every one of them, which is how a completed
    certification run lost its evidence at report-writing time, and the two
    renderers that do not go through JSON would have written a raw ``b'\\xde'``
    repr into a report rather than failing loudly.

    The mapping is total and deterministic:

    * ``bytes`` become an uppercase ``0x`` literal, the same form SQL Server
      displays and the matrix asserts on, truncated past
      :data:`MAX_BINARY_PREFIX` with the true length and a digest. Content is
      never sniffed for text: guessing would turn the VARBINARY fixture
      ``0x41424344`` into ``'ABCD'`` and pass an assertion that should fail.
      A caller that *knows* the column is text passes ``textual=True``, which
      decodes UTF-8 with replacement instead.
    * ``Decimal`` becomes a string rather than a float, because the matrix
      asserts the uint64 boundary 18446744073709551615, which no float holds.
    * dates, times, intervals and UUIDs become their canonical text form.
    * a non-finite float becomes text: ``json.dump`` writes bare ``NaN`` and
      ``Infinity``, which no other JSON reader accepts.

    Every result is a string, number, bool, ``None``, or a container of those,
    so redaction - which only rewrites strings - can still reach all of it.
    """
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        return raw.decode('utf-8', errors='replace') if textual else _binary_literal(raw)
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, datetime.timedelta):
        return str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, dict):
        return {
            str(key): normalize_value(item, textual=textual)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple, set)):
        return [normalize_value(item, textual=textual) for item in value]
    text = str(value)
    if len(text) > MAX_TEXT:
        return text[:MAX_TEXT] + f'... [{len(text)} characters]'
    return text


#: Below this length a literal is more likely to be a fragment of ordinary SQL
#: than an identifier worth hiding. ``sql``, ``dev`` and ``db`` are the ones
#: this actually keeps out.
_LITERAL_MIN_LENGTH = 4

#: Names that identify nothing. The four system databases are called the same
#: thing on every SQL Server in the world, and the rest are the placeholder
#: names people give a scratch database. Redacting them would blank ordinary
#: English out of error messages ("master key", "test data") while protecting
#: nobody.
NON_SECRET_LITERALS = frozenset({
    'master', 'model', 'msdb', 'tempdb',
    'data', 'test', 'demo', 'main', 'temp', 'public', 'default', 'sample',
})


def _usable_literals(literals: Iterable[Any]) -> Set[str]:
    """The subset of *literals* worth substituting."""
    usable: Set[str] = set()
    for literal in literals:
        if not literal:
            continue
        text = str(literal)
        if len(text) < _LITERAL_MIN_LENGTH:
            continue
        if text.strip().lower() in NON_SECRET_LITERALS:
            continue
        usable.add(text)
    return usable


@dataclass
class Redactor:
    """Filters secrets and environment identifiers out of harness artifacts.

    ``extra_literals`` holds values the caller knows are sensitive but that no
    pattern would catch — typically the login name and server host taken from
    the environment. They are replaced first, longest match first, so a short
    value that is a substring of a longer one cannot leave a fragment behind.

    Two literals are deliberately *not* honoured: anything shorter than
    :data:`_LITERAL_MIN_LENGTH`, and the common names in
    :data:`NON_SECRET_LITERALS`. A run against ``master`` would otherwise put
    ``[redacted]`` through every ``CREATE MASTER KEY`` and every "master key
    does not exist" error in the evidence, which destroys exactly the record the
    harness exists to produce — and it protects nothing, because ``master`` is
    the same name on every SQL Server ever installed. The trade is explicit: a
    login that is literally called ``test`` is not masked by this list.
    """

    extra_literals: Sequence[str] = field(default_factory=tuple)
    keep_public_hosts: bool = True

    def redact(self, value: str) -> str:
        if not value:
            return value
        text = str(value)

        placeholders: Dict[str, str] = {}
        if self.keep_public_hosts:
            for idx, host in enumerate(PUBLIC_HOSTS):
                token = f'\x00PUBLICHOST{idx}\x00'
                if host.lower() in text.lower():
                    text = re.sub(re.escape(host), token, text, flags=re.IGNORECASE)
                    placeholders[token] = host

        for literal in sorted(_usable_literals(self.extra_literals),
                              key=len, reverse=True):
            text = re.sub(re.escape(str(literal)), _REDACTION, text, flags=re.IGNORECASE)

        for _name, pattern, replacement in _FILTERS:
            text = pattern.sub(replacement, text)

        for token, host in placeholders.items():
            text = text.replace(token, host)
        return text

    def redact_obj(self, obj):
        """Recursively redact strings inside dicts / lists / tuples.

        Anything that is not already a JSON scalar is normalised first, so a
        driver-native value cannot slip through unredacted and cannot reach a
        serialiser that would refuse it.
        """
        if isinstance(obj, str):
            return self.redact(obj)
        if isinstance(obj, dict):
            return {str(key): self.redact_obj(value) for key, value in obj.items()}
        if isinstance(obj, (list, tuple, set)):
            return [self.redact_obj(item) for item in obj]
        if obj is None or isinstance(obj, (bool, int)):
            return obj
        if isinstance(obj, float) and math.isfinite(obj):
            return obj
        normalized = normalize_value(obj)
        return self.redact(normalized) if isinstance(normalized, str) else normalized


# --------------------------------------------------------------------------
# Input assertion
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class SecretFinding:
    """One piece of secret-shaped text found in a document."""

    kind: str
    line: int
    excerpt: str


#: Patterns that indicate *real* credential material rather than a placeholder.
_SECRET_SHAPES: Tuple[Tuple[str, Pattern[str]], ...] = (
    ('sas_signature', re.compile(r'\bsig=[A-Za-z0-9%+/=]{10,}', re.IGNORECASE)),
    ('bearer_token', re.compile(r'\bBearer\s+[A-Za-z0-9._\-]{20,}', re.IGNORECASE)),
    ('jwt', re.compile(r'\beyJ[A-Za-z0-9._\-]{20,}')),
    ('storage_account_key', re.compile(r'\b[A-Za-z0-9+/]{60,}={0,2}\b')),
    ('connection_password', re.compile(r'\b(?:PWD|Password)\s*=\s*(?!\s*$)[^;\s\'"<]{3,}', re.IGNORECASE)),
    ('inline_secret', re.compile(r"\bSECRET\s*=\s*'(?!\s*<)(?:[^']|'')*'", re.IGNORECASE)),
    ('inline_password', re.compile(r"\bPASSWORD\s*=\s*'(?!\s*<)(?:[^']|'')*'", re.IGNORECASE)),
)


def secret_findings(text: str) -> List[SecretFinding]:
    """Return secret-shaped fragments in ``text``.

    Placeholder tokens (``<...>``) are removed before matching, so the
    generator's deliberate ``SECRET = '<SAS_token_without_leading_?>'`` is not
    reported while a real token in the same position is.
    """
    if not text:
        return []
    findings: List[SecretFinding] = []
    for line_no, line in enumerate(text.split('\n'), start=1):
        probe = PLACEHOLDER_RE.sub('<>', line)
        for kind, pattern in _SECRET_SHAPES:
            match = pattern.search(probe)
            if match:
                findings.append(
                    SecretFinding(kind=kind, line=line_no, excerpt=_excerpt(match.group(0)))
                )
    return findings


def _excerpt(value: str) -> str:
    """Describe a secret without reproducing it."""
    head = value[:12].split('=')[0]
    return f'{head}=<{len(value)} chars>'


def assert_no_secrets(text: str, *, context: str = 'document') -> None:
    """Raise when ``text`` carries secret-shaped material."""
    findings = secret_findings(text)
    if findings:
        kinds = ', '.join(sorted({f.kind for f in findings}))
        raise ValueError(f'{context} contains secret-shaped material: {kinds}')


def redact_iterable(values: Iterable[str], redactor: Redactor) -> List[str]:
    return [redactor.redact(v) for v in values]
