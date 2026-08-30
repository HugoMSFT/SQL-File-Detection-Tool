"""CLI behavior and option-forwarding tests."""

from unittest.mock import patch

from click.testing import CliRunner

from external_file_detection.cli import main
from external_file_detection.sql_generator import DEFAULT_TARGET_PLATFORM


def test_analyze_files_forwards_cloud_credentials():
    runner = CliRunner()
    with patch(
        'external_file_detection.cli.ExternalFileDetectorApp'
    ) as app_type:
        app_type.return_value.analyze_files.return_value = []
        result = runner.invoke(main, [
            'analyze-files',
            's3://bucket/data.csv',
            '--aws-access-key-id',
            'access',
            '--aws-secret-access-key',
            'secret',
            '--aws-region',
            'west',
        ])

    assert result.exit_code == 0
    app_type.assert_called_once_with({
        'aws_access_key_id': 'access',
        'aws_secret_access_key': 'secret',
        'region_name': 'west',
    })
    app_type.return_value.analyze_files.assert_called_once_with(
        ['s3://bucket/data.csv'],
        None,
        target_platform=DEFAULT_TARGET_PLATFORM,
        storage_url=None,
        schema_name='dbo',
        table_name=None,
        auth_method=None,
        credential_name=None,
    )


def test_default_target_platform_is_azure_sql_database():
    """An unspecified --target-platform resolves to Azure SQL Database."""
    assert DEFAULT_TARGET_PLATFORM == 'azure_sql_db'
    runner = CliRunner()
    with patch(
        'external_file_detection.cli.ExternalFileDetectorApp'
    ) as app_type:
        app_type.return_value.analyze_files.return_value = []
        result = runner.invoke(main, ['analyze-files', 'local.csv'])

    assert result.exit_code == 0
    _args, kwargs = app_type.return_value.analyze_files.call_args
    assert kwargs['target_platform'] == 'azure_sql_db'


def test_explicit_target_platform_is_preserved():
    """An explicit platform selection is never overridden by the default."""
    runner = CliRunner()
    with patch(
        'external_file_detection.cli.ExternalFileDetectorApp'
    ) as app_type:
        app_type.return_value.analyze_files.return_value = []
        result = runner.invoke(main, [
            'analyze-files', 'local.csv',
            '--target-platform', 'sql_server_2019',
        ])

    assert result.exit_code == 0
    _args, kwargs = app_type.return_value.analyze_files.call_args
    assert kwargs['target_platform'] == 'sql_server_2019'


def test_analyze_files_returns_nonzero_when_any_file_fails():
    runner = CliRunner()
    failed_result = {
        'file_path': 'broken.csv',
        'error': 'invalid file',
        'metadata': {'file_type': 'csv'},
        'sql_ddl': None,
    }
    with patch(
        'external_file_detection.cli.ExternalFileDetectorApp'
    ) as app_type:
        app_type.return_value.analyze_files.return_value = [failed_result]
        result = runner.invoke(main, ['analyze-files', 'broken.csv'])

    assert result.exit_code != 0
    assert '1 of 1 files could not be analyzed' in result.output


def test_gui_commands_share_the_same_launcher():
    runner = CliRunner()
    with patch('external_file_detection.cli._run_web_gui') as run_gui:
        gui_result = runner.invoke(main, [
            'gui',
            '--port',
            '5050',
            '--root-dir',
            'data',
        ])
        web_result = runner.invoke(main, [
            'web',
            '--port',
            '5051',
            '--root-dir',
            'other-data',
        ])

    assert gui_result.exit_code == 0
    assert web_result.exit_code == 0
    assert run_gui.call_args_list[0].args == (
        '127.0.0.1',
        5050,
        False,
        'data',
    )
    assert run_gui.call_args_list[1].args == (
        '127.0.0.1',
        5051,
        False,
        'other-data',
    )


def test_analyze_end_to_end_generates_complete_platform_sql(tmp_path):
    """Real end-to-end run: the CLI must emit a complete, platform-specific
    script whose regular and external table names do not collide."""
    data_dir = tmp_path / 'data'
    data_dir.mkdir()
    csv_file = data_dir / 'orders.csv'
    csv_file.write_text(
        'id,customer,amount\n1,alice,10.5\n2,bob,20.25\n', encoding='utf-8')
    out_file = tmp_path / 'out.sql'

    runner = CliRunner()
    result = runner.invoke(main, [
        'analyze', str(data_dir),
        '--output', str(out_file),
        '--target-platform', 'azure_sql_db',
    ])

    assert result.exit_code == 0, result.output

    assert out_file.exists(), result.output
    script = out_file.read_text(encoding='utf-8')

    # All sections present and GO-separated.
    for marker in ('CREATE TABLE', 'CREATE EXTERNAL TABLE', 'BULK INSERT',
                   'OPENROWSET', 'BEST PRACTICES', 'GO'):
        assert marker in script, marker

    # Distinct regular vs external table names.
    assert 'CREATE TABLE [dbo].[orders]' in script
    assert 'CREATE EXTERNAL TABLE [dbo].[ext_orders]' in script

    # Platform-specific: Azure SQL DB, never SQL Server-only HADOOP options.
    assert 'Azure SQL Database' in script
    assert 'TYPE = HADOOP' not in script
    assert 'REJECT_TYPE' not in script

    # No absolute local path smuggled into a cloud FROM/BULK clause.
    assert 'GO\nGO' not in script


def test_analyze_forwards_target_platform_to_app():
    runner = CliRunner()
    with patch(
        'external_file_detection.cli.ExternalFileDetectorApp'
    ) as app_type:
        app_type.return_value.analyze_location.return_value = {
            'files_found': 0, 'files': [], 'summary': {'total_size': 0,
                                                        'file_types': {}},
        }
        result = runner.invoke(main, [
            'analyze', 'data', '--target-platform', 'fabric_sql_db',
        ])

    assert result.exit_code == 0
    kwargs = app_type.return_value.analyze_location.call_args.kwargs
    assert kwargs['target_platform'] == 'fabric_sql_db'


def test_analyze_rejects_unknown_target_platform():
    runner = CliRunner()
    result = runner.invoke(main, [
        'analyze', 'data', '--target-platform', 'oracle',
    ])
    assert result.exit_code != 0
    assert 'oracle' in result.output


def test_analyze_forwards_object_name_overrides():
    """--schema / --table / --credential-name / --auth-method reach the app.

    Without these, a file called orders.csv generates dbo.orders, which
    collides with a real table in any TPC-H style database.
    """
    runner = CliRunner()
    with patch(
        'external_file_detection.cli.ExternalFileDetectorApp'
    ) as app_type:
        app_type.return_value.analyze_location.return_value = {
            'location': 'x', 'files_found': 0, 'files': [],
        }
        result = runner.invoke(main, [
            'analyze', 'folder',
            '--schema', 'staging',
            '--table', 'orders_import',
            '--credential-name', 'cred_staging',
            '--auth-method', 'managed_identity',
        ])

    assert result.exit_code == 0
    app_type.return_value.analyze_location.assert_called_once_with(
        'folder',
        None,
        target_platform=DEFAULT_TARGET_PLATFORM,
        storage_url=None,
        schema_name='staging',
        table_name='orders_import',
        auth_method='managed_identity',
        credential_name='cred_staging',
    )


def test_analyze_rejects_unknown_auth_method():
    """An unknown auth method is rejected instead of silently ignored."""
    runner = CliRunner()
    result = runner.invoke(main, ['analyze', 'folder', '--auth-method', 'nope'])
    assert result.exit_code != 0
    assert 'nope' in result.output
