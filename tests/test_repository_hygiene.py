"""The repository should not accumulate the generator's own scratch output.

`_doc.sql` was committed by accident: somebody redirected a complete document to
a file in the repository root while checking a fix, and `git add -A` picked it
up. It is 40 KB of generated SQL that nothing reads, it drifts away from the
generator that produced it the moment the generator changes, and while it sat
there it advertised a `TRUNCATE TABLE [dbo].[orders]` that the product no longer
emits.

The generated corpus that *is* meant to be tracked lives in `tests/parity` (byte
comparisons between the two generators) and `data sample/` (sample fixtures).
Anywhere else, a `.sql` file in this repository is scratch.
"""

import os
import subprocess
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

#: Directories whose `.sql` files are deliberate artifacts.
TRACKED_SQL_HOMES = ('data sample/', 'tests/parity/', 'docs/')


def tracked_files(pattern):
    result = subprocess.run(
        ['git', 'ls-files', pattern],
        cwd=REPO_ROOT, capture_output=True, text=True, check=True,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def git_available():
    try:
        subprocess.run(['git', 'rev-parse', '--git-dir'], cwd=REPO_ROOT,
                       capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        return False
    return True


@unittest.skipUnless(git_available(), 'not a git checkout')
class ScratchSqlIsNeverTracked(unittest.TestCase):

    def test_no_generated_sql_sits_outside_its_home(self):
        strays = [
            path for path in tracked_files('*.sql')
            if not path.startswith(TRACKED_SQL_HOMES)
        ]
        self.assertEqual(
            strays, [],
            'generated scratch SQL is tracked: ' + ', '.join(strays) +
            '. Delete it; the generator produces it on demand.',
        )

    def test_the_repository_root_holds_no_sql_at_all(self):
        strays = [path for path in tracked_files('*.sql') if '/' not in path]
        self.assertEqual(strays, [], 'SQL in the repository root: ' + ', '.join(strays))

    def test_scratch_names_are_ignored_so_the_accident_cannot_repeat(self):
        # Ignoring them is what makes `git add -A` safe, which is how the file
        # got in. The test asserts the ignore rule, not just the absence.
        for name in ('gen_out.sql', '_doc.sql', 'scratch.sql'):
            result = subprocess.run(
                ['git', 'check-ignore', '-q', name],
                cwd=REPO_ROOT, capture_output=True,
            )
            self.assertEqual(
                result.returncode, 0,
                f'{name} in the repository root is not ignored',
            )

    def test_deliberate_sql_is_still_tracked(self):
        # A rule that ignored every .sql file everywhere would pass the tests
        # above by deleting the evidence.
        self.assertTrue(
            tracked_files('data sample/*.sql'),
            'the sample SQL fixtures vanished',
        )


@unittest.skipUnless(git_available(), 'not a git checkout')
class RunArtifactsAreNeverTracked(unittest.TestCase):
    """Certification output describes a live server, so it must not be committed.

    Evidence names the endpoint it ran against, the database, the login and the
    objects it created. The harness redacts what it writes, but the safest
    handling of an artifact is not to have it in the repository at all - and a
    `npm test *> node-test.log` transcript reached the staging area once while
    this branch was being written.
    """

    def test_no_test_transcript_is_tracked(self):
        self.assertEqual(tracked_files('node-test.log'), [])

    def test_no_junit_evidence_is_tracked(self):
        self.assertEqual(tracked_files('*.junit.xml'), [])

    def test_the_artifact_names_are_ignored(self):
        for name in ('node-test.log', 'evidence.junit.xml'):
            result = subprocess.run(
                ['git', 'check-ignore', '-q', name],
                cwd=REPO_ROOT, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, f'{name} is not ignored')


if __name__ == '__main__':
    unittest.main()
