"""Make the non-shipped certification harness importable from the test suite.

The harness lives in ``scripts/certification`` deliberately: it must never be
importable from the package the extension ships, and ``.vscodeignore`` keeps it
out of the VSIX. Tests reach it by putting ``scripts`` on ``sys.path`` rather
than by adding an ``__init__.py`` that would make it look like a subpackage.
"""

import os
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPTS = os.path.join(REPO_ROOT, 'scripts')

if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)


@pytest.fixture()
def identity():
    from certification.runid import RunIdentity

    return RunIdentity('0123abcd')


@pytest.fixture()
def policy(identity):
    from certification.safety import SafetyPolicy

    return SafetyPolicy(identity, allowed_hosts=('cert.example.invalid',))
