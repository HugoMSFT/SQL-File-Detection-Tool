"""Command line entry point for the certification harness.

    python -m certification plan     --target azure --staging staging.json
    python -m certification verify   --manifest manifest.json
    python -m certification execute  --manifest manifest.json --confirm
    python -m certification report   --evidence evidence.json

``plan`` and ``verify`` never open a network connection and need no
credentials. ``execute`` is the only subcommand that connects, it refuses to
start without ``--confirm``, and it reads the password only from
``SQLFDT_CERT_PASSWORD`` (which it removes from the environment), standard
input, or an interactive prompt.

Run it from the repository root with ``scripts`` on ``PYTHONPATH``::

    set PYTHONPATH=%CD%\\scripts
    python -m certification plan --target azure --staging staging.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

from .evidence import RunEvidence, write_json, write_junit, write_markdown
from .manifest import Staging, build_manifest, write_manifest
from .matrix import HYPOTHESES, MATRIX, TARGETS, uncovered_hypotheses
from .redaction import Redactor
from .runid import RunIdentity, new_run_identity, parse_run_identity
from .safety import SafetyPolicy, evaluate_batch


def _identity(value: Optional[str]) -> RunIdentity:
    return parse_run_identity(value) if value else new_run_identity()


def cmd_plan(args: argparse.Namespace) -> int:
    identity = _identity(args.run_id)
    staging = Staging.load(args.staging)
    redactor = Redactor()
    manifest = build_manifest(
        target=args.target,
        identity=identity,
        staging=staging,
        vm_platform=args.vm_platform,
        redactor=redactor,
        emit_sql=args.emit_sql,
    )
    write_manifest(manifest, args.out)

    counts: Dict[str, int] = {}
    for cell in manifest['cells']:
        counts[cell['plan_verdict']] = counts.get(cell['plan_verdict'], 0) + 1
    print(f'run id      : {identity.run_id}')
    print(f'schema      : {identity.schema}')
    print(f'prefix      : {identity.prefix}')
    if args.target == 'vm':
        print(f'database    : {identity.database}')
    print(f'target      : {args.target} ({manifest["platform"]})')
    print(f'cells       : {len(manifest["cells"])}')
    for verdict, count in sorted(counts.items()):
        print(f'  {verdict:<16}{count}')
    print(f'plan sha256 : {manifest["plan_sha256"]}')
    print(f'written     : {args.out}')
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    with open(args.manifest, 'r', encoding='utf-8') as handle:
        manifest = json.load(handle)
    identity = RunIdentity(manifest['identity']['run_id'])
    policy = SafetyPolicy(
        identity,
        allowed_hosts=manifest.get('hosts') or (),
        allow_create_database=bool(manifest.get('allow_create_database')),
    )
    problems = 0
    for cell in manifest['cells']:
        for batch in cell.get('batches', []):
            sql = batch.get('sql')
            if sql is None:
                continue
            report = evaluate_batch(sql, policy)
            recorded = batch['safety']['allowed']
            if report.allowed != recorded:
                problems += 1
                print(
                    f'{cell["cell_id"]} batch {batch["batch_index"]}: manifest says '
                    f'allowed={recorded}, gate says allowed={report.allowed} '
                    f'({", ".join(report.codes)})'
                )
    missing = uncovered_hypotheses()
    if missing:
        problems += len(missing)
        for name in sorted(missing):
            print(f'hypothesis {name} has no matrix cell: {HYPOTHESES[name]}')
    print('verify: OK' if problems == 0 else f'verify: {problems} problem(s)')
    return 0 if problems == 0 else 1


def cmd_matrix(args: argparse.Namespace) -> int:
    print(f'{"cell":<6}{"target(s)":<14}{"fixture":<20}{"statement":<24}'
          f'{"access":<15}{"hyp":<12}accepts')
    for entry in MATRIX:
        print(
            f'{entry.cell_id:<6}{",".join(entry.targets):<14}{entry.fixture:<20}'
            f'{entry.statement_kind:<24}{entry.access:<15}{entry.hypothesis:<12}'
            f'{",".join(entry.accepts)}'
        )
    print()
    for name, text in HYPOTHESES.items():
        print(f'{name}: {text}')
    return 0


def cmd_execute(args: argparse.Namespace) -> int:
    # --confirm guards *connecting*. A dry run connects to nothing, so
    # requiring it there would only train people to pass --confirm reflexively.
    if not args.confirm and not args.dry_run:
        print(
            'refusing to connect without --confirm.\n'
            'This subcommand runs generated SQL against a live server. Review the\n'
            'manifest first with "verify", then re-run with --confirm.',
            file=sys.stderr,
        )
        return 2

    from .execute import ExecutionOptions, execute_cell, probe_engine, read_inventory, run_cleanup

    with open(args.manifest, 'r', encoding='utf-8') as handle:
        manifest = json.load(handle)
    identity = RunIdentity(manifest['identity']['run_id'])
    policy = SafetyPolicy(
        identity,
        allowed_hosts=manifest.get('hosts') or (),
        allow_create_database=bool(manifest.get('allow_create_database')),
    )
    options = ExecutionOptions(dry_run=args.dry_run)
    evidence = RunEvidence(
        run_id=identity.run_id,
        target=manifest['target'],
        platform=manifest['platform'],
    )

    if args.dry_run:
        # A dry run must not import an adapter, read an endpoint, ask for a
        # password or open a socket. It gates and hashes every batch and stops.
        redactor = Redactor()
        evidence.engine = {'driver': None, 'dry_run': True}
        for cell in manifest['cells']:
            evidence.cells.append(
                execute_cell(
                    None, cell, policy=policy, redactor=redactor, options=options
                )
            )
        evidence.cleanup_verified = True
        _write_reports(evidence, args.out_prefix, redactor)
        summary = evidence.summary()
        print(json.dumps(summary, indent=2))
        return 0

    from . import adapters

    settings = adapters.ConnectionSettings.from_env(
        host=args.host, database=args.database, user=args.user, port=args.port
    )
    redactor = Redactor(extra_literals=settings.redaction_literals())
    password = adapters.take_password()
    try:
        connection = adapters.connect(settings, password)
    finally:
        del password

    with connection:
        evidence.engine = redactor.redact_obj(probe_engine(connection))
        evidence.inventory_before = read_inventory(connection, identity)
        for cell in manifest['cells']:
            evidence.cells.append(
                execute_cell(
                    connection, cell, policy=policy, redactor=redactor, options=options
                )
            )
        cleanup = run_cleanup(connection, identity, redactor=redactor)
        evidence.inventory_after = cleanup['inventory_after']
        evidence.cleanup_verified = cleanup['verified']
        evidence.residue = cleanup['residue']

    _write_reports(evidence, args.out_prefix, redactor)
    summary = evidence.summary()
    print(json.dumps(summary, indent=2))
    return 0 if summary['DEFECTS'] == 0 and evidence.cleanup_verified else 1


def cmd_report(args: argparse.Namespace) -> int:
    with open(args.evidence, 'r', encoding='utf-8') as handle:
        payload = json.load(handle)
    print(f'run {payload["run_id"]} against {payload["target"]} ({payload["platform"]})')
    for verdict, count in payload['summary'].items():
        print(f'  {verdict:<24}{count}')
    for cell in payload['cells']:
        if not cell['accepted']:
            print(f'  DEFECT {cell["cell_id"]} [{cell["hypothesis"]}] {cell["verdict"]}')
    return 0


def _write_reports(evidence: RunEvidence, prefix: str, redactor: Redactor) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(prefix)) or '.', exist_ok=True)
    write_json(evidence, f'{prefix}.json', redactor)
    write_junit(evidence, f'{prefix}.junit.xml', redactor)
    write_markdown(evidence, f'{prefix}.md', redactor)
    print(f'wrote {prefix}.json, {prefix}.junit.xml, {prefix}.md')


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='python -m certification',
        description='Live certification harness for the SQL File Detection Tool.',
    )
    sub = parser.add_subparsers(dest='command', required=True)

    plan = sub.add_parser('plan', help='build a manifest (no network, no credentials)')
    plan.add_argument('--target', choices=TARGETS, required=True)
    plan.add_argument('--staging', help='staging JSON describing where fixtures live')
    plan.add_argument('--run-id', help='reuse an existing run id instead of minting one')
    plan.add_argument('--vm-platform', default='sql_server_2025',
                      help='generator platform id matching the live VM engine version')
    plan.add_argument('--out', default='certification-manifest.json')
    plan.add_argument('--emit-sql', action='store_true',
                      help='keep unredacted SQL in the manifest so it can be executed')
    plan.set_defaults(func=cmd_plan)

    verify = sub.add_parser('verify', help='re-run the safety gate over a manifest')
    verify.add_argument('--manifest', required=True)
    verify.set_defaults(func=cmd_verify)

    matrix = sub.add_parser('matrix', help='print the certification matrix')
    matrix.set_defaults(func=cmd_matrix)

    execute = sub.add_parser('execute', help='run a manifest against a live server')
    execute.add_argument('--manifest', required=True)
    execute.add_argument('--confirm', action='store_true')
    execute.add_argument('--dry-run', action='store_true')
    execute.add_argument('--host', help=f'overrides ${adapters_env("HOST")}')
    execute.add_argument('--database', help=f'overrides ${adapters_env("DATABASE")}')
    execute.add_argument('--user', help=f'overrides ${adapters_env("USER")}')
    execute.add_argument('--port', type=int)
    execute.add_argument('--out-prefix', default='certification-evidence')
    execute.set_defaults(func=cmd_execute)

    report = sub.add_parser('report', help='summarise an evidence file')
    report.add_argument('--evidence', required=True)
    report.set_defaults(func=cmd_report)
    return parser


def adapters_env(suffix: str) -> str:
    return f'SQLFDT_CERT_{suffix}'


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == '__main__':
    raise SystemExit(main())
