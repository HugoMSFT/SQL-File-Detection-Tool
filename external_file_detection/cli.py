"""Command-line interface for the SQL File Detection Tool."""

import click
import json
import logging
from typing import Dict, Any

from .external_file_detector import ExternalFileDetectorApp
from .sql_generator import AUTH_METHODS, DEFAULT_TARGET_PLATFORM, SQLGenerator
from .azure_auth import AUTH_MODES as AZURE_AUTH_MODES
from .azure_auth import redact as _redact
from . import __product_name__, __version__

logger = logging.getLogger(__name__)


def _build_storage_config(aws_access_key_id, aws_secret_access_key, aws_region,
                          azure_account_name, azure_account_key,
                          azure_connection_string, azure_sas=None,
                          azure_auth_mode=None) -> Dict[str, Any]:
    """Build storage configuration dict from CLI options."""
    storage_config: Dict[str, Any] = {}
    if aws_access_key_id:
        storage_config['aws_access_key_id'] = aws_access_key_id
    if aws_secret_access_key:
        storage_config['aws_secret_access_key'] = aws_secret_access_key
    if aws_region:
        storage_config['region_name'] = aws_region
    if azure_account_name:
        storage_config['azure_account_name'] = azure_account_name
    if azure_account_key:
        storage_config['azure_account_key'] = azure_account_key
    if azure_connection_string:
        storage_config['azure_connection_string'] = azure_connection_string
    if azure_sas:
        storage_config['azure_sas_token'] = azure_sas
    if azure_auth_mode:
        storage_config['azure_auth_mode'] = azure_auth_mode
    return storage_config


def target_platform_option(func):
    """Shared Click option selecting the SQL platform for generated scripts."""
    return click.option(
        '--target-platform', default=DEFAULT_TARGET_PLATFORM,
        show_default=True,
        type=click.Choice(SQLGenerator.PLATFORMS),
        help='SQL platform the generated script targets',
    )(func)


def naming_options(func):
    """Shared Click options controlling generated object names and auth.

    Without an explicit schema, a table name derived from the file name lands
    in ``dbo``, where it can collide with a real table -- a file called
    ``orders.csv`` targets ``dbo.orders``. These options make every generated
    name caller-controlled.
    """
    func = click.option(
        '--auth-method', default=None,
        type=click.Choice(AUTH_METHODS),
        help='How the generated SQL authenticates to storage. Defaults to '
             'managed_identity where the platform supports it, which needs '
             'no secret and no database master key. Use public for a '
             'container that allows anonymous read.',
    )(func)
    func = click.option(
        '--credential-name', default=None,
        help='Name for the generated database scoped credential '
             '(default: cred_<data-source>).',
    )(func)
    func = click.option(
        '--table', 'table_name', default=None,
        help='Explicit table name instead of one derived from the file name. '
             'Only valid when analysing a single file.',
    )(func)
    func = click.option(
        '--schema', 'schema_name', default='dbo', show_default=True,
        help='Schema every generated object is created in. Set this to keep '
             'generated objects out of dbo.',
    )(func)
    return func


def storage_url_option(func):
    """Shared Click option naming where the data is staged for SQL."""
    return click.option(
        '--storage-url', default=None,
        help='Cloud location the data is (or will be) staged at, for '
             'example abs://container@account.blob.core.windows.net/folder. '
             'Used verbatim in the generated SQL; local files need this '
             'because a cloud SQL engine cannot read your disk.',
    )(func)


def storage_options(func):
    """Shared Click options for cloud storage credentials."""
    func = click.option('--azure-auth-mode', default=None,
                        type=click.Choice(AZURE_AUTH_MODES),
                        help='Explicit Azure Storage authentication mode. '
                             'Use managed_identity in production; '
                             'entra_default reuses a local developer sign-in.')(func)
    func = click.option('--azure-sas', default=None, envvar='AZURE_STORAGE_SAS_TOKEN',
                        help='Azure storage SAS URL or token (or set AZURE_STORAGE_SAS_TOKEN env var)')(func)
    func = click.option('--azure-connection-string', default=None, envvar='AZURE_STORAGE_CONNECTION_STRING',
                        help='Azure storage connection string (or set AZURE_STORAGE_CONNECTION_STRING env var)')(func)
    func = click.option('--azure-account-key', default=None, envvar='AZURE_STORAGE_KEY',
                        help='Azure storage account key (or set AZURE_STORAGE_KEY env var)')(func)
    func = click.option('--azure-account-name', default=None, envvar='AZURE_STORAGE_ACCOUNT',
                        help='Azure storage account name (or set AZURE_STORAGE_ACCOUNT env var)')(func)
    func = click.option('--aws-region', default='us-east-1', envvar='AWS_DEFAULT_REGION',
                        help='AWS region (or set AWS_DEFAULT_REGION env var)')(func)
    func = click.option('--aws-secret-access-key', default=None, envvar='AWS_SECRET_ACCESS_KEY',
                        help='AWS secret access key (or set AWS_SECRET_ACCESS_KEY env var)')(func)
    func = click.option('--aws-access-key-id', default=None, envvar='AWS_ACCESS_KEY_ID',
                        help='AWS access key ID (or set AWS_ACCESS_KEY_ID env var)')(func)
    return func


def _run_web_gui(host: str, port: int, debug: bool,
                 root_dir: str = None) -> None:
    """Launch the shared web GUI implementation."""
    try:
        from .web_gui import ExternalFileDetectionWebGUI
        app = ExternalFileDetectionWebGUI(root_dir=root_dir)
        app.run(host=host, port=port, debug=debug)
    except ImportError as e:
        raise click.ClickException(
            f"Could not launch the {__product_name__} web interface: {e}. "
            f"Please ensure Flask is installed: pip install flask"
        ) from e
    except Exception as e:
        raise click.ClickException(str(e)) from e


@click.group()
@click.version_option(version=__version__)
@click.option('--verbose', '-v', is_flag=True, help='Enable verbose logging')
def main(verbose):
    """SQL File Detection Tool - detect data files and generate SQL DDL.

    Generated scripts target Azure SQL Database by default; pass
    --target-platform to choose another SQL platform.
    """
    level = logging.DEBUG if verbose else logging.WARNING
    logging.basicConfig(
        level=level,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )


@main.command()
@click.option('--host', default='127.0.0.1', help='Host to bind to')
@click.option('--port', default=5000, help='Port to bind to')
@click.option('--debug', is_flag=True, help='Enable debug mode')
@click.option('--root-dir', default=None, help='Restrict file browsing to this directory tree')
def gui(host, port, debug, root_dir):
    """Launch the web-based graphical user interface."""
    _run_web_gui(host, port, debug, root_dir)


@main.command()
@click.argument('location', type=str)
@click.option('--data-source', '-d', default=None, 
              help='Name of the external data source for SQL DDL')
@click.option('--output', '-o', default=None, 
              help='Output file path for results')
@click.option('--format', '-f', default='sql', type=click.Choice(['sql', 'json']),
              help='Output format')
@target_platform_option
@storage_url_option
@naming_options
@storage_options
def analyze(location, data_source, output, format, target_platform,
           storage_url, schema_name, table_name, credential_name, auth_method,
           aws_access_key_id,
           aws_secret_access_key, aws_region, azure_account_name,
           azure_account_key, azure_connection_string, azure_sas,
           azure_auth_mode):
    """Analyze files at the specified location."""
    
    storage_config = _build_storage_config(
        aws_access_key_id, aws_secret_access_key, aws_region,
        azure_account_name, azure_account_key, azure_connection_string,
        azure_sas, azure_auth_mode
    )
    
    # Initialize application
    app = ExternalFileDetectorApp(storage_config)
    
    try:
        # Analyze location
        click.echo(f"Analyzing location: {location}")
        results = app.analyze_location(location, data_source,
                                       target_platform=target_platform,
                                       storage_url=storage_url,
                                       schema_name=schema_name,
                                       table_name=table_name,
                                       auth_method=auth_method,
                                       credential_name=credential_name)
        
        # Display summary
        click.echo(f"\nAnalysis completed!")
        click.echo(f"Files found: {results['files_found']}")
        
        if results['files_found'] > 0:
            click.echo(f"Total size: {results['summary']['total_size']:,} bytes")
            click.echo("File types:")
            for file_type, count in results['summary']['file_types'].items():
                click.echo(f"  {file_type}: {count}")
        
        # Export results if output specified
        if output:
            app.export_results(results, output, format)
            click.echo(f"\nResults exported to: {output}")
        else:
            # Display results to console
            if format == 'json':
                click.echo("\nResults (JSON):")
                click.echo(json.dumps(results, indent=2, default=str))
            else:
                click.echo("\nGenerated SQL DDL:")
                for file_result in results['files']:
                    if 'error' in file_result:
                        click.echo(f"-- Error analyzing {file_result['file_path']}: {file_result['error']}")
                    else:
                        click.echo(f"-- File: {file_result['file_path']}")
                        click.echo(file_result['sql_ddl'])
                        click.echo()
        
        if 'error' in results:
            click.echo(f"Warning: {_redact(results['error'])}", err=True)
            
    except click.ClickException:
        raise
    except Exception as e:
        raise click.ClickException(str(e)) from e


@main.command()
@click.argument('files', nargs=-1, required=True)
@click.option('--data-source', '-d', default=None,
              help='Name of the external data source for SQL DDL')
@click.option('--output', '-o', default=None,
              help='Output file path for results')
@click.option('--format', '-f', default='sql', type=click.Choice(['sql', 'json']),
              help='Output format')
@target_platform_option
@storage_url_option
@naming_options
@storage_options
def analyze_files(files, data_source, output, format, target_platform,
                  storage_url, schema_name, table_name, credential_name,
                  auth_method,
                  aws_access_key_id,
                  aws_secret_access_key, aws_region, azure_account_name,
                  azure_account_key, azure_connection_string, azure_sas,
                  azure_auth_mode):
    """Analyze specific files."""

    storage_config = _build_storage_config(
        aws_access_key_id, aws_secret_access_key, aws_region,
        azure_account_name, azure_account_key, azure_connection_string,
        azure_sas, azure_auth_mode
    )
    app = ExternalFileDetectorApp(storage_config)
    
    try:
        results = app.analyze_files(list(files), data_source,
                                    target_platform=target_platform,
                                    storage_url=storage_url,
                                    schema_name=schema_name,
                                    table_name=table_name,
                                    auth_method=auth_method,
                                    credential_name=credential_name)
        
        click.echo(f"Analyzed {len(results)} files")
        
        # Export or display results
        if output:
            # Convert to same format as analyze command
            export_data = {
                'location': 'multiple_files',
                'files_found': len(results),
                'files': results
            }
            app.export_results(export_data, output, format)
            click.echo(f"Results exported to: {output}")
        else:
            if format == 'json':
                click.echo(json.dumps(results, indent=2, default=str))
            else:
                for result in results:
                    if 'error' in result:
                        click.echo(f"-- Error analyzing {result['file_path']}: {result['error']}")
                    else:
                        click.echo(f"-- File: {result['file_path']}")
                        click.echo(result['sql_ddl'])
                        click.echo()

        failed = sum(1 for result in results if 'error' in result)
        if failed:
            raise click.ClickException(
                f"{failed} of {len(results)} files could not be analyzed"
            )
    
    except click.ClickException:
        raise
    except Exception as e:
        raise click.ClickException(str(e)) from e


@main.command()
@click.argument('name')
@click.argument('storage_type', type=click.Choice(['s3', 'azure', 'local']))
@click.argument('location')
@click.option('--credential', default=None,
              help='Name of the database credential to use')
@target_platform_option
def generate_data_source(name, storage_type, location, credential,
                         target_platform):
    """Generate CREATE EXTERNAL DATA SOURCE statement."""
    
    app = ExternalFileDetectorApp()
    
    try:
        ddl = app.generate_data_source_ddl(name, storage_type, location, credential,
                                          target_platform=target_platform)
        click.echo(ddl)
    except Exception as e:
        click.echo(f"Error: {_redact(str(e))}", err=True)
        raise SystemExit(1)


@main.command()
def supported_types():
    """List supported file types."""
    
    app = ExternalFileDetectorApp()
    types = app.get_supported_file_types()
    
    click.echo("Supported file types:")
    for file_type in sorted(types):
        click.echo(f"  {file_type}")


@main.command()
@click.argument('location')
@storage_options
def list_files(location, aws_access_key_id, aws_secret_access_key, aws_region,
               azure_account_name, azure_account_key, azure_connection_string,
               azure_sas, azure_auth_mode):
    """List files at the specified location."""
    
    from .storage_handlers import StorageFactory
    
    storage_config = _build_storage_config(
        aws_access_key_id, aws_secret_access_key, aws_region,
        azure_account_name, azure_account_key, azure_connection_string,
        azure_sas, azure_auth_mode
    )
    
    try:
        storage_handler = StorageFactory.create_handler(location, **storage_config)
        files = storage_handler.list_files(location)
        
        click.echo(f"Files found at {location}:")
        for file_path in files:
            click.echo(f"  {file_path}")
        
        click.echo(f"\nTotal files: {len(files)}")
        
    except Exception as e:
        click.echo(f"Error: {_redact(str(e))}", err=True)
        raise SystemExit(1)


@main.command()
@click.option('--host', '-h', default='127.0.0.1', help='Host to bind to')
@click.option('--port', '-p', default=5000, type=int, help='Port to listen on')
@click.option('--debug', is_flag=True, help='Enable debug mode')
@click.option('--root-dir', default=None,
              help='Restrict file browsing to this directory tree')
def web(host, port, debug, root_dir):
    """Launch the web UI (compatibility alias for gui)."""
    _run_web_gui(host, port, debug, root_dir)


if __name__ == '__main__':
    main()