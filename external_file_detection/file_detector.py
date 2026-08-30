"""File type detection and metadata analysis module."""

import os
import codecs
import json
import csv
import math
import logging
import re
import threading
from collections import OrderedDict
from copy import deepcopy
from typing import Dict, List, Any, Optional, Tuple
from pathlib import Path

logger = logging.getLogger(__name__)

# Lazy imports for heavy dependencies (deferred to first use)
pd = None  # pandas
pq = None  # pyarrow.parquet


def _ensure_pandas():
    """Lazily import pandas on first use."""
    global pd
    if pd is None:
        import pandas as _pd
        pd = _pd
    return pd


def _ensure_pyarrow():
    """Lazily import pyarrow.parquet on first use."""
    global pq
    if pq is None:
        import pyarrow.parquet as _pq
        pq = _pq
    return pq

# --- Constants ---
CSV_SAMPLE_SIZE = 4096
ENCODING_DETECTION_BYTES = 65536
LARGE_FILE_THRESHOLD = 100 * 1024 * 1024  # 100 MB
JSON_FULL_PARSE_MAX_BYTES = 32 * 1024 * 1024
JSON_SAMPLE_MAX_CHARS = 4 * 1024 * 1024
JSON_SCHEMA_SAMPLE_ROWS = 200
CACHE_MAX_ENTRIES = 256


def _json_safe(val: Any) -> Any:
    """Return a JSON-serialisable representation of *val* for sample storage."""
    if isinstance(val, float) and (math.isnan(val) or math.isinf(val)):
        return None
    if isinstance(val, (str, int, float, bool, type(None))):
        return val
    return str(val)


def _size_sampled_string(observed_length: int) -> int:
    """Add headroom so a sampled maximum is not treated as a hard limit."""
    if observed_length <= 0:
        return 0
    return int(math.ceil(observed_length * 1.25))


class FileDetector:
    """Detects file types and analyzes metadata for SQL DDL generation."""

    SUPPORTED_EXTENSIONS = {
        '.txt': 'text',
        '.csv': 'csv',
        '.tsv': 'csv',
        '.parquet': 'parquet',
        '.snappy': 'parquet',
        '.json': 'json',
        '.jsonl': 'json',
        '.ndjson': 'json',
        '.orc': 'orc',
        '.rc': 'rc',
        '.delta': 'delta',
        '.xlsx': 'excel',
        '.xls': 'excel',
    }

    # Codepage numbers for SQL Server BULK INSERT
    CODEPAGE_MAP = {
        'utf-8': '65001',
        'utf-8-sig': '65001',
        'ascii': '1252',
        'latin-1': '1252',
        'iso-8859-1': '1252',
        'cp1252': '1252',
        'windows-1252': '1252',
        'utf-16': '1200',
        'utf-16-le': '1200',
        'utf-16-be': '1201',
        'shift_jis': '932',
        'shift-jis': '932',
        'sjis': '932',
        'cp932': '932',
        'ms932': '932',
        'euc-jp': '20932',
        'euc_jp': '20932',
        'gbk': '936',
        'cp936': '936',
        'gb2312': '936',
        'big5': '950',
        'cp950': '950',
        'cp1251': '1251',
        'windows-1251': '1251',
    }

    def __init__(self, cache_max_entries: int = CACHE_MAX_ENTRIES):
        """Initialize the file detector."""
        if cache_max_entries < 1:
            raise ValueError('cache_max_entries must be at least 1')
        self._cache_max_entries = cache_max_entries
        self._cache_lock = threading.Lock()
        self._encoding_cache: OrderedDict = OrderedDict()
        self._metadata_cache: OrderedDict = OrderedDict()

    def _get_file_signature(self, file_path: str) -> Optional[Tuple[str, int, int]]:
        """Return a cache signature for a file or directory based on path + stat info."""
        try:
            stat = os.stat(file_path)
            mtime_ns = stat.st_mtime_ns
            size = stat.st_size
            if os.path.isdir(file_path):
                for metadata_dir_name in ('_delta_log', 'metadata'):
                    metadata_dir = os.path.join(file_path, metadata_dir_name)
                    if not os.path.isdir(metadata_dir):
                        continue
                    for entry in os.scandir(metadata_dir):
                        if not entry.is_file():
                            continue
                        entry_stat = entry.stat()
                        mtime_ns = max(mtime_ns, entry_stat.st_mtime_ns)
                        size += entry_stat.st_size
            return (os.path.abspath(file_path), mtime_ns, size)
        except OSError:
            return None

    @staticmethod
    def _cache_get(cache: OrderedDict, signature: tuple) -> Any:
        """Return and promote an LRU cache entry. Caller must hold the cache lock."""
        if signature not in cache:
            return None
        value = cache.pop(signature)
        cache[signature] = value
        return value

    def _cache_set(self, cache: OrderedDict, signature: tuple, value: Any) -> None:
        """Insert an LRU cache entry. Caller must hold the cache lock."""
        cache.pop(signature, None)
        cache[signature] = value
        while len(cache) > self._cache_max_entries:
            cache.popitem(last=False)

    def clear_caches(self) -> None:
        """Clear cached encoding and metadata results."""
        with self._cache_lock:
            self._encoding_cache.clear()
            self._metadata_cache.clear()

    def is_delta_table_directory(self, directory_path: str) -> bool:
        """Return True if *directory_path* looks like a Delta Lake table folder."""
        if not os.path.isdir(directory_path):
            return False
        return os.path.isdir(os.path.join(directory_path, '_delta_log'))

    def is_iceberg_table_directory(self, directory_path: str) -> bool:
        """Return True if *directory_path* looks like an Apache Iceberg table folder."""
        if not os.path.isdir(directory_path):
            return False
        metadata_dir = os.path.join(directory_path, 'metadata')
        if not os.path.isdir(metadata_dir):
            return False
        import glob
        return bool(glob.glob(os.path.join(metadata_dir, '*.metadata.json')))

    # ------------------------------------------------------------------
    # Type detection
    # ------------------------------------------------------------------

    def detect_file_type(self, file_path: str) -> str:
        """Detect the type of a file based on extension and content analysis."""
        if self.is_delta_table_directory(file_path):
            return 'delta'
        if self.is_iceberg_table_directory(file_path):
            return 'iceberg'
        if os.path.isdir(file_path):
            return 'unknown'

        path = Path(file_path)
        extension = path.suffix.lower()

        if extension in self.SUPPORTED_EXTENSIONS:
            return self.SUPPORTED_EXTENSIONS[extension]

        try:
            return self._detect_by_content(file_path)
        except Exception:
            return 'unknown'

    def _detect_by_content(self, file_path: str) -> str:
        """Detect file type by analysing the first bytes / characters."""
        # Parquet magic bytes: PAR1
        try:
            with open(file_path, 'rb') as f:
                header = f.read(4)
            if header == b'PAR1':
                return 'parquet'
        except Exception:
            pass

        # JSON — only read the first few KB instead of the whole file
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                sample = f.read(8192)
            sample_stripped = sample.lstrip()
            if sample_stripped and sample_stripped[0] in ('{', '['):
                json.loads(sample_stripped)
                return 'json'
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            # Partial read may fail to parse; check if it starts like JSON
            try:
                if sample_stripped and sample_stripped[0] in ('{', '['):
                    return 'json'
            except Exception:
                pass

        # CSV / delimited text
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                sample = f.read(2048)
            sniffer = csv.Sniffer()
            if sniffer.has_header(sample):
                return 'csv'
        except Exception:
            pass

        return 'text'

    # ------------------------------------------------------------------
    # Encoding detection
    # ------------------------------------------------------------------

    #: Byte-order marks that settle the encoding outright. Ordered longest
    #: first so the UTF-32LE mark is never read as UTF-16LE followed by NULs.
    _BOM_ENCODINGS: Tuple[Tuple[bytes, str], ...] = (
        (codecs.BOM_UTF8, 'utf-8-sig'),
        (codecs.BOM_UTF32_LE, 'utf-32'),
        (codecs.BOM_UTF32_BE, 'utf-32'),
        (codecs.BOM_UTF16_LE, 'utf-16'),
        (codecs.BOM_UTF16_BE, 'utf-16'),
    )

    @staticmethod
    def _decodes_as_utf8(raw: bytes, truncated: bool) -> bool:
        """Return True when *raw* is valid UTF-8.

        A capped read can slice a multi-byte character in half, which is an
        artefact of the cap and not evidence the file is something else, so a
        failure in the final three bytes of a truncated read is retried
        without the incomplete tail.
        """
        try:
            raw.decode('utf-8')
            return True
        except UnicodeDecodeError as exc:
            if not (truncated and exc.end >= len(raw) and exc.start >= len(raw) - 3):
                return False
            try:
                raw[: exc.start].decode('utf-8')
                return True
            except UnicodeDecodeError:
                return False

    def detect_encoding(self, file_path: str) -> Tuple[str, float]:
        """Detect a file's encoding.

        A byte-order mark, pure ASCII and valid UTF-8 are *facts about the
        bytes*; ``chardet`` is a statistical guess. Asking the guess first made
        the answer depend on which chardet build happened to be installed --
        under Python 3.9 it classified valid UTF-8 fixtures as a charmap codec,
        and every later read of those files then died on byte 0x81. The
        certain answers are therefore established first, and chardet is left to
        do the job only it can do: naming a legacy codepage such as CP932.
        """
        signature = self._get_file_signature(file_path)
        if signature:
            with self._cache_lock:
                cached = self._cache_get(self._encoding_cache, signature)
                if cached is not None:
                    return cached

        detected = self._detect_encoding_uncached(file_path)
        if signature:
            with self._cache_lock:
                self._cache_set(self._encoding_cache, signature, detected)
        return detected

    def _detect_encoding_uncached(self, file_path: str) -> Tuple[str, float]:
        try:
            import chardet
        except ImportError:
            chardet = None

        with open(file_path, 'rb') as handle:
            raw = handle.read(ENCODING_DETECTION_BYTES)
            truncated = bool(handle.read(1))

        for bom, encoding in self._BOM_ENCODINGS:
            if raw.startswith(bom):
                return (encoding, 1.0)

        if raw:
            # ASCII is a subset of UTF-8 but maps to a different SQL Server
            # codepage, so it keeps its own answer rather than being folded in.
            if max(raw) < 0x80:
                return ('ascii', 1.0)
            if self._decodes_as_utf8(raw, truncated):
                return ('utf-8', 1.0)

        if chardet is not None:
            result = chardet.detect(raw) or {}
            return (
                (result.get('encoding') or 'utf-8').lower(),
                float(result.get('confidence') or 0.0),
            )

        for enc in ['utf-8-sig', 'utf-8', 'cp1252', 'latin-1']:
            try:
                with open(file_path, 'r', encoding=enc) as handle:
                    handle.read(4096)
                return (enc, 0.5)
            except (UnicodeDecodeError, LookupError):
                continue
        return ('utf-8', 0.0)

    def encoding_to_codepage(self, encoding: str) -> str:
        """Return the SQL Server codepage string for a given Python encoding name."""
        key = encoding.lower().strip()
        return self.CODEPAGE_MAP.get(key, 'ACP')

    # ------------------------------------------------------------------
    # Full metadata analysis
    # ------------------------------------------------------------------

    def analyze_file_metadata(self, file_path: str) -> Dict[str, Any]:
        """Analyse file metadata including schema, size, encoding and format details."""
        signature = self._get_file_signature(file_path)
        if signature:
            with self._cache_lock:
                cached = self._cache_get(self._metadata_cache, signature)
                if cached is not None:
                    return deepcopy(cached)

        file_type = self.detect_file_type(file_path)
        if file_type in ('csv', 'text', 'json'):
            encoding, enc_confidence = self.detect_encoding(file_path)
        else:
            encoding, enc_confidence = 'binary', 1.0
        codepage = self.encoding_to_codepage(encoding)

        if os.path.isdir(file_path):
            file_size = sum(
                os.path.getsize(os.path.join(dp, f))
                for dp, _, fns in os.walk(file_path)
                for f in fns
            )
        else:
            file_size = os.path.getsize(file_path)

        metadata: Dict[str, Any] = {
            'file_path': file_path,
            'file_name': os.path.basename(file_path),
            'file_type': file_type,
            'file_size': file_size,
            'schema': None,
            'row_count': None,
            'column_count': None,
            'delimiter': None,
            'encoding': encoding,
            'encoding_confidence': round(enc_confidence * 100),
            'codepage': codepage,
            'has_header': False,
            'compression': None,
            'nullable_columns': [],
            'parquet_metadata': None,
            'delta_metadata': None,
        }

        # Warn if encoding detection confidence is low
        if file_type in ('csv', 'text', 'json') and enc_confidence < 0.5:
            metadata['encoding_warning'] = (
                f'Low confidence ({round(enc_confidence * 100)}%) for encoding "{encoding}". '
                f'Verify encoding manually or specify it explicitly.'
            )

        try:
            if file_type == 'csv':
                metadata.update(self._analyze_csv(file_path, encoding))
            elif file_type == 'parquet':
                metadata.update(self._analyze_parquet(file_path))
            elif file_type == 'orc':
                metadata.update(self._analyze_orc(file_path))
            elif file_type == 'delta':
                metadata.update(self._analyze_delta(file_path))
            elif file_type == 'iceberg':
                metadata.update(self._analyze_iceberg(file_path))
            elif file_type == 'json':
                metadata.update(self._analyze_json(file_path, encoding))
            elif file_type == 'excel':
                metadata.update(self._analyze_excel(file_path))
            elif file_type == 'text':
                metadata.update(self._analyze_text(file_path, encoding))
        except Exception as e:
            metadata['error'] = str(e)

        if signature:
            with self._cache_lock:
                self._cache_set(
                    self._metadata_cache, signature, deepcopy(metadata)
                )
        return metadata

    # ------------------------------------------------------------------
    # Per-format analyser helpers
    # ------------------------------------------------------------------

    def _analyze_csv(self, file_path: str, encoding: str = 'utf-8') -> Dict[str, Any]:
        """Analyse CSV / TSV file metadata."""
        _ensure_pandas()
        result: Dict[str, Any] = {}
        try:
            delimiter = ','
            has_header = True
            try:
                with open(file_path, 'r', encoding=encoding, errors='replace') as f:
                    sample = f.read(4096)
                sniffer = csv.Sniffer()
                dialect = sniffer.sniff(sample)
                delimiter = dialect.delimiter
                has_header = sniffer.has_header(sample)
            except csv.Error:
                if '.tsv' in file_path.lower():
                    delimiter = '\t'

            result['delimiter'] = delimiter
            result['has_header'] = has_header

            df = pd.read_csv(
                file_path,
                nrows=1000,
                encoding=encoding,
                sep=delimiter,
                header=0 if has_header else None,
                low_memory=False,
                on_bad_lines='warn',
            )
            if not has_header:
                df.columns = [
                    f'column_{index + 1}' for index in range(len(df.columns))
                ]
            else:
                df.columns = [str(column) for column in df.columns]
            result['schema'] = [
                (str(col), str(dtype)) for col, dtype in df.dtypes.items()
            ]
            result['column_count'] = len(df.columns)
            result['schema_inference'] = 'sampled'
            result['schema_sample_size'] = len(df)
            result['nullability_inference'] = 'conservative'

            # Sample max string lengths for smarter SQL type sizing
            observed_lengths: Dict[str, int] = {}
            for col in df.columns:
                if pd.api.types.is_string_dtype(df[col].dtype):
                    max_len = df[col].dropna().astype(str).str.len().max()
                    observed_lengths[str(col)] = (
                        int(max_len) if pd.notna(max_len) else 0
                    )
            result['observed_max_string_lengths'] = observed_lengths
            result['max_string_lengths'] = {
                col: _size_sampled_string(length)
                for col, length in observed_lengths.items()
            }

            try:
                file_size = os.path.getsize(file_path)
                if file_size > LARGE_FILE_THRESHOLD:  # estimate row count for large files
                    with open(file_path, 'rb') as f:
                        sample_lines = [f.readline() for _ in range(500)]
                    populated_lines = [line for line in sample_lines if line]
                    avg_line = sum(
                        len(line) for line in populated_lines
                    ) / max(len(populated_lines), 1)
                    result['row_count'] = max(
                        int(file_size / max(avg_line, 1))
                        - (1 if has_header else 0),
                        0,
                    )
                    result['row_count_estimated'] = True
                else:
                    with open(
                        file_path,
                        'r',
                        encoding=encoding,
                        errors='replace',
                        newline='',
                    ) as f:
                        logical_rows = sum(
                            1 for _ in csv.reader(f, delimiter=delimiter)
                        )
                    result['row_count'] = max(
                        logical_rows - (1 if has_header else 0), 0
                    )
                    result['row_count_estimated'] = False
            except (OSError, UnicodeError, csv.Error):
                result['row_count'] = len(df)
                result['row_count_estimated'] = True

            result['nullable_columns'] = [str(col) for col in df.columns]

            # Store sample rows (first 3) for SQL comment generation
            sample_rows = df.head(3).where(pd.notnull(df.head(3)), None).values.tolist()
            result['sample_rows'] = [[_json_safe(v) for v in row] for row in sample_rows]
        except Exception as e:
            logger.warning("Failed to analyze CSV %s: %s", file_path, e)
            result['error'] = str(e)
            result.setdefault('delimiter', ',')
            result.setdefault('has_header', False)
        return result

    def _analyze_parquet(self, file_path: str) -> Dict[str, Any]:
        """Analyse Parquet file metadata."""
        _ensure_pyarrow()
        try:
            pf = pq.ParquetFile(file_path)
            arrow_schema = pf.schema_arrow
            pq_meta = pf.metadata

            schema = [(field.name, str(field.type)) for field in arrow_schema]
            nullable_cols = [field.name for field in arrow_schema if field.nullable]

            compression = None
            if pq_meta.num_row_groups > 0:
                try:
                    compression = pq_meta.row_group(0).column(0).compression
                except Exception:
                    pass

            kv_meta: Dict[str, str] = {}
            if pq_meta.metadata:
                for k, v in pq_meta.metadata.items():
                    try:
                        kv_meta[k.decode()] = v.decode()
                    except Exception:
                        pass

            return {
                'schema': schema,
                'row_count': pq_meta.num_rows,
                'column_count': len(arrow_schema),
                'compression': compression,
                'nullable_columns': nullable_cols,
                'encoding': 'binary',
                'parquet_metadata': {
                    'created_by': pq_meta.created_by,
                    'num_row_groups': pq_meta.num_row_groups,
                    'serialized_size': pq_meta.serialized_size,
                    'format_version': str(pq_meta.format_version),
                    'key_value_metadata': kv_meta,
                },
            }
        except Exception as e:
            return {'error': str(e), 'encoding': 'binary'}

    def _analyze_orc(self, file_path: str) -> Dict[str, Any]:
        """Analyse ORC file metadata using the Arrow ORC reader."""
        _ensure_pyarrow()
        try:
            import pyarrow.orc as orc
        except ImportError:
            return {
                'error': 'ORC analysis requires a pyarrow build with ORC '
                         'support. Install with: pip install pyarrow',
                'encoding': 'binary',
            }

        try:
            reader = orc.ORCFile(file_path)
            arrow_schema = reader.schema
            compression = getattr(reader, 'compression', None)
            return {
                'schema': [(f.name, str(f.type)) for f in arrow_schema],
                'row_count': reader.nrows,
                'column_count': len(arrow_schema),
                'compression': str(compression) if compression else None,
                'nullable_columns': [
                    f.name for f in arrow_schema if f.nullable
                ],
                'encoding': 'binary',
            }
        except Exception as e:
            return {'error': str(e), 'encoding': 'binary'}

    @staticmethod
    def _first_parquet_file(
        directory_path: str,
        data_subdirectory: Optional[str] = None,
    ) -> Optional[str]:
        """Return the first underlying Parquet file without loading table data."""
        search_root = (
            os.path.join(directory_path, data_subdirectory)
            if data_subdirectory
            else directory_path
        )
        if not os.path.isdir(search_root):
            return None

        excluded_directories = {
            '_delta_log',
            '_change_data',
            '_symlink_format_manifest',
        }
        for root, dirs, files in os.walk(search_root):
            dirs[:] = sorted(
                directory
                for directory in dirs
                if directory not in excluded_directories
            )
            for filename in sorted(files):
                if filename.lower().endswith('.parquet'):
                    return os.path.join(root, filename)
        return None

    def _analyze_table_parquet_fallback(
        self, file_path: str, warning: str
    ) -> Dict[str, Any]:
        """Derive schema from one data file without claiming a table row count."""
        parquet_file = self._first_parquet_file(file_path)
        if parquet_file is None:
            return {
                'error': 'No underlying Parquet data file found',
                'warning': warning,
                'encoding': 'binary',
            }
        result = self._analyze_parquet(parquet_file)
        result['row_count'] = None
        result['warning'] = warning
        result['schema_inference'] = 'underlying_parquet_file'
        return result

    def _analyze_delta(self, file_path: str) -> Dict[str, Any]:
        """Analyse a Delta Lake table folder."""
        try:
            from deltalake import DeltaTable  # type: ignore
            dt = DeltaTable(file_path)
            schema = dt.schema()
            meta = dt.metadata()

            fields = [(f.name, str(f.type)) for f in schema.fields]
            nullable_cols = [f.name for f in schema.fields if f.nullable]

            delta_meta = {
                'version': dt.version(),
                'name': meta.name,
                'description': meta.description,
                'partition_columns': meta.partition_columns,
                'created_time': str(meta.created_time) if meta.created_time else None,
                'configuration': meta.configuration,
            }

            row_count = None
            try:
                # Use pyarrow dataset to count rows without loading data
                ds = dt.to_pyarrow_dataset()
                row_count = ds.count_rows()
            except Exception as exc:
                logger.warning(
                    "Unable to count rows in Delta table %s: %s",
                    file_path,
                    exc,
                )

            return {
                'schema': fields,
                'column_count': len(fields),
                'row_count': row_count,
                'nullable_columns': nullable_cols,
                'delta_metadata': delta_meta,
                'encoding': 'binary',
            }
        except ImportError:
            logger.warning("DeltaTable analysis requires 'deltalake' package. "
                           "Falling back to Parquet analysis for %s. "
                           "Install with: pip install deltalake", file_path)
            return self._analyze_table_parquet_fallback(
                file_path,
                'Delta table support requires: pip install deltalake',
            )
        except Exception as e:
            return self._analyze_table_parquet_fallback(
                file_path,
                f'Delta log parsing failed ({type(e).__name__}). '
                'Metadata derived from one underlying Parquet file.',
            )

    @staticmethod
    def _iceberg_metadata_version(metadata_file: str) -> Optional[int]:
        """Extract a numeric version from common Iceberg metadata filenames."""
        name = os.path.basename(metadata_file)
        for pattern in (
            r'^v(\d+)\.metadata\.json$',
            r'^(\d+)(?:-[^.]+)?\.metadata\.json$',
        ):
            match = re.match(pattern, name, flags=re.IGNORECASE)
            if match:
                return int(match.group(1))
        return None

    def _latest_iceberg_metadata_file(self, table_path: str) -> Optional[str]:
        """Select current Iceberg metadata by numeric metadata version."""
        import glob

        metadata_dir = os.path.join(table_path, 'metadata')
        candidates = glob.glob(
            os.path.join(metadata_dir, '*.metadata.json')
        )
        if not candidates:
            return None

        versioned = [
            (version, candidate)
            for candidate in candidates
            if (version := self._iceberg_metadata_version(candidate)) is not None
        ]
        if versioned:
            return max(
                versioned,
                key=lambda item: (
                    item[0],
                    os.path.getmtime(item[1]),
                    item[1],
                ),
            )[1]
        return max(candidates, key=lambda path: (os.path.getmtime(path), path))

    @staticmethod
    def _current_iceberg_schema(metadata: Dict[str, Any]) -> Dict[str, Any]:
        """Return the schema identified by current-schema-id."""
        direct_schema = metadata.get('schema')
        if isinstance(direct_schema, dict):
            return direct_schema

        schemas = [
            schema
            for schema in metadata.get('schemas', [])
            if isinstance(schema, dict)
        ]
        current_schema_id = metadata.get('current-schema-id')
        for schema in schemas:
            if schema.get('schema-id') == current_schema_id:
                return schema
        if schemas:
            return max(
                schemas,
                key=lambda schema: schema.get('schema-id', -1),
            )
        return {}

    @staticmethod
    def _current_iceberg_partition_spec(
        metadata: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Return fields from the default Iceberg partition spec."""
        direct_spec = metadata.get('partition-spec')
        if isinstance(direct_spec, list):
            return direct_spec
        if isinstance(direct_spec, dict):
            fields = direct_spec.get('fields', [])
            return fields if isinstance(fields, list) else []

        specs = [
            spec
            for spec in metadata.get('partition-specs', [])
            if isinstance(spec, dict)
        ]
        default_spec_id = metadata.get('default-spec-id')
        for spec in specs:
            if spec.get('spec-id') == default_spec_id:
                fields = spec.get('fields', [])
                return fields if isinstance(fields, list) else []
        return []

    @staticmethod
    def _iceberg_row_count(metadata: Dict[str, Any]) -> Optional[int]:
        """Read an authoritative row count from the current snapshot summary."""
        current_snapshot_id = metadata.get('current-snapshot-id')
        if current_snapshot_id is None:
            return 0 if 'current-snapshot-id' in metadata else None

        for snapshot in metadata.get('snapshots', []):
            if not isinstance(snapshot, dict):
                continue
            if snapshot.get('snapshot-id') != current_snapshot_id:
                continue
            summary = snapshot.get('summary') or {}
            total_records = summary.get('total-records')
            try:
                return max(int(total_records), 0)
            except (TypeError, ValueError):
                return None
        return None

    @staticmethod
    def _iceberg_type(raw_type: Any) -> str:
        """Map an Iceberg primitive or nested type to the internal type names."""
        if isinstance(raw_type, dict):
            nested_type = str(raw_type.get('type', 'string')).lower()
            if nested_type == 'list':
                return 'list'
            if nested_type in ('struct', 'map'):
                return 'dict'
            raw_type = nested_type

        normalized = str(raw_type).lower().strip()
        primitive = re.split(r'[\[(]', normalized, maxsplit=1)[0]

        # Preserve decimal precision/scale so the SQL mapper can emit
        # DECIMAL(p, s) instead of collapsing to a generic decimal type.
        if primitive in ('decimal', 'decimal128', 'decimal256'):
            match = re.match(
                r'^decimal(?:128|256)?\s*\(\s*(\d+)\s*,\s*(-?\d+)\s*\)$',
                normalized,
            )
            if match:
                return f'decimal({match.group(1)},{match.group(2)})'
            return 'decimal128'

        # Preserve timezone and nanosecond semantics for timestamps.
        timestamp_map = {
            'timestamp': 'timestamp[us]',
            'timestamp_ntz': 'timestamp[us]',
            'timestamptz': 'timestamp[us, tz=UTC]',
            'timestamp_ns': 'timestamp[ns]',
            'timestamptz_ns': 'timestamp[ns, tz=UTC]',
        }
        if primitive in timestamp_map:
            return timestamp_map[primitive]

        type_map = {
            'boolean': 'bool',
            'int': 'int32',
            'long': 'int64',
            'float': 'float32',
            'double': 'float64',
            'string': 'str',
            'date': 'date',
            'time': 'time64[us]',
            'binary': 'binary',
            'uuid': 'str',
            'fixed': 'binary',
        }
        return type_map.get(primitive, 'str')

    def _analyze_iceberg(self, file_path: str) -> Dict[str, Any]:
        """Analyse an Apache Iceberg table folder from current metadata."""
        try:
            metadata_file = self._latest_iceberg_metadata_file(file_path)
            if metadata_file is None:
                return {
                    'error': 'No Iceberg metadata file found',
                    'encoding': 'binary',
                }

            with open(metadata_file, 'r', encoding='utf-8') as handle:
                metadata = json.load(handle)
            if not isinstance(metadata, dict):
                raise ValueError('Iceberg metadata root must be a JSON object')

            current_schema = self._current_iceberg_schema(metadata)
            fields = current_schema.get('fields', [])
            if not isinstance(fields, list):
                raise ValueError('Iceberg schema fields must be a list')

            schema = []
            nullable_columns = []
            for field in fields:
                if not isinstance(field, dict):
                    continue
                name = str(field.get('name', ''))
                if not name:
                    continue
                schema.append((name, self._iceberg_type(field.get('type'))))
                if not field.get('required', False):
                    nullable_columns.append(name)

            iceberg_metadata = {
                'format_version': metadata.get('format-version'),
                'table_uuid': metadata.get('table-uuid'),
                'location': metadata.get('location'),
                'last_updated': metadata.get('last-updated-ms'),
                'current_schema_id': metadata.get('current-schema-id'),
                'default_spec_id': metadata.get('default-spec-id'),
                'partition_spec': self._current_iceberg_partition_spec(
                    metadata
                ),
                'metadata_file': os.path.basename(metadata_file),
            }
            return {
                'schema': schema,
                'column_count': len(schema),
                'row_count': self._iceberg_row_count(metadata),
                'nullable_columns': nullable_columns,
                'iceberg_metadata': iceberg_metadata,
                'schema_inference': 'iceberg_metadata',
                'encoding': 'binary',
            }
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as e:
            return {'error': str(e), 'encoding': 'binary'}

    @staticmethod
    def _first_json_character(file_path: str, encoding: str) -> str:
        """Return the first non-whitespace character from a bounded prefix."""
        with open(
            file_path, 'r', encoding=encoding, errors='replace'
        ) as handle:
            prefix = handle.read(CSV_SAMPLE_SIZE)
        stripped = prefix.lstrip('\ufeff \t\r\n')
        return stripped[0] if stripped else ''

    def _analyze_ndjson_candidate(
        self,
        file_path: str,
        encoding: str,
        explicit_ndjson: bool,
    ) -> Optional[Dict[str, Any]]:
        """Stream an NDJSON candidate while retaining only a schema sample."""
        rows: List[Dict[str, Any]] = []
        row_count = 0
        invalid_lines = 0
        with open(
            file_path, 'r', encoding=encoding, errors='replace'
        ) as handle:
            while True:
                line = handle.readline(JSON_SAMPLE_MAX_CHARS + 1)
                if not line:
                    break
                if (
                    len(line) > JSON_SAMPLE_MAX_CHARS
                    and not line.endswith(('\n', '\r'))
                ):
                    return None
                line = line.strip()
                if not line:
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    invalid_lines += 1
                    if not explicit_ndjson:
                        return None
                    continue
                if not isinstance(value, dict):
                    return None
                row_count += 1
                if len(rows) < JSON_SCHEMA_SAMPLE_ROWS:
                    rows.append(value)

        if not rows:
            return None
        if row_count == 1 and not explicit_ndjson:
            return self._build_json_result(
                rows,
                json_format='object',
                row_count=1,
                sampled=False,
            )

        result = self._build_json_result(
            rows,
            json_format='ndjson',
            row_count=row_count,
            sampled=row_count > len(rows),
        )
        if invalid_lines:
            result['warning'] = (
                f'Skipped {invalid_lines} invalid NDJSON '
                f'line{"s" if invalid_lines != 1 else ""}.'
            )
        return result

    @staticmethod
    def _read_json_array_sample(
        file_path: str,
        encoding: str,
        max_rows: int = JSON_SCHEMA_SAMPLE_ROWS,
    ) -> List[Dict[str, Any]]:
        """Decode a bounded prefix of a JSON array without loading the file."""
        with open(
            file_path, 'r', encoding=encoding, errors='replace'
        ) as handle:
            text = handle.read(JSON_SAMPLE_MAX_CHARS)

        text = text.lstrip('\ufeff \t\r\n')
        if not text.startswith('['):
            return []

        decoder = json.JSONDecoder()
        rows: List[Dict[str, Any]] = []
        index = 1
        while len(rows) < max_rows:
            while index < len(text) and text[index] in ' \t\r\n,':
                index += 1
            if index >= len(text) or text[index] == ']':
                break
            try:
                value, index = decoder.raw_decode(text, index)
            except json.JSONDecodeError:
                break
            if not isinstance(value, dict):
                return []
            rows.append(value)
        return rows

    def _analyze_json(
        self, file_path: str, encoding: str = 'utf-8'
    ) -> Dict[str, Any]:
        """Analyse JSON or NDJSON with bounded in-memory parsing."""
        try:
            first_char = self._first_json_character(file_path, encoding)
            explicit_ndjson = Path(file_path).suffix.lower() in (
                '.jsonl',
                '.ndjson',
            )
            if first_char == '{' or explicit_ndjson:
                ndjson_result = self._analyze_ndjson_candidate(
                    file_path,
                    encoding,
                    explicit_ndjson,
                )
                if ndjson_result is not None:
                    return ndjson_result

            file_size = os.path.getsize(file_path)
            if file_size > JSON_FULL_PARSE_MAX_BYTES:
                if first_char == '[':
                    rows = self._read_json_array_sample(
                        file_path,
                        encoding,
                    )
                    if rows:
                        result = self._build_json_result(
                            rows,
                            json_format='array',
                            row_count=None,
                            sampled=True,
                        )
                        result['analysis_truncated'] = True
                        result['warning'] = (
                            'JSON array exceeds the full-parse limit; '
                            'schema was inferred from a bounded prefix.'
                        )
                        return result
                return {
                    'error': (
                        'JSON document exceeds the '
                        f'{JSON_FULL_PARSE_MAX_BYTES}-byte full-parse limit'
                    ),
                    'analysis_truncated': True,
                }

            with open(
                file_path, 'r', encoding=encoding, errors='replace'
            ) as handle:
                data = json.load(handle)

            if isinstance(data, list):
                object_rows = [
                    value for value in data[:JSON_SCHEMA_SAMPLE_ROWS]
                    if isinstance(value, dict)
                ]
                if object_rows:
                    return self._build_json_result(
                        object_rows,
                        json_format='array',
                        row_count=len(data),
                        sampled=len(data) > len(object_rows),
                    )
            elif isinstance(data, dict):
                return self._build_json_result(
                    [data],
                    json_format='object',
                    row_count=1,
                    sampled=False,
                )
            return {}
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as e:
            return {'error': str(e)}

    # --- JSON helper ------------------------------------------------

    @staticmethod
    def _build_json_result(
        rows: List[Dict[str, Any]],
        json_format: str,
        row_count: Optional[int] = None,
        sampled: bool = False,
    ) -> Dict[str, Any]:
        """Build rich JSON metadata from a list of row-dicts.

        Walks one level deep to classify each field as scalar / object / array
        and records bounded sample values for SQL generation.
        """
        all_keys: Dict[str, None] = {}
        for row in rows:
            for key in row:
                if key not in all_keys:
                    all_keys[key] = None

        schema: List[tuple] = []
        nesting: Dict[str, str] = {}
        sample_values: Dict[str, Any] = {}
        observed_lengths: Dict[str, int] = {}

        for key in all_keys:
            effective_val = None
            for r in rows:
                if key in r and r[key] is not None and effective_val is None:
                    effective_val = r[key]

            if isinstance(effective_val, dict):
                nesting[key] = 'object'
                schema.append((key, 'dict'))
            elif isinstance(effective_val, list):
                nesting[key] = 'array'
                schema.append((key, 'list'))
            else:
                nesting[key] = 'scalar'
                schema.append((key, type(effective_val).__name__ if effective_val is not None else 'str'))
                string_lengths = [
                    len(value)
                    for row in rows
                    if isinstance((value := row.get(key)), str)
                ]
                if string_lengths:
                    observed_lengths[key] = max(string_lengths)

            sample_values[key] = effective_val

        return {
            'schema': schema,
            'row_count': len(rows) if row_count is None and not sampled else row_count,
            'column_count': len(schema),
            'has_header': True,
            'json_format': json_format,
            'json_nesting': nesting,
            'json_sample_values': {k: _json_safe(v) for k, v in sample_values.items()},
            'nullable_columns': list(all_keys),
            'nullability_inference': 'conservative',
            'schema_inference': 'sampled' if sampled else 'full',
            'schema_sample_size': len(rows),
            'observed_max_string_lengths': observed_lengths,
            'max_string_lengths': {
                key: _size_sampled_string(length)
                for key, length in observed_lengths.items()
            },
        }


    def _analyze_text(self, file_path: str, encoding: str = 'utf-8') -> Dict[str, Any]:
        """Analyse plain text file metadata."""
        try:
            with open(file_path, 'r', encoding=encoding, errors='replace') as f:
                row_count = sum(1 for _ in f)
            return {'row_count': row_count}
        except (OSError, UnicodeError) as e:
            return {'error': str(e)}

    def _analyze_excel(self, file_path: str) -> Dict[str, Any]:
        """Analyse Excel (.xlsx / .xls) file metadata."""
        _ensure_pandas()
        try:
            try:
                import openpyxl  # noqa: F401
                df = pd.read_excel(file_path, nrows=200, engine='openpyxl')
            except ImportError:
                logger.warning("openpyxl not installed; Excel analysis may be limited. "
                               "Install with: pip install openpyxl")
                df = pd.read_excel(file_path, nrows=200)

            schema = []
            observed_lengths: Dict[str, int] = {}
            for col in df.columns:
                dtype = str(df[col].dtype)
                if pd.api.types.is_string_dtype(df[col].dtype):
                    lengths = df[col].dropna().astype(str).str.len()
                    if len(lengths) > 0:
                        observed_lengths[str(col)] = int(lengths.max())
                schema.append((str(col), dtype))

            return {
                'schema': schema,
                'nullable_columns': [str(col) for col in df.columns],
                'nullability_inference': 'conservative',
                'observed_max_string_lengths': observed_lengths,
                'max_string_lengths': {
                    col: _size_sampled_string(length)
                    for col, length in observed_lengths.items()
                },
                'row_count': len(df) if len(df) < 200 else None,
                'row_count_lower_bound': 200 if len(df) == 200 else None,
                'column_count': len(schema),
                'has_header': True,
                'schema_inference': 'sampled',
                'schema_sample_size': len(df),
                'sample_rows': [[_json_safe(v) for v in row] for row in df.head(3).where(pd.notnull(df.head(3)), None).values.tolist()],
            }
        except Exception as e:
            return {'error': str(e)}

    # ------------------------------------------------------------------
    # Preview data (tabular)
    # ------------------------------------------------------------------

    @staticmethod
    def _parquet_preview_frame(file_path: str, max_rows: int):
        """Read at most one bounded Parquet record batch."""
        parquet_file = pq.ParquetFile(file_path)
        batch = next(
            parquet_file.iter_batches(batch_size=max_rows),
            None,
        )
        if batch is None:
            return pd.DataFrame(columns=parquet_file.schema_arrow.names)
        return batch.to_pandas()

    def get_preview_data(self, file_path: str, max_rows: int = 100) -> Dict[str, Any]:
        """Return a tabular preview of the file as columns + rows."""
        max_rows = max(1, min(int(max_rows), 10000))
        _ensure_pandas()
        _ensure_pyarrow()
        file_type = self.detect_file_type(file_path)
        meta = self.analyze_file_metadata(file_path)
        encoding = meta.get('encoding', 'utf-8') or 'utf-8'
        if encoding == 'binary':
            encoding = 'utf-8'

        try:
            if file_type == 'csv':
                delimiter = meta.get('delimiter', ',') or ','
                df = pd.read_csv(file_path, nrows=max_rows, encoding=encoding,
                                 sep=delimiter, low_memory=False, on_bad_lines='skip')

            elif file_type == 'parquet':
                df = self._parquet_preview_frame(file_path, max_rows)

            elif file_type == 'delta':
                try:
                    from deltalake import DeltaTable  # type: ignore
                    dt = DeltaTable(file_path)
                    # Use dataset scanner to avoid loading full table
                    ds = dt.to_pyarrow_dataset()
                    df = ds.scanner().head(max_rows).to_pandas()
                except ImportError:
                    parquet_file = self._first_parquet_file(file_path)
                    if parquet_file is None:
                        raise FileNotFoundError(
                            'No underlying Parquet data file found'
                        )
                    df = self._parquet_preview_frame(
                        parquet_file, max_rows
                    )

            elif file_type == 'iceberg':
                parquet_file = self._first_parquet_file(
                    file_path, data_subdirectory='data'
                )
                if parquet_file is None:
                    df = pd.DataFrame()
                else:
                    df = self._parquet_preview_frame(
                        parquet_file, max_rows
                    )

            elif file_type == 'json':
                # Try NDJSON first (line-delimited JSON: each line is a JSON object)
                is_ndjson = False
                with open(file_path, 'r', encoding=encoding, errors='replace') as f:
                    first_char = f.read(1)
                    if first_char == '{':
                        f.seek(0)
                        rows = []
                        while len(rows) < max_rows:
                            line = f.readline(JSON_SAMPLE_MAX_CHARS + 1)
                            if not line:
                                break
                            if (
                                len(line) > JSON_SAMPLE_MAX_CHARS
                                and not line.endswith(('\n', '\r'))
                            ):
                                raise ValueError(
                                    'JSON line exceeds the preview parse limit'
                                )
                            line = line.strip()
                            if line:
                                try:
                                    rows.append(json.loads(line))
                                except json.JSONDecodeError:
                                    pass
                        if rows:
                            df = pd.DataFrame(rows)
                            is_ndjson = True

                if not is_ndjson:
                    if os.path.getsize(file_path) > JSON_FULL_PARSE_MAX_BYTES:
                        data = self._read_json_array_sample(
                            file_path,
                            encoding,
                            max_rows=max_rows,
                        )
                        if not data:
                            raise ValueError(
                                'JSON document exceeds the preview parse limit'
                            )
                        df = pd.DataFrame(data)
                    else:
                        with open(file_path, 'r', encoding=encoding, errors='replace') as f:
                            data = json.load(f)
                        if isinstance(data, list):
                            df = pd.DataFrame(data[:max_rows])
                        else:
                            df = pd.DataFrame([data])

            elif file_type == 'excel':
                try:
                    import openpyxl  # noqa: F401
                    df = pd.read_excel(file_path, nrows=max_rows, engine='openpyxl')
                except ImportError:
                    df = pd.read_excel(file_path, nrows=max_rows)

            else:
                lines = []
                with open(file_path, 'r', encoding=encoding, errors='replace') as f:
                    for i, line in enumerate(f):
                        if i >= max_rows:
                            break
                        lines.append({'line': line.rstrip()})
                df = pd.DataFrame(lines)

            columns = [{'name': col, 'type': str(dtype)} for col, dtype in df.dtypes.items()]
            rows = df.where(pd.notnull(df), None).values.tolist()

            def _safe_val(v):
                """Ensure value is JSON-serialisable (NaN/Inf → None)."""
                if v is None:
                    return None
                if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                    return None
                if not isinstance(v, (str, int, float, bool)):
                    return str(v)
                return v

            safe_rows = [[_safe_val(v) for v in row] for row in rows]

            return {
                'columns': columns,
                'rows': safe_rows,
                'total_rows': meta.get('row_count'),
                'truncated': bool(meta.get('analysis_truncated'))
                or (meta.get('row_count') or 0) > max_rows,
            }

        except Exception as e:
            return {
                'columns': [],
                'rows': [],
                'total_rows': None,
                'truncated': False,
                'error': str(e),
            }

    # ------------------------------------------------------------------
    # Directory scan
    # ------------------------------------------------------------------

    def scan_directory(self, directory_path: str) -> List[Dict[str, Any]]:
        """Scan a directory recursively for supported files."""
        if not os.path.isdir(directory_path):
            raise NotADirectoryError(
                f'Directory does not exist: {directory_path}'
            )
        if (
            self.is_delta_table_directory(directory_path)
            or self.is_iceberg_table_directory(directory_path)
        ):
            return [self.analyze_file_metadata(directory_path)]

        results = []
        for root, dirs, files in os.walk(directory_path):
            dirs[:] = sorted(
                d
                for d in dirs
                if not d.startswith('.') and d != '__pycache__'
            )

            # Recognize Delta table folders once at the directory level and avoid
            # descending into their internals as separate file entries.
            delta_dirs = []
            iceberg_dirs = []
            remaining_dirs = []
            for dirname in dirs:
                candidate = os.path.join(root, dirname)
                if self.is_delta_table_directory(candidate):
                    delta_dirs.append(candidate)
                elif self.is_iceberg_table_directory(candidate):
                    iceberg_dirs.append(candidate)
                else:
                    remaining_dirs.append(dirname)

            for delta_dir in delta_dirs:
                metadata = self.analyze_file_metadata(delta_dir)
                results.append(metadata)

            for iceberg_dir in iceberg_dirs:
                metadata = self.analyze_file_metadata(iceberg_dir)
                results.append(metadata)

            dirs[:] = remaining_dirs

            for file in sorted(files):
                file_path = os.path.join(root, file)
                file_type = self.detect_file_type(file_path)
                if file_type != 'unknown':
                    metadata = self.analyze_file_metadata(file_path)
                    results.append(metadata)
        return results
