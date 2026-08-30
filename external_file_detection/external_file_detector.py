"""Main external file detector application."""

import os
import logging
import re
import tempfile
import uuid
from contextlib import nullcontext
from typing import Dict, List, Any

from .file_detector import FileDetector
from .sql_generator import SQLGenerator, _sql_server_storage_parts
from .storage_handlers import StorageHandler, StorageFactory

logger = logging.getLogger(__name__)


class ExternalFileDetectorApp:
    """Main application for external file detection and SQL DDL generation."""
    
    def __init__(self, storage_config: Dict[str, Any] = None):
        """
        Initialize the external file detector application.
        
        Args:
            storage_config: Configuration for cloud storage access
        """
        self.file_detector = FileDetector()
        self.sql_generator = SQLGenerator()
        self.storage_config = storage_config or {}
    
    def analyze_location(self, location: str, data_source: str = None,
                         target_platform: str = 'sql_server_2022') -> Dict[str, Any]:
        """
        Analyze files at the given location and generate SQL DDL.
        
        Args:
            location: Path to analyze (local, S3, or Azure)
            data_source: Name of the external data source for SQL
            target_platform: SQL platform the generated script targets
            
        Returns:
            Analysis results with file metadata and SQL DDL
        """
        # Create storage handler
        storage_handler = StorageFactory.create_handler(location, **self.storage_config)
        
        # List files
        files = storage_handler.list_files(location)
        
        if not files:
            return {
                'location': location,
                'files_found': 0,
                'files': [],
                'error': 'No files found at the specified location'
            }
        
        results = {
            'location': location,
            'files_found': len(files),
            'files': [],
            'summary': {
                'file_types': {},
                'total_size': 0,
                'total_files': len(files)
            }
        }
        
        temp_context = (
            tempfile.TemporaryDirectory(prefix='efd_remote_')
            if StorageFactory.is_remote(location)
            else nullcontext(None)
        )
        with temp_context as temp_dir:
            for file_path in files:
                file_result = self._analyze_single_file(
                    file_path, storage_handler, data_source, temp_dir,
                    target_platform=target_platform,
                )
                results['files'].append(file_result)
                
                # Update summary
                file_type = file_result['metadata']['file_type']
                if file_type not in results['summary']['file_types']:
                    results['summary']['file_types'][file_type] = 0
                results['summary']['file_types'][file_type] += 1
                
                if 'file_size' in file_result['metadata']:
                    results['summary']['total_size'] += file_result['metadata']['file_size']
        
        return results
    
    def _analyze_single_file(self, file_path: str, storage_handler: StorageHandler,
                           data_source: str = None, temp_dir: str = None,
                           target_platform: str = 'sql_server_2022') -> Dict[str, Any]:
        """Analyze a single file and generate SQL DDL."""
        local_path = file_path
        
        # Download file if it's remote
        is_remote = StorageFactory.is_remote(file_path)
        if is_remote and temp_dir is None:
            with tempfile.TemporaryDirectory(prefix='efd_remote_') as owned_temp_dir:
                return self._analyze_single_file(
                    file_path,
                    storage_handler,
                    data_source,
                    owned_temp_dir,
                    target_platform=target_platform,
                )

        if is_remote:
            source_name = StorageFactory.basename(file_path) or 'download'
            suffix_match = re.search(r'\.[A-Za-z0-9]{1,10}$', source_name)
            safe_suffix = (
                suffix_match.group(0).lower() if suffix_match else ''
            )
            filename = f"{uuid.uuid4().hex}{safe_suffix}"
            local_path = os.path.join(temp_dir, filename)
            try:
                local_path = storage_handler.download_file(file_path, local_path)
            except Exception as e:
                logger.error("Failed to download %s: %s", file_path, e)
                return self._file_error(
                    file_path, f"Failed to download file: {e}"
                )
        
        # Analyze file metadata
        try:
            metadata = self.file_detector.analyze_file_metadata(local_path)
            metadata['original_path'] = file_path
            if is_remote:
                metadata['file_path'] = file_path
                metadata['file_name'] = StorageFactory.basename(file_path)
            if metadata.get('error'):
                return self._file_error(
                    file_path,
                    f"Failed to analyze file: {metadata['error']}",
                    metadata=metadata,
                )
        except Exception as e:
            logger.error("Failed to analyze %s: %s", file_path, e)
            return self._file_error(file_path, f"Failed to analyze file: {e}")
        
        # Generate SQL DDL
        table_name = self._generate_table_name(file_path)
        try:
            ddl = self.sql_generator.generate_complete_ddl(
                metadata,
                table_name,
                data_source,
                location=None,
                target_platform=target_platform,
                storage_url=file_path if is_remote else None,
            )
        except Exception as e:
            logger.error("Failed to generate DDL for %s: %s", file_path, e)
            return self._file_error(
                file_path,
                f"Failed to generate DDL: {e}",
                metadata=metadata,
                table_name=table_name,
            )
        
        return {
            'file_path': file_path,
            'metadata': metadata,
            'sql_ddl': ddl,
            'table_name': table_name
        }

    def _file_error(self, file_path: str, message: str,
                    metadata: Dict[str, Any] = None,
                    table_name: str = None) -> Dict[str, Any]:
        """Build a consistent per-file error result."""
        error_metadata = metadata or {
            'file_path': file_path,
            'file_name': StorageFactory.basename(file_path),
            'file_type': 'unknown',
        }
        return {
            'file_path': file_path,
            'error': message,
            'metadata': error_metadata,
            'sql_ddl': None,
            'table_name': table_name or self._generate_table_name(file_path),
        }
    
    def _generate_table_name(self, file_path: str) -> str:
        """Generate a valid SQL table name from file path."""
        # Extract filename without extension
        filename = StorageFactory.basename(file_path)
        name_without_ext = os.path.splitext(filename)[0]
        
        # Clean name for SQL compatibility
        clean_name = ''.join(c if c.isalnum() else '_' for c in name_without_ext)
        
        # Ensure it doesn't start with a number
        if clean_name and clean_name[0].isdigit():
            clean_name = 'tbl_' + clean_name
        
        # Ensure it's not empty
        if not clean_name:
            clean_name = 'external_table'
        
        return clean_name
    
    def analyze_files(self, file_paths: List[str], data_source: str = None,
                      target_platform: str = 'sql_server_2022') -> List[Dict[str, Any]]:
        """
        Analyze multiple specific files.
        
        Args:
            file_paths: List of file paths to analyze
            data_source: Name of the external data source for SQL
            target_platform: SQL platform the generated script targets
            
        Returns:
            List of analysis results
        """
        results = []
        handler_cache: Dict[str, StorageHandler] = {}

        has_remote = any(StorageFactory.is_remote(path) for path in file_paths)
        temp_context = (
            tempfile.TemporaryDirectory(prefix='efd_remote_')
            if has_remote
            else nullcontext(None)
        )
        with temp_context as temp_dir:
            for file_path in file_paths:
                cache_key = StorageFactory.cache_key(file_path)
                if cache_key not in handler_cache:
                    handler_cache[cache_key] = StorageFactory.create_handler(
                        file_path, **self.storage_config
                    )
                result = self._analyze_single_file(
                    file_path,
                    handler_cache[cache_key],
                    data_source,
                    temp_dir,
                    target_platform=target_platform,
                )
                results.append(result)
        
        return results
    
    def generate_data_source_ddl(self, data_source_name: str, storage_type: str,
                                location: str, credential: str = None,
                                target_platform: str = 'sql_server_2022') -> str:
        """
        Generate CREATE EXTERNAL DATA SOURCE statement.
        
        Args:
            data_source_name: Name for the data source
            storage_type: Type of storage (S3, Azure, etc.)
            location: Base location/URL
            credential: Optional credential name
            target_platform: SQL Server target version
            
        Returns:
            SQL CREATE EXTERNAL DATA SOURCE statement
        """
        # Sanitize inputs to prevent SQL injection
        safe_ds_name = self._sanitize_sql_identifier(data_source_name)
        if target_platform not in self.sql_generator.PLATFORMS:
            target_platform = 'sql_server_2022'

        storage_kind = storage_type.lower()
        if storage_kind == 'azure':
            normalized_location, _ = _sql_server_storage_parts(
                location, '<file>', target_platform
            )
        elif storage_kind == 's3':
            if target_platform == 'sql_server_2019':
                raise ValueError(
                    'S3-compatible external data sources require '
                    'SQL Server 2022 or later'
                )
            normalized_location = location
        else:
            normalized_location = location
        safe_location = normalized_location.replace("'", "''")
        
        sql_parts = [f"CREATE EXTERNAL DATA SOURCE [{safe_ds_name}]"]
        sql_parts.append("WITH (")
        
        options = []
        
        if target_platform == 'sql_server_2019':
            options.append("    TYPE = HADOOP")
        options.append(f"    LOCATION = '{safe_location}'")
        
        if credential:
            safe_credential = self._sanitize_sql_identifier(credential)
            options.append(f"    CREDENTIAL = [{safe_credential}]")
        
        sql_parts.append(",\n".join(options))
        sql_parts.append(");")
        
        return "\n".join(sql_parts)
    
    def export_results(self, results: Dict[str, Any], output_file: str,
                      format: str = 'sql') -> None:
        """
        Export analysis results to file.
        
        Args:
            results: Analysis results
            output_file: Path to output file
            format: Output format ('sql', 'json')
        """
        output_dir = os.path.dirname(output_file)
        if output_dir:  # Only create directory if there's a directory part
            os.makedirs(output_dir, exist_ok=True)
        
        if format.lower() == 'json':
            import json
            with open(output_file, 'w', encoding='utf-8', newline='\n') as f:
                json.dump(results, f, indent=2, default=str)
        else:  # SQL format
            with open(output_file, 'w', encoding='utf-8', newline='\n') as f:
                f.write("-- External File Detection Results\n")
                f.write(f"-- Location: {self._sanitize_sql_comment(results['location'])}\n")
                f.write(f"-- Files found: {results['files_found']}\n\n")
                
                for file_result in results['files']:
                    f.write(f"-- File: {self._sanitize_sql_comment(file_result['file_path'])}\n")
                    f.write(f"-- Type: {self._sanitize_sql_comment(file_result['metadata']['file_type'])}\n")
                    if 'error' in file_result:
                        f.write(f"-- Error: {self._sanitize_sql_comment(file_result['error'])}\n\n")
                    else:
                        f.write(file_result['sql_ddl'])
                        f.write("\n\n")
    
    @staticmethod
    def _sanitize_sql_identifier(name: str) -> str:
        """Sanitize a value for use as a SQL bracket-delimited identifier."""
        # Remove characters that could break bracket-delimited identifiers
        return name.replace(']', ']]')
    
    @staticmethod
    def _sanitize_sql_comment(value: str) -> str:
        """Sanitize a value for safe inclusion in a SQL comment."""
        # Replace newlines to prevent breaking out of comments
        return str(value).replace('\n', ' ').replace('\r', '')
    
    def get_supported_file_types(self) -> List[str]:
        """Get list of supported file types."""
        return sorted(set(self.file_detector.SUPPORTED_EXTENSIONS.values()))