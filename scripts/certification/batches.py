"""T-SQL aware batch splitting and lexical masking.

Two facts drive this module.

1. ``GO`` is not a T-SQL statement, it is a *client* batch separator. A server
   never sees it. Sending a multi-``GO`` script as one command fails, and — more
   dangerously — silently changes semantics for statements that must be first in
   their batch (``CREATE SCHEMA``, ``CREATE VIEW``, ``CREATE PROCEDURE``,
   ``CREATE MASTER KEY`` in some paths). The harness therefore executes one
   batch at a time and records a verdict per batch.

2. There is no global transaction to fall back on. ``CREATE DATABASE``,
   ``CREATE EXTERNAL DATA SOURCE`` and friends are not transactional, so a
   "roll it all back at the end" story would be fiction. Batch-level accounting
   plus an explicit inverse cleanup script is the honest alternative.

:func:`mask_sql` is the shared primitive: it blanks out comments and string
literal *contents* while preserving offsets, so both the batch splitter and the
safety gate can pattern-match on real code without being fooled by a keyword
that only appears inside a comment or a quoted string.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List

#: ``GO`` alone on a line, optionally with a repeat count and a trailing comment.
GO_RE = re.compile(r'^\s*GO(?:\s+(\d+))?\s*(?:--.*)?$', re.IGNORECASE)


def mask_sql(
    sql: str,
    *,
    mask_identifiers: bool = False,
    mask_strings: bool = True,
) -> str:
    """Blank comment and string-literal content, preserving length and newlines.

    The returned string has exactly the same length as ``sql`` and the same
    newline positions, so an index into the mask is an index into the original.

    Delimiters themselves are kept (``'``, ``[``, ``]``, ``"``) so callers can
    still tell that *something* was quoted.

    ``mask_identifiers`` additionally blanks the inside of ``[...]`` and
    ``"..."`` identifiers. The batch splitter wants that (a ``GO`` inside a
    quoted identifier is not a separator); the safety gate explicitly does not,
    because it has to be able to see ``[dbo].[orders]``.

    ``mask_strings=False`` keeps string-literal *content* intact and blanks
    only comments. The placeholder scan needs that combination: a ``<path>``
    inside ``LOCATION = '<path>'`` is a real unresolved placeholder that would
    be sent to the server, while the same token inside a ``--`` guidance
    comment is documentation and must not block execution.
    """
    out = list(sql)
    n = len(sql)

    def blank(start: int, end: int) -> None:
        for k in range(max(start, 0), min(end, n)):
            if out[k] != '\n':
                out[k] = ' '

    i = 0
    while i < n:
        ch = sql[i]
        if ch == '-' and sql.startswith('--', i):
            end = sql.find('\n', i)
            end = n if end == -1 else end
            blank(i, end)
            i = end
        elif ch == '/' and sql.startswith('/*', i):
            depth = 1
            j = i + 2
            while j < n and depth > 0:
                if sql.startswith('/*', j):
                    depth += 1
                    j += 2
                elif sql.startswith('*/', j):
                    depth -= 1
                    j += 2
                else:
                    j += 1
            blank(i, j)
            i = j
        elif ch == "'":
            j = i + 1
            while j < n:
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            if mask_strings:
                blank(i + 1, j - 1)
            i = j
        elif ch == '[':
            j = i + 1
            while j < n and sql[j] != ']':
                j += 1
            j = min(j + 1, n)
            if mask_identifiers:
                blank(i + 1, j - 1)
            i = j
        elif ch == '"':
            j = i + 1
            while j < n:
                if sql[j] == '"':
                    if j + 1 < n and sql[j + 1] == '"':
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            if mask_identifiers:
                blank(i + 1, j - 1)
            i = j
        else:
            i += 1
    return ''.join(out)


def strip_sql_comments(sql: str) -> str:
    """Return ``sql`` with comments removed but code and literals intact.

    Used by assertions that need to prove a keyword appears in *executable*
    code rather than in the generator's explanatory comment blocks. Trailing
    comments on a code line must go too: a line-based filter that keeps
    ``SELECT 1; -- see [dbo].[orders]`` intact would let a ``sql_excludes``
    assertion fail on prose, or a ``sql_contains`` assertion pass on prose,
    which is exactly backwards.
    """
    masked = mask_sql(sql, mask_strings=False)
    kept: List[str] = []
    for raw, masked_line in zip(sql.split('\n'), masked.split('\n')):
        if masked_line.strip() == '':
            if raw.strip() != '':
                continue
            kept.append('')
            continue
        kept.append(masked_line.rstrip())
    return '\n'.join(kept)


@dataclass(frozen=True)
class Batch:
    """One unit of execution, exactly as the client will send it."""

    index: int
    text: str
    start_line: int
    repeat: int = 1

    @property
    def is_empty(self) -> bool:
        return not self.text.strip()


def split_batches(sql: str) -> List[Batch]:
    """Split ``sql`` into ``GO``-separated batches.

    ``GO`` is only honoured when it is alone on a line outside comments,
    string literals and quoted identifiers. Empty *and comment-only* batches
    are dropped so neither a trailing ``GO`` nor a block of guidance prose
    produces a phantom execution.
    """
    masked = mask_sql(sql, mask_identifiers=True)
    raw_lines = sql.split('\n')
    masked_lines = masked.split('\n')

    batches: List[Batch] = []
    current: List[str] = []
    start_line = 1
    index = 0

    def flush(repeat: int, line_no: int) -> None:
        nonlocal current, start_line, index
        text = '\n'.join(current).strip('\n')
        # A batch of nothing but comments is not an execution. Keeping it would
        # make a cell whose generator output is pure guidance prose (Excel,
        # Iceberg) look READY instead of NOT_EXECUTABLE.
        if strip_sql_comments(text).strip():
            batches.append(Batch(index=index, text=text, start_line=start_line, repeat=repeat))
            index += 1
        current = []
        start_line = line_no + 1

    for line_no, (raw, masked_line) in enumerate(zip(raw_lines, masked_lines), start=1):
        match = GO_RE.match(masked_line)
        if match:
            flush(int(match.group(1) or 1), line_no)
        else:
            current.append(raw)

    flush(1, len(raw_lines))
    return batches
