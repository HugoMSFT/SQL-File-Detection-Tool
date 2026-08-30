"""SQL DDL generator for external file formats and tables."""

import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse


@dataclass
class ExternalFileFormatConfig:
    """Configuration for external file format."""
    format_type: str
    field_terminator: Optional[str] = None
    string_delimiter: Optional[str] = None
    date_format: Optional[str] = None
    use_type_default: bool = False
    encoding: str = 'UTF8'
    first_row: int = 1
    data_compression: Optional[str] = None
    serde_method: Optional[str] = None


#: Canonical product-wide default SQL target platform.
#:
#: Every entry point (CLI, Flask API, web UI, VS Code extension) resolves an
#: unspecified ``target_platform`` to this single constant so the default can
#: never drift between layers. Explicit platform selection is untouched.
DEFAULT_TARGET_PLATFORM = 'azure_sql_db'


_S3_SCHEMES = frozenset({'s3', 's3a', 's3n'})

# Platforms whose OPENROWSET(BULK ...)/BULK INSERT can reach S3-compatible
# object storage. SQL Server 2019 and the Azure SQL family cannot.
S3_BULK_PLATFORMS = frozenset({'sql_server_2022', 'sql_server_2025'})


def _storage_url_kind(storage_url: Optional[str]) -> str:
    """Classify *storage_url* as ``azure``/``s3``/``onelake``/``other``/``local``.

    Used to decide whether a platform can reach the file at all, and which kind
    of external data source the generated script must reference. A local path
    (or an empty value) is reported as ``local``.
    """
    if not storage_url:
        return 'local'

    normalized = str(storage_url).strip().replace('\\', '/')
    parsed = urlparse(normalized)
    scheme = parsed.scheme.lower()
    host = (parsed.netloc or '').lower()

    if scheme in _S3_SCHEMES:
        return 's3'
    if 'fabric.microsoft.com' in host or host.startswith('onelake.'):
        return 'onelake'
    if scheme in _AZURE_STORAGE_SCHEMES or scheme == 'azure':
        return 'azure'
    if scheme in {'http', 'https'} and (
        host.endswith('.blob.core.windows.net')
        or host.endswith('.dfs.core.windows.net')
    ):
        return 'azure'
    if scheme in {'http', 'https', 'gs', 'ftp'}:
        return 'other'
    return 'local'


def _sql_server_storage_parts(storage_url: Optional[str], file_name: str,
                              target_platform: str) -> Tuple[str, str]:
    """Return a SQL Server external data source location and relative file path."""
    fallback_name = os.path.basename(str(file_name).replace('\\', '/')) or '<file>'
    is_2019 = target_platform == 'sql_server_2019'
    default_location = (
        'wasbs://<container>@<storage_account>.blob.core.windows.net'
        if is_2019
        else 'adls://<container>@<storage_account>.dfs.core.windows.net'
    )
    default_path = f'<path>/{fallback_name}'

    if not storage_url:
        return default_location, default_path

    normalized = str(storage_url).strip().replace('\\', '/')
    parsed = urlparse(normalized)
    scheme = parsed.scheme.lower()
    host = parsed.netloc
    path = parsed.path.strip('/')

    scheme_map = {
        'abs': 'wasbs' if is_2019 else 'abs',
        'wasb': 'wasbs' if is_2019 else 'abs',
        'wasbs': 'wasbs' if is_2019 else 'abs',
        'adls': 'abfss' if is_2019 else 'adls',
        'abfs': 'abfss' if is_2019 else 'adls',
        'abfss': 'abfss' if is_2019 else 'adls',
    }
    if scheme in scheme_map and host:
        target_scheme = scheme_map[scheme]
        relative_path = path
        if '@' not in host and path:
            container, separator, remainder = path.partition('/')
            host = f'{container}@{host}'
            relative_path = remainder if separator else ''
        return (
            f'{target_scheme}://{host}',
            relative_path or fallback_name,
        )

    if scheme == 'https' and host:
        container, separator, remainder = path.partition('/')
        lower_host = host.lower()
        if lower_host.endswith('.dfs.core.windows.net'):
            target_scheme = 'abfss' if is_2019 else 'adls'
        elif lower_host.endswith('.blob.core.windows.net'):
            target_scheme = 'wasbs' if is_2019 else 'abs'
        else:
            return default_location, path or fallback_name
        source_host = f'{container}@{host}' if container else host
        return (
            f'{target_scheme}://{source_host}',
            remainder if separator and remainder else fallback_name,
        )

    if scheme == 's3' and host and not is_2019:
        return f's3://{host}', path or fallback_name

    if scheme == 'azure' and host:
        # Internal ``azure://<container>/<path>`` URL produced by the Azure
        # storage handler. The account name is unknown, so emit a placeholder
        # source root and keep only the container-relative path.
        target_scheme = 'wasbs' if is_2019 else 'abs'
        account = '<storage_account>.blob.core.windows.net'
        return f'{target_scheme}://{host}@{account}', path or fallback_name

    if scheme in {'http', 'https', 's3', 'gs'}:
        # Unknown remote endpoint: never leak an absolute URL into BULK/LOCATION.
        return default_location, path or fallback_name

    return default_location, normalized.lstrip('/') or fallback_name


# ----------------------------------------------------------------------
# Azure SQL Database / Managed Instance storage helpers
# ----------------------------------------------------------------------

_AZURE_PLACEHOLDER_ACCOUNT = '<storage_account>.dfs.core.windows.net'
_AZURE_STORAGE_SCHEMES = frozenset(
    {'abs', 'wasb', 'wasbs', 'adls', 'abfs', 'abfss'}
)


_CLOUD_URL_SCHEMES = frozenset(
    {'abs', 'wasb', 'wasbs', 'adls', 'abfs', 'abfss', 'azure',
     's3', 's3a', 's3n', 'gs', 'http', 'https', 'onelake'}
)


def _looks_like_cloud_url(storage_url: Optional[str]) -> bool:
    """Return True when *storage_url* points at remote object storage."""
    if not storage_url:
        return False
    scheme = urlparse(str(storage_url).strip().replace('\\', '/')).scheme.lower()
    return scheme in _CLOUD_URL_SCHEMES


def _parse_azure_storage_url(storage_url: Optional[str],
                             file_name: str) -> Tuple[str, str, str]:
    """Split an Azure storage URL into ``(account_host, container, rel_path)``.

    Placeholders are returned for any part that cannot be derived, so generated
    SQL never embeds a local path or an absolute URL where a container-relative
    path is required.
    """
    fallback_name = os.path.basename(str(file_name).replace('\\', '/')) or '<file>'
    default = (
        _AZURE_PLACEHOLDER_ACCOUNT,
        '<container>',
        f'<path>/{fallback_name}',
    )
    if not storage_url:
        return default

    normalized = str(storage_url).strip().replace('\\', '/')
    parsed = urlparse(normalized)
    scheme = parsed.scheme.lower()
    host = parsed.netloc
    path = parsed.path.strip('/')

    if scheme in _AZURE_STORAGE_SCHEMES and host:
        if '@' in host:
            container, _, account = host.partition('@')
            return (
                account or _AZURE_PLACEHOLDER_ACCOUNT,
                container or '<container>',
                path or fallback_name,
            )
        container, separator, remainder = path.partition('/')
        return (
            host,
            container or '<container>',
            (remainder if separator else '') or fallback_name,
        )

    lower_host = host.lower()
    if scheme in {'http', 'https'} and (
        lower_host.endswith('.blob.core.windows.net')
        or lower_host.endswith('.dfs.core.windows.net')
    ):
        container, separator, remainder = path.partition('/')
        return (
            host,
            container or '<container>',
            (remainder if separator else '') or fallback_name,
        )

    if scheme == 'azure' and host:
        return _AZURE_PLACEHOLDER_ACCOUNT, host, path or fallback_name

    return default


def _azure_bulk_storage_parts(storage_url: Optional[str],
                              file_name: str) -> Tuple[str, str]:
    """Return an HTTPS BLOB_STORAGE container root and container-relative path.

    ``BULK INSERT`` and ``OPENROWSET(BULK ...)`` bulk access to Azure Blob
    Storage require a ``DATA_SOURCE`` created with ``TYPE = BLOB_STORAGE`` whose
    ``LOCATION`` is an ``https://`` blob-endpoint URL, and a ``FROM``/``BULK``
    value relative to it. This applies to SQL Server 2017 and later as well as
    to Azure SQL Database / Managed Instance; ``abs://`` and ``adls://``
    locations are *not* accepted by a bulk data source.
    """
    account, container, relative_path = _parse_azure_storage_url(
        storage_url, file_name
    )
    blob_host = re.sub(
        r'\.dfs\.core\.windows\.net$',
        '.blob.core.windows.net',
        account,
        flags=re.IGNORECASE,
    )
    return f'https://{blob_host}/{container}', relative_path


def _azure_virtualization_parts(storage_url: Optional[str],
                                file_name: str) -> Tuple[str, str]:
    """Return an ``abs://``/``adls://`` data source location and relative path.

    Azure SQL data virtualization (``OPENROWSET``/``CREATE EXTERNAL TABLE``)
    requires the external data source ``LOCATION`` to use the ``abs://`` or
    ``adls://`` prefix rather than ``https://``.
    """
    account, container, relative_path = _parse_azure_storage_url(
        storage_url, file_name
    )
    prefix = (
        'adls' if account.lower().endswith('.dfs.core.windows.net') else 'abs'
    )
    return f'{prefix}://{container}@{account}', relative_path


# ----------------------------------------------------------------------
# Microsoft Fabric OneLake helpers
# ----------------------------------------------------------------------

FABRIC_DEFAULT_SOURCE_LOCATION = (
    'abfss://<workspace_id>@<tenant>.dfs.fabric.microsoft.com/'
    '<lakehouse_id>/Files'
)


def _fabric_onelake_parts(storage_url: Optional[str],
                          file_name: str) -> Tuple[str, str]:
    """Split a OneLake path into a ``.../Files`` source root and relative path.

    Fabric SQL Database data virtualization targets a Lakehouse ``Files``
    section, so the external data source stops at ``/Files`` and the
    ``OPENROWSET``/``CREATE EXTERNAL TABLE`` path is relative to it.
    """
    fallback_name = os.path.basename(str(file_name).replace('\\', '/')) or '<file>'
    default = (FABRIC_DEFAULT_SOURCE_LOCATION, f'<path>/{fallback_name}')
    if not storage_url:
        return default

    normalized = str(storage_url).strip().replace('\\', '/')
    parsed = urlparse(normalized)
    scheme = parsed.scheme.lower()
    host = parsed.netloc
    path = parsed.path.strip('/')

    if scheme in {'abfs', 'abfss'} and host:
        root, separator, remainder = _split_on_files_segment(path)
        if not separator:
            return default
        return f'abfss://{host}/{root}', remainder or fallback_name

    if scheme in {'http', 'https'} and host and 'fabric.microsoft.com' in host.lower():
        workspace, separator, remainder = path.partition('/')
        if not separator:
            return default
        root, files_separator, tail = _split_on_files_segment(remainder)
        if not files_separator:
            return default
        return (
            f'abfss://{workspace}@{host}/{root}',
            tail or fallback_name,
        )

    return default


def _split_on_files_segment(path: str) -> Tuple[str, bool, str]:
    """Split ``path`` on its first ``Files`` segment (inclusive)."""
    segments = path.split('/')
    for index, segment in enumerate(segments):
        if segment.lower() == 'files':
            return (
                '/'.join(segments[:index + 1]),
                True,
                '/'.join(segments[index + 1:]),
            )
    return path, False, ''


# ----------------------------------------------------------------------
# Arrow / pandas type parsing
# ----------------------------------------------------------------------

_UNIT_PRECISION = {'s': 0, 'ms': 3, 'us': 6, 'ns': 7}

_STRUCTURAL_TYPE_RE = re.compile(
    r'^(struct|list|large_list|fixed_size_list|map|union|dense_union|'
    r'sparse_union|dictionary)\s*[<(]'
)
_STRUCTURAL_TYPE_NAMES = frozenset({
    'struct', 'list', 'large_list', 'fixed_size_list', 'map', 'union',
    'dense_union', 'sparse_union', 'dictionary', 'dict', 'object[]',
})
_DECIMAL_TYPE_RE = re.compile(
    r'^(?:decimal128|decimal256|decimal|numeric)\s*\(\s*(\d+)\s*'
    r'(?:,\s*(-?\d+)\s*)?\)$'
)
_TIMESTAMP_TYPE_RE = re.compile(
    r'^(?:timestamp|datetime64)\s*\[\s*(s|ms|us|ns)\s*(?:,\s*(.+?)\s*)?\]$'
)
_TIME_TYPE_RE = re.compile(r'^time(?:32|64)?\s*\[\s*(s|ms|us|ns)\s*\]$')

MAX_SQL_DECIMAL_PRECISION = 38


def _is_structural_type(lowered: str) -> bool:
    """Return True for Arrow container types that must serialise as text."""
    return (
        lowered in _STRUCTURAL_TYPE_NAMES
        or bool(_STRUCTURAL_TYPE_RE.match(lowered))
    )


def _decimal_sql_type(lowered: str) -> Optional[str]:
    """Map ``decimal(p,s)``-style types to a SQL Server DECIMAL, else None."""
    match = _DECIMAL_TYPE_RE.match(lowered)
    if not match:
        return None
    precision = int(match.group(1))
    scale = int(match.group(2)) if match.group(2) is not None else 0
    if scale < 0:
        # A negative scale widens the integer part; SQL Server has no
        # equivalent, so absorb it into the precision.
        precision += -scale
        scale = 0
    if precision < 1 or precision > MAX_SQL_DECIMAL_PRECISION or scale > precision:
        return 'NVARCHAR(MAX)'
    return f'DECIMAL({precision},{scale})'


def _temporal_sql_type(lowered: str) -> Optional[str]:
    """Map Arrow/pandas timestamp and time types to SQL Server types."""
    match = _TIMESTAMP_TYPE_RE.match(lowered)
    if match:
        precision = _UNIT_PRECISION[match.group(1)]
        timezone = (match.group(2) or '').strip()
        if timezone:
            return f'DATETIMEOFFSET({precision})'
        return f'DATETIME2({precision})'

    match = _TIME_TYPE_RE.match(lowered)
    if match:
        return f'TIME({_UNIT_PRECISION[match.group(1)]})'
    return None


class SQLGenerator:
    """Generates T-SQL statements for CREATE TABLE, BULK INSERT, OPENROWSET, and CREATE EXTERNAL TABLE."""

    # Mapping from detected types to SQL Server data types
    TYPE_MAPPING = {
        'int64':         'BIGINT',
        'int32':         'INT',
        'int16':         'SMALLINT',
        'int8':          'SMALLINT',   # Arrow int8 is signed; TINYINT is unsigned
        'int':           'INT',
        'uint64':        'DECIMAL(20,0)',
        'uint32':        'BIGINT',
        'uint16':        'INT',
        'uint8':         'TINYINT',    # Arrow uint8 matches SQL Server TINYINT
        'float64':       'FLOAT',
        'float32':       'REAL',
        'float':         'FLOAT',
        'double':        'FLOAT',
        'half_float':    'REAL',
        'bool':          'BIT',
        'boolean':       'BIT',
        'object':        'NVARCHAR(255)',
        'str':           'NVARCHAR(255)',
        'string':        'NVARCHAR(255)',
        'large_string':  'NVARCHAR(MAX)',
        'datetime64[ns]':'DATETIME2(7)',
        'datetime64[us]':'DATETIME2(6)',
        'timestamp[us]': 'DATETIME2(6)',
        'timestamp[ns]': 'DATETIME2(7)',
        'timestamp':     'DATETIME2(7)',
        'timestamptz':   'DATETIMEOFFSET(7)',
        'datetime64':    'DATETIME2(7)',
        'date32':        'DATE',
        'date64':        'DATE',
        'date':          'DATE',
        'time':          'TIME(7)',
        'time64[us]':    'TIME(6)',
        'decimal128':    'DECIMAL(38,10)',
        'decimal256':    'NVARCHAR(MAX)',   # up to 76 digits; exceeds DECIMAL(38)
        'binary':        'VARBINARY(MAX)',
        'large_binary':  'VARBINARY(MAX)',
        'list':          'NVARCHAR(MAX)',        # JSON serialised
        'struct':        'NVARCHAR(MAX)',        # JSON serialised
        'dict':          'NVARCHAR(MAX)',
        'map':           'NVARCHAR(MAX)',
        'union':         'NVARCHAR(MAX)',
        'null':          'NVARCHAR(255)',
    }

    # Delimiter display names for comments
    DELIMITER_NAMES = {
        ',':  'comma',
        '\t': 'tab',
        '|':  'pipe',
        ';':  'semicolon',
        ' ':  'space',
    }

    # Supported target platforms
    PLATFORMS = (
        'sql_server_2019', 'sql_server_2022', 'sql_server_2025',
        'azure_sql_db', 'azure_sql_mi',
        'fabric_sql_db',
    )

    #: Product-wide default platform, mirrored from the module constant so
    #: callers holding a generator instance need not import it separately.
    DEFAULT_PLATFORM = DEFAULT_TARGET_PLATFORM

    @staticmethod
    def normalize_platform(target_platform: Optional[str]) -> str:
        """Return a supported platform, falling back to the product default."""
        if target_platform in SQLGenerator.PLATFORMS:
            return target_platform
        return DEFAULT_TARGET_PLATFORM

    # Feature availability per platform.
    # Each key maps to a frozenset of platforms that support it.
    PLATFORM_FEATURES = {
        'create_table': frozenset({
            'sql_server_2019', 'sql_server_2022', 'sql_server_2025',
            'azure_sql_db', 'azure_sql_mi',
            'fabric_sql_db',
        }),
        'bulk_insert': frozenset({
            'sql_server_2019', 'sql_server_2022', 'sql_server_2025',
            'azure_sql_db', 'azure_sql_mi',
        }),
        'openrowset': frozenset({
            'sql_server_2019', 'sql_server_2022', 'sql_server_2025',
            'azure_sql_db', 'azure_sql_mi',
            'fabric_sql_db',
        }),
        'openrowset_format_keyword': frozenset({ # OPENROWSET(BULK ..., FORMAT = ...)
            'sql_server_2022', 'sql_server_2025',
            'azure_sql_db', 'azure_sql_mi',
            'fabric_sql_db',
        }),
        'openrowset_bulk_local': frozenset({     # OPENROWSET(BULK '\\path')  local files
            'sql_server_2019', 'sql_server_2022', 'sql_server_2025',
        }),
        'openrowset_data_source': frozenset({    # OPENROWSET(BULK ..., DATA_SOURCE = ds)
            'sql_server_2022', 'sql_server_2025',
            'azure_sql_db', 'azure_sql_mi',
            'fabric_sql_db',
        }),
        'external_table': frozenset({
            'sql_server_2019', 'sql_server_2022', 'sql_server_2025',
            'azure_sql_db', 'azure_sql_mi',
            'fabric_sql_db',
        }),
        'credential_setup': frozenset({
            'sql_server_2019', 'sql_server_2022', 'sql_server_2025',
            'azure_sql_db', 'azure_sql_mi',
            'fabric_sql_db',
        }),
        'json_openjson': frozenset({             # OPENJSON, JSON_VALUE, JSON_QUERY, ISJSON
            'sql_server_2019', 'sql_server_2022', 'sql_server_2025',
            'azure_sql_db', 'azure_sql_mi',
            'fabric_sql_db',
        }),
        'json_path_exists': frozenset({          # JSON_PATH_EXISTS  (SQL Server 2022+)
            'sql_server_2022', 'sql_server_2025',
            'azure_sql_db', 'azure_sql_mi',
            'fabric_sql_db',
        }),
        'json_object_array': frozenset({         # JSON_OBJECT / JSON_ARRAY  (SQL Server 2022+)
            'sql_server_2022', 'sql_server_2025',
            'azure_sql_db', 'azure_sql_mi',
            'fabric_sql_db',
        }),
        'for_json': frozenset({
            'sql_server_2019', 'sql_server_2022', 'sql_server_2025',
            'azure_sql_db', 'azure_sql_mi',
            'fabric_sql_db',
        }),
    }

    # Platforms whose external data sources are the SQL Server 2019 PolyBase
    # HADOOP type; only those accept REJECT_TYPE / REJECT_VALUE.
    HADOOP_EXTERNAL_SOURCE_PLATFORMS = frozenset({'sql_server_2019'})

    # Azure SQL family targets that use ``abs://``/``adls://`` data
    # virtualization rather than on-box file access.
    AZURE_SQL_PLATFORMS = frozenset({'azure_sql_db', 'azure_sql_mi'})

    # Human-readable platform labels
    PLATFORM_LABELS = {
        'sql_server_2019': 'SQL Server 2019',
        'sql_server_2022': 'SQL Server 2022',
        'sql_server_2025': 'SQL Server 2025',
        'azure_sql_db': 'Azure SQL Database',
        'azure_sql_mi': 'Azure SQL Managed Instance',
        'fabric_sql_db': 'Microsoft Fabric SQL Database',
    }

    # CREATE EXTERNAL FILE FORMAT availability differs by SQL product and
    # format. JSON is only supported by Azure SQL Edge, which is not one of the
    # targets exposed by this application.
    #
    # Live certification (2026, SQL Server 2025 17.0.4065.4 and Azure SQL
    # Database 12.0.2000.8) confirmed each entry below by creating and dropping
    # the format: DELTA and ORC were accepted on both engines, RCFILE was
    # rejected with error 46506 (invalid FORMAT_TYPE options) and JSON with
    # error 102 (syntax error near 'JSON').
    EXTERNAL_FORMAT_PLATFORMS = {
        'DELIMITEDTEXT': frozenset(PLATFORMS),
        'PARQUET': frozenset({
            'sql_server_2022', 'sql_server_2025',
            'azure_sql_db', 'azure_sql_mi', 'fabric_sql_db',
        }),
        # Delta external file format is available on SQL Server 2022+ and
        # Azure SQL Database, but not on Azure SQL Managed Instance or
        # Fabric SQL Database. Certified live as DDL on SQL Server 2025 and
        # Azure SQL Database.
        'DELTA': frozenset({
            'sql_server_2022', 'sql_server_2025', 'azure_sql_db',
        }),
        # ORC keeps its legacy PolyBase support on SQL Server 2019 and was
        # additionally accepted as DDL on SQL Server 2025 and Azure SQL
        # Database during live certification. The data path was not certified
        # (no maintained public ORC blob), so the generator emits an explicit
        # caveat rather than claiming full support.
        'ORC': frozenset({'sql_server_2019', 'sql_server_2025', 'azure_sql_db'}),
        'RCFILE': frozenset({'sql_server_2019'}),
        'JSON': frozenset(),
    }

    #: Formats whose CREATE EXTERNAL FILE FORMAT statement is certified only as
    #: DDL: the engine accepts and drops the format, but reading data through it
    #: was never proven against a live file.
    DDL_ONLY_CERTIFIED_FORMATS = frozenset({'ORC'})


    # ``FIRST_ROW`` is a CREATE EXTERNAL FILE FORMAT / FORMAT_OPTIONS option on
    # SQL Server 2022+, on Azure SQL Database and on Fabric SQL Database data
    # virtualization. It is not documented for SQL Server 2019 and remains
    # unverified on Azure SQL Managed Instance. Note that ``FIRSTROW`` (no
    # underscore) is a different, widely supported OPENROWSET / BULK INSERT
    # option.
    #
    # Azure SQL Database is included on live evidence rather than on the
    # documentation: certification against Azure SQL Database 12.0.2000.8 showed
    # that omitting FIRST_ROW made an external table over a headered CSV fail
    # with error 4864 (bulk load data conversion error, row 1 column 1, header
    # text converted to float), while the identical format with FIRST_ROW = 2
    # returned all 150 rows. SQL Server 2025 17.0.4065.4 behaved the same way.
    FIRST_ROW_FORMAT_PLATFORMS = frozenset({
        'sql_server_2022', 'sql_server_2025', 'azure_sql_db', 'fabric_sql_db',
    })

    COMPRESSION_CODECS = {
        'SNAPPY': 'org.apache.hadoop.io.compress.SnappyCodec',
        'GZIP': 'org.apache.hadoop.io.compress.GzipCodec',
        'GZ': 'org.apache.hadoop.io.compress.GzipCodec',
        'DEFAULT': 'org.apache.hadoop.io.compress.DefaultCodec',
    }

    def _supports(self, feature: str, platform: str) -> bool:
        """Return True if *platform* supports *feature*."""
        return platform in self.PLATFORM_FEATURES.get(feature, frozenset())

    # ------------------------------------------------------------------
    # Shared reader-option builders
    # ------------------------------------------------------------------

    # Widest option keyword emitted by the CSV reader option builder, so every
    # generated block lines its ``=`` signs up the same way.
    CSV_OPTION_WIDTH = len('FIELDTERMINATOR')

    @classmethod
    def _csv_reader_options(cls, metadata: Dict[str, Any], indent: int = 4,
                            prefix: str = '',
                            trailing_comma: bool = False) -> List[str]:
        """Build the shared CSV reader options from detected file metadata.

        Emits ``FORMAT``, ``FIRSTROW``, ``FIELDTERMINATOR``, ``ROWTERMINATOR``
        and ``CODEPAGE`` so that ``BULK INSERT`` and every ``OPENROWSET``
        variant agree on the detected delimiter, header row and code page. Note
        that ``OPENROWSET``/``BULK INSERT`` use ``FIRSTROW`` (no underscore);
        ``FIRST_ROW`` is a ``CREATE EXTERNAL FILE FORMAT`` option.
        """
        delimiter = metadata.get('delimiter', ',') or ','
        has_header = metadata.get('has_header', True)
        encoding = (metadata.get('encoding') or 'utf-8').upper()
        codepage = metadata.get('codepage', '65001') or '65001'
        delim_escaped = _quote_literal(_display_delimiter(delimiter))
        pad = f'{prefix}{" " * indent}'
        width = cls.CSV_OPTION_WIDTH
        tail = ',' if trailing_comma else ''
        return [
            f'{pad}{"FORMAT":<{width}} = \'CSV\',',
            f'{pad}{"FIRSTROW":<{width}} = {2 if has_header else 1},'
            f'{"        -- skip the header row" if has_header else "        -- no header row detected"}',
            f'{pad}{"FIELDTERMINATOR":<{width}} = \'{delim_escaped}\',',
            f'{pad}{"ROWTERMINATOR":<{width}} = \'0x0a\','
            f'        -- LF (use \'0x0d0a\' for CRLF)',
            f'{pad}{"CODEPAGE":<{width}} = \'{_quote_literal(codepage)}\'{tail}'
            f'  -- {_sql_comment(encoding)}',
        ]

    @staticmethod
    def _json_row_frame_options(indent: int = 4,
                                row_terminator: str = '0x0b') -> List[str]:
        """Options that make the CSV reader return whole JSON text per row.

        This framing is for the *virtualization* connectors (``abs://`` /
        ``adls://``), which reject ``SINGLE_CLOB``/``SINGLE_NCLOB``/
        ``SINGLE_BLOB``. A ``TYPE = BLOB_STORAGE`` data source accepts the
        single-LOB options directly and should use
        :meth:`_json_single_lob_options` instead.
        """
        pad = ' ' * indent
        width = SQLGenerator.CSV_OPTION_WIDTH
        return [
            f'{pad}{"FORMAT":<{width}} = \'CSV\',',
            f'{pad}{"FIELDTERMINATOR":<{width}} = \'0x0b\',',
            f'{pad}{"FIELDQUOTE":<{width}} = \'0x0b\',',
            f'{pad}{"ROWTERMINATOR":<{width}} = \'{row_terminator}\'',
        ]

    #: Encodings whose whole-file OPENROWSET read needs ``SINGLE_NCLOB``.
    #: ``SINGLE_CLOB`` fails with error 4806 ("SINGLE_CLOB requires a double-byte
    #: character set (DBCS) input file; the file specified is Unicode") when the
    #: file is UTF-16, which live certification reproduced against a UTF-16
    #: server-local text file.
    WIDE_TEXT_ENCODINGS = ('UTF-16', 'UTF16', 'UTF_16', 'UCS-2', 'UCS2')

    @classmethod
    def _single_lob_keyword(cls, metadata: Optional[Dict[str, Any]]) -> str:
        """Return ``SINGLE_NCLOB`` for UTF-16 input, else ``SINGLE_CLOB``."""
        encoding = ((metadata or {}).get('encoding') or '').upper()
        normalised = encoding.replace('-', '').replace('_', '')
        if any(normalised.startswith(w.replace('-', '').replace('_', ''))
               for w in cls.WIDE_TEXT_ENCODINGS):
            return 'SINGLE_NCLOB'
        return 'SINGLE_CLOB'

    @classmethod
    def _json_single_lob_options(cls, metadata: Optional[Dict[str, Any]] = None,
                                 indent: int = 4) -> List[str]:
        """Whole-document read options for a ``TYPE = BLOB_STORAGE`` source.

        Live certification against Azure SQL Database 12.0.2000.8 and SQL Server
        2025 17.0.4065.4 read a public blob with
        ``OPENROWSET(BULK '<relative path>', DATA_SOURCE = '<blob storage
        source>', SINGLE_CLOB)`` and got the exact document back on both
        engines, so the single-LOB options do combine with a data source as long
        as that source is ``TYPE = BLOB_STORAGE`` rather than ``abs://``.
        """
        return [f'{" " * indent}{cls._single_lob_keyword(metadata)}']

    @staticmethod
    def _bulk_data_source_supported(target_platform: str,
                                    storage_url: Optional[str]) -> bool:
        """Return True when bulk access needs a BLOB_STORAGE data source.

        Azure SQL Database / Managed Instance can only bulk-load from Azure
        storage, and SQL Server 2017+ needs the same ``TYPE = BLOB_STORAGE``
        source whenever the detected file lives in Azure Blob Storage / ADLS.
        """
        if target_platform in SQLGenerator.AZURE_SQL_PLATFORMS:
            return True
        if target_platform.startswith('sql_server_'):
            return _storage_url_kind(storage_url) == 'azure'
        return False

    def _openrowset_with_schema(self, metadata: Dict[str, Any],
                                indent: int = 4,
                                terminator: str = ')') -> List[str]:
        """Emit an explicit ``WITH (...)`` column list for OPENROWSET.

        Without it the CSV reader returns untyped columns and, when the file has
        a header row, the header can end up in the result set.
        """
        cols = self._generate_column_definitions(metadata, indent=indent)
        body = ',\n'.join(cols) if cols else f'{" " * indent}[data] NVARCHAR(MAX)'
        return ['WITH (', body, terminator]

    def _not_supported_message(self, feature_label: str,
                               platform: str,
                               alternatives: str = '') -> str:
        """Return a comment block saying feature is not available."""
        label = self.PLATFORM_LABELS.get(platform, platform)
        lines = [
            f'-- ====================================================================',
            f'-- {_sql_comment(feature_label)}',
            f'-- NOT AVAILABLE on {_sql_comment(label)}',
            f'-- ====================================================================',
        ]
        if alternatives:
            lines.append(f'-- {_sql_comment(alternatives)}')
        return '\n'.join(lines)

    # ------------------------------------------------------------------
    # CREATE TABLE
    # ------------------------------------------------------------------

    def generate_create_table(self, metadata: Dict[str, Any],
                              table_name: str = None,
                              schema_name: str = 'dbo',
                              target_platform: str = DEFAULT_TARGET_PLATFORM,
                              storage_url: str = None,
                              data_source: str = 'MyDataSource') -> str:
        """
        Generate a standard CREATE TABLE statement.

        Args:
            target_platform: One of the PLATFORMS tuple values.
        Nullable columns (detected from sample data) use NULL; others use NOT NULL.
        """
        if target_platform not in self.PLATFORMS:
            target_platform = DEFAULT_TARGET_PLATFORM

        if not self._supports('create_table', target_platform):
            return self._not_supported_message(
                'CREATE TABLE', target_platform,
                'Use CREATE EXTERNAL TABLE instead (see EXT TABLE tab).')

        if not table_name:
            base = os.path.splitext(os.path.basename(metadata['file_path']))[0]
            table_name = _clean_identifier(base)
        table_name = _escape_identifier(table_name)
        schema_name = _escape_identifier(schema_name)

        columns = self._generate_column_definitions(metadata, include_nullability=True)
        if not columns:
            columns = ['    [data] NVARCHAR(MAX) NULL']

        file_type = metadata.get('file_type', 'unknown').upper()
        file_name = metadata.get('file_name', metadata['file_path'])

        platform_label = self.PLATFORM_LABELS.get(target_platform, target_platform)

        lines = [
            f'-- ====================================================================',
            f'-- CREATE TABLE',
            f'-- Source : {_sql_comment(file_name)}  ({_sql_comment(file_type)})',
            f'-- Target : {_sql_comment(platform_label)}',
            f'-- ====================================================================',
            f'',
            f'CREATE TABLE [{schema_name}].[{table_name}]',
            f'(',
        ]
        lines.append(',\n'.join(columns))
        lines.append(f')')
        lines.append(f';')

        # Append sample data as comments
        lines += self._format_sample_rows(metadata)

        lines += self._create_table_quick_load(
            metadata,
            schema_name,
            table_name,
            target_platform,
            storage_url,
            data_source,
        )

        return '\n'.join(lines)

    def _create_table_quick_load(
            self, metadata: Dict[str, Any], schema_name: str, table_name: str,
            target_platform: str, storage_url: Optional[str],
            data_source: str) -> List[str]:
        """Build platform-specific quick-load guidance for CREATE TABLE."""
        file_type = metadata.get('file_type', 'csv')
        file_name = metadata.get('file_name', metadata['file_path'])
        lines = [
            '',
            '-- ====================================================================',
            '-- QUICK LOAD',
            '-- ====================================================================',
        ]

        if file_type == 'json':
            return lines + [
                '-- JSON is not an OPENROWSET file format.',
                '-- Use the JSON Functions tab for SINGLE_CLOB + OPENJSON.',
            ]

        if target_platform == 'sql_server_2019':
            if file_type in {'csv', 'text'}:
                return lines + [
                    '-- Use the BULK INSERT tab for local or network CSV/text files.',
                    '-- Cloud OPENROWSET file access requires SQL Server 2022 or later.',
                ]
            return lines + [
                f'-- {file_type.upper()} file access is not available on SQL Server 2019.',
                '-- Convert the source to CSV before loading.',
            ]

        if target_platform == 'fabric_sql_db':
            if file_type in {'csv', 'text', 'parquet'}:
                source_location, bulk_path = _fabric_onelake_parts(
                    storage_url, file_name
                )
                return lines + [
                    '-- Fabric SQL Database reads Lakehouse Files through an',
                    '-- external data source (Microsoft Entra passthrough).',
                    f'-- Data source location: {_sql_comment(source_location)}',
                    f'-- INSERT INTO [{_sql_comment(schema_name)}].[{_sql_comment(table_name)}]',
                    '-- SELECT *',
                    '-- FROM OPENROWSET(',
                    f'--     BULK \'{_sql_comment(_quote_literal(bulk_path))}\',',
                    f'--     DATA_SOURCE = \'{_sql_comment(_quote_literal(data_source))}\',',
                    f'--     FORMAT = \'{_format_keyword(file_type)}\'',
                    '-- ) AS src;',
                ]
            return lines + [
                f'-- {file_type.upper()} is not readable by Fabric SQL Database '
                'OPENROWSET.',
                '-- Convert the source to CSV or Parquet in the Lakehouse first.',
            ]

        if target_platform in self.AZURE_SQL_PLATFORMS:
            if file_type == 'delta' and target_platform == 'azure_sql_mi':
                return lines + [
                    '-- Delta is not supported by Azure SQL Managed Instance.',
                    '-- Convert the table to Parquet or CSV before loading.',
                ]
            source_location, bulk_path = _azure_virtualization_parts(
                storage_url, file_name
            )
            return lines + [
                '-- Azure SQL data virtualization uses an external data source',
                '-- whose LOCATION starts with abs:// or adls:// (not https://).',
                f'-- Data source location: {_sql_comment(source_location)}',
                f'-- INSERT INTO [{_sql_comment(schema_name)}].[{_sql_comment(table_name)}]',
                '-- SELECT *',
                '-- FROM OPENROWSET(',
                f'--     BULK \'{_sql_comment(_quote_literal(bulk_path))}\',',
                f'--     DATA_SOURCE = \'{_sql_comment(_quote_literal(data_source))}\',',
                f'--     FORMAT = \'{_format_keyword(file_type)}\'',
                '-- ) AS src;',
            ]

        if (
            target_platform not in {'sql_server_2022', 'sql_server_2025'}
            or file_type not in {'csv', 'text', 'parquet', 'delta'}
        ):
            return lines + [
                '-- See the OPENROWSET tab for platform-specific loading syntax.',
            ]

        source_location, bulk_path = _sql_server_storage_parts(
            storage_url, file_name, target_platform
        )
        return lines + [
            '-- SQL Server object storage uses an external data source whose',
            '-- LOCATION starts with adls://, abs://, or s3:// (not https://).',
            f'-- Data source location: {_sql_comment(source_location)}',
            f'-- INSERT INTO [{_sql_comment(schema_name)}].[{_sql_comment(table_name)}]',
            '-- SELECT *',
            '-- FROM OPENROWSET(',
            f'--     BULK \'{_sql_comment(_quote_literal(bulk_path))}\',',
            f'--     DATA_SOURCE = \'{_sql_comment(_quote_literal(data_source))}\',',
            f'--     FORMAT = \'{_format_keyword(file_type)}\'',
            '-- ) AS src;',
        ]

    # ------------------------------------------------------------------
    # BULK INSERT
    # ------------------------------------------------------------------

    def generate_bulk_insert(self, metadata: Dict[str, Any],
                             table_name: str = None,
                             schema_name: str = 'dbo',
                             file_path_override: str = None,
                             target_platform: str = DEFAULT_TARGET_PLATFORM,
                             storage_url: str = None,
                             data_source: str = 'MyDataSource',
                             include_prereq: bool = True,
                             credential_name: str = None,
                             auth_method: str = None) -> str:
        """Generate a BULK INSERT statement (CSV / delimited text files only)."""
        if target_platform not in self.PLATFORMS:
            target_platform = DEFAULT_TARGET_PLATFORM

        if not self._supports('bulk_insert', target_platform):
            if target_platform == 'fabric_sql_db':
                return self._bulk_insert_fabric_alternatives(
                    metadata, table_name, schema_name, storage_url, data_source
                )

            alts = []
            if self._supports('openrowset', target_platform):
                alts.append('OPENROWSET (see OPENROWSET tab)')
            if self._supports('external_table', target_platform):
                alts.append('CREATE EXTERNAL TABLE (see EXT TABLE tab)')
            alt_text = ', '.join(alts) if alts else 'Use the appropriate data loading method for your platform.'
            return self._not_supported_message(
                'BULK INSERT', target_platform,
                f'Alternative: {alt_text}')

        if not table_name:
            base = os.path.splitext(os.path.basename(metadata['file_path']))[0]
            table_name = _clean_identifier(base)
        table_name = _escape_identifier(table_name)
        schema_name = _escape_identifier(schema_name)

        file_type = metadata.get('file_type', '')
        file_name = metadata.get('file_name', metadata.get('file_path', '<file>'))
        encoding = metadata.get('encoding', 'utf-8') or 'utf-8'
        codepage = metadata.get('codepage', '65001')

        if file_type not in ('csv', 'text'):
            return (
                f'-- BULK INSERT is designed for delimited text / CSV files.\n'
                f'-- This file is {_sql_comment(file_type.upper())} — '
                f'use OPENROWSET or CREATE EXTERNAL TABLE instead.\n'
            )

        delimiter = metadata.get('delimiter', ',') or ','
        delim_escaped = _quote_literal(_display_delimiter(delimiter))
        delim_name = self.DELIMITER_NAMES.get(delimiter, repr(delimiter))

        platform_label = self.PLATFORM_LABELS.get(target_platform, target_platform)
        use_for_note = 'High-speed batch load into ' + platform_label

        storage_kind = _storage_url_kind(storage_url)
        needs_bulk_source = self._bulk_data_source_supported(
            target_platform, storage_url
        )
        prereq_lines: List[str] = []
        data_source_line = None

        if needs_bulk_source:
            # BULK INSERT reads Azure storage through a TYPE = BLOB_STORAGE
            # external data source (SQL Server 2017+, Azure SQL DB / MI); FROM
            # must be relative to that source's container, never an absolute
            # URL. This source is separate from the abs:// / adls:// data
            # virtualization source used by external tables.
            bulk_ident, bulk_literal, bulk_cred_ident = _bulk_data_source_names(
                data_source, credential_name
            )
            source_root, relative_path = _azure_bulk_storage_parts(
                storage_url, file_name
            )
            from_path = _quote_literal(relative_path)
            data_source_line = (
                f'    DATA_SOURCE     = \'{bulk_literal}\','
            )
            prereq_note = (
                'A BLOB_STORAGE external data source is required; '
                'FROM is relative to its container'
            )
            bulk_auth = _resolve_auth_method(auth_method, target_platform)
            bulk_cred_clause = _credential_clause(bulk_cred_ident, bulk_auth)
            prereq_lines = ([
                f'-- Step 0: Create the BLOB_STORAGE data source used by BULK INSERT.',
                f'--         This is separate from the abs:// / adls:// data',
                f'--         virtualization source used by external tables.',
            ] + _credential_ddl(bulk_cred_ident, bulk_auth, '') + [
                f'',
                f'CREATE EXTERNAL DATA SOURCE [{bulk_ident}]',
                f'WITH (',
                f'    TYPE = BLOB_STORAGE,',
                f'    LOCATION = \'{_quote_literal(source_root)}\'' + (
                    ',' if bulk_cred_clause else ''),
            ] + bulk_cred_clause + [
                f');',
                f'GO',
                f'',
            ]) if include_prereq else [
                f'-- Step 0: [{bulk_ident}] (TYPE = BLOB_STORAGE, LOCATION',
                f'--         \'{_quote_literal(source_root)}\') is created in the',
                f'--         prerequisite setup section above.',
                f'',
            ]
        elif storage_kind in ('s3', 'onelake', 'other'):
            # Never emit a remote URL as a local BULK path: BULK INSERT has no
            # data source type for these locations and would fail at run time.
            label = {
                's3': 'S3-compatible object storage',
                'onelake': 'OneLake',
                'other': 'this URL scheme',
            }[storage_kind]
            from_path = _quote_literal(
                f'<local_or_UNC_staging_path>/{os.path.basename(str(file_name))}'
            )
            prereq_note = (
                f'BULK INSERT cannot read {label}; stage the file locally first'
            )
            prereq_lines = [
                f'-- Step 0: BULK INSERT cannot read {_sql_comment(label)}.',
                f'--         TYPE = BLOB_STORAGE data sources only accept Azure',
                f'--         Blob Storage https:// endpoints.',
                f'--         Source: {_sql_comment(str(storage_url))}',
            ]
            if storage_kind == 's3' and target_platform in S3_BULK_PLATFORMS:
                prereq_lines += [
                    '--         Use OPENROWSET with an s3:// data source instead',
                    '--         (see OPENROWSET tab), or stage the file on a path the',
                    '--         SQL Server service account can read.',
                ]
            else:
                prereq_lines += [
                    '--         Stage the file on a local or UNC path the SQL Server',
                    '--         service account can read, then run the load below.',
                ]
            prereq_lines.append('')
        else:
            from_path = _quote_literal(
                (file_path_override or metadata['file_path']).replace('\\', '/')
            )
            prereq_note = 'File must be accessible to the SQL Server service account'

        lines = [
            f'-- ====================================================================',
            f'-- BULK INSERT',
            f'-- Source    : {_sql_comment(file_name)}',
            f'-- Encoding  : {_sql_comment(encoding.upper())}  '
            f'(codepage {_sql_comment(codepage)})',
            f'-- Delimiter : {_sql_comment(delim_name)}  '
            f'("{_sql_comment(delim_escaped)}")',
            f'-- Target   : {_sql_comment(platform_label)}',
            f'-- Use for   : {_sql_comment(use_for_note)}',
            f'-- Prereq    : {_sql_comment(prereq_note)}',
            f'-- ====================================================================',
            f'',
        ]
        lines += prereq_lines
        lines += [
            f'-- Step 1: Create the target table (see CREATE TABLE tab)',
            f'',
            f'-- Step 2: Load the data',
            f'BULK INSERT [{schema_name}].[{table_name}]',
            f'FROM \'{from_path}\'',
            f'WITH',
            f'(',
        ]
        if data_source_line:
            lines.append(data_source_line)
        lines += self._csv_reader_options(metadata, trailing_comma=True)
        lines += [
            f'    TABLOCK,                            -- Minimally logged; remove if concurrent inserts needed',
            f'    MAXERRORS       = 0,               -- Fail on first error; increase for tolerant loads',
            f'    BATCHSIZE       = 50000            -- Tune per available memory',
            f');',
            f'',
            f'-- Verify row count',
            f'SELECT COUNT(*) AS loaded_rows FROM [{schema_name}].[{table_name}];',
        ]
        return '\n'.join(lines)

    def _bulk_insert_fabric_alternatives(self, metadata: Dict[str, Any],
                                         table_name: Optional[str],
                                         schema_name: str,
                                         storage_url: Optional[str],
                                         data_source: str) -> str:
        """Fabric SQL Database has no BULK INSERT; show OPENROWSET load patterns."""
        file_type = metadata.get('file_type', 'csv')
        file_name = metadata.get('file_name', metadata.get('file_path', 'file.csv'))
        detected_type = file_type.upper()
        source_location, relative_path = _fabric_onelake_parts(
            storage_url, file_name
        )
        bulk_path = _quote_literal(relative_path)
        source_name = _quote_literal(data_source)

        if not table_name:
            base = os.path.splitext(os.path.basename(metadata.get('file_path', 'file')))[0]
            table_name = _clean_identifier(base)
        table_name = _escape_identifier(table_name)
        schema_name = _escape_identifier(schema_name)

        header = [
            '-- ====================================================================',
            '-- BULK INSERT',
            '-- NOT AVAILABLE on Microsoft Fabric SQL Database',
            '-- ====================================================================',
            '-- Use OPENROWSET instead (data virtualization, preview):',
            '-- https://learn.microsoft.com/fabric/database/sql/data-virtualization',
            f'-- Data source location: {_sql_comment(source_location)}',
            '',
        ]

        if file_type == 'delta':
            return '\n'.join(header + [
                '-- Delta is not readable by Fabric SQL Database OPENROWSET.',
                '-- Create a OneLake shortcut to the Delta table from a Lakehouse',
                '-- and query it there, or convert the table to Parquet.',
            ])

        if file_type == 'json':
            return '\n'.join(header + [
                '-- JSON has no OPENROWSET file format on Fabric SQL Database.',
                '-- SINGLE_CLOB cannot be combined with DATA_SOURCE, so the CSV',
                '-- reader is framed with non-printing characters to return the',
                '-- whole document as one value, then parsed with OPENJSON.',
                '',
                f'INSERT INTO [{schema_name}].[{table_name}]',
                'SELECT j.*',
                'FROM OPENROWSET(',
                f'    BULK \'{bulk_path}\',',
                f'    DATA_SOURCE     = \'{source_name}\',',
            ] + self._json_row_frame_options() + [
                ') WITH (json_doc NVARCHAR(MAX)) AS src',
                'CROSS APPLY OPENJSON(src.json_doc) AS j;',
            ])

        format_keyword = _format_keyword(file_type)
        column_list = self._column_name_list(metadata)
        reader_options: List[str]
        if file_type in ('csv', 'text'):
            # Reuse the shared CSV option builder so the detected header row,
            # delimiter and code page are honoured; without FIRSTROW the header
            # would be loaded as a data row.
            reader_options = self._csv_reader_options(metadata)
        else:
            reader_options = [f'    FORMAT          = \'{format_keyword}\'']

        with_schema = self._openrowset_with_schema(metadata)

        body = [
            '-- Option 1: SELECT INTO from OPENROWSET (creates a new staging table)',
            f'SELECT {column_list}',
            f'INTO [{schema_name}].[stg_{table_name}]',
            'FROM OPENROWSET(',
            f'    BULK \'{bulk_path}\',',
            f'    DATA_SOURCE     = \'{source_name}\',',
        ] + reader_options + [')'] + with_schema + [
            'AS src;',
            '',
            '-- Option 2: INSERT INTO from OPENROWSET (loads an existing typed table)',
            f'INSERT INTO [{schema_name}].[{table_name}] ({column_list})',
            f'SELECT {column_list}',
            'FROM OPENROWSET(',
            f'    BULK \'{bulk_path}\',',
            f'    DATA_SOURCE     = \'{source_name}\',',
        ] + reader_options + [')'] + with_schema + [
            'AS src;',
            '',
            f'-- Detected source type: {_sql_comment(detected_type)}',
            '-- For JSON payloads, combine OPENROWSET with OPENJSON (see JSON Functions tab).',
        ]
        return '\n'.join(header + body)

    def _column_name_list(self, metadata: Dict[str, Any]) -> str:
        """Return a bracketed comma-separated column list, or ``*`` if unknown."""
        schema = metadata.get('schema') or []
        names = [f'[{_escape_identifier(_clean_identifier(name))}]'
                 for name, _ in schema]
        return ', '.join(names) if names else '*'

    # ------------------------------------------------------------------
    # OPENROWSET
    # ------------------------------------------------------------------

    def generate_openrowset(self, metadata: Dict[str, Any],
                            storage_url: str = None,
                            credential_name: str = 'MyStorageCredential',
                            data_source: str = 'MyDataSource',
                            target_platform: str = DEFAULT_TARGET_PLATFORM) -> str:
        """
        Generate OPENROWSET queries.
        Supports CSV, Parquet, Delta, JSON.
        """
        if target_platform not in self.PLATFORMS:
            target_platform = DEFAULT_TARGET_PLATFORM

        if not self._supports('openrowset', target_platform):
            alts = []
            if self._supports('bulk_insert', target_platform):
                alts.append('BULK INSERT (see BULK INSERT tab)')
            if self._supports('json_openjson', target_platform):
                alts.append('JSON functions (see JSON Functions tab)')
            alt_text = ', '.join(alts) if alts else 'Use the appropriate data access method for your platform.'
            return self._not_supported_message(
                'OPENROWSET', target_platform,
                f'Alternative: {alt_text}')

        file_type = metadata.get('file_type', 'csv')
        file_name = metadata.get('file_name', metadata['file_path'])
        local_path = _quote_literal(metadata['file_path'].replace('\\', '/'))

        platform_label = self.PLATFORM_LABELS.get(target_platform, target_platform)
        lines = [
            f'-- ====================================================================',
            f'-- OPENROWSET',
            f'-- Source  : {_sql_comment(file_name)}  '
            f'({_sql_comment(file_type.upper())})',
            f'-- Target  : {_sql_comment(platform_label)}',
            f'-- Use for : Ad-hoc / exploratory queries without creating a table',
            f'-- ====================================================================',
            f'',
        ]

        if target_platform == 'fabric_sql_db':
            return self._generate_openrowset_fabric(
                metadata, lines, storage_url, data_source)

        if target_platform in self.AZURE_SQL_PLATFORMS:
            return self._generate_openrowset_azure(
                metadata, lines, storage_url, data_source, target_platform)

        if target_platform == 'sql_server_2019':
            return self._generate_openrowset_sql_server_2019(
                metadata, lines, local_path, storage_url, data_source)

        # SQL Server 2022 / 2025. Object storage formats always use a data
        # source; text formats do too as soon as a storage URL is known.
        if file_type in {'parquet', 'delta'} or storage_url:
            return self._generate_openrowset_sql_server_object_storage(
                metadata, lines, storage_url, data_source, target_platform
            )

        return self._generate_openrowset_local(
            metadata, lines, local_path, target_platform)

    # ---- SQL Server 2019 ---------------------------------------------

    def _generate_openrowset_sql_server_2019(self, metadata: Dict[str, Any],
                                             lines: List[str],
                                             local_path: str,
                                             storage_url: Optional[str],
                                             data_source: str = 'MyDataSource') -> str:
        """SQL Server 2019 OPENROWSET: local paths plus Azure Blob bulk access."""
        file_type = metadata.get('file_type', 'csv')

        if file_type in {'parquet', 'delta'}:
            format_label = 'Parquet' if file_type == 'parquet' else 'Delta Lake'
            lines += [
                f'-- {format_label} file access is not available on SQL Server 2019.',
                f'-- SQL Server 2022 or later is required for '
                f'OPENROWSET FORMAT = \'{file_type.upper()}\'.',
                f'-- Convert the data to CSV for SQL Server 2019.',
            ]
            return '\n'.join(lines)

        storage_kind = _storage_url_kind(storage_url)

        if storage_kind == 'azure':
            # SQL Server 2017+ can bulk-read Azure Blob Storage through a
            # TYPE = BLOB_STORAGE external data source. BULK stays relative to
            # that source; an absolute URL is never a valid BULK path.
            return self._openrowset_blob_storage_bulk(
                metadata, lines, storage_url, data_source, 'sql_server_2019'
            )

        if storage_url:
            # Never emit BULK N'https://...' or BULK 's3://...': SQL Server 2019
            # OPENROWSET cannot reach S3 or arbitrary URLs.
            lines += [
                '-- SQL Server 2019 OPENROWSET cannot read this object storage URL.',
                f'-- Detected remote source: {_sql_comment(storage_url)}',
                '-- Azure Blob Storage is reachable through a TYPE = BLOB_STORAGE',
                '-- external data source, but s3:// requires SQL Server 2022 or later.',
                '--',
                '-- Staging options:',
                '--   1. Copy the file to a local disk or UNC share, then use',
                '--      BULK INSERT / OPENROWSET(BULK) against that path.',
                '--   2. Copy the file to Azure Blob Storage and use a',
                '--      TYPE = BLOB_STORAGE data source with OPENROWSET(BULK).',
                '--   3. Upgrade to SQL Server 2022+ for s3:// data sources and',
                '--      FORMAT = \'PARQUET\' / \'DELTA\' support.',
            ]
            return '\n'.join(lines)

        return self._generate_openrowset_local(
            metadata, lines, local_path, 'sql_server_2019')

    def _openrowset_blob_storage_bulk(self, metadata: Dict[str, Any],
                                      lines: List[str],
                                      storage_url: Optional[str],
                                      data_source: str,
                                      target_platform: str) -> str:
        """OPENROWSET(BULK) over an Azure Blob TYPE = BLOB_STORAGE data source.

        This is the only bulk-access shape available to SQL Server 2019 for
        remote files: ``FORMAT = 'CSV'`` with a container-relative ``BULK``
        path. A ``TYPE = BLOB_STORAGE`` source does accept
        ``SINGLE_CLOB``/``SINGLE_NCLOB``, so a whole JSON document is read that
        way rather than through non-printing CSV framing.
        """
        file_type = metadata.get('file_type', 'csv')
        file_name = metadata.get('file_name', metadata['file_path'])
        bulk_ident, bulk_literal, bulk_cred_ident = _bulk_data_source_names(
            data_source
        )
        source_root, relative_path = _azure_bulk_storage_parts(
            storage_url, file_name
        )
        bulk_path = _quote_literal(relative_path)

        lines += [
            '-- Azure Blob Storage bulk access (SQL Server 2017 and later).',
            '-- BULK is relative to the TYPE = BLOB_STORAGE data source root;',
            '-- an absolute https:// URL is not a valid BULK path.',
            f'-- Data source root: {_sql_comment(source_root)}',
            '',
            '-- Prerequisite (see the credential setup section):',
            f'--   CREATE EXTERNAL DATA SOURCE [{bulk_ident}]',
            f'--   WITH (TYPE = BLOB_STORAGE, LOCATION = \'{_quote_literal(source_root)}\',',
            f'--         CREDENTIAL = [{bulk_cred_ident}]);',
            '',
        ]

        if file_type == 'json':
            lob = self._single_lob_keyword(metadata)
            lines += [
                f'-- JSON: a TYPE = BLOB_STORAGE data source accepts {lob},',
                '-- so the whole document arrives as one value and is parsed with',
                '-- OPENJSON. (The single-LOB options are rejected only by the',
                '-- abs:// / adls:// virtualization connectors.)',
                'SELECT j.*',
                'FROM OPENROWSET(',
                f'    BULK \'{bulk_path}\',',
                f'    DATA_SOURCE     = \'{bulk_literal}\',',
            ]
            lines += self._json_single_lob_options(metadata)
            lines += [
                ') AS src',
                'CROSS APPLY OPENJSON(src.BulkColumn) AS j;',
            ]
            return '\n'.join(lines)

        lines += [
            '-- Delimited text (FORMAT = \'CSV\' is the only format available on 2019):',
            'SELECT TOP 100 *',
            'FROM OPENROWSET(',
            f'    BULK \'{bulk_path}\',',
            f'    DATA_SOURCE     = \'{bulk_literal}\',',
        ]
        lines += self._csv_reader_options(metadata, trailing_comma=True)
        lines += [')']
        lines += self._openrowset_with_schema(metadata)
        lines += ['AS src;']
        return '\n'.join(lines)

    # ---- Microsoft Fabric SQL Database --------------------------------

    def _generate_openrowset_fabric(self, metadata: Dict[str, Any],
                                    lines: List[str],
                                    storage_url: Optional[str],
                                    data_source: str) -> str:
        """Generate Fabric SQL Database OPENROWSET over Lakehouse Files."""
        file_type = metadata.get('file_type', 'csv')
        file_name = metadata.get('file_name', metadata['file_path'])
        encoding = metadata.get('encoding', 'utf-8') or 'utf-8'
        codepage = metadata.get('codepage', '65001')
        delimiter = metadata.get('delimiter', ',') or ','
        has_header = metadata.get('has_header', True)
        delim_escaped = _quote_literal(_display_delimiter(delimiter))

        source_location, relative_path = _fabric_onelake_parts(
            storage_url, file_name
        )
        bulk_path = _quote_literal(relative_path)
        source_name = _quote_literal(data_source)

        lines += [
            '-- Fabric SQL Database data virtualization (preview).',
            '-- Access is authorised with Microsoft Entra passthrough, so the',
            '-- external data source carries no credential or secret.',
            f'-- Data source location: {_sql_comment(source_location)}',
            '-- https://learn.microsoft.com/fabric/database/sql/data-virtualization',
            '',
        ]

        if file_type == 'delta':
            lines += [
                '-- Delta is NOT supported by Fabric SQL Database OPENROWSET.',
                '-- Create a OneLake shortcut to the Delta table from a Lakehouse',
                '-- or Warehouse and query it there, or convert it to Parquet',
                '-- inside the Lakehouse Files section first.',
            ]
            return '\n'.join(lines)

        if file_type == 'parquet':
            lines += [
                '-- ---- Parquet ---------------------------------------------------------',
                'SELECT TOP (100) *',
                'FROM OPENROWSET(',
                f'    BULK \'{bulk_path}\',',
                f'    DATA_SOURCE = \'{source_name}\',',
                '    FORMAT = \'PARQUET\'',
                ') AS [result];',
            ]
            return '\n'.join(lines)

        if file_type == 'json':
            lines += [
                '-- JSON has no OPENROWSET file format on Fabric SQL Database.',
                '-- Read the document as one text column via the CSV reader,',
                '-- then shred it with OPENJSON.',
                '-- ---- JSON -> relational ----------------------------------------------',
                'SELECT j.*',
                'FROM OPENROWSET(',
                f'    BULK \'{bulk_path}\',',
                f'    DATA_SOURCE     = \'{source_name}\',',
            ]
            lines += self._json_row_frame_options()
            lines += [
                ') WITH (json_doc NVARCHAR(MAX)) AS [src]',
                'CROSS APPLY OPENJSON(src.json_doc)',
                'WITH (',
            ]
            openjson_cols = self._generate_openjson_columns(metadata, indent=4)
            lines.append(
                ',\n'.join(openjson_cols) if openjson_cols
                else '    [data] NVARCHAR(MAX)'
            )
            lines += [') AS j;']
            return '\n'.join(lines)

        # CSV / delimited text
        lines += [
            '-- ---- CSV with explicit schema ----------------------------------------',
            'SELECT TOP (100) *',
            'FROM OPENROWSET(',
            f'    BULK \'{bulk_path}\',',
            f'    DATA_SOURCE     = \'{source_name}\',',
        ]
        lines += self._csv_reader_options(metadata)
        lines += [') WITH (']
        cols = self._generate_column_definitions(metadata, indent=4)
        lines.append(',\n'.join(cols) if cols else '    [data] NVARCHAR(MAX)')
        lines += [') AS [result];']
        return '\n'.join(lines)

    # ---- Azure SQL Database / Managed Instance -----------------------

    def _generate_openrowset_azure(self, metadata: Dict[str, Any],
                                   lines: List[str],
                                   storage_url: Optional[str],
                                   data_source: str,
                                   target_platform: str) -> str:
        """Generate Azure SQL data virtualization OPENROWSET statements."""
        file_type = metadata.get('file_type', 'csv')
        file_name = metadata.get('file_name', metadata['file_path'])
        encoding = metadata.get('encoding', 'utf-8') or 'utf-8'
        codepage = metadata.get('codepage', '65001')
        delimiter = metadata.get('delimiter', ',') or ','
        has_header = metadata.get('has_header', True)
        json_format = metadata.get('json_format', 'array')
        delim_escaped = _quote_literal(_display_delimiter(delimiter))
        platform_label = self.PLATFORM_LABELS.get(target_platform, target_platform)

        source_location, relative_path = _azure_virtualization_parts(
            storage_url, file_name
        )
        bulk_path = _quote_literal(relative_path)
        source_name = _quote_literal(data_source)

        lines += [
            '-- Azure SQL data virtualization: BULK is relative to the external',
            '-- data source, whose LOCATION uses abs:// or adls:// (not https://).',
            f'-- Data source location: {_sql_comment(source_location)}',
            '-- See the PREREQUISITE SETUP section for the CREATE EXTERNAL',
            '-- DATA SOURCE statement that this DATA_SOURCE name refers to.',
            '',
        ]

        if file_type == 'delta':
            if target_platform == 'azure_sql_mi':
                lines += [
                    f'-- Delta is NOT supported on {_sql_comment(platform_label)}.',
                    '-- Azure SQL Managed Instance data virtualization reads CSV',
                    '-- and Parquet only. Convert the Delta table to Parquet.',
                ]
                return '\n'.join(lines)
            lines += [
                '-- ---- Delta Lake ------------------------------------------------------',
                '-- BULK points at the Delta table folder, not a single file.',
                'SELECT TOP (100) *',
                'FROM OPENROWSET(',
                f'    BULK \'{_quote_literal(_delta_table_folder(relative_path))}\',',
                f'    DATA_SOURCE = \'{source_name}\',',
                '    FORMAT = \'DELTA\'',
                ') AS [result];',
            ]
            return '\n'.join(lines)

        if file_type == 'parquet':
            lines += [
                '-- ---- Parquet ---------------------------------------------------------',
                'SELECT TOP (100) *',
                'FROM OPENROWSET(',
                f'    BULK \'{bulk_path}\',',
                f'    DATA_SOURCE = \'{source_name}\',',
                '    FORMAT = \'PARQUET\'',
                ') AS [result];',
                '',
                '-- ---- Wildcard folder scan --------------------------------------------',
                'SELECT *',
                'FROM OPENROWSET(',
                f'    BULK \'{_quote_literal(_folder_of(relative_path))}*.parquet\',',
                f'    DATA_SOURCE = \'{source_name}\',',
                '    FORMAT = \'PARQUET\'',
                ') AS [result];',
            ]
            return '\n'.join(lines)

        if file_type == 'json':
            bulk_ident, bulk_literal, _ = _bulk_data_source_names(data_source)
            _, bulk_relative = _azure_bulk_storage_parts(storage_url, file_name)
            lob = self._single_lob_keyword(metadata)
            if json_format == 'ndjson':
                lines += [
                    '-- ---- NDJSON / JSON Lines: one document per row -----------------------',
                    '-- Row framing needs the abs:// virtualization source. The https://',
                    '-- BLOB_STORAGE connector rejects FIELDTERMINATOR / FIELDQUOTE /',
                    '-- ROWTERMINATOR with error 5369.',
                    'SELECT TOP (100) doc',
                    'FROM OPENROWSET(',
                    f'    BULK \'{bulk_path}\',',
                    f'    DATA_SOURCE     = \'{source_name}\',',
                ]
                lines += self._json_row_frame_options(row_terminator='0x0a')
                lines += [
                    ') WITH (doc NVARCHAR(MAX)) AS [src];'
                    '  -- LF: one JSON document per line',
                    '',
                ]
            lines += [
                '-- ---- Whole document -> OPENJSON --------------------------------------',
                f'-- {lob} needs the TYPE = BLOB_STORAGE data source [{bulk_ident}],',
                '-- not the abs:// virtualization source: the single-LOB options are',
                '-- rejected by abs:// / adls:// but accepted by https:// BLOB_STORAGE.',
                '-- BULK is relative to that source root.',
                'DECLARE @json NVARCHAR(MAX);',
                'SELECT @json = BulkColumn',
                'FROM OPENROWSET(',
                f'    BULK \'{_quote_literal(bulk_relative)}\',',
                f'    DATA_SOURCE     = \'{bulk_literal}\',',
            ]
            lines += self._json_single_lob_options(metadata)
            lines += [
                ') AS [src];',
                '',
                'SELECT * FROM OPENJSON(@json)',
            ]
            openjson_cols = self._generate_openjson_columns(metadata, indent=4)
            if openjson_cols:
                lines += ['WITH (', ',\n'.join(openjson_cols), ');']
            else:
                lines.append(';')
            return '\n'.join(lines)

        # CSV / delimited text
        lines += [
            '-- ---- CSV with explicit schema ----------------------------------------',
            'SELECT TOP (100) *',
            'FROM OPENROWSET(',
            f'    BULK \'{bulk_path}\',',
            f'    DATA_SOURCE     = \'{source_name}\',',
        ]
        lines += self._csv_reader_options(metadata)
        lines += [') WITH (']
        cols = self._generate_column_definitions(metadata, indent=4)
        lines.append(',\n'.join(cols) if cols else '    [data] NVARCHAR(MAX)')
        lines += [
            ') AS [result];',
            '',
            '-- ---- Whole file as one value (small files) ---------------------------',
            '-- The single-LOB options need the TYPE = BLOB_STORAGE data source;',
            '-- the abs:// / adls:// virtualization connectors reject them.',
            'SELECT BulkColumn AS file_text',
            'FROM OPENROWSET(',
            f'    BULK \'{_quote_literal(_azure_bulk_storage_parts(storage_url, file_name)[1])}\',',
            f'    DATA_SOURCE     = \'{_bulk_data_source_names(data_source)[1]}\',',
        ]
        lines += self._json_single_lob_options(metadata)
        lines += [') AS [src];']
        return '\n'.join(lines)

    def _generate_openrowset_local(self, metadata: Dict[str, Any],
                                   lines: List[str],
                                   local_path: str,
                                   target_platform: str) -> str:
        """Generate OPENROWSET(BULK ...) for on-prem SQL Server using local file paths."""
        file_type = metadata.get('file_type', 'csv')
        encoding = metadata.get('encoding', 'utf-8') or 'utf-8'
        codepage = metadata.get('codepage', '65001')
        delimiter = metadata.get('delimiter', ',') or ','
        has_header = metadata.get('has_header', True)
        delim_escaped = _quote_literal(delimiter.replace('\t', '\\t'))
        file_name = metadata.get('file_name', metadata['file_path'])

        if file_type in ('csv', 'text'):
            lines += [
                f'-- ---- CSV via OPENROWSET(BULK) — SQL Server local file -------------------',
                f'SELECT TOP 100 *',
                f'FROM OPENROWSET(',
                f'    BULK N\'{local_path}\',',
                f'    FORMATFILE = N\'<path_to_format_file.xml>\',',
                f'    CODEPAGE   = \'{_quote_literal(codepage)}\',  '
                f'-- {_sql_comment(encoding.upper())}',
                f'    FIRSTROW   = {2 if has_header else 1}',
                f') AS [result];',
                f'',
                f'-- ---- Alternative: ad-hoc with SINGLE_CLOB (small files) ---',
                f'SELECT BulkColumn',
                f'FROM OPENROWSET(BULK N\'{local_path}\', SINGLE_CLOB) AS [src];',
            ]
        elif file_type == 'json':
            lines += [
                f'-- {_sql_comment(self.PLATFORM_LABELS[target_platform])} does not support',
                f'-- FORMAT = \'JSON\' or JSON external tables. This workaround',
                f'-- loads JSON as text and parses it with OPENJSON.',
                f'-- ---- JSON via SINGLE_CLOB + OPENJSON  (SQL Server 2016+) ---------------',
                f'DECLARE @json NVARCHAR(MAX);',
                f'SELECT @json = BulkColumn',
                f'FROM OPENROWSET(BULK N\'{local_path}\', SINGLE_CLOB) AS [src];',
                f'',
                f'SELECT * FROM OPENJSON(@json)',
            ]
            openjson_cols = self._generate_openjson_columns(metadata, indent=4)
            if openjson_cols:
                lines += [
                    f'WITH (',
                    ',\n'.join(openjson_cols),
                    f');',
                ]
            else:
                lines.append(f';')
        elif file_type == 'parquet':
            lines += [
                f'-- Parquet OPENROWSET requires SQL Server 2022 or later and',
                f'-- a supported object storage data source (ABS, ADLS, or S3).',
            ]
        elif file_type == 'delta':
            lines += [
                f'-- Delta OPENROWSET requires SQL Server 2022 or later and',
                f'-- a supported object storage data source (ABS, ADLS, or S3).',
            ]

        return '\n'.join(lines)

    def _generate_openrowset_sql_server_object_storage(
            self, metadata: Dict[str, Any], lines: List[str],
            storage_url: Optional[str], data_source: str,
            target_platform: str) -> str:
        """Generate SQL Server 2022+ OPENROWSET over an object storage source."""
        file_type = metadata.get('file_type', 'parquet')
        file_name = metadata.get('file_name', metadata['file_path'])
        encoding = metadata.get('encoding', 'utf-8') or 'utf-8'
        codepage = metadata.get('codepage', '65001')
        delimiter = metadata.get('delimiter', ',') or ','
        has_header = metadata.get('has_header', True)
        json_format = metadata.get('json_format', 'array')
        delim_escaped = _quote_literal(_display_delimiter(delimiter))

        source_location, relative_path = _sql_server_storage_parts(
            storage_url, file_name, target_platform
        )
        bulk_path = _quote_literal(relative_path)
        source_name = _quote_literal(data_source)

        lines += [
            f'-- SQL Server 2022+ reads external files from ABS, ADLS Gen2,',
            f'-- or S3-compatible object storage. The external data source',
            f'-- LOCATION must use abs://, adls://, or s3://, not https://.',
            f'-- BULK is relative to that data source.',
            f'-- Data source location: {_sql_comment(source_location)}',
            f'',
        ]

        if file_type in {'parquet', 'delta'}:
            format_keyword = file_type.upper()
            path_literal = (
                _quote_literal(_delta_table_folder(relative_path))
                if file_type == 'delta'
                else bulk_path
            )
            lines += [
                f'SELECT TOP (100) *',
                f'FROM OPENROWSET(',
                f'    BULK \'{path_literal}\',',
                f'    DATA_SOURCE = \'{source_name}\',',
                f'    FORMAT = \'{format_keyword}\'',
                f') AS [result];',
            ]
            return '\n'.join(lines)

        if file_type == 'json':
            bulk_ident, bulk_literal, _ = _bulk_data_source_names(data_source)
            _, bulk_relative = _azure_bulk_storage_parts(storage_url, file_name)
            lob = self._single_lob_keyword(metadata)
            if json_format == 'ndjson':
                lines += [
                    '-- ---- NDJSON / JSON Lines: one document per row -----------------------',
                    '-- Row framing needs the abs:// / adls:// virtualization source. The',
                    '-- https:// BLOB_STORAGE connector rejects FIELDTERMINATOR /',
                    '-- FIELDQUOTE / ROWTERMINATOR with error 5369.',
                    'SELECT TOP (100) doc',
                    'FROM OPENROWSET(',
                    f'    BULK \'{bulk_path}\',',
                    f'    DATA_SOURCE     = \'{source_name}\',',
                ]
                lines += self._json_row_frame_options(row_terminator='0x0a')
                lines += [
                    ') WITH (doc NVARCHAR(MAX)) AS [src];'
                    '  -- LF: one JSON document per line',
                    '',
                ]
            lines += [
                '-- ---- JSON -> OPENJSON ------------------------------------------------',
                '-- SQL Server has no OPENROWSET FORMAT = \'JSON\'. Read the whole',
                f'-- document with {lob} through the TYPE = BLOB_STORAGE data source',
                f'-- [{bulk_ident}], then parse it with OPENJSON. The single-LOB',
                '-- options are rejected only by the abs:// / adls:// connectors.',
                'DECLARE @json NVARCHAR(MAX);',
                'SELECT @json = BulkColumn',
                'FROM OPENROWSET(',
                f'    BULK \'{_quote_literal(bulk_relative)}\',',
                f'    DATA_SOURCE     = \'{bulk_literal}\',',
            ]
            lines += self._json_single_lob_options(metadata)
            lines += [
                ') AS [src];',
                '',
                'SELECT * FROM OPENJSON(@json)',
            ]
            openjson_cols = self._generate_openjson_columns(metadata, indent=4)
            if openjson_cols:
                lines += ['WITH (', ',\n'.join(openjson_cols), ');']
            else:
                lines.append(';')
            return '\n'.join(lines)

        # CSV / delimited text
        lines += [
            '-- ---- CSV with explicit schema ----------------------------------------',
            'SELECT TOP (100) *',
            'FROM OPENROWSET(',
            f'    BULK \'{bulk_path}\',',
            f'    DATA_SOURCE     = \'{source_name}\',',
        ]
        lines += self._csv_reader_options(metadata)
        lines += [') WITH (']
        cols = self._generate_column_definitions(metadata, indent=4)
        lines.append(',\n'.join(cols) if cols else '    [data] NVARCHAR(MAX)')
        lines += [
            ') AS [result];',
            '',
            '-- ---- Whole file as one value (small files) ---------------------------',
            '-- The single-LOB options need the TYPE = BLOB_STORAGE data source;',
            '-- the abs:// / adls:// virtualization connectors reject them.',
            'SELECT BulkColumn AS file_text',
            'FROM OPENROWSET(',
            f'    BULK \'{_quote_literal(_azure_bulk_storage_parts(storage_url, file_name)[1])}\',',
            f'    DATA_SOURCE     = \'{_bulk_data_source_names(data_source)[1]}\',',
        ]
        lines += self._json_single_lob_options(metadata)
        lines += [') AS [src];']
        return '\n'.join(lines)

    # ------------------------------------------------------------------
    # CREATE EXTERNAL FILE FORMAT
    # ------------------------------------------------------------------

    def generate_external_file_format(self, metadata: Dict[str, Any],
                                      format_name: str = None,
                                      target_platform: str = DEFAULT_TARGET_PLATFORM) -> str:
        """Generate CREATE EXTERNAL FILE FORMAT statement."""
        if target_platform not in self.PLATFORMS:
            target_platform = DEFAULT_TARGET_PLATFORM

        if not self._supports('external_table', target_platform):
            return self._not_supported_message(
                'CREATE EXTERNAL FILE FORMAT', target_platform,
                'External tables are not available on this platform.')

        if not format_name:
            format_name = f'ff_{metadata["file_type"]}_format'
        format_name = _escape_identifier(format_name)

        config = self._determine_format_config(metadata)
        if not config.format_type:
            return self._not_supported_message(
                'CREATE EXTERNAL FILE FORMAT',
                target_platform,
                self._no_external_format_guidance(metadata.get('file_type', '')),
            )
        supported_platforms = self.EXTERNAL_FORMAT_PLATFORMS.get(
            config.format_type, frozenset()
        )
        if target_platform not in supported_platforms:
            alternative = (
                'Use OPENROWSET with OPENJSON for JSON input.'
                if config.format_type == 'JSON'
                else 'Choose a file format supported by the selected platform.'
            )
            return self._not_supported_message(
                f'CREATE EXTERNAL FILE FORMAT ({config.format_type})',
                target_platform,
                alternative,
            )

        with_options = [f'    FORMAT_TYPE = {config.format_type}']
        trailing_notes: List[str] = []

        if config.format_type == 'DELIMITEDTEXT':
            delimited_options = []
            if config.field_terminator:
                delimited_options.append(
                    f'        FIELD_TERMINATOR = '
                    f'\'{_quote_literal(config.field_terminator)}\''
                )
            if config.string_delimiter:
                delimited_options.append(
                    f'        STRING_DELIMITER = '
                    f'\'{_quote_literal(config.string_delimiter)}\''
                )
            if config.date_format:
                delimited_options.append(
                    f'        DATE_FORMAT = \'{_quote_literal(config.date_format)}\''
                )
            # Always emitted, never left implicit: USE_TYPE_DEFAULT decides
            # whether a missing field becomes the type default (0, '') or stays
            # NULL, and that difference is invisible in the generated DDL unless
            # the option is written out.
            delimited_options.append(
                f'        USE_TYPE_DEFAULT = '
                f'{"TRUE" if config.use_type_default else "FALSE"}'
            )
            if not config.use_type_default:
                trailing_notes.append(
                    '-- USE_TYPE_DEFAULT = FALSE keeps missing fields as NULL. '
                    'TRUE would store 0 for numeric and \'\' for string columns, '
                    'which cannot be told apart from real values.'
                )
            if config.encoding:
                delimited_options.append(
                    f'        ENCODING = \'{_quote_literal(config.encoding)}\''
                )
            if config.first_row != 1:
                if target_platform in self.FIRST_ROW_FORMAT_PLATFORMS:
                    delimited_options.append(f'        FIRST_ROW = {config.first_row}')
                else:
                    platform_label = self.PLATFORM_LABELS.get(
                        target_platform, target_platform)
                    trailing_notes += [
                        f'-- FIRST_ROW is not a FORMAT_OPTIONS option on '
                        f'{_sql_comment(platform_label)}; a header row of '
                        f'{config.first_row - 1} line(s) was detected.',
                        '-- Filter the header out in queries (WHERE [col] <> '
                        '\'<header value>\'), strip it before loading, or use '
                        'OPENROWSET with FIRSTROW.',
                    ]
            if delimited_options:
                with_options.append(
                    '    FORMAT_OPTIONS (\n'
                    + ',\n'.join(delimited_options)
                    + '\n    )'
                )

        if config.format_type in self.DDL_ONLY_CERTIFIED_FORMATS:
            trailing_notes.append(
                f'-- {config.format_type} is accepted as DDL on this platform, but '
                f'reading data through it was not certified. Verify a query against '
                f'a real {config.format_type} file before relying on it.'
            )

        if config.serde_method:
            with_options.append(
                f'    SERDE_METHOD = \'{_quote_literal(config.serde_method)}\''
            )
        if config.data_compression:
            with_options.append(
                f'    DATA_COMPRESSION = '
                f'\'{_quote_literal(config.data_compression)}\''
            )

        sql_parts = [
            f'-- CREATE EXTERNAL FILE FORMAT  '
            f'({_sql_comment(self.PLATFORM_LABELS.get(target_platform, target_platform))})',
        ]
        sql_parts += trailing_notes
        sql_parts += [
            f'CREATE EXTERNAL FILE FORMAT [{format_name}]',
            f'WITH (',
            ',\n'.join(with_options),
            f');',
        ]
        return '\n'.join(sql_parts)

    # ------------------------------------------------------------------
    # CREATE EXTERNAL TABLE
    # ------------------------------------------------------------------

    def generate_external_table(self, metadata: Dict[str, Any],
                                table_name: str = None,
                                data_source: str = None,
                                location: str = None,
                                file_format: str = None,
                                schema_name: str = 'dbo',
                                target_platform: str = DEFAULT_TARGET_PLATFORM,
                                storage_url: str = None) -> str:
        """Generate CREATE EXTERNAL TABLE statement (PolyBase / data virtualization)."""
        if target_platform not in self.PLATFORMS:
            target_platform = DEFAULT_TARGET_PLATFORM

        if not self._supports('external_table', target_platform):
            alts = []
            if self._supports('bulk_insert', target_platform):
                alts.append('BULK INSERT (see BULK INSERT tab)')
            if self._supports('json_openjson', target_platform):
                alts.append('JSON functions (see JSON Functions tab)')
            alt_text = ', '.join(alts) if alts else 'Use the appropriate data access method.'
            return self._not_supported_message(
                'CREATE EXTERNAL TABLE', target_platform,
                f'Alternative: {alt_text}')

        config = self._determine_format_config(metadata)
        if target_platform not in self.EXTERNAL_FORMAT_PLATFORMS.get(
            config.format_type, frozenset()
        ):
            alternative = (
                'Use OPENROWSET with OPENJSON for JSON input.'
                if config.format_type == 'JSON'
                else 'Choose a file format supported by the selected platform.'
            )
            return self._not_supported_message(
                f'CREATE EXTERNAL TABLE ({config.format_type})',
                target_platform,
                alternative,
            )

        if not table_name:
            base = os.path.splitext(os.path.basename(metadata['file_path']))[0]
            table_name = f'ext_{_clean_identifier(base)}'
        file_name = metadata.get('file_name') or os.path.basename(
            metadata['file_path']
        )
        source_location, relative_path = self._external_source_parts(
            storage_url, file_name, target_platform
        )
        if not location:
            location = relative_path
        location = str(location).replace('\\', '/')
        if not file_format:
            file_format = f'ff_{metadata["file_type"]}_format'
        table_name = _escape_identifier(table_name)
        schema_name = _escape_identifier(schema_name)
        file_format = _escape_identifier(file_format)
        data_source = _escape_identifier(data_source or 'MyDataSource')

        columns = self._generate_column_definitions(metadata, include_nullability=False)
        if not columns:
            columns = ['    [data] NVARCHAR(MAX)']

        with_options = []
        with_options.append(f'    DATA_SOURCE = [{data_source}]')
        with_options.append(f'    LOCATION = \'{_quote_literal(location)}\'')
        with_options.append(f'    FILE_FORMAT = [{file_format}]')
        if target_platform in self.HADOOP_EXTERNAL_SOURCE_PLATFORMS:
            # REJECT_TYPE / REJECT_VALUE are PolyBase (TYPE = HADOOP) options.
            # Modern abs:// / adls:// / Fabric sources reject them.
            with_options.append(f'    REJECT_TYPE = VALUE')
            with_options.append(f'    REJECT_VALUE = 0')

        platform_label = self.PLATFORM_LABELS.get(target_platform, target_platform)
        header = [
            f'-- ====================================================================',
            f'-- CREATE EXTERNAL TABLE  ({_sql_comment(platform_label)})',
            f'-- Prereq: CREATE EXTERNAL DATA SOURCE and CREATE EXTERNAL FILE FORMAT',
            f'-- LOCATION is relative to the external data source:',
            f'--   {_sql_comment(source_location)}',
        ]
        if target_platform == 'fabric_sql_db':
            header.append(
                '-- Fabric SQL Database data virtualization is in preview and uses'
            )
            header.append(
                '-- Microsoft Entra passthrough over Lakehouse Files.'
            )
        header.append(
            f'-- ===================================================================='
        )
        sql_parts = header + [
            f'',
            f'CREATE EXTERNAL TABLE [{schema_name}].[{table_name}]',
            f'(',
            ',\n'.join(columns),
            f')',
            f'WITH',
            f'(',
            ',\n'.join(with_options),
            f');',
        ]
        return '\n'.join(sql_parts)

    def _external_source_parts(self, storage_url: Optional[str],
                               file_name: str,
                               target_platform: str) -> Tuple[str, str]:
        """Resolve (external data source location, relative path) per platform."""
        if target_platform == 'fabric_sql_db':
            return _fabric_onelake_parts(storage_url, file_name)
        if target_platform in self.AZURE_SQL_PLATFORMS:
            return _azure_virtualization_parts(storage_url, file_name)
        return _sql_server_storage_parts(storage_url, file_name, target_platform)

    def _cloud_staging_notice(self, storage_url: Optional[str],
                              target_platform: str,
                              file_name: str) -> List[str]:
        """Return comment lines telling the user to stage local files in Azure.

        Azure SQL Database and Azure SQL Managed Instance cannot read a path on
        the machine that ran the analysis. When the analyzed file is local, the
        generated script uses ``<container>``/``<path>`` placeholders, so make
        the upload step explicit instead of letting the placeholders imply the
        script is runnable as-is.
        """
        if target_platform not in self.AZURE_SQL_PLATFORMS:
            return []
        if storage_url and _looks_like_cloud_url(storage_url):
            return []
        base_name = os.path.basename(str(file_name).replace('\\', '/')) or '<file>'
        label = self.PLATFORM_LABELS.get(target_platform, target_platform)
        return [
            '-- --------------------------------------------------------------------',
            f'-- STAGE THE DATA IN AZURE STORAGE FIRST',
            f'-- {_sql_comment(label)} runs in Azure and cannot read a path on',
            '-- your workstation or an on-premises file share. The analyzed source',
            f'-- ({_sql_comment(base_name)}) is a local file, so this script uses',
            '-- <storage_account>, <container> and <path> placeholders.',
            '--   1. Upload the file to an Azure Blob Storage or ADLS Gen2 container.',
            '--   2. Replace the placeholders below with the real account,',
            '--      container and blob path.',
            '--   3. Grant the credential (SAS or Managed Identity) read access.',
            '-- Tip: attach the storage account in the app and analyze the blob',
            '--      directly to get a script with the real location filled in.',
            '-- --------------------------------------------------------------------',
            '',
        ]

    # ------------------------------------------------------------------
    # COPY INTO  (Synapse Dedicated Pool / Fabric Data Warehouse)
    # ------------------------------------------------------------------

    def generate_copy_into(self, metadata: Dict[str, Any],
                           table_name: str = None,
                           schema_name: str = 'dbo',
                           storage_url: str = None,
                           target_platform: str = DEFAULT_TARGET_PLATFORM) -> str:
        """Explain COPY INTO availability for the exposed SQL targets."""
        if target_platform not in self.PLATFORMS:
            target_platform = DEFAULT_TARGET_PLATFORM

        platform_label = self.PLATFORM_LABELS.get(target_platform, target_platform)
        lines = [
            '-- ====================================================================',
            '-- COPY INTO',
            f'-- NOT AVAILABLE on {_sql_comment(platform_label)}',
            '-- ====================================================================',
            '-- Recommended alternatives:',
        ]
        alternatives: List[str] = []
        if self._supports('bulk_insert', target_platform):
            alternatives.append(
                'BULK INSERT for high-speed CSV/text ingestion '
                '(see BULK INSERT tab).'
            )
        if self._supports('openrowset', target_platform):
            alternatives.append(
                'OPENROWSET for ad-hoc reads and ELT patterns '
                '(see OPENROWSET tab).\n'
                '--    Use SELECT INTO or INSERT INTO ... SELECT FROM '
                'OPENROWSET for loading.'
            )
        if self._supports('json_openjson', target_platform):
            alternatives.append(
                'OPENJSON / JSON_VALUE for JSON ingestion '
                '(see JSON Functions tab).'
            )
        if target_platform == 'fabric_sql_db':
            alternatives.append(
                'Fabric Data Pipelines / Dataflows Gen2 for '
                'orchestrated ingestion.'
            )
        for index, alternative in enumerate(alternatives, 1):
            lines.append(f'-- {index}. {alternative}')
        return '\n'.join(lines)

    # ------------------------------------------------------------------
    # CREDENTIAL + DATA SOURCE setup
    # ------------------------------------------------------------------

    def generate_credential_setup(self, data_source: str = 'MyDataSource',
                                  file_format: str = 'ff_csv_format',
                                  metadata: Dict[str, Any] = None,
                                  target_platform: str = DEFAULT_TARGET_PLATFORM,
                                  storage_url: str = None,
                                  credential_name: str = None,
                                  auth_method: str = None) -> str:
        """Generate prerequisite CREATE CREDENTIAL, CREATE EXTERNAL DATA SOURCE,
        and CREATE EXTERNAL FILE FORMAT statements.

        ``auth_method`` selects how storage is authenticated and defaults to
        ``'managed_identity'`` wherever the platform supports it, because a
        managed identity needs neither a secret nor a database master key.
        ``credential_name`` overrides the derived ``cred_<data_source>`` name.
        """
        if target_platform not in self.PLATFORMS:
            target_platform = DEFAULT_TARGET_PLATFORM

        if not self._supports('credential_setup', target_platform):
            return self._not_supported_message(
                'CREDENTIAL / DATA SOURCE SETUP', target_platform,
                'External data sources are not supported on this platform. '
                'Use BULK INSERT or application-level data loading instead.')

        platform_label = self.PLATFORM_LABELS.get(target_platform, target_platform)
        metadata = metadata or {}
        config = self._determine_format_config(metadata)
        if target_platform not in self.EXTERNAL_FORMAT_PLATFORMS.get(
            config.format_type, frozenset()
        ):
            alternative = (
                'Use OPENROWSET with SINGLE_CLOB and OPENJSON for JSON text.'
                if config.format_type == 'JSON'
                else 'SQL Server 2022 or later is required for this file format.'
            )
            return self._not_supported_message(
                f'EXTERNAL DATA SOURCE SETUP ({config.format_type})',
                target_platform,
                alternative,
            )

        data_source_raw = data_source
        auth_method = _resolve_auth_method(auth_method, target_platform)
        cred_ident = _credential_identifier(data_source_raw, credential_name)
        data_source = _escape_identifier(data_source)
        file_name = metadata.get(
            'file_name', metadata.get('file_path', '<file>')
        )
        source_location, _ = self._external_source_parts(
            storage_url, file_name, target_platform
        )

        if target_platform == 'fabric_sql_db':
            return '\n'.join([
                f'-- ====================================================================',
                f'-- PREREQUISITE SETUP  ({_sql_comment(platform_label)})',
                f'-- Data virtualization on Fabric SQL Database is in PREVIEW.',
                f'-- Authorisation uses Microsoft Entra passthrough, so there is no',
                f'-- master key, database scoped credential, SAS token, or secret.',
                f'-- The caller must have access to the target Fabric Lakehouse.',
                f'-- https://learn.microsoft.com/fabric/database/sql/data-virtualization',
                f'-- ====================================================================',
                f'',
                f'-- 1. External Data Source over the Lakehouse Files area',
                f'CREATE EXTERNAL DATA SOURCE [{data_source}]',
                f'WITH (',
                f'    LOCATION = \'{_quote_literal(source_location)}\'',
                f');',
                f'GO',
                f'',
                f'-- 2. External File Format (see EXTERNAL FILE FORMAT section)',
                f'-- Fabric SQL Database supports DELIMITEDTEXT and PARQUET.',
                f'-- JSON is read indirectly through the CSV reader + OPENJSON.',
                f'-- Delta tables must be reached through a OneLake shortcut in a',
                f'-- Lakehouse or Warehouse instead.',
                f'GO',
            ])

        lines = [
            f'-- ====================================================================',
            f'-- PREREQUISITE SETUP  ({_sql_comment(platform_label)})',
            f'-- Run these ONCE before using CREATE EXTERNAL TABLE or OPENROWSET',
            f'-- with a DATA_SOURCE reference.',
            f'-- ====================================================================',
            f'',
        ]
        lines += self._cloud_staging_notice(storage_url, target_platform,
                                            file_name)
        if auth_method in ('managed_identity', 'public'):
            lines += [
                f'-- 1. Master key: NOT required.',
            ]
            lines += [
                f'-- {_sql_comment(note_line)}'
                for note_line in _AUTH_NO_MASTER_KEY_NOTE[auth_method]
            ]
            lines += [
                f'-- Certified live on Azure SQL Database: the database master',
                f'-- key count stayed 0 before, during and after the credential',
                f'-- existed, so no master key password has to be invented,',
                f'-- stored or rotated.',
                f'',
            ]
        else:
            lines += [
                f'-- 1. Master key (required once per database for this auth method)',
                f'-- Only needed because a SECRET is being stored. Switching to',
                f'-- IDENTITY = \'MANAGED IDENTITY\' removes this step entirely.',
                f'IF NOT EXISTS (SELECT * FROM sys.symmetric_keys WHERE name = \'##MS_DatabaseMasterKey##\')',
                f'    CREATE MASTER KEY ENCRYPTION BY PASSWORD = \'<StrongPassword!>\';',
                f'GO',
                f'',
            ]

        if target_platform == 'sql_server_2019':
            lines += _credential_ddl(cred_ident, auth_method, '2.')
            lines += [
                f'',
                f'-- 3. External Data Source (external tables / PolyBase)',
                f'-- SQL Server 2019 uses wasbs:// for Azure Blob Storage or',
                f'-- abfss:// for ADLS Gen2 (CU11+) and requires TYPE = HADOOP.',
                f'-- TYPE = BLOB_STORAGE sources cannot back external tables, so',
                f'-- bulk access gets its own source below.',
                f'CREATE EXTERNAL DATA SOURCE [{data_source}]',
                f'WITH (',
                f'    TYPE = HADOOP,',
                f'    LOCATION = \'{_quote_literal(source_location)}\',',
            ]
            clause = _credential_clause(cred_ident, auth_method)
            if not clause:
                lines[-1] = lines[-1].rstrip(',')
            lines += clause
            lines += [
                f');',
                f'GO',
            ]
            lines += self._bulk_data_source_block(
                data_source_raw, storage_url, file_name, target_platform,
                step_number=4, credential_name=credential_name,
                auth_method=auth_method,
            )
            return '\n'.join(lines)

        lines += _credential_ddl(cred_ident, auth_method, '2.')
        lines += [
            f'',
            f'-- 3. External Data Source (data virtualization)',
        ]
        if target_platform in self.AZURE_SQL_PLATFORMS:
            lines += [
                f'-- Azure SQL data virtualization requires abs:// (Blob Storage)',
                f'-- or adls:// (ADLS Gen2). Do not specify TYPE and do not use',
                f'-- an https:// location here.',
            ]
        else:
            lines += [
                f'-- SQL Server 2022+ infers the connector from LOCATION.',
                f'-- Do not specify TYPE. Use abs:// for Azure Blob Storage,',
                f'-- adls:// for ADLS Gen2, or s3:// for S3-compatible storage.',
            ]
        location_line = f'    LOCATION = \'{_quote_literal(source_location)}\''
        cred_clause = _credential_clause(cred_ident, auth_method)
        lines += [
            f'CREATE EXTERNAL DATA SOURCE [{data_source}]',
            f'WITH (',
            location_line + (',' if cred_clause else ''),
        ]
        lines += cred_clause
        lines += [
            f');',
            f'GO',
        ]

        lines += self._bulk_data_source_block(
            data_source_raw, storage_url, file_name, target_platform,
            step_number=4, credential_name=credential_name,
            auth_method=auth_method,
        )

        return '\n'.join(lines)

    def _bulk_data_source_block(self, data_source_raw: str,
                                storage_url: Optional[str],
                                file_name: str,
                                target_platform: str,
                                step_number: int = 4,
                                credential_name: Optional[str] = None,
                                auth_method: Optional[str] = None) -> List[str]:
        """Build the TYPE = BLOB_STORAGE data source used by bulk operations.

        A ``TYPE = BLOB_STORAGE`` source cannot back an external table, and the
        ``abs://`` / ``adls://`` / ``wasbs://`` sources used by external tables
        cannot back ``BULK INSERT`` or ``OPENROWSET(BULK ...)``. Both are
        therefore emitted, under distinct names.
        """
        if not self._bulk_data_source_supported(target_platform, storage_url):
            return []

        auth_method = _resolve_auth_method(auth_method, target_platform)
        bulk_ident, _, bulk_cred_ident = _bulk_data_source_names(
            data_source_raw, credential_name
        )
        bulk_location, _ = _azure_bulk_storage_parts(storage_url, file_name)
        lines = [
            f'',
            f'-- {step_number}. External Data Source for BULK INSERT / OPENROWSET(BULK)',
            f'-- Bulk access needs TYPE = BLOB_STORAGE with an https:// endpoint,',
            f'-- which cannot back an external table, so it gets its own name.',
            f'-- This source is also what makes SINGLE_CLOB / SINGLE_NCLOB usable:',
            f'-- certified live, the single-LOB options work through a',
            f'-- TYPE = BLOB_STORAGE source and are rejected only by abs:// / adls://.',
        ]
        lines += _credential_ddl(bulk_cred_ident, auth_method, '')
        cred_clause = _credential_clause(bulk_cred_ident, auth_method)
        lines += [
            f'',
            f'CREATE EXTERNAL DATA SOURCE [{bulk_ident}]',
            f'WITH (',
            f'    TYPE = BLOB_STORAGE,',
            f'    LOCATION = \'{_quote_literal(bulk_location)}\'' + (
                ',' if cred_clause else ''),
        ]
        lines += cred_clause
        lines += [
            f');',
            f'GO',
        ]
        return lines

    # ------------------------------------------------------------------
    # JSON Functions  (OPENJSON, JSON_VALUE, JSON_QUERY, ISJSON, etc.)
    # ------------------------------------------------------------------

    def generate_json_functions(self, metadata: Dict[str, Any],
                                table_name: str = None,
                                schema_name: str = 'dbo',
                                target_platform: str = DEFAULT_TARGET_PLATFORM,
                                storage_url: str = None,
                                data_source: str = 'MyDataSource') -> str:
        """Generate comprehensive T-SQL JSON function examples using the file's real schema."""
        if target_platform not in self.PLATFORMS:
            target_platform = DEFAULT_TARGET_PLATFORM

        if not self._supports('json_openjson', target_platform):
            alts = []
            if self._supports('openrowset', target_platform):
                alts.append('OPENROWSET (see OPENROWSET tab)')
            if self._supports('external_table', target_platform):
                alts.append('CREATE EXTERNAL TABLE (see EXT TABLE tab)')
            alt_text = ', '.join(alts) if alts else 'JSON functions may have limited support on this platform.'
            return self._not_supported_message(
                'JSON FUNCTIONS (OPENJSON / JSON_VALUE / JSON_QUERY)',
                target_platform,
                f'Alternative: {alt_text}')

        has_path_exists = self._supports('json_path_exists', target_platform)
        has_json_object = self._supports('json_object_array', target_platform)
        is_on_prem = target_platform.startswith('sql_server_')
        has_openrowset_cloud = self._supports('openrowset_format_keyword', target_platform)

        platform_label = self.PLATFORM_LABELS.get(target_platform, target_platform)
        file_type = metadata.get('file_type', 'csv')
        file_name = metadata.get('file_name', metadata.get('file_path', 'file'))
        json_format = metadata.get('json_format', 'array')
        nesting = metadata.get('json_nesting') or {}
        schema = metadata.get('schema') or []

        if not table_name:
            base = os.path.splitext(os.path.basename(metadata.get('file_path', 'data')))[0]
            table_name = _clean_identifier(base)
        table_name = _escape_identifier(table_name)
        schema_name = _escape_identifier(schema_name)

        file_path_sql = metadata.get('file_path', r'C:/data/file.json').replace('\\', '/').replace("'", "''")
        json_bulk_source = None
        if not is_on_prem or storage_url:
            _, json_relative = self._external_source_parts(
                storage_url, file_name, target_platform
            )
            file_path_sql = _quote_literal(json_relative)
            json_bulk_source = _quote_literal(data_source or 'MyDataSource')

        lines = [
            f'-- ====================================================================',
            f'-- T-SQL JSON FUNCTIONS  —  {_sql_comment(file_name)}',
            f'-- Target  : {_sql_comment(platform_label)}',
            f'-- JSON format : {_sql_comment(json_format.upper())}',
            f'-- Columns     : {len(schema)}',
            f'-- ====================================================================',
            f'',
        ]

        # ---- Section 1: read the document, then OPENJSON -----------------
        openjson_cols = self._generate_openjson_columns(metadata, indent=8)
        openjson_with = ',\n'.join(openjson_cols) if openjson_cols else '        [data] NVARCHAR(MAX)'

        if json_bulk_source:
            lines += [
                f'-- ----------------------------------------------------------------',
                f'-- 1. OPENROWSET(BULK) + OPENJSON',
                f'--    BULK is relative to external data source '
                f'[{json_bulk_source}].',
                f'--    SINGLE_CLOB / SINGLE_NCLOB / SINGLE_BLOB cannot be combined',
                f'--    with DATA_SOURCE, so the CSV reader is framed with',
                f'--    non-printing characters to return the whole document.',
                f'-- ----------------------------------------------------------------',
                f'DECLARE @json NVARCHAR(MAX);',
                f'SELECT @json = json_doc',
                f'FROM OPENROWSET(',
                f'    BULK \'{file_path_sql}\',',
                f'    DATA_SOURCE     = \'{json_bulk_source}\',',
            ]
            lines += self._json_row_frame_options()
            lines += [
                f') WITH (json_doc NVARCHAR(MAX)) AS j;',
                f'',
            ]
        else:
            lines += [
                f'-- ----------------------------------------------------------------',
                f'-- 1. OPENROWSET(BULK) + OPENJSON  (SQL Server 2016+ / Azure SQL)',
                f'--    Loads the entire file as a single string, then parses as JSON.',
                f'-- ----------------------------------------------------------------',
                f'DECLARE @json NVARCHAR(MAX);',
                f'SELECT @json = BulkColumn',
                f'FROM OPENROWSET(BULK N\'{file_path_sql}\', SINGLE_CLOB) AS j;',
                f'',
            ]

        if json_format == 'object':
            # Single object: direct JSON_VALUE
            lines += [
                f'-- Single JSON object — extract individual values',
                f'SELECT',
            ]
            jv = []
            for col_name, col_type in schema:
                clean = _escape_identifier(col_name)
                kind = nesting.get(col_name, 'scalar')
                if kind in ('object', 'array'):
                    jv.append(f'    JSON_QUERY(@json, \'{_quote_json_path(col_name)}\') AS [{clean}]')
                else:
                    jv.append(f'    JSON_VALUE(@json, \'{_quote_json_path(col_name)}\') AS [{clean}]')
            lines.append(',\n'.join(jv) + ';' if jv else '    @json;')
        else:
            lines += [
                f'-- Parse the JSON array into rows with typed columns',
                f'SELECT *',
                f'FROM OPENJSON(@json)',
                f'WITH (',
                openjson_with,
                f');',
            ]

        # ---- Section 2: OPENJSON without schema (key/value/type) ---------
        lines += [
            f'',
            f'-- ----------------------------------------------------------------',
            f'-- 2. OPENJSON — schemaless (key / value / type discovery)',
            f'-- ----------------------------------------------------------------',
            f'SELECT [key], [value], [type]',
            f'FROM OPENJSON(@json);',
        ]

        # ---- Section 3: Nested objects — JSON_QUERY + CROSS APPLY --------
        nested_cols = [(n, k) for n, k in nesting.items() if k in ('object', 'array')]
        if nested_cols:
            lines += [
                f'',
                f'-- ----------------------------------------------------------------',
                f'-- 3. NESTED OBJECTS / ARRAYS  — CROSS APPLY OPENJSON',
                f'-- ----------------------------------------------------------------',
            ]
            for col_name, kind in nested_cols:
                clean = _escape_identifier(col_name)
                lines += [
                    f'',
                    f'-- Expand nested {"array" if kind == "array" else "object"}: '
                    f'$.{_sql_comment(col_name)}',
                    f'SELECT',
                    f'    parent.[key] AS parent_key,',
                    f'    child.[key]  AS child_key,',
                    f'    child.[value] AS child_value',
                    f'FROM OPENJSON(@json) AS parent',
                    f'CROSS APPLY OPENJSON(parent.[value], \'{_quote_json_path(col_name)}\') AS child;',
                ]

        # ---- Section 4: Validation with ISJSON --------------------------
        lines += [
            f'',
            f'-- ----------------------------------------------------------------',
            f'-- 4. VALIDATE JSON  — ISJSON  (SQL Server 2016+)',
            f'-- ----------------------------------------------------------------',
            f'SELECT',
            f'    ISJSON(@json) AS is_valid_json,',
            f'    CASE ISJSON(@json) WHEN 1 THEN \'Valid\' ELSE \'Invalid\' END AS status;',
        ]

        # ---- Section 5: JSON_PATH_EXISTS  (SQL Server 2022+ / Azure SQL) ---
        if schema and has_path_exists:
            first_col = schema[0][0]
            lines += [
                f'',
                f'-- ----------------------------------------------------------------',
                f'-- 5. JSON_PATH_EXISTS  ({_sql_comment(platform_label)})',
                f'-- ----------------------------------------------------------------',
                f'SELECT JSON_PATH_EXISTS(@json, \'{_quote_json_path(first_col)}\') AS path_exists;',
            ]
        elif schema and not has_path_exists:
            lines += [
                f'',
                f'-- ----------------------------------------------------------------',
                f'-- 5. JSON_PATH_EXISTS  — NOT available on '
                f'{_sql_comment(platform_label)}',
                f'--    Requires SQL Server 2022+ or Azure SQL Database',
                f'-- ----------------------------------------------------------------',
            ]

        # ---- Section 6: JSON_MODIFY  (update values) --------------------
        if schema:
            first_col = schema[0][0]
            lines += [
                f'',
                f'-- ----------------------------------------------------------------',
                f'-- 6. JSON_MODIFY  — update a value in the JSON document',
                f'-- ----------------------------------------------------------------',
                f'SET @json = JSON_MODIFY(@json, \'{_quote_json_path(first_col)}\', \'new_value\');',
                f'-- Verify: SELECT JSON_VALUE(@json, '
                f'\'{_sql_comment(_quote_json_path(first_col))}\');',
            ]

        # ---- Section 7: Object-storage OPENROWSET + OPENJSON --------------
        if has_openrowset_cloud and not is_on_prem:
            cloud_source_location, cloud_relative = self._external_source_parts(
                storage_url, file_name, target_platform
            )
            blob_path = _quote_literal(cloud_relative)
            cloud_source = _quote_literal(data_source or 'MyDataSource')
            lines += [
                f'',
                f'-- ----------------------------------------------------------------',
                f'-- 7. OPENROWSET + OPENJSON via external data source '
                f'({_sql_comment(platform_label)})',
                f'--    Data source location: {_sql_comment(cloud_source_location)}',
                f'-- ----------------------------------------------------------------',
                f'SELECT j.*',
                f'FROM OPENROWSET(',
                f'    BULK \'{blob_path}\',',
                f'    DATA_SOURCE     = \'{cloud_source}\',',
                f'    FORMAT          = \'CSV\',',
                f'    FIELDTERMINATOR = \'0x0b\',',
                f'    FIELDQUOTE      = \'0x0b\'',
                f') WITH (json_doc NVARCHAR(MAX)) AS src',
                f'CROSS APPLY OPENJSON(src.json_doc)',
                f'WITH (',
            ]
            lines.append(',\n'.join(openjson_cols) if openjson_cols else '    [data] NVARCHAR(MAX)')
            lines += [f') AS j;']
        elif is_on_prem:
            lines += [
                f'',
                f'-- ----------------------------------------------------------------',
                f'-- 7. Cloud OPENROWSET syntax is not available on '
                f'{_sql_comment(platform_label)}.',
                f'--    Use Section 1 (SINGLE_CLOB + OPENJSON) for local JSON files.',
                f'-- ----------------------------------------------------------------',
            ]

        # ---- Section 8: INSERT parsed JSON into table -------------------
        if schema:
            insert_cols = ', '.join(
                f'[{_escape_identifier(c)}]'
                for c, _ in schema
                if nesting.get(c, 'scalar') == 'scalar'
            )
            if insert_cols:
                lines += [
                    f'',
                    f'-- ----------------------------------------------------------------',
                    f'-- 8. INSERT parsed JSON into '
                    f'[{_sql_comment(schema_name)}].[{_sql_comment(table_name)}]',
                    f'--    (create the table first — see CREATE TABLE tab)',
                    f'-- ----------------------------------------------------------------',
                    f'INSERT INTO [{schema_name}].[{table_name}] ({insert_cols})',
                    f'SELECT {insert_cols}',
                    f'FROM OPENJSON(@json)',
                    f'WITH (',
                    openjson_with,
                    f');',
                ]

        return '\n'.join(lines)

    # ------------------------------------------------------------------
    # FOR JSON PATH  (SQL → JSON export)
    # ------------------------------------------------------------------

    def generate_for_json_path(self, metadata: Dict[str, Any],
                               table_name: str = None,
                               schema_name: str = 'dbo',
                               target_platform: str = DEFAULT_TARGET_PLATFORM) -> str:
        """Generate FOR JSON PATH examples for SQL-to-JSON export."""
        if target_platform not in self.PLATFORMS:
            target_platform = DEFAULT_TARGET_PLATFORM

        if not self._supports('for_json', target_platform):
            return self._not_supported_message(
                'FOR JSON PATH', target_platform,
                'FOR JSON is not available on Data Warehouse platforms. '
                'Use application-level JSON serialisation instead.')

        has_json_object = self._supports('json_object_array', target_platform)
        platform_label = self.PLATFORM_LABELS.get(target_platform, target_platform)

        if not table_name:
            base = os.path.splitext(os.path.basename(metadata.get('file_path', 'data')))[0]
            table_name = _clean_identifier(base)
        root_label = _quote_literal(table_name)  # literal context (FOR JSON ROOT)
        table_name = _escape_identifier(table_name)
        schema_name = _escape_identifier(schema_name)
        schema = metadata.get('schema') or []
        nesting = metadata.get('json_nesting') or {}

        select_cols = []
        for col_name, _ in schema:
            clean = _escape_identifier(col_name)
            kind = nesting.get(col_name, 'scalar')
            if kind in ('object', 'array'):
                select_cols.append(f'    JSON_QUERY([{clean}]) AS [{_escape_identifier(col_name)}]')
            else:
                select_cols.append(f'    [{clean}] AS [{_escape_identifier(col_name)}]')

        cols_str = ',\n'.join(select_cols) if select_cols else '    *'

        lines = [
            f'-- ====================================================================',
            f'-- FOR JSON PATH  — export SQL rows back to JSON',
            f'-- Target : {_sql_comment(platform_label)}',
            f'-- ====================================================================',
            f'',
            f'-- 1. Basic array output (each row = one JSON object)',
            f'SELECT',
            cols_str,
            f'FROM [{schema_name}].[{table_name}]',
            f'FOR JSON PATH;',
            f'',
            f'-- 2. Wrapped in a root element',
            f'SELECT',
            cols_str,
            f'FROM [{schema_name}].[{table_name}]',
            f'FOR JSON PATH, ROOT(\'{root_label}\');',
            f'',
            f'-- 3. Include NULL values in output (omitted by default)',
            f'SELECT',
            cols_str,
            f'FROM [{schema_name}].[{table_name}]',
            f'FOR JSON PATH, INCLUDE_NULL_VALUES;',
            f'',
            f'-- 4. Single object (without array wrapper)',
            f'SELECT TOP 1',
            cols_str,
            f'FROM [{schema_name}].[{table_name}]',
            f'FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;',
        ]

        if has_json_object:
            lines += [
                f'',
                f'-- 5. JSON_OBJECT / JSON_ARRAY  '
                f'({_sql_comment(platform_label)})',
                f'SELECT',
                f'    JSON_OBJECT(',
            ]
            jo_pairs = [
                f'        \'{_quote_literal(col_name)}\': '
                f'[{_escape_identifier(col_name)}]'
                for col_name, _ in schema[:6]
            ]
            lines.append(',\n'.join(jo_pairs) if jo_pairs else '        \'data\': *')
            lines += [
                f'    ) AS json_row',
                f'FROM [{schema_name}].[{table_name}];',
            ]
        else:
            lines += [
                f'',
                f'-- 5. JSON_OBJECT / JSON_ARRAY  — NOT available on '
                f'{_sql_comment(platform_label)}',
                f'--    Requires SQL Server 2022+ or Azure SQL Database',
            ]

        return '\n'.join(lines)

    # ------------------------------------------------------------------
    # BEST PRACTICES
    # ------------------------------------------------------------------

    def generate_best_practices(self, metadata: Dict[str, Any],
                                target_platform: str = DEFAULT_TARGET_PLATFORM,
                                table_name: str = None,
                                schema_name: str = 'dbo') -> str:
        """Generate a best-practices guide for ingesting / querying this file type."""
        if target_platform not in self.PLATFORMS:
            target_platform = DEFAULT_TARGET_PLATFORM

        platform_label = self.PLATFORM_LABELS.get(target_platform, target_platform)
        file_type = metadata.get('file_type', 'csv')
        file_name = metadata.get('file_name', 'file')
        row_count = metadata.get('row_count')
        encoding = (metadata.get('encoding') or 'utf-8').upper()
        compression = metadata.get('compression')
        delimiter = metadata.get('delimiter', ',')
        has_header = metadata.get('has_header', True)

        size_bytes = metadata.get('file_size', 0)
        size_mb = (size_bytes or 0) / 1024 / 1024
        size_label = f'{size_mb:.1f} MB'

        rows_label = f'{row_count:}' if row_count else 'unknown'
        # A caller-supplied table name is the exact name used by CREATE TABLE /
        # BULK INSERT, so the validation queries below must use it verbatim.
        # Only a derived name needs cleaning (e.g. a leading digit).
        resolved_table_name = table_name or _clean_identifier(
            os.path.splitext(file_name)[0] or 'data'
        )

        lines = [
            '-- ====================================================================',
            f'-- BEST PRACTICES  —  {_sql_comment(file_name)}',
            f'-- Target   : {_sql_comment(platform_label)}',
            f'-- File type : {_sql_comment(file_type.upper())}',
            f'-- File size : {size_label}',
            f'-- Row count : {rows_label}',
            f'-- Encoding  : {_sql_comment(encoding)}',
            '-- ====================================================================',
            '',
        ]

        lines += _best_practices_summary(metadata, target_platform, size_mb)
        warnings = _best_practices_warnings(metadata)
        if warnings:
            lines += warnings

        # Platform-specific loading recommendation
        load_methods = []
        if (
            self._supports('bulk_insert', target_platform)
            and file_type in {'csv', 'text'}
        ):
            load_methods.append('BULK INSERT (high-speed batch loads)')
        openrowset_supported = (
            file_type not in {'parquet', 'delta'}
            or target_platform in {'sql_server_2022', 'sql_server_2025'}
            or (
                file_type == 'parquet'
                and target_platform in {
                    'azure_sql_db', 'azure_sql_mi', 'fabric_sql_db'
                }
            )
        )
        if self._supports('openrowset', target_platform) and openrowset_supported:
            load_methods.append('OPENROWSET (ad-hoc / exploratory queries)')
        config = self._determine_format_config(metadata)
        if (
            self._supports('external_table', target_platform)
            and target_platform in self.EXTERNAL_FORMAT_PLATFORMS.get(
                config.format_type, frozenset()
            )
        ):
            load_methods.append('CREATE EXTERNAL TABLE (persistent virtual table)')
        if self._supports('json_openjson', target_platform) and file_type == 'json':
            load_methods.append('OPENJSON / JSON_VALUE (native JSON parsing)')
        if self._supports('for_json', target_platform):
            load_methods.append('FOR JSON PATH (export to JSON)')

        if load_methods:
            lines += [
                f'-- RECOMMENDED LOADING METHODS for '
                f'{_sql_comment(platform_label)}:',
            ]
            for i, m in enumerate(load_methods, 1):
                lines.append(f'--   {i}. {m}')
            lines.append('')

        if file_type == 'csv':
            lines += _best_practices_csv(size_mb, encoding, delimiter, has_header,
                                         compression, target_platform)
        elif file_type == 'parquet':
            lines += _best_practices_parquet(size_mb, compression, metadata,
                                             target_platform)
        elif file_type == 'delta':
            lines += _best_practices_delta(metadata, target_platform)
        elif file_type == 'json':
            lines += _best_practices_json(size_mb, target_platform)
        else:
            lines += _best_practices_generic()

        lines += _best_practices_validation_sql(
            metadata, resolved_table_name, schema_name
        )

        return '\n'.join(lines)

    # ------------------------------------------------------------------
    # Complete DDL (all statements)
    # ------------------------------------------------------------------

    def generate_complete_ddl(self, metadata: Dict[str, Any],
                              table_name: str = None,
                              data_source: str = None,
                              location: str = None,
                              schema_name: str = 'dbo',
                              target_platform: str = DEFAULT_TARGET_PLATFORM,
                              storage_url: str = None,
                              format_name: str = None,
                              external_table_name: str = None,
                              credential_name: str = None,
                              auth_method: str = None) -> str:
        """Return every generated section as one runnable, GO-separated script."""
        statements = self.generate_all_statements(
            metadata, table_name, data_source or 'MyDataSource', location,
            schema_name, target_platform=target_platform,
            storage_url=storage_url,
            format_name=format_name,
            external_table_name=external_table_name,
            credential_name=credential_name,
            auth_method=auth_method,
        )

        ordered_sections = [
            'credential_setup',
            'external_file_format',
            'create_external_table',
            'create_table',
            'bulk_insert',
            'openrowset',
        ]
        # The JSON parse / DML section only makes sense for JSON input; emitting
        # it for CSV or Parquet produces statements that reference a file the
        # script never reads. FOR JSON stays because it exports any table.
        if metadata.get('file_type') == 'json':
            ordered_sections.append('json_functions')
        ordered_sections += [
            'for_json',
            'best_practices',
            'copy_into',
        ]

        # The prerequisite setup section already creates the BLOB_STORAGE
        # source that BULK INSERT needs, so do not create it twice.
        bulk_ident, _, _ = _bulk_data_source_names(
            data_source or 'MyDataSource', credential_name
        )
        if f'CREATE EXTERNAL DATA SOURCE [{bulk_ident}]' in (
            statements.get('credential_setup') or ''
        ):
            resolved_table = _clean_identifier(
                table_name or os.path.splitext(
                    os.path.basename(metadata['file_path']))[0]
            )
            statements['bulk_insert'] = self.generate_bulk_insert(
                metadata, resolved_table, schema_name,
                target_platform=target_platform,
                storage_url=storage_url,
                data_source=data_source or 'MyDataSource',
                include_prereq=False,
                credential_name=credential_name,
                auth_method=auth_method,
            )

        parts: List[str] = []
        for key in ordered_sections:
            section = (statements.get(key) or '').strip()
            if not section:
                continue
            parts.append(section)
            if not section.endswith('GO'):
                parts.append('GO')

        return '\n\n'.join(parts) + '\n'

    @staticmethod
    def resolve_table_name(metadata: Dict[str, Any],
                           table_name: str = None) -> str:
        """Return the regular table name a caller-supplied override resolves to.

        ``None``/blank derives the name from the file name, matching
        :meth:`generate_all_statements`; anything else is cleaned but kept.
        """
        if not table_name:
            base = os.path.splitext(os.path.basename(metadata['file_path']))[0]
            return _clean_identifier(base)
        return _clean_identifier(table_name)

    def generate_all_statements(self, metadata: Dict[str, Any],
                                table_name: str = None,
                                data_source: str = 'MyDataSource',
                                location: str = None,
                                schema_name: str = 'dbo',
                                target_platform: str = DEFAULT_TARGET_PLATFORM,
                                storage_url: str = None,
                                format_name: str = None,
                                external_table_name: str = None,
                                credential_name: str = None,
                                auth_method: str = None) -> Dict[str, str]:
        """
        Return a dictionary with all generated SQL statement types:
            create_table, bulk_insert, openrowset, copy_into,
            external_file_format, create_external_table,
            json_functions, for_json, best_practices

        ``format_name``, ``external_table_name`` and ``credential_name``
        override the derived object names. Every generated object name is
        therefore caller-controlled, which lets a deployment place all objects
        under its own naming standard and lets a certification run confine them
        to a disposable prefix instead of writing into ``dbo``.
        """
        if not table_name:
            base = os.path.splitext(os.path.basename(metadata['file_path']))[0]
            table_name = _clean_identifier(base)
        else:
            table_name = _clean_identifier(table_name)
        data_source = data_source or 'MyDataSource'        # The external table must not collide with the regular table in the
        # same script, so it always gets its own name.
        external_table_name = (
            _clean_identifier(external_table_name) if external_table_name
            else f'ext_{table_name}'
        )

        fmt_name = (
            _clean_identifier(format_name) if format_name
            else f'ff_{metadata.get("file_type", "csv")}_format'
        )

        return {
            'create_table': self.generate_create_table(metadata, table_name, schema_name,
                                                       target_platform=target_platform,
                                                       storage_url=storage_url,
                                                       data_source=data_source),
            'bulk_insert': self.generate_bulk_insert(metadata, table_name, schema_name,
                                                     target_platform=target_platform,
                                                     storage_url=storage_url,
                                                     data_source=data_source,
                                                     credential_name=credential_name,
                                                     auth_method=auth_method),
            'openrowset': self.generate_openrowset(metadata,
                                                   storage_url=storage_url,
                                                   data_source=data_source,
                                                   target_platform=target_platform),
            'copy_into': self.generate_copy_into(metadata, table_name, schema_name,
                                                 storage_url=storage_url,
                                                 target_platform=target_platform),
            'external_file_format': self.generate_external_file_format(metadata, fmt_name,
                                                                       target_platform=target_platform),
            'create_external_table': self.generate_external_table(
                metadata, external_table_name, data_source, location, fmt_name,
                schema_name, target_platform=target_platform,
                storage_url=storage_url,
            ),
            'json_functions': self.generate_json_functions(metadata, table_name, schema_name,
                                                          target_platform=target_platform,
                                                          storage_url=storage_url,
                                                          data_source=data_source),
            'for_json': self.generate_for_json_path(metadata, table_name, schema_name,
                                                    target_platform=target_platform),
            'credential_setup': self.generate_credential_setup(data_source, fmt_name,
                                                               metadata=metadata,
                                                               target_platform=target_platform,
                                                               storage_url=storage_url,
                                                               credential_name=credential_name,
                                                               auth_method=auth_method),
            'best_practices': self.generate_best_practices(metadata,
                                                           target_platform=target_platform,
                                                           table_name=table_name,
                                                           schema_name=schema_name),
        }

    # ------------------------------------------------------------------
    # Sample data comments
    # ------------------------------------------------------------------

    @staticmethod
    def _format_sample_rows(metadata: Dict[str, Any]) -> List[str]:
        """Return sample data rows as SQL comments for context."""
        sample_rows = metadata.get('sample_rows')
        schema = metadata.get('schema')
        json_samples = metadata.get('json_sample_values')

        if not schema:
            return []

        lines: List[str] = []

        # For CSV/Excel with sample_rows
        if sample_rows and len(sample_rows) > 0:
            col_names = [c[0] for c in schema]
            # Truncate wide tables to first 8 columns for readability
            max_display = 8
            truncated = len(col_names) > max_display
            display_cols = col_names[:max_display]
            lines.append('')
            lines.append('-- Sample data (first rows from file):')
            header = ' | '.join(_sql_comment(n)[:20] for n in display_cols)
            if truncated:
                header += f' | ... ({len(col_names) - max_display} more)'
            lines.append(f'-- {header}')
            lines.append(f'-- {"-" * len(header)}')
            for row in sample_rows[:3]:
                display_vals = row[:max_display]
                vals = ' | '.join(
                    _sql_comment(v if v is not None else 'NULL')[:20]
                    for v in display_vals
                )
                if truncated:
                    vals += ' | ...'
                lines.append(f'-- {vals}')

        # For JSON with json_sample_values
        elif json_samples:
            lines.append('')
            lines.append('-- Sample data (first record):')
            for col_name, _ in schema[:10]:
                val = json_samples.get(col_name, '')
                val_str = _sql_comment(val)[:60]
                lines.append(
                    f'--   {_sql_comment(col_name)}: {val_str}'
                )

        return lines

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _determine_format_config(self, metadata: Dict[str, Any]) -> ExternalFileFormatConfig:
        file_type = metadata.get('file_type', 'text')
        encoding = self._external_format_encoding(metadata.get('encoding'))

        if file_type == 'csv':
            delimiter = metadata.get('delimiter', ',') or ','
            has_header = metadata.get('has_header', False)
            return ExternalFileFormatConfig(
                format_type='DELIMITEDTEXT',
                field_terminator=delimiter.replace('\t', '\\t'),
                string_delimiter='"',
                first_row=2 if has_header else 1,
                encoding=encoding,
                # USE_TYPE_DEFAULT = FALSE preserves the source's missing-value
                # semantics. Live certification against Azure SQL Database
                # showed that TRUE silently rewrites a missing numeric to 0 and
                # a missing string to '', so an absent value becomes
                # indistinguishable from a real zero or empty string.
                use_type_default=False,
            )
        elif file_type == 'json':
            return ExternalFileFormatConfig(format_type='JSON')
        elif file_type == 'parquet':
            comp = (metadata.get('compression') or '').upper()
            return ExternalFileFormatConfig(
                format_type='PARQUET',
                data_compression=self.COMPRESSION_CODECS.get(comp),
            )
        elif file_type == 'delta':
            return ExternalFileFormatConfig(format_type='DELTA')
        elif file_type == 'orc':
            comp = (metadata.get('compression') or '').upper()
            return ExternalFileFormatConfig(
                format_type='ORC',
                data_compression=self.COMPRESSION_CODECS.get(comp),
            )
        elif file_type == 'rc':
            comp = (metadata.get('compression') or '').upper()
            return ExternalFileFormatConfig(
                format_type='RCFILE',
                serde_method='org.apache.hadoop.hive.serde2.columnar.ColumnarSerDe',
                data_compression=self.COMPRESSION_CODECS.get(comp),
            )
        elif file_type in self.NO_EXTERNAL_FORMAT_FILE_TYPES:
            # Excel workbooks and Iceberg tables have no external file format.
            # Falling through to DELIMITEDTEXT would emit a statement that is
            # accepted by the engine but reads the container bytes as text, so
            # the format type is left unset and the caller emits guidance.
            return ExternalFileFormatConfig(format_type='')
        else:
            return ExternalFileFormatConfig(format_type='DELIMITEDTEXT',
                                            field_terminator='\\n',
                                            encoding=encoding)

    #: File types that have no CREATE EXTERNAL FILE FORMAT representation at
    #: all. They must never fall through to DELIMITEDTEXT, which would produce a
    #: statement that succeeds but reads a binary container as delimited text.
    NO_EXTERNAL_FORMAT_FILE_TYPES = frozenset({'excel', 'xlsx', 'xls', 'iceberg'})

    #: Guidance shown instead of a bogus DELIMITEDTEXT format.
    NO_EXTERNAL_FORMAT_GUIDANCE = {
        'excel': (
            'Excel workbooks are a ZIP/OLE container, not a delimited text '
            'file. No FORMAT_TYPE describes them. Export the worksheet to CSV '
            'or Parquet first, or read the workbook with SSIS, Azure Data '
            'Factory, or the ACE OLE DB provider through a linked server.'
        ),
        'iceberg': (
            'Apache Iceberg tables are not a FORMAT_TYPE. Point the external '
            'table at the underlying Parquet data files, or query the table '
            'through a compute engine that speaks the Iceberg catalog.'
        ),
    }

    @classmethod
    def _no_external_format_guidance(cls, file_type: str) -> str:
        key = 'excel' if file_type in ('excel', 'xlsx', 'xls') else file_type
        return cls.NO_EXTERNAL_FORMAT_GUIDANCE.get(
            key,
            f'{file_type or "This file type"} has no CREATE EXTERNAL FILE '
            f'FORMAT representation.',
        )

    #: ``ENCODING`` in FORMAT_OPTIONS accepts only these two keywords.
    EXTERNAL_FORMAT_ENCODINGS = frozenset({'UTF8', 'UTF16'})

    @classmethod
    def _external_format_encoding(cls, encoding: Optional[str]) -> str:
        """Map a detected encoding onto a legal ``ENCODING`` keyword.

        ``CREATE EXTERNAL FILE FORMAT`` accepts only ``UTF8`` and ``UTF16``.
        Anything else (CP932, Latin-1, ...) must be omitted rather than passed
        through, because an unknown keyword is a syntax error rather than a
        graceful fallback.
        """
        normalised = (encoding or 'utf-8').upper()
        if normalised in ('UTF-8', 'UTF_8', 'UTF8-SIG', 'UTF-8-SIG', 'UTF8'):
            return 'UTF8'
        if normalised.replace('-', '').replace('_', '').startswith('UTF16'):
            return 'UTF16'
        return ''

    def _generate_column_definitions(self, metadata: Dict[str, Any],
                                     include_nullability: bool = False,
                                     indent: int = 4) -> List[str]:
        schema = metadata.get('schema')
        if not schema:
            return []
        nullable_set = set(metadata.get('nullable_columns') or [])
        max_lengths = metadata.get('max_string_lengths') or {}
        sql_type_overrides = metadata.get('sql_type_overrides') or {}
        pad = ' ' * indent
        columns = []
        _validate_unique_column_names(schema)
        for col_name, col_type in schema:
            clean_name = _escape_identifier(col_name)
            # Use explicit SQL type override if provided by schema editor
            if col_name in sql_type_overrides:
                sql_type = _safe_sql_type(sql_type_overrides[col_name])
            else:
                sql_type = self._map_type_to_sql(col_type, max_length=max_lengths.get(col_name))
            if include_nullability:
                null_kw = 'NULL' if col_name in nullable_set else 'NOT NULL'
                columns.append(f'{pad}[{clean_name}] {sql_type:<22} {null_kw}')
            else:
                columns.append(f'{pad}[{clean_name}] {sql_type}')
        return columns

    def _generate_openjson_columns(self, metadata: Dict[str, Any],
                                    indent: int = 4) -> List[str]:
        """Build WITH-clause column list for OPENJSON.

        Uses json_nesting to emit ``AS JSON`` for nested objects/arrays.
        """
        schema = metadata.get('schema') or []
        nesting = metadata.get('json_nesting') or {}
        max_lengths = metadata.get('max_string_lengths') or {}
        sql_type_overrides = metadata.get('sql_type_overrides') or {}
        pad = ' ' * indent
        cols: List[str] = []
        _validate_unique_column_names(schema)
        for col_name, col_type in schema:
            clean = _escape_identifier(col_name)
            kind = nesting.get(col_name, 'scalar')
            if kind in ('object', 'array'):
                cols.append(f'{pad}[{clean}] NVARCHAR(MAX) \'{_quote_json_path(col_name)}\' AS JSON')
            else:
                if col_name in sql_type_overrides:
                    sql_type = _safe_sql_type(sql_type_overrides[col_name])
                else:
                    sql_type = self._map_type_to_sql(col_type,
                                                     max_length=max_lengths.get(col_name))
                cols.append(f'{pad}[{clean}] {sql_type} \'{_quote_json_path(col_name)}\'')
        return cols

    # ------------------------------------------------------------------
    # Multi-file export
    # ------------------------------------------------------------------

    # Objects that are shared by every file in a multi-file export and must
    # therefore be created only once.
    SHARED_OBJECT_PATTERNS = (
        re.compile(r'^\s*CREATE\s+MASTER\s+KEY\b', re.IGNORECASE | re.MULTILINE),
        re.compile(r'^\s*CREATE\s+DATABASE\s+SCOPED\s+CREDENTIAL\s+(\[[^\]]*\]|\S+)',
                   re.IGNORECASE | re.MULTILINE),
        re.compile(r'^\s*CREATE\s+EXTERNAL\s+DATA\s+SOURCE\s+(\[[^\]]*\]|\S+)',
                   re.IGNORECASE | re.MULTILINE),
        re.compile(r'^\s*CREATE\s+EXTERNAL\s+FILE\s+FORMAT\s+(\[[^\]]*\]|\S+)',
                   re.IGNORECASE | re.MULTILINE),
    )

    @classmethod
    def _shared_objects_in(cls, batch: str) -> List[str]:
        """Return keys for the shared prerequisite objects created in *batch*."""
        keys: List[str] = []
        for pattern in cls.SHARED_OBJECT_PATTERNS:
            for match in pattern.finditer(batch):
                name = match.group(1) if match.groups() else ''
                keys.append(f'{pattern.pattern}|{name.upper()}')
        return keys

    @classmethod
    def deduplicate_shared_prerequisites(cls, script: str,
                                         seen: Optional[set] = None) -> str:
        """Comment out shared prerequisite batches that were already created.

        Concatenating per-file complete scripts repeats ``CREATE MASTER KEY``,
        ``CREATE DATABASE SCOPED CREDENTIAL``, ``CREATE EXTERNAL DATA SOURCE``
        and ``CREATE EXTERNAL FILE FORMAT``, which makes every file after the
        first fail. A batch is skipped only when *every* shared object it
        creates has already been created, so file-specific batches are never
        dropped.

        *seen* is mutated so a caller can carry state across several scripts.
        """
        if seen is None:
            seen = set()

        kept: List[str] = []
        for batch in _split_go_batches(script):
            keys = cls._shared_objects_in(batch)
            if keys and all(key in seen for key in keys):
                kept.append(
                    '-- Skipped: the shared prerequisite object(s) in this batch\n'
                    '-- are already created earlier in this export.'
                )
                continue
            seen.update(keys)
            kept.append(batch)

        return '\nGO\n'.join(kept)

    def _map_type_to_sql(self, data_type: str, max_length: int = None) -> str:
        """Map a detected Arrow/pandas/Iceberg type name to a SQL Server type."""
        data_type_lower = str(data_type).strip().lower()

        # Container types must be serialised as text before anything else, so a
        # nested type such as ``struct<id: int64>`` can never become BIGINT.
        if _is_structural_type(data_type_lower):
            return 'NVARCHAR(MAX)'

        decimal_type = _decimal_sql_type(data_type_lower)
        if decimal_type:
            return decimal_type

        temporal_type = _temporal_sql_type(data_type_lower)
        if temporal_type:
            return temporal_type

        # Exact match
        if data_type_lower in self.TYPE_MAPPING:
            sql_type = self.TYPE_MAPPING[data_type_lower]
            # Override NVARCHAR(255) with a smarter size when string length data exists
            if sql_type == 'NVARCHAR(255)' and max_length is not None:
                if max_length > 4000:
                    return 'NVARCHAR(MAX)'
                elif max_length > 200:
                    # Round up to a nice boundary
                    size = ((max_length // 50) + 1) * 50
                    return f'NVARCHAR({min(size, 4000)})'
            return sql_type

        # Any remaining parameterised/nested shape is unsafe to guess at.
        if '<' in data_type_lower or '{' in data_type_lower:
            return 'NVARCHAR(MAX)'

        # Substring fallback, longest key first so that e.g. ``large_string``
        # never resolves through the shorter ``string`` key.
        for key in self._substring_type_keys():
            if key in data_type_lower:
                return self.TYPE_MAPPING[key]

        # decimal / numeric without a parseable precision
        if 'decimal' in data_type_lower or 'numeric' in data_type_lower:
            return 'DECIMAL(18,4)'
        return 'NVARCHAR(255)'

    @classmethod
    def _substring_type_keys(cls) -> Tuple[str, ...]:
        """Return TYPE_MAPPING keys ordered longest-first for safe matching."""
        cached = cls.__dict__.get('_SUBSTRING_TYPE_KEYS')
        if cached is None:
            cached = tuple(
                sorted(cls.TYPE_MAPPING, key=len, reverse=True)
            )
            cls._SUBSTRING_TYPE_KEYS = cached
        return cached


# ------------------------------------------------------------------
# Module-level helpers
# ------------------------------------------------------------------


def _clean_identifier(name: str) -> str:
    """Clean a name so it is a valid SQL identifier."""
    clean = re.sub(r'[^A-Za-z0-9_]', '_', str(name))
    if clean and clean[0].isdigit():
        clean = 'col_' + clean
    return clean or 'column_1'


_CONTROL_CHARACTERS = re.compile(r'[\x00-\x1f\x7f\x85\u2028\u2029]+')


def _collapse_control_characters(value: str) -> str:
    """Collapse the characters that can never appear safely in generated SQL.

    Line terminators are the important ones. ``GO`` is not a T-SQL keyword: it
    is a *client-side* batch separator, so every tool that runs a script
    (sqlcmd, SSMS, Azure Data Studio, and :func:`_split_go_batches` below)
    splits on a line whose only content is ``GO``. A newline smuggled into a
    bracketed identifier or a quoted literal would therefore cut the statement
    in half and let whatever follows run as its own batch, even though the
    server-side parser accepts the identifier perfectly happily.

    No legitimate identifier, path, URL or delimiter contains a control
    character - delimiters are rendered through :func:`_display_delimiter`
    before they reach :func:`_quote_literal` - so collapsing them to a space is
    lossless in practice and closes the batch-injection vector at its source.

    U+0085 (NEL), U+2028 and U+2029 are included even though they sit outside
    the C0/C1 ranges a naive filter would use: all three are line terminators to
    some readers (Python's own ``str.splitlines()`` among them), and a defence
    that depends on which reader splits the script is not a defence.
    """
    return _CONTROL_CHARACTERS.sub(' ', str(value))


def _escape_identifier(name: str) -> str:
    """Escape a value for safe use inside a T-SQL bracket-quoted ``[identifier]``.

    Bracket-quoting requires that any closing bracket be doubled so a value can
    never terminate the identifier early, and control characters are collapsed
    first so a value can never terminate the *batch* early either. Unlike
    :func:`_clean_identifier`, the printable characters are preserved so
    caller-supplied names (table, schema, data source, ...) keep their intended
    form while remaining injection-safe.
    """
    return _collapse_control_characters(name).replace(']', ']]')


def _quote_literal(value: Any) -> str:
    """Escape a value for safe use inside a T-SQL single-quoted ``'string'`` literal."""
    return _collapse_control_characters(value).replace("'", "''")


def _sql_comment(value: Any) -> str:
    """Collapse untrusted text to one line before placing it in a SQL comment."""
    return _collapse_control_characters(value).strip()


def _display_delimiter(value: str) -> str:
    """Render control delimiters visibly in generated SQL guidance."""
    control_characters = {'\t': r'\t', '\r': r'\r', '\n': r'\n'}
    return ''.join(
        control_characters.get(character, character)
        for character in value
    )


def _folder_of(relative_path: str) -> str:
    """Return the folder portion of a data-source relative path, with a slash."""
    normalized = str(relative_path).replace('\\', '/')
    if '/' not in normalized:
        return ''
    folder = normalized.rsplit('/', 1)[0]
    return f'{folder}/' if folder else ''


_SCRIPT_LINES = re.compile(r'\r\n|\r|\n')


def _split_go_batches(script: str) -> List[str]:
    """Split a T-SQL script on its ``GO`` batch separators.

    Only a line whose sole content is ``GO`` separates batches, and a ``GO``
    that falls inside a ``'literal'``, a ``[identifier]`` or a block comment is
    not a separator at all. :func:`_escape_identifier` and
    :func:`_quote_literal` already make it impossible to smuggle a line break
    into either region, so this scan is defence in depth: it keeps the splitter
    correct even for a script this module did not generate.

    Lines are split on CR/LF only, not with ``str.splitlines()``. ``splitlines``
    also breaks on U+000B, U+000C, U+001C-U+001E and U+0085, none of which
    sqlcmd, SSMS or the native TypeScript splitter treat as a line ending. Using
    it here would make this function disagree with every client that actually
    runs the script - and with the native implementation it is kept in parity
    with.
    """
    batches: List[str] = []
    current: List[str] = []
    state = {'literal': False, 'bracket': False, 'comment_depth': 0}

    def advance(line: str) -> None:
        """Track which quoting region the *end* of *line* is inside."""
        index = 0
        length = len(line)
        while index < length:
            character = line[index]
            following = line[index + 1] if index + 1 < length else ''
            if state['literal']:
                if character == "'":
                    if following == "'":
                        index += 1
                    else:
                        state['literal'] = False
            elif state['bracket']:
                if character == ']':
                    if following == ']':
                        index += 1
                    else:
                        state['bracket'] = False
            elif state['comment_depth'] > 0:
                if character == '*' and following == '/':
                    state['comment_depth'] -= 1
                    index += 1
                elif character == '/' and following == '*':
                    state['comment_depth'] += 1
                    index += 1
            elif character == '-' and following == '-':
                # A line comment runs to the end of the line and cannot change
                # the region the next line starts in.
                return
            elif character == '/' and following == '*':
                state['comment_depth'] += 1
                index += 1
            elif character == "'":
                state['literal'] = True
            elif character == '[':
                state['bracket'] = True
            index += 1

    for line in _SCRIPT_LINES.split(str(script)):
        separable = (
            not state['literal']
            and not state['bracket']
            and state['comment_depth'] == 0
        )
        if separable and line.strip().upper() == 'GO':
            batches.append('\n'.join(current).strip())
            current = []
        else:
            advance(line)
            current.append(line)
    tail = '\n'.join(current).strip()
    if tail:
        batches.append(tail)
    return [batch for batch in batches if batch]


def _delta_table_folder(relative_path: str) -> str:
    """Return the Delta table folder for a detector-resolved relative path.

    A Delta table is detected as a directory, so the resolved relative path
    *is* the table folder: only a trailing slash has to be added. Taking the
    parent folder would point ``OPENROWSET`` at the sibling tables instead, and
    an empty result would produce an invalid ``BULK ''``.
    """
    normalized = str(relative_path).replace('\\', '/').strip('/')
    if not normalized:
        return '<delta_table_folder>/'
    return f'{normalized}/'


def _bulk_data_source_names(
    data_source: str, credential_name: Optional[str] = None
) -> Tuple[str, str, str]:
    """Return ``(identifier, literal, credential_identifier)`` for a bulk source.

    The raw ``<data_source>_Bulk`` name is escaped once per context: bracket
    escaping for ``[identifier]`` and quote doubling for ``'literal'``. Escaping
    first and reusing the result would corrupt names containing ``]`` or ``'``.

    ``credential_name`` overrides the derived ``cred_<data_source>_Bulk`` name so
    callers that must place every object under their own prefix (certification
    runs, deployments with a naming standard) can do so.
    """
    raw = f'{data_source}_Bulk'
    cred_raw = f'{credential_name}_Bulk' if credential_name else f'cred_{raw}'
    return (
        _escape_identifier(raw),
        _quote_literal(raw),
        _escape_identifier(cred_raw),
    )


def _credential_identifier(
    data_source: str, credential_name: Optional[str] = None
) -> str:
    """Return the escaped database scoped credential identifier."""
    return _escape_identifier(credential_name or f'cred_{data_source}')


#: Authentication methods the generator can emit for storage access.
#:
#: ``managed_identity`` is preferred and is the default wherever the platform
#: supports it. Live certification against Azure SQL Database proved that
#: ``CREATE DATABASE SCOPED CREDENTIAL ... WITH IDENTITY = 'MANAGED IDENTITY'``
#: succeeds with **no database master key**: the master key count was 0 before
#: the credential was created, 0 while it existed, and 0 after it was dropped.
#: That removes the need to invent and store a master key password or a SAS
#: token, so it is both simpler and secret-free.
AUTH_METHODS = ('managed_identity', 'sas', 'storage_key', 'public')

#: Why the master key step is skipped, per secret-free authentication method.
_AUTH_NO_MASTER_KEY_NOTE = {
    'managed_identity': (
        "IDENTITY = 'MANAGED IDENTITY' stores no secret, so there is",
        'nothing for a database master key to encrypt.',
    ),
    'public': (
        'The container allows anonymous read access, so no credential',
        'and no database master key are created.',
    ),
}

#: Platforms where ``IDENTITY = 'MANAGED IDENTITY'`` is the preferred default.
MANAGED_IDENTITY_PLATFORMS = frozenset({
    'azure_sql_db',
    'azure_sql_mi',
    'sql_server_2022',
    'sql_server_2025',
})


def _resolve_auth_method(auth_method: Optional[str],
                         target_platform: str) -> str:
    """Return the effective authentication method for a platform."""
    if auth_method in AUTH_METHODS:
        return auth_method
    if target_platform in MANAGED_IDENTITY_PLATFORMS:
        return 'managed_identity'
    return 'storage_key' if target_platform == 'sql_server_2019' else 'sas'


def _credential_ddl(cred_ident: str, auth_method: str,
                    step_label: str) -> List[str]:
    """Return the credential DDL lines for one authentication method.

    ``public`` returns only a comment: a container that allows anonymous read
    needs no credential at all, and emitting one would force an unnecessary
    secret into the script.
    """
    prefix = f' {step_label} ' if step_label else ' '
    if auth_method == 'public':
        return [
            f'--{prefix}Database Scoped Credential: not required.',
            '-- The container allows anonymous read access, so the external',
            '-- data source below is created without a CREDENTIAL.',
        ]
    if auth_method == 'managed_identity':
        return [
            f'--{prefix}Database Scoped Credential (managed identity)',
            '-- PREFERRED: no secret, no SAS token, and no database master key.',
            '-- Grant the server/instance managed identity the Storage Blob Data',
            '-- Reader role on the storage account (Storage Blob Data Contributor',
            '-- if the workload also writes). Certified live: creating this',
            '-- credential left the database master key count at 0.',
            f'CREATE DATABASE SCOPED CREDENTIAL [{cred_ident}]',
            'WITH',
            "    IDENTITY = 'MANAGED IDENTITY';",
            'GO',
        ]
    if auth_method == 'storage_key':
        return [
            f'--{prefix}Database Scoped Credential (storage account key)',
            '-- Prefer IDENTITY = \'MANAGED IDENTITY\' where the platform',
            '-- supports it; an account key is a long-lived shared secret.',
            '-- Requires a database master key (step 1).',
            f'CREATE DATABASE SCOPED CREDENTIAL [{cred_ident}]',
            'WITH',
            "    IDENTITY = '<storage_account_name>',",
            "    SECRET   = '<storage_account_key>';",
            'GO',
        ]
    return [
        f'--{prefix}Database Scoped Credential (SAS token)',
        '-- Prefer IDENTITY = \'MANAGED IDENTITY\' where the platform',
        '-- supports it: it needs no secret and no database master key.',
        '-- Requires a database master key (step 1).',
        f'CREATE DATABASE SCOPED CREDENTIAL [{cred_ident}]',
        'WITH',
        "    IDENTITY = 'SHARED ACCESS SIGNATURE',",
        "    SECRET   = '<SAS_token_without_leading_?>';",
        'GO',
    ]


def _credential_clause(cred_ident: str, auth_method: str) -> List[str]:
    """Return the trailing ``CREDENTIAL = [...]`` line, if one is needed."""
    if auth_method == 'public':
        return []
    return [f'    CREDENTIAL = [{cred_ident}]']


def _validate_unique_column_names(schema: List[Any]) -> None:
    """Reject duplicate column names under typical case-insensitive SQL collation."""
    seen = set()
    for column in schema:
        name = str(column[0])
        key = name.casefold()
        if key in seen:
            raise ValueError(f'Duplicate column name: {name}')
        seen.add(key)


_SIMPLE_JSON_KEY = re.compile(r'\A[A-Za-z_][A-Za-z0-9_]*\Z')


def _quote_json_path(name: str) -> str:
    """Build a safe T-SQL JSON path (``$.<key>``) for *name*.

    Simple identifiers are emitted as ``$.key``. Names containing spaces, dots
    or other special characters are wrapped in double quotes (``$."weird key"``)
    as required by SQL Server. The result is additionally escaped so it is safe
    to embed inside a single-quoted SQL string literal.
    """
    n = str(name)
    if _SIMPLE_JSON_KEY.match(n):
        path = f'$.{n}'
    else:
        esc = n.replace('\\', '\\\\').replace('"', '\\"')
        path = f'$."{esc}"'
    return _quote_literal(path)


# Allowed shape for a SQL data type: a type name optionally followed by a
# parenthesised length/precision such as NVARCHAR(255), DECIMAL(18,4) or
# VARBINARY(MAX). Anything else (e.g. a value smuggled in from the web schema
# editor) is rejected and replaced with a safe default.
#
# ``\A``/``\Z`` rather than ``^``/``$`` because Python's ``$`` also matches
# before a trailing newline, and ``re.ASCII`` because Python's ``\d`` otherwise
# accepts non-ASCII digits. Both keep the allowlist exactly as narrow as the
# native TypeScript implementation, which JavaScript's regular expressions give
# for free.
#
# The internal whitespace is ``[ \t]``, never ``\s``. The accepted candidate is
# interpolated into DDL verbatim, so this is the one generator path that does
# not run through ``_collapse_control_characters``; ``\s`` would admit ``\n``,
# ``\r``, ``\x0b`` and ``\x0c``, putting a real line break inside CREATE TABLE.
# The JavaScript mirror uses the same class, where ``\s`` would additionally
# have admitted U+00A0, U+2028, U+2029 and U+FEFF.
_VALID_SQL_TYPE = re.compile(
    r'\A[A-Za-z][A-Za-z0-9_]*[ \t]*(\([ \t]*(\d+|MAX)[ \t]*(,[ \t]*\d+[ \t]*)?\))?\Z',
    re.IGNORECASE | re.ASCII,
)


def _safe_sql_type(sql_type: str, fallback: str = 'NVARCHAR(MAX)') -> str:
    """Return *sql_type* only if it matches the allowed type pattern, else *fallback*."""
    candidate = str(sql_type).strip()
    return candidate if _VALID_SQL_TYPE.match(candidate) else fallback


def _format_keyword(file_type: str) -> str:
    return {'parquet': 'PARQUET', 'delta': 'DELTA', 'json': 'CSV',
            'orc': 'ORC'}.get(file_type, 'CSV')


def _best_practices_summary(metadata: Dict[str, Any],
                            target_platform: str,
                            size_mb: float) -> List[str]:
    file_type = metadata.get('file_type', 'csv')

    recommended = 'CREATE TABLE + INSERT validation flow'
    fastest = 'OPENROWSET for preview / exploratory access'
    lowest_cost = 'OPENROWSET with projection/filtering'
    staging = 'Load to a staging table first, then transform into the final schema'

    if target_platform == 'fabric_sql_db':
        recommended = 'OPENROWSET with SELECT INTO / INSERT INTO ... SELECT'
        fastest = 'OPENROWSET for direct external access'
        lowest_cost = 'OPENROWSET over parquet with projected columns'
    elif target_platform.startswith('sql_server_') or target_platform in {'azure_sql_db', 'azure_sql_mi'}:
        if file_type in {'csv', 'text'}:
            recommended = 'BULK INSERT for load, then validate in SQL'
            fastest = 'BULK INSERT for local or staged CSV/text files'
        elif file_type == 'json':
            recommended = (
                'Load JSON as text with OPENROWSET(SINGLE_CLOB), then parse '
                'with OPENJSON'
            )
            fastest = 'OPENJSON after loading the file as NVARCHAR(MAX)'
        elif file_type in {'parquet', 'delta'}:
            if target_platform == 'sql_server_2019':
                recommended = (
                    f'{file_type.title()} is not supported; convert to CSV '
                    'before loading'
                )
                fastest = 'Convert to CSV, then use BULK INSERT'
            else:
                recommended = (
                    f'OPENROWSET FORMAT=\'{file_type.upper()}\' over ABS, '
                    'ADLS, or S3 storage'
                )
                fastest = 'OPENROWSET with projected columns'

    if size_mb > 512:
        staging = 'For large files, land data in staging and validate in batches'
    elif size_mb < 25:
        staging = 'For small files, direct load is fine, but keep a validation query ready'

    return [
        '-- RECOMMENDED PATH',
        f'--   Best option   : {recommended}',
        f'--   Fastest path  : {fastest}',
        f'--   Lowest cost   : {lowest_cost}',
        f'--   Staging       : {staging}',
        '',
    ]


def _best_practices_warnings(metadata: Dict[str, Any]) -> List[str]:
    warnings: List[str] = []
    encoding = metadata.get('encoding')
    confidence = metadata.get('encoding_confidence')
    file_type = metadata.get('file_type', 'csv')
    json_nesting = metadata.get('json_nesting') or {}
    max_lengths = metadata.get('max_string_lengths') or {}
    nullable = set(metadata.get('nullable_columns') or [])
    schema = metadata.get('schema') or []

    if encoding and encoding != 'binary' and confidence is not None and confidence < 70:
        warnings.append(f'--   Low encoding confidence ({confidence}%). Verify file encoding before loading.')
    if metadata.get('row_count_estimated'):
        warnings.append('--   Row count is estimated. Validate with a post-load COUNT(*) query.')
    if file_type == 'json' and any(kind in {'object', 'array'} for kind in json_nesting.values()):
        warnings.append('--   Nested JSON detected. Expect flattening or OPENJSON WITH (...) work before production load.')
    if any(length > 4000 for length in max_lengths.values()):
        warnings.append('--   Very long strings detected. Consider NVARCHAR(MAX) columns and downstream truncation checks.')

    numeric_markers = ('int', 'float', 'double', 'decimal', 'numeric', 'real')
    nullable_numeric = [name for name, dtype in schema if name in nullable and any(m in str(dtype).lower() for m in numeric_markers)]
    if nullable_numeric:
        column_list = _sql_comment(', '.join(map(str, nullable_numeric[:5])))
        warnings.append(
            f'--   Nullable numeric columns detected: {column_list}. '
            f'Stage as text if source quality is inconsistent.'
        )

    if not warnings:
        return []

    return ['-- WARNINGS / WATCH-OUTS', *warnings, '']


def _best_practices_validation_sql(metadata: Dict[str, Any],
                                   table_name: str,
                                   schema_name: str = 'dbo') -> List[str]:
    schema = metadata.get('schema') or []
    cols = [_escape_identifier(col) for col, _ in schema[:3]]
    select_cols = ', '.join(f'[{c}]' for c in cols) if cols else '*'
    safe_table = _escape_identifier(table_name)
    safe_schema = _escape_identifier(schema_name or 'dbo')
    target = f'[{safe_schema}].[{safe_table}]'

    lines = [
        '',
        '-- VALIDATION SQL AFTER LOAD',
        f'-- 1. Row count',
        f'SELECT COUNT(*) AS loaded_rows FROM {target};',
        '',
        f'-- 2. Sample rows',
        f'SELECT TOP 10 {select_cols} FROM {target};',
    ]

    if cols:
        null_checks = ', '.join(
            f'SUM(CASE WHEN [{c}] IS NULL THEN 1 ELSE 0 END) AS [{c}_nulls]'
            for c in cols
        )
        lines += [
            '',
            '-- 3. Null distribution check',
            f'SELECT {null_checks} FROM {target};',
        ]

    lines.append('')
    return lines


def _best_practices_csv(size_mb: float, encoding: str, delimiter: str,
                        has_header: bool, compression: str,
                        target_platform: str = DEFAULT_TARGET_PLATFORM) -> List[str]:
    delim_name = {',' : 'comma', '\t': 'tab', '|': 'pipe', ';': 'semicolon'}.get(delimiter, repr(delimiter))
    display_delimiter = _sql_comment(_display_delimiter(delimiter))
    is_fabric = target_platform == 'fabric_sql_db'
    is_azure_sql = target_platform in {'azure_sql_db', 'azure_sql_mi'}

    if is_fabric:
        tool_selection = [
            '--    Any size → OPENROWSET over Lakehouse Files (data virtualization, preview)',
            '--    Repeated loads → CREATE EXTERNAL TABLE + INSERT INTO ... SELECT',
            '--    Orchestrated loads → Fabric Data Pipelines / Dataflows Gen2',
        ]
    elif is_azure_sql:
        tool_selection = [
            '--    < 1 GB   → BULK INSERT with a BLOB_STORAGE data source',
            '--    Any size → OPENROWSET over an abs:// or adls:// data source',
            '--    Repeated loads → CREATE EXTERNAL TABLE (data virtualization)',
        ]
    else:
        tool_selection = [
            '--    < 1 GB   → BULK INSERT into SQL Server (fastest local load)',
            '--    Any size → OPENROWSET over a local path or object storage data source',
            '--    Repeated loads → CREATE EXTERNAL TABLE (avoid materialising data)',
        ]

    lines = [
        f'-- Detected: {_sql_comment(delim_name)}-delimited, '
        f'encoding {_sql_comment(encoding)}',
        '',
        '-- 1. TOOL SELECTION',
        *tool_selection,
        '',
        '-- 2. ENCODING',
        f'--    Detected encoding : {_sql_comment(encoding)}',
        '--    Always specify CODEPAGE to avoid silent data corruption.',
        '--    UTF-8 → CODEPAGE = \'65001\'   |   UTF-16 → CODEPAGE = \'1200\'',
        '--    Latin-1 / CP1252 → CODEPAGE = \'1252\'',
        '',
        '-- 3. HEADER ROW',
        f'--    has_header = {has_header} → {"FIRSTROW = 2 (skip header)" if has_header else "FIRSTROW = 1 (no header detected)"}',
        '',
        '-- 4. STAGING PATTERN (recommended)',
        '--    a. Load raw data into a STAGING table (all columns NVARCHAR).',
        '--    b. Validate / transform into the final typed table.',
        '--    c. This avoids cryptic conversion errors on bad rows.',
        '',
        '-- 5. PERFORMANCE',
        '--    Split large files into 256 MB chunks before importing.',
        '--    Pre-sort by the partition key when possible.',
        '',
    ]

    if is_fabric:
        lines += [
            '-- 6. ERROR HANDLING',
            '--    OPENROWSET has no reject options: stage to NVARCHAR columns and',
            '--    validate with TRY_CONVERT before writing the typed table.',
            '',
            '-- 7. LOAD PATTERN (Fabric SQL Database)',
            '--    INSERT INTO [dbo].[MyTable]',
            '--    SELECT * FROM OPENROWSET(',
            '--        BULK \'folder/file.csv\',',
            '--        DATA_SOURCE = \'MyDataSource\',',
            '--        FORMAT = \'CSV\',',
            f'--        FIRSTROW = {2 if has_header else 1},',
            f'--        FIELDTERMINATOR = \'{display_delimiter}\',',
            '--        CODEPAGE = \'65001\'',
            '--    ) WITH ([col1] INT, [col2] NVARCHAR(255)) AS [src];',
        ]
        return lines

    lines += [
        '-- 6. ERROR HANDLING',
        '--    Use MAXERRORS to log bad rows before aborting.',
        '--    Pair with ERRORFILE to capture rejected rows for inspection.',
        '',
        '-- 7. BULK INSERT TEMPLATE',
    ]
    if is_azure_sql:
        lines += [
            '--    BULK INSERT [dbo].[MyTable]',
            '--    FROM \'folder/file.csv\'',
            '--    WITH (',
            '--        DATA_SOURCE = \'MyDataSource_Bulk\',  '
            '-- TYPE = BLOB_STORAGE',
            f'--        FIRSTROW = {2 if has_header else 1},',
            f'--        FIELDTERMINATOR = \'{display_delimiter}\',',
            '--        CODEPAGE = \'65001\',',
            '--        TABLOCK',
            '--    );',
        ]
    else:
        lines += [
            '--    BULK INSERT [dbo].[MyTable]',
            '--    FROM \'C:\\data\\file.csv\'',
            '--    WITH (',
            f'--        FIRSTROW = {2 if has_header else 1},',
            f'--        FIELDTERMINATOR = \'{display_delimiter}\',',
            '--        CODEPAGE = \'65001\',',
            '--        TABLOCK',
            '--    );',
        ]
    return lines


def _best_practices_parquet(size_mb: float, compression: str,
                             metadata: Dict[str, Any],
                             target_platform: str = DEFAULT_TARGET_PLATFORM) -> List[str]:
    row_groups = (metadata.get('parquet_metadata') or {}).get('num_row_groups', 'unknown')
    comp_label = compression or 'UNCOMPRESSED'

    if target_platform == 'fabric_sql_db':
        tool_selection = [
            '--    Fabric SQL Database → OPENROWSET FORMAT=\'PARQUET\' over Lakehouse Files',
            '--    Repeated access     → CREATE EXTERNAL TABLE with FORMAT_TYPE = PARQUET',
            '--    Managed access      → OneLake shortcut from a Lakehouse or Warehouse',
        ]
    elif target_platform == 'sql_server_2019':
        tool_selection = [
            '--    SQL Server 2019 → Parquet is not supported; convert to CSV first',
            '--    Or upgrade to SQL Server 2022+ for OPENROWSET FORMAT=\'PARQUET\'',
        ]
    elif target_platform in {'azure_sql_db', 'azure_sql_mi'}:
        tool_selection = [
            '--    Azure SQL → OPENROWSET FORMAT=\'PARQUET\' over abs:// or adls://',
            '--    Repeated access → CREATE EXTERNAL TABLE with FORMAT_TYPE = PARQUET',
        ]
    else:
        tool_selection = [
            '--    SQL Server 2022+ → OPENROWSET FORMAT=\'PARQUET\' over ABS/ADLS/S3',
            '--    Repeated access  → CREATE EXTERNAL TABLE with FORMAT_TYPE = PARQUET',
        ]

    lines = [
        f'-- Detected: Parquet, compression={_sql_comment(comp_label)}, '
        f'row_groups={_sql_comment(row_groups)}',
        '',
        '-- 1. TOOL SELECTION',
        *tool_selection,
        '',
        '-- 2. COMPRESSION',
        f'--    Detected: {_sql_comment(comp_label)}',
        '--    Snappy → best balance of speed and ratio (recommended for analytics)',
        '--    ZSTD   → better compression, requires pyarrow/Spark write options',
        '--    LZ4    → fastest decompression, slightly larger files',
        '--    Avoid GZIP for Parquet (not splittable)',
        '',
        '-- 3. PARTITIONING',
        '--    For large datasets write Parquet partitioned by date or region:',
        '--    df.write.partitionBy("year","month").parquet("path/")',
        '--    Then use folder wildcards:  BULK \'path/year=*/month=*/*.parquet\'',
        '',
        '-- 4. ROW GROUP SIZE',
        '--    Ideal row group size: 128 MB (Spark default).',
        f'--    This file has {_sql_comment(row_groups)} row group(s).',
        '--    Too many small row groups → slow reads. Repartition / coalesce before write.',
        '',
        '-- 5. SCHEMA EVOLUTION',
        '--    Add new nullable columns at the end of the schema.',
        '--    OPENROWSET reads only the columns requested — missing columns return NULL.',
        '',
        '-- 6. STATISTICS',
        '--    Create column statistics after loading for the query optimiser:',
        '--    CREATE STATISTICS stats_col1 ON [dbo].[MyTable]([col1]);',
    ]
    return lines


def _best_practices_delta(metadata: Dict[str, Any],
                          target_platform: str) -> List[str]:
    dm = metadata.get('delta_metadata') or {}
    version = dm.get('version', 'unknown')
    partition_cols = dm.get('partition_columns') or []

    if target_platform in {'sql_server_2022', 'sql_server_2025'}:
        platform_guidance = [
            '--    SQL Server 2022+ → OPENROWSET FORMAT=\'DELTA\' over ABS/ADLS/S3',
            '--    Point BULK at the Delta table folder, not a single file.',
        ]
    elif target_platform == 'azure_sql_db':
        platform_guidance = [
            '--    Azure SQL Database → OPENROWSET FORMAT=\'DELTA\' over abs:// or adls://',
            '--    Point BULK at the Delta table folder, not a single file.',
        ]
    elif target_platform == 'azure_sql_mi':
        platform_guidance = [
            '--    Azure SQL Managed Instance → Delta is NOT supported.',
            '--    Convert the table to Parquet, then use FORMAT=\'PARQUET\'.',
        ]
    elif target_platform == 'fabric_sql_db':
        platform_guidance = [
            '--    Fabric SQL Database → Delta is NOT supported by OPENROWSET.',
            '--    Create a OneLake shortcut to the Delta table from a Lakehouse or',
            '--    Warehouse, or convert the table to Parquet in Lakehouse Files.',
        ]
    else:
        platform_guidance = [
            '--    SQL Server 2019 → Delta is not supported; convert to CSV or Parquet',
            '--    and upgrade to SQL Server 2022+ for native Delta access.',
        ]

    lines = [
        f'-- Detected: Delta Lake table  (version {_sql_comment(version)})',
        f'-- Partition columns: {_sql_comment(partition_cols or "none")}',
        '',
        '-- 1. TOOL SELECTION',
        *platform_guidance,
        '',
        '-- 2. TIME TRAVEL',
        '--    Delta time travel is a writer-engine feature (Spark / Databricks):',
        '--    spark.read.format("delta").option("versionAsOf", 5).load("...")',
        '--    Vacuum regularly to avoid bloat:  VACUUM delta.`path` RETAIN 168 HOURS',
        '',
        '-- 3. QUERY TEMPLATE',
        '--    SELECT TOP 100 *',
        '--    -- MyDataSource LOCATION uses adls:// or abs://',
        '--    FROM OPENROWSET(',
        '--        BULK \'<delta_folder>/\',',
        '--        DATA_SOURCE = \'MyDataSource\',',
        '--        FORMAT = \'DELTA\'',
        '--    ) AS [result];',
        '',
        '-- 4. PARTITION PRUNING',
        f'--    Partition by: '
        f'{_sql_comment(partition_cols or "< not partitioned >")}',
        '--    Add matching WHERE clauses to eliminate partition scans.',
        '',
        '-- 5. OPTIMIZE & ZORDER (Databricks / OSS Delta)',
        '--    OPTIMIZE delta.`path` ZORDER BY (event_date, user_id)',
        '--    Reduces file scans for selective queries significantly.',
        '',
        '-- 6. CONVERT DELTA → PARQUET when the target does not support Delta',
        '--    spark.read.format("delta").load("path").write.parquet("out/")',
        '--    Then use CREATE EXTERNAL TABLE with FORMAT_TYPE = PARQUET.',
    ]
    return lines


def _best_practices_json(size_mb: float,
                         target_platform: str = DEFAULT_TARGET_PLATFORM) -> List[str]:
    if target_platform == 'fabric_sql_db':
        remote_example = [
            '-- 3. FABRIC SQL DATABASE — JSON via OPENROWSET + OPENJSON',
            '--    Fabric SQL Database has no JSON file format, so the CSV reader',
            '--    is used with non-printing delimiters to read whole documents.',
            '--    SELECT j.*',
            '--    FROM OPENROWSET(BULK \'folder/file.json\',',
            '--        DATA_SOURCE = \'MyDataSource\', FORMAT = \'CSV\',',
            '--        FIELDTERMINATOR = \'0x0b\', FIELDQUOTE = \'0x0b\')',
            '--    WITH (json_doc NVARCHAR(MAX)) AS src',
            '--    CROSS APPLY OPENJSON(src.json_doc)',
            '--    WITH ([col1] INT, [col2] NVARCHAR(255)) AS j;',
        ]
    else:
        remote_example = [
            '-- 3. OBJECT STORAGE — JSON via OPENROWSET + OPENJSON',
            '--    SELECT j.*',
            '--    FROM OPENROWSET(BULK \'folder/file.json\',',
            '--        DATA_SOURCE = \'MyDataSource\', FORMAT = \'CSV\',',
            '--        FIELDTERMINATOR = \'0x0b\', FIELDQUOTE = \'0x0b\')',
            '--    WITH (json_doc NVARCHAR(MAX)) AS src',
            '--    CROSS APPLY OPENJSON(src.json_doc)',
            '--    WITH ([col1] INT, [col2] NVARCHAR(255)) AS j;',
        ]

    lines = [
        '-- Detected: JSON file',
        '',
        '-- 1. TOOL SELECTION',
        '--    Small files (< 100 MB): OPENJSON directly in T-SQL',
        '--    Large files           : Convert to Parquet with pandas/Spark, then use Parquet path',
        '',
        '-- 2. OPENJSON (SQL Server 2016+ / Azure SQL / Fabric SQL DB)',
        '--    DECLARE @json NVARCHAR(MAX) = (SELECT BulkColumn FROM OPENROWSET(',
        '--        BULK \'file.json\', DATA_SOURCE = \'MyDataSource\', SINGLE_CLOB) AS j);',
        '--    SELECT * FROM OPENJSON(@json)',
        '--    WITH (',
        '--        [col1] INT     \'$.col1\',',
        '--        [col2] NVARCHAR(255) \'$.col2\'',
        '--    );',
        '',
        *remote_example,
        '',
        '-- 4. PERFORMANCE',
        '--    JSON parsing in T-SQL is CPU-intensive.',
        '--    Pre-process JSON to Parquet with pandas/pyarrow for large datasets:',
        '--       import pandas as pd; df = pd.read_json("file.json")',
        '--       df.to_parquet("file.parquet", compression="snappy")',
    ]
    return lines


def _best_practices_generic() -> List[str]:
    return [
        '-- 1. Identify the exact file format and encoding before loading.',
        '-- 2. Use a staging table (all columns NVARCHAR) for initial load.',
        '-- 3. Validate and transform into typed production table.',
        '-- 4. Add column statistics after loading for the query optimiser.',
    ]
