"""Unique, verifiable identity for one certification run.

Every object a certification run creates carries the same run identity, and the
safety gate refuses to execute a statement that touches anything else. That is
the single mechanism that keeps the harness away from the TPC-H data living in
the same database: it is not a list of things to avoid, it is a list of the only
things that may be touched.

Naming
------
For a run id ``ab12cd34``::

    schema    sqlfdt_cert_ab12cd34
    prefix    sqlfdt_cert_ab12cd34_
    database  sqlfdt_cert_ab12cd34      (SQL Server on a VM only)

The run id is random, so a rerun never collides with the residue of a previous
run, and a stale cleanup script can never match a live run's objects.
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass

#: Shared literal prefix. Deliberately unlikely to collide with user objects and
#: easy to grep for when a human has to clean up after an aborted run.
NAMESPACE = 'sqlfdt_cert'

#: A run id is exactly 8 lowercase hex characters.
RUN_ID_RE = re.compile(r'^[0-9a-f]{8}$')

#: Matches any identifier belonging to *some* certification run.
ANY_RUN_OBJECT_RE = re.compile(rf'^{NAMESPACE}_[0-9a-f]{{8}}(?:_.*)?$', re.IGNORECASE)

#: The only shape a name read back from a live server may have before it is
#: interpolated into cleanup DDL. Anything carrying a bracket, a quote, a
#: semicolon or a comment marker fails here and is left alone.
OWNED_NAME_RE = re.compile(r'^[a-z0-9_]{1,128}$')


class RunIdentityError(ValueError):
    """Raised when a run identity is malformed."""


@dataclass(frozen=True)
class RunIdentity:
    """The names one certification run is allowed to create."""

    run_id: str

    def __post_init__(self) -> None:
        if not RUN_ID_RE.match(self.run_id or ''):
            raise RunIdentityError(
                f'run id must be 8 lowercase hex characters, got {self.run_id!r}'
            )

    @property
    def schema(self) -> str:
        """Schema that holds every table/view the run creates."""
        return f'{NAMESPACE}_{self.run_id}'

    @property
    def prefix(self) -> str:
        """Prefix every object name must start with."""
        return f'{NAMESPACE}_{self.run_id}_'

    @property
    def database(self) -> str:
        """Disposable database name (SQL Server on a VM only)."""
        return f'{NAMESPACE}_{self.run_id}'

    def name(self, *parts: str) -> str:
        """Build a prefixed object name from ``parts``.

        ``identity.name('csv', 'scalar')`` -> ``sqlfdt_cert_ab12cd34_csv_scalar``
        """
        tail = '_'.join(p.strip('_') for p in parts if p and p.strip('_'))
        candidate = f'{self.prefix}{tail}' if tail else self.prefix.rstrip('_')
        # SQL Server identifiers cap at 128 characters; truncate the tail, never
        # the prefix, so the safety gate can still recognise the object.
        return candidate[:128]

    def qualified(self, *parts: str) -> str:
        """Bracket-quoted ``[schema].[prefixed_name]`` for use in SQL."""
        return f'[{self.schema}].[{self.name(*parts)}]'

    def owns(self, identifier: str) -> bool:
        """True when ``identifier`` belongs to *this* run.

        The check is deliberately strict about shape, not just prefix. A name
        read back from a live server is interpolated into ``DROP`` DDL, so an
        identifier carrying ``]``, ``;``, a quote or a comment marker must not
        be recognised as ours no matter what it starts with.
        """
        bare = identifier.strip().strip('[]"').lower()
        if not OWNED_NAME_RE.match(bare):
            return False
        return bare == self.schema or bare.startswith(self.prefix)

    def as_dict(self) -> dict:
        return {
            'run_id': self.run_id,
            'schema': self.schema,
            'prefix': self.prefix,
            'database': self.database,
        }


def new_run_identity() -> RunIdentity:
    """Mint a fresh, random run identity."""
    return RunIdentity(secrets.token_hex(4))


def parse_run_identity(value: str) -> RunIdentity:
    """Recover a :class:`RunIdentity` from a run id, schema or prefix."""
    raw = (value or '').strip().strip('[]"')
    lowered = raw.lower()
    if lowered.startswith(f'{NAMESPACE}_'):
        lowered = lowered[len(NAMESPACE) + 1 :]
    return RunIdentity(lowered[:8])


def is_certification_object(identifier: str) -> bool:
    """True when ``identifier`` belongs to *any* certification run.

    Used by inventory diffing so a leftover object from an aborted run is
    reported as certification residue rather than as a pre-existing user object.
    """
    return bool(ANY_RUN_OBJECT_RE.match((identifier or '').strip().strip('[]"')))
