"""SQL File Detection Tool - detect data files and generate SQL DDL.

The importable package is still called ``external_file_detection`` so existing
scripts keep working; the product, distribution and CLI are named
"SQL File Detection Tool" / ``sql-file-detection-tool``.
"""

__version__ = "1.2.0"

#: Display name used in page titles, CLI help, log messages and docs.
__product_name__ = "SQL File Detection Tool"

#: Console-script name of the primary CLI.
__cli_name__ = "sql-file-detection-tool"

from .file_detector import FileDetector
from .sql_generator import DEFAULT_TARGET_PLATFORM, SQLGenerator
from .external_file_detector import ExternalFileDetectorApp
from .storage_handlers import StorageHandler, StorageFactory

#: Product-named alias for the application class. The original name is kept
#: for backward compatibility.
SQLFileDetectionApp = ExternalFileDetectorApp

__all__ = [
    "DEFAULT_TARGET_PLATFORM",
    "FileDetector",
    "SQLGenerator",
    "ExternalFileDetectorApp",
    "SQLFileDetectionApp",
    "StorageHandler",
    "StorageFactory",
    "__product_name__",
    "__cli_name__",
    "__version__",
]
