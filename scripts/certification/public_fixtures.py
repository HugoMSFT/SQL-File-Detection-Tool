"""Declared shapes for the public objects the live run actually reads.

The harness analyses a *local demo fixture* to get the metadata it hands to the
generator, then points the generated statement at a *public blob*. That is only
sound when the two describe the same bytes. They did not: the demo
``sales_scalars.csv`` has ten columns of synthetic sales data, while the staged
``iris.csv`` has five columns of flower measurements. The generated ``WITH``
clause therefore named columns the file does not contain, which produces either
a false FAIL or - worse - a false PASS whose projected values are all NULL.

So a remote location is not enough. A staged fixture must also declare *which*
public object it is, and that declaration lives here: committed, non-secret,
and pinned to a URL. The planner then generates from this metadata instead of
from the demo file, and refuses to plan a remote cell whose staging entry
declares no shape. Refusing is the point - it is what keeps a demo fixture's
type-fidelity claims from being quietly transferred onto an unrelated file.

Nothing here is a credential, an endpoint of ours, or a private path. Every URL
is a public Microsoft-hosted dataset.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Sequence, Tuple


@dataclass(frozen=True)
class PublicShape:
    """The declared, verifiable shape of one public object.

    ``columns`` uses the same ``(name, type)`` pairs the detector emits, so the
    generator cannot tell this apart from a real analysis - which is the whole
    point, since the generator is what is under test.
    """

    key: str
    summary: str
    #: Canonical public URL. Pinned so a reviewer can check the shape by hand.
    url: str
    file_type: str
    columns: Tuple[Tuple[str, str], ...]
    file_name: str
    row_count: Optional[int] = None
    delimiter: Optional[str] = None
    encoding: str = 'utf-8'
    codepage: str = '65001'
    has_header: bool = True
    compression: Optional[str] = None
    json_format: Optional[str] = None
    #: Longest observed value per string column, checked against the object.
    #: Without this the generator sizes every string NVARCHAR(255), and the
    #: NDJSON `message` field runs to 3862 characters.
    max_string_lengths: Dict[str, int] = field(default_factory=dict)
    #: `scalar` / `object` / `array` per JSON field, which is what decides
    #: whether a column is projected `AS JSON`.
    json_nesting: Dict[str, str] = field(default_factory=dict)
    #: Columns whose values are wide free text. Recorded so a reviewer can see
    #: why a mapping needs NVARCHAR(MAX) rather than a guessed width.
    wide_text_columns: Tuple[str, ...] = ()
    #: Counting every row of a large public dataset is expensive and proves
    #: nothing extra, so a shape may ask for a bounded read instead.
    verification_limit: Optional[int] = None
    #: Set when the object is read as one whole document rather than as rows.
    whole_document: bool = False
    notes: str = ''

    @property
    def column_count(self) -> int:
        return len(self.columns)

    def metadata(self) -> Dict[str, Any]:
        """Generator-shaped metadata for this object.

        ``file_path`` is the bare object name, never a path on this machine: the
        statement runs on the server, and interpolating a worktree path is how
        the first live run earned error 4860.
        """
        names = [name for name, _ in self.columns]
        document: Dict[str, Any] = {
            'file_path': self.file_name,
            'file_name': self.file_name,
            'file_type': self.file_type,
            'file_size': None,
            'schema': [list(pair) for pair in self.columns],
            'row_count': self.row_count,
            'column_count': self.column_count,
            'delimiter': self.delimiter,
            'encoding': self.encoding,
            'encoding_confidence': 100,
            'codepage': self.codepage,
            'has_header': self.has_header,
            'compression': self.compression,
            'nullable_columns': list(names),
            'parquet_metadata': None,
            'delta_metadata': None,
            'schema_inference': 'declared',
            'nullability_inference': 'conservative',
            'row_count_estimated': self.row_count is None,
            'sample_rows': [],
            # Provenance, so anyone reading a manifest can see that this schema
            # was declared against a pinned public object rather than sniffed
            # from whatever happened to be on the analysing machine.
            'public_shape': self.key,
            'public_shape_url': self.url,
        }
        if self.json_format:
            document['json_format'] = self.json_format
        if self.json_nesting:
            document['json_nesting'] = dict(self.json_nesting)
        if self.max_string_lengths:
            document['observed_max_string_lengths'] = dict(self.max_string_lengths)
            document['max_string_lengths'] = dict(self.max_string_lengths)
        return document

    def expectations(self) -> Dict[str, Any]:
        """What a verification query should find.

        A row count is only asserted when this shape actually pins one. Guessing
        one for a large dataset is how a harness invents a failure.
        """
        expected: Dict[str, Any] = {'column_count': self.column_count}
        if self.row_count is not None and not self.verification_limit:
            expected['row_count'] = self.row_count
        return expected


# ---------------------------------------------------------------------------
# The objects
# ---------------------------------------------------------------------------

_FLOAT = 'float64'
_STR = 'object'

IRIS_CSV = PublicShape(
    key='iris_csv',
    summary='Iris measurements, the canonical small public CSV',
    url='https://azuremlexamples.blob.core.windows.net/datasets/iris.csv',
    file_name='iris.csv',
    file_type='csv',
    columns=(
        ('sepal_length', _FLOAT),
        ('sepal_width', _FLOAT),
        ('petal_length', _FLOAT),
        ('petal_width', _FLOAT),
        ('species', _STR),
    ),
    row_count=150,
    delimiter=',',
    encoding='utf-8',
    codepage='65001',
    has_header=True,
    max_string_lengths={'species': 20},
    notes=(
        'Five columns, four float and one string, comma separated with a header '
        'row, UTF-8 without a BOM. Certifies the CSV access pattern only - it '
        'carries no Unicode, no boundary values and no wide decimals, so it '
        'proves nothing about type fidelity.'
    ),
)

# The 21 columns Azure Open Datasets documents for NYC yellow taxi. No row count
# is declared: a month of taxi trips is millions of rows, and counting them all
# certifies nothing that reading ten rows does not.
TAXI_PARQUET = PublicShape(
    key='taxi_parquet_2018_06',
    summary='NYC yellow taxi, June 2018, Azure Open Datasets',
    url=(
        'https://azureopendatastorage.blob.core.windows.net/nyctlc/yellow/'
        'puYear=2018/puMonth=6/'
    ),
    file_name='part.parquet',
    file_type='parquet',
    columns=(
        ('vendorID', 'int32'),
        ('tpepPickupDateTime', 'timestamp[us]'),
        ('tpepDropoffDateTime', 'timestamp[us]'),
        ('passengerCount', 'int32'),
        ('tripDistance', 'double'),
        ('puLocationId', 'string'),
        ('doLocationId', 'string'),
        ('startLon', 'double'),
        ('startLat', 'double'),
        ('endLon', 'double'),
        ('endLat', 'double'),
        ('rateCodeId', 'int32'),
        ('storeAndFwdFlag', 'string'),
        ('paymentType', 'string'),
        ('fareAmount', 'double'),
        ('extra', 'double'),
        ('mtaTax', 'double'),
        ('improvementSurcharge', 'string'),
        ('tipAmount', 'double'),
        ('tollsAmount', 'double'),
        ('totalAmount', 'double'),
    ),
    row_count=None,
    encoding='binary',
    codepage='ACP',
    has_header=False,
    compression='SNAPPY',
    verification_limit=10,
    notes=(
        'Twenty-one scalar and timestamp columns. Certifies the Parquet access '
        'pattern and column projection. It is NOT the all-types fixture: it has '
        'no nested, map, list, decimal-boundary or logical-type columns, so it '
        'must never be relabelled as type-fidelity coverage.'
    ),
)

ALIASES_JSON = PublicShape(
    key='aliases_json',
    summary='Azure CLI VM image aliases, a whole JSON object',
    url='https://azcliprod.blob.core.windows.net/cli/vm/aliases.json',
    file_name='aliases.json',
    file_type='json',
    # The real top-level keys of the object, checked against the public URL.
    # `$schema` is kept deliberately: a key that is not a plain identifier has
    # to be emitted as the quoted JSON path `$."$schema"`, and this is the only
    # cell that certifies that live.
    columns=(
        ('$schema', 'str'),
        ('contentVersion', 'str'),
        ('parameters', 'dict'),
        ('variables', 'dict'),
        ('resources', 'list'),
        ('outputs', 'dict'),
    ),
    row_count=1,
    delimiter=None,
    json_format='object',
    json_nesting={
        '$schema': 'scalar',
        'contentVersion': 'scalar',
        'parameters': 'object',
        'variables': 'object',
        'resources': 'array',
        'outputs': 'object',
    },
    max_string_lengths={'$schema': 128, 'contentVersion': 32},
    whole_document=True,
    notes=(
        'Read as one document, not as rows: a whole JSON object is what selects '
        'the _Bulk HTTPS source with SINGLE_CLOB. It is an ARM deployment '
        'template, so its six top-level keys are fixed by that schema even '
        'though the image aliases inside `outputs` change over time. Projecting '
        'those six is what proves the document arrived intact rather than '
        'arriving as a correctly shaped row of NULLs.'
    ),
)

PETRI_NDJSON = PublicShape(
    key='petri_ndjson',
    summary='OpenVMM test log, newline-delimited JSON',
    url=(
        'https://openvmmghtestresults.blob.core.windows.net/results/'
        '31194099274_2/aarch64-linux-tcg-vmm-tests-logs/'
        'aarch64_exclusive__openvmm_linux_aarch64_assigned_device_peer_to_peer'
        '_dma_aarch64_tcg/petri.jsonl'
    ),
    file_name='petri.jsonl',
    file_type='json',
    columns=(
        ('timestamp', 'str'),
        ('source', 'str'),
        ('severity', 'str'),
        ('message', 'str'),
    ),
    row_count=729,
    delimiter=None,
    json_format='ndjson',
    json_nesting={
        'timestamp': 'scalar',
        'source': 'scalar',
        'severity': 'scalar',
        'message': 'scalar',
    },
    # Measured against the object: the longest message is 3862 characters, which
    # is what the live run reported too.
    max_string_lengths={
        'timestamp': 32,
        'source': 32,
        'severity': 16,
        'message': 4000,
    },
    wide_text_columns=('message',),
    notes=(
        'Four fields per line and 729 lines, confirmed live on both engines. '
        '`message` is wide free text - the live run saw 3862 characters - so it '
        'must map to NVARCHAR(MAX) rather than a guessed width. Newline '
        'delimited JSON is what selects the abs:// virtualization source with '
        'CSV row framing; the https BLOB_STORAGE connector rejects the '
        'delimiter options with error 5369. '
        'SNAPSHOT: unlike the other three, this is not a curated dataset. It is '
        'one artifact from one OpenVMM CI run, in a results container its '
        'owners are free to prune or restructure at any time, so the row count '
        'and the field set pinned here are a snapshot rather than a contract. '
        'A run whose staged bytes no longer match this shape must be recorded '
        'as unstaged, not as a generator defect - which is what the shape check '
        'in the planner is for.'
    ),
)


PUBLIC_SHAPES: Dict[str, PublicShape] = {
    shape.key: shape
    for shape in (IRIS_CSV, TAXI_PARQUET, ALIASES_JSON, PETRI_NDJSON)
}


def resolve_shape(key: Optional[str]) -> Optional[PublicShape]:
    if not key:
        return None
    return PUBLIC_SHAPES.get(str(key))


def shape_mismatch(shape: PublicShape, file_type: str) -> Optional[str]:
    """Why this shape cannot stand in for a fixture of ``file_type``.

    A csv fixture pointed at a Parquet object would generate a delimited-text
    read of binary data, and the resulting error would look like a generator
    defect. Catching it in the planner keeps that confusion out of the evidence.
    """
    if shape.file_type != file_type:
        return (
            f'staged shape {shape.key!r} is {shape.file_type}, but the fixture '
            f'is {file_type}'
        )
    return None
