"""Storage handlers for local, S3, and Azure storage."""

import os
import logging
from typing import List, Dict, Any, Tuple
from abc import ABC, abstractmethod
from urllib.parse import quote, unquote, urlparse

logger = logging.getLogger(__name__)


def _ensure_parent_directory(path: str) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)


def _is_local_table_directory(path: str) -> bool:
    """Return whether a local directory is a Delta or Iceberg table root."""
    if os.path.isdir(os.path.join(path, '_delta_log')):
        return True
    metadata_dir = os.path.join(path, 'metadata')
    if not os.path.isdir(metadata_dir):
        return False
    try:
        return any(
            entry.is_file()
            and entry.name.lower().endswith('.metadata.json')
            for entry in os.scandir(metadata_dir)
        )
    except OSError:
        return False


def _parse_s3_path(path: str, require_key: bool = False) -> Tuple[str, str]:
    parsed = urlparse(path)
    if parsed.scheme.lower() != 's3' or not parsed.netloc:
        raise ValueError("S3 path must use s3://bucket[/key]")
    key = unquote(parsed.path.lstrip('/'))
    if require_key and not key:
        raise ValueError("S3 object path must include a key")
    return parsed.netloc, key


def _parse_azure_path(path: str, require_blob: bool = False) -> Tuple[str, str]:
    parsed = urlparse(path)
    if parsed.scheme.lower() == 'azure':
        container = parsed.netloc
        blob_name = unquote(parsed.path.lstrip('/'))
    elif parsed.scheme.lower() == 'https':
        hostname = (parsed.hostname or '').lower()
        if not hostname.endswith('.blob.core.windows.net'):
            raise ValueError(
                "Azure HTTPS path must use a *.blob.core.windows.net host"
            )
        raw_path = parsed.path.lstrip('/')
        raw_container, separator, raw_blob_name = raw_path.partition('/')
        container = unquote(raw_container)
        blob_name = unquote(raw_blob_name) if separator else ''
    else:
        raise ValueError("Azure path must start with azure:// or use an HTTPS blob URL")

    if not container:
        raise ValueError("Azure path must include a container")
    if require_blob and not blob_name:
        raise ValueError("Azure blob path must include a blob name")
    return container, blob_name


class StorageHandler(ABC):
    """Abstract base class for storage handlers."""
    
    @abstractmethod
    def list_files(self, path: str) -> List[str]:
        """List files in the given path."""
        pass
    
    @abstractmethod
    def get_file_info(self, file_path: str) -> Dict[str, Any]:
        """Get file information."""
        pass
    
    @abstractmethod
    def download_file(self, source_path: str, local_path: str) -> str:
        """Download file to local path for analysis."""
        pass


class LocalStorageHandler(StorageHandler):
    """Handler for local file system storage."""
    
    def list_files(self, path: str) -> List[str]:
        """List files in the local directory."""
        files = []
        if os.path.isfile(path):
            return [path]
        if not os.path.isdir(path):
            raise FileNotFoundError(f"Local path does not exist: {path}")
        if _is_local_table_directory(path):
            return [path]
        
        for root, dirs, filenames in os.walk(path):
            dirs.sort()
            table_dirs = []
            remaining_dirs = []
            for dirname in dirs:
                full_dir = os.path.join(root, dirname)
                if _is_local_table_directory(full_dir):
                    table_dirs.append(full_dir)
                else:
                    remaining_dirs.append(dirname)

            files.extend(sorted(table_dirs))
            dirs[:] = remaining_dirs

            for filename in sorted(filenames):
                files.append(os.path.join(root, filename))
        
        return files
    
    def get_file_info(self, file_path: str) -> Dict[str, Any]:
        """Get local file information."""
        stat = os.stat(file_path)
        return {
            'path': file_path,
            'size': stat.st_size,
            'modified': stat.st_mtime,
            'is_file': os.path.isfile(file_path)
        }
    
    def download_file(self, source_path: str, local_path: str) -> str:
        """For local storage, just return the source path."""
        return source_path


class S3StorageHandler(StorageHandler):
    """Handler for Amazon S3 storage."""
    
    def __init__(self, aws_access_key_id: str = None, aws_secret_access_key: str = None,
                 region_name: str = 'us-east-1'):
        """Initialize S3 handler."""
        try:
            import boto3
        except ImportError:
            raise ImportError(
                "boto3 is required for S3 storage. Install with: pip install boto3"
            )
        self.s3_client = boto3.client(
            's3',
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
            region_name=region_name
        )
    
    def list_files(self, path: str) -> List[str]:
        """List files in S3 bucket/prefix."""
        bucket, prefix = _parse_s3_path(path)
        
        files = []
        paginator = self.s3_client.get_paginator('list_objects_v2')
        
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            if 'Contents' in page:
                for obj in page['Contents']:
                    if not obj['Key'].endswith('/'):  # Skip directories
                        encoded_key = quote(obj['Key'], safe='/')
                        files.append(f"s3://{bucket}/{encoded_key}")
        
        return files
    
    def get_file_info(self, file_path: str) -> Dict[str, Any]:
        """Get S3 file information."""
        bucket, key = _parse_s3_path(file_path, require_key=True)
        
        try:
            response = self.s3_client.head_object(Bucket=bucket, Key=key)
            return {
                'path': file_path,
                'size': response['ContentLength'],
                'modified': response['LastModified'].timestamp(),
                'is_file': True,
                'etag': response['ETag']
            }
        except Exception as e:
            return {
                'path': file_path,
                'error': str(e),
                'is_file': False
            }
    
    def download_file(self, source_path: str, local_path: str) -> str:
        """Download S3 file to local path."""
        bucket, key = _parse_s3_path(source_path, require_key=True)
        _ensure_parent_directory(local_path)
        
        self.s3_client.download_file(bucket, key, local_path)
        return local_path


class AzureStorageHandler(StorageHandler):
    """Handler for Azure Blob Storage.

    Authentication is expressed as an explicit mode rather than an implicit
    chain. Supported modes are the ones in
    :mod:`external_file_detection.azure_auth`: Microsoft Entra ID (developer,
    interactive, managed identity or a VS Code brokered token), SAS,
    connection string, account key, and anonymous public read.
    """

    #: Hard ceiling on blobs returned by :meth:`list_files` so a container
    #: with millions of blobs cannot exhaust memory.
    MAX_LISTED_FILES = 5000

    #: Instance override default, also used when a handler is built without
    #: running ``__init__`` (as some tests do).
    max_listed_files = MAX_LISTED_FILES

    def __init__(self, account_name: str = None, account_key: str = None,
                 connection_string: str = None, sas_token: str = None,
                 auth_mode: str = None, credential: Any = None,
                 connection: Any = None,
                 max_listed_files: int = None):
        """Initialize the Azure storage handler.

        Args:
            account_name: Storage account name.
            account_key: Shared key (least preferred).
            connection_string: Storage connection string.
            sas_token: SAS token or full SAS URL.
            auth_mode: One of ``azure_auth.AUTH_MODES``. Inferred from the
                supplied material when omitted.
            credential: A ready ``TokenCredential``.
            connection: An ``azure_auth.AzureConnection`` to reuse, which also
                reuses its cached clients.
            max_listed_files: Override the listing ceiling.
        """
        from . import azure_auth

        self.max_listed_files = int(max_listed_files or self.MAX_LISTED_FILES)
        self._connection = connection

        if connection is not None:
            self.auth_mode = connection.mode
            self.account_name = account_name or connection.account_name
            self.blob_service_client = connection.blob_service_client(
                self.account_name
            )
            return

        BlobServiceClient = azure_auth._require_azure_storage()
        self.account_name = account_name

        if auth_mode is None:
            if connection_string:
                auth_mode = azure_auth.AUTH_CONNECTION_STRING
            elif sas_token:
                auth_mode = azure_auth.AUTH_SAS
            elif account_key:
                auth_mode = azure_auth.AUTH_ACCOUNT_KEY
            elif credential is not None:
                auth_mode = azure_auth.AUTH_ENTRA_DEFAULT
            elif account_name:
                auth_mode = azure_auth.AUTH_ENTRA_DEFAULT
            else:
                raise ValueError(
                    "Either connection_string or account_name must be provided"
                )
        self.auth_mode = auth_mode

        if auth_mode == azure_auth.AUTH_CONNECTION_STRING:
            if not connection_string:
                raise ValueError("connection_string is required for this mode")
            resolved, _ = azure_auth.parse_connection_string(connection_string)
            self.account_name = account_name or resolved
            self.blob_service_client = BlobServiceClient.from_connection_string(
                connection_string
            )
            return

        if auth_mode == azure_auth.AUTH_SAS:
            parsed_account, _container, token = azure_auth.parse_sas_input(
                sas_token or ''
            )
            self.account_name = account_name or parsed_account
            if not self.account_name:
                raise ValueError(
                    "A bare SAS token also needs the storage account name"
                )
            self.blob_service_client = BlobServiceClient(
                self._account_url(), credential=token
            )
            return

        if not self.account_name:
            raise ValueError(
                "Either connection_string or account_name must be provided"
            )

        if auth_mode == azure_auth.AUTH_ACCOUNT_KEY:
            if not account_key:
                raise ValueError("account_key is required for this mode")
            self.blob_service_client = BlobServiceClient(
                self._account_url(), credential=account_key
            )
            return

        if auth_mode == azure_auth.AUTH_ANONYMOUS:
            self.blob_service_client = BlobServiceClient(
                self._account_url(), credential=None
            )
            return

        resolved_credential = credential
        if resolved_credential is None:
            resolved_credential = azure_auth.build_entra_credential(auth_mode)
        self.blob_service_client = BlobServiceClient(
            self._account_url(), credential=resolved_credential
        )

    def _account_url(self) -> str:
        return f"https://{self.account_name}.blob.core.windows.net"

    def list_files(self, path: str) -> List[str]:
        """List files in an Azure blob container, bounded by the ceiling."""
        container, prefix = _parse_azure_path(path)

        files = []
        container_client = self.blob_service_client.get_container_client(container)

        blob_list = container_client.list_blobs(name_starts_with=prefix)
        for blob in blob_list:
            if blob.name.endswith('/'):  # Skip directory placeholders
                continue
            encoded_name = quote(blob.name, safe='/')
            files.append(f"azure://{container}/{encoded_name}")
            if len(files) >= self.max_listed_files:
                logger.warning(
                    "Stopped listing %s after %d blobs; narrow the prefix to "
                    "see the rest.", container, self.max_listed_files,
                )
                break

        return files
    
    def get_file_info(self, file_path: str) -> Dict[str, Any]:
        """Get Azure blob information."""
        container, blob_name = _parse_azure_path(file_path, require_blob=True)
        
        try:
            blob_client = self.blob_service_client.get_blob_client(
                container=container, 
                blob=blob_name
            )
            properties = blob_client.get_blob_properties()
            
            return {
                'path': file_path,
                'size': properties.size,
                'modified': properties.last_modified.timestamp(),
                'is_file': True,
                'etag': properties.etag,
                'content_type': properties.content_settings.content_type
            }
        except Exception as e:
            return {
                'path': file_path,
                'error': str(e),
                'is_file': False
            }
    
    def download_file(self, source_path: str, local_path: str) -> str:
        """Download Azure blob to local path."""
        container, blob_name = _parse_azure_path(source_path, require_blob=True)
        _ensure_parent_directory(local_path)
        
        blob_client = self.blob_service_client.get_blob_client(
            container=container,
            blob=blob_name
        )
        
        with open(local_path, 'wb') as download_file:
            blob_client.download_blob().readinto(download_file)
        
        return local_path


class StorageFactory:
    """Factory for creating storage handlers."""
    
    @staticmethod
    def create_handler(path: str, **kwargs) -> StorageHandler:
        """Create appropriate storage handler based on path."""
        parsed = urlparse(path)
        scheme = parsed.scheme.lower()
        hostname = (parsed.hostname or '').lower()

        if scheme == 's3':
            return S3StorageHandler(
                aws_access_key_id=kwargs.get('aws_access_key_id'),
                aws_secret_access_key=kwargs.get('aws_secret_access_key'),
                region_name=kwargs.get('region_name', 'us-east-1')
            )
        elif scheme == 'azure' or (
            scheme == 'https' and hostname.endswith('.blob.core.windows.net')
        ):
            return AzureStorageHandler(
                account_name=kwargs.get('azure_account_name'),
                account_key=kwargs.get('azure_account_key'),
                connection_string=kwargs.get('azure_connection_string'),
                sas_token=kwargs.get('azure_sas_token'),
                auth_mode=kwargs.get('azure_auth_mode'),
                credential=kwargs.get('azure_credential'),
                connection=kwargs.get('azure_connection'),
            )
        else:
            return LocalStorageHandler()

    @staticmethod
    def is_remote(path: str) -> bool:
        """Return whether *path* names a supported remote storage object."""
        parsed = urlparse(path)
        hostname = (parsed.hostname or '').lower()
        return parsed.scheme.lower() in {'s3', 'azure'} or (
            parsed.scheme.lower() == 'https'
            and hostname.endswith('.blob.core.windows.net')
        )

    @staticmethod
    def cache_key(path: str) -> str:
        """Return a handler cache key that preserves remote account boundaries."""
        parsed = urlparse(path)
        if StorageFactory.is_remote(path):
            return f'{parsed.scheme.lower()}://{parsed.netloc.lower()}'
        return 'local'

    @staticmethod
    def basename(path: str) -> str:
        """Return the final path component for local or remote paths."""
        if StorageFactory.is_remote(path):
            return os.path.basename(unquote(urlparse(path).path.rstrip('/')))
        return os.path.basename(path)