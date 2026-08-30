-- ====================================================================
-- PREREQUISITE SETUP  (SQL Server 2025)
-- Run these ONCE before using CREATE EXTERNAL TABLE or OPENROWSET
-- with a DATA_SOURCE reference.
-- ====================================================================

-- 1. Master key: NOT required.
-- IDENTITY = 'MANAGED IDENTITY' stores no secret, so there is
-- nothing for a database master key to encrypt.
-- Certified live on Azure SQL Database: the database master
-- key count stayed 0 before, during and after the credential
-- existed, so no master key password has to be invented,
-- stored or rotated.

-- 2. Database Scoped Credential (managed identity)
-- PREFERRED: no secret, no SAS token, and no database master key.
-- Grant the server/instance managed identity the Storage Blob Data
-- Reader role on the storage account (Storage Blob Data Contributor
-- if the workload also writes). Certified live: creating this
-- credential left the database master key count at 0.
IF NOT EXISTS (SELECT 1 FROM sys.database_scoped_credentials WHERE name = N'cred_cert_src')
BEGIN
    CREATE DATABASE SCOPED CREDENTIAL [cred_cert_src]
    WITH
        IDENTITY = 'MANAGED IDENTITY';
END
GO

-- 3. External Data Source (data virtualization)
-- SQL Server 2022+ infers the connector from LOCATION.
-- Do not specify TYPE. Use abs:// for Azure Blob Storage,
-- adls:// for ADLS Gen2, or s3:// for S3-compatible storage.
IF NOT EXISTS (SELECT 1 FROM sys.external_data_sources WHERE name = N'cert_src')
BEGIN
    CREATE EXTERNAL DATA SOURCE [cert_src]
    WITH (
        LOCATION = 'abs://datasets@example.blob.core.windows.net',
        CREDENTIAL = [cred_cert_src]
    );
END
GO

-- 4. External Data Source for BULK INSERT / OPENROWSET(BULK)
-- Bulk access needs TYPE = BLOB_STORAGE with an https:// endpoint,
-- which cannot back an external table, so it gets its own name.
-- This source is also what makes SINGLE_CLOB / SINGLE_NCLOB usable:
-- certified live, the single-LOB options work through a
-- TYPE = BLOB_STORAGE source and are rejected only by abs:// / adls://.
-- Database Scoped Credential (managed identity)
-- PREFERRED: no secret, no SAS token, and no database master key.
-- Grant the server/instance managed identity the Storage Blob Data
-- Reader role on the storage account (Storage Blob Data Contributor
-- if the workload also writes). Certified live: creating this
-- credential left the database master key count at 0.
IF NOT EXISTS (SELECT 1 FROM sys.database_scoped_credentials WHERE name = N'cred_cert_src_Bulk')
BEGIN
    CREATE DATABASE SCOPED CREDENTIAL [cred_cert_src_Bulk]
    WITH
        IDENTITY = 'MANAGED IDENTITY';
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.external_data_sources WHERE name = N'cert_src_Bulk')
BEGIN
    CREATE EXTERNAL DATA SOURCE [cert_src_Bulk]
    WITH (
        TYPE = BLOB_STORAGE,
        LOCATION = 'https://example.blob.core.windows.net/datasets',
        CREDENTIAL = [cred_cert_src_Bulk]
    );
END
GO

-- CREATE EXTERNAL FILE FORMAT  (SQL Server 2025)
-- USE_TYPE_DEFAULT = FALSE keeps missing fields as NULL. TRUE would store 0 for numeric and '' for string columns, which cannot be told apart from real values.
IF NOT EXISTS (SELECT 1 FROM sys.external_file_formats WHERE name = N'ff_csv_format')
BEGIN
    CREATE EXTERNAL FILE FORMAT [ff_csv_format]
    WITH (
        FORMAT_TYPE = DELIMITEDTEXT,
        FORMAT_OPTIONS (
            FIELD_TERMINATOR = ',',
            STRING_DELIMITER = '"',
            USE_TYPE_DEFAULT = FALSE,
            ENCODING = 'UTF8',
            FIRST_ROW = 2
        )
    );
END

GO

-- ====================================================================
-- CREATE EXTERNAL TABLE  (SQL Server 2025)
-- Prereq: CREATE EXTERNAL DATA SOURCE and CREATE EXTERNAL FILE FORMAT
-- LOCATION is relative to the external data source:
--   abs://datasets@example.blob.core.windows.net
-- ====================================================================

IF OBJECT_ID(N'[cert_schema].[ext_cert_iris]', N'U') IS NULL
BEGIN
    CREATE EXTERNAL TABLE [cert_schema].[ext_cert_iris]
    (
        [sepal_length] FLOAT,
        [sepal_width] FLOAT,
        [petal_length] FLOAT,
        [petal_width] FLOAT,
        [species] NVARCHAR(255)
    )
    WITH
    (
        DATA_SOURCE = [cert_src],
        LOCATION = 'iris.csv',
        FILE_FORMAT = [ff_csv_format]
    );
END

GO

-- ====================================================================
-- CREATE TABLE
-- Source : iris.csv  (CSV)
-- Target : SQL Server 2025
-- ====================================================================

IF OBJECT_ID(N'[cert_schema].[cert_iris]', N'U') IS NULL
BEGIN
    CREATE TABLE [cert_schema].[cert_iris]
    (
        [sepal_length] FLOAT                  NOT NULL,
        [sepal_width] FLOAT                  NOT NULL,
        [petal_length] FLOAT                  NOT NULL,
        [petal_width] FLOAT                  NOT NULL,
        [species] NVARCHAR(255)          NOT NULL
    )
    ;
END

-- ====================================================================
-- QUICK LOAD
-- ====================================================================
-- SQL Server object storage uses an external data source whose
-- LOCATION starts with adls://, abs://, or s3:// (not https://).
-- Data source location: abs://datasets@example.blob.core.windows.net
-- INSERT INTO [cert_schema].[cert_iris]
-- SELECT *
-- FROM OPENROWSET(
--     BULK 'iris.csv',
--     DATA_SOURCE = 'cert_src',
--     FORMAT = 'CSV'
-- ) AS src;

GO

-- ====================================================================
-- RERUN SAFETY
-- ====================================================================
-- This document is safe to run more than once: every CREATE above is
-- guarded, and the load target is emptied here so a second run does
-- not insert the same rows twice.
-- WARNING: this empties [cert_schema].[cert_iris]. That table is meant to be
-- owned by this script. If a table of that name already holds data you
-- care about, change the target name before running (--table/--schema).
-- Delete this batch if you mean to append to existing data.
IF OBJECT_ID(N'[cert_schema].[cert_iris]', N'U') IS NOT NULL
    TRUNCATE TABLE [cert_schema].[cert_iris];
GO

-- ====================================================================
-- BULK INSERT
-- Source    : iris.csv
-- Encoding  : UTF-8  (codepage 65001)
-- Delimiter : comma  (",")
-- Target   : SQL Server 2025
-- Use for   : High-speed batch load into SQL Server 2025
-- Prereq    : A BLOB_STORAGE external data source is required; FROM is relative to its container
-- ====================================================================

-- Step 0: [cert_src_Bulk] (TYPE = BLOB_STORAGE, LOCATION
--         'https://example.blob.core.windows.net/datasets') is created in the
--         prerequisite setup section above.

-- Step 1: Create the target table (see CREATE TABLE tab)

-- Step 2: Load the data
BULK INSERT [cert_schema].[cert_iris]
FROM 'iris.csv'
WITH
(
    DATA_SOURCE     = 'cert_src_Bulk',
    FORMAT          = 'CSV',
    FIRSTROW        = 2,        -- skip the header row
    FIELDTERMINATOR = ',',
    ROWTERMINATOR   = '0x0a',        -- LF (use '0x0d0a' for CRLF)
    CODEPAGE        = '65001',  -- UTF-8
    TABLOCK,                            -- Minimally logged; remove if concurrent inserts needed
    MAXERRORS       = 0,               -- Fail on first error; increase for tolerant loads
    BATCHSIZE       = 50000            -- Tune per available memory
);

-- Verify row count
SELECT COUNT(*) AS loaded_rows FROM [cert_schema].[cert_iris];

GO

-- ====================================================================
-- OPENROWSET
-- Source  : iris.csv  (CSV)
-- Target  : SQL Server 2025
-- Use for : Ad-hoc / exploratory queries without creating a table
-- ====================================================================

-- SQL Server 2022+ reads external files from ABS, ADLS Gen2,
-- or S3-compatible object storage. The external data source
-- LOCATION must use abs://, adls://, or s3://, not https://.
-- BULK is relative to that data source.
-- Data source location: abs://datasets@example.blob.core.windows.net

-- ---- CSV with explicit schema ----------------------------------------
SELECT TOP (100) *
FROM OPENROWSET(
    BULK 'iris.csv',
    DATA_SOURCE     = 'cert_src',
    FORMAT          = 'CSV',
    FIRSTROW        = 2,        -- skip the header row
    FIELDTERMINATOR = ',',
    ROWTERMINATOR   = '0x0a',        -- LF (use '0x0d0a' for CRLF)
    CODEPAGE        = '65001'  -- UTF-8
) WITH (
    [sepal_length] FLOAT,
    [sepal_width] FLOAT,
    [petal_length] FLOAT,
    [petal_width] FLOAT,
    [species] NVARCHAR(255)
) AS [result];

-- ---- Whole file as one value (small files) ---------------------------
-- The single-LOB options need the TYPE = BLOB_STORAGE data source;
-- the abs:// / adls:// virtualization connectors reject them.
SELECT BulkColumn AS file_text
FROM OPENROWSET(
    BULK 'iris.csv',
    DATA_SOURCE     = 'cert_src_Bulk',
    SINGLE_CLOB
) AS [src];

GO

-- ====================================================================
-- FOR JSON PATH  — export SQL rows back to JSON
-- Target : SQL Server 2025
-- ====================================================================

-- 1. Basic array output (each row = one JSON object)
SELECT
    [sepal_length] AS [sepal_length],
    [sepal_width] AS [sepal_width],
    [petal_length] AS [petal_length],
    [petal_width] AS [petal_width],
    [species] AS [species]
FROM [cert_schema].[cert_iris]
FOR JSON PATH;

-- 2. Wrapped in a root element
SELECT
    [sepal_length] AS [sepal_length],
    [sepal_width] AS [sepal_width],
    [petal_length] AS [petal_length],
    [petal_width] AS [petal_width],
    [species] AS [species]
FROM [cert_schema].[cert_iris]
FOR JSON PATH, ROOT('cert_iris');

-- 3. Include NULL values in output (omitted by default)
SELECT
    [sepal_length] AS [sepal_length],
    [sepal_width] AS [sepal_width],
    [petal_length] AS [petal_length],
    [petal_width] AS [petal_width],
    [species] AS [species]
FROM [cert_schema].[cert_iris]
FOR JSON PATH, INCLUDE_NULL_VALUES;

-- 4. Single object (without array wrapper)
SELECT TOP 1
    [sepal_length] AS [sepal_length],
    [sepal_width] AS [sepal_width],
    [petal_length] AS [petal_length],
    [petal_width] AS [petal_width],
    [species] AS [species]
FROM [cert_schema].[cert_iris]
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;

-- 5. JSON_OBJECT / JSON_ARRAY  (SQL Server 2025)
SELECT
    JSON_OBJECT(
        'sepal_length': [sepal_length],
        'sepal_width': [sepal_width],
        'petal_length': [petal_length],
        'petal_width': [petal_width],
        'species': [species]
    ) AS json_row
FROM [cert_schema].[cert_iris];

GO

-- ====================================================================
-- BEST PRACTICES  —  iris.csv
-- Target   : SQL Server 2025
-- File type : CSV
-- File size : 0.0 MB
-- Row count : 150
-- Encoding  : UTF-8
-- ====================================================================

-- RECOMMENDED PATH
--   Best option   : BULK INSERT for load, then validate in SQL
--   Fastest path  : BULK INSERT for local or staged CSV/text files
--   Lowest cost   : OPENROWSET with projection/filtering
--   Staging       : For small files, direct load is fine, but keep a validation query ready

-- RECOMMENDED LOADING METHODS for SQL Server 2025:
--   1. BULK INSERT (high-speed batch loads)
--   2. OPENROWSET (ad-hoc / exploratory queries)
--   3. CREATE EXTERNAL TABLE (persistent virtual table)
--   4. FOR JSON PATH (export to JSON)

-- Detected: comma-delimited, encoding UTF-8

-- 1. TOOL SELECTION
--    < 1 GB   → BULK INSERT into SQL Server (fastest local load)
--    Any size → OPENROWSET over a local path or object storage data source
--    Repeated loads → CREATE EXTERNAL TABLE (avoid materialising data)

-- 2. ENCODING
--    Detected encoding : UTF-8
--    Always specify CODEPAGE to avoid silent data corruption.
--    UTF-8 → CODEPAGE = '65001'   |   UTF-16 → CODEPAGE = '1200'
--    Latin-1 / CP1252 → CODEPAGE = '1252'

-- 3. HEADER ROW
--    has_header = True → FIRSTROW = 2 (skip header)

-- 4. STAGING PATTERN (recommended)
--    a. Load raw data into a STAGING table (all columns NVARCHAR).
--    b. Validate / transform into the final typed table.
--    c. This avoids cryptic conversion errors on bad rows.

-- 5. PERFORMANCE
--    Split large files into 256 MB chunks before importing.
--    Pre-sort by the partition key when possible.

-- 6. ERROR HANDLING
--    Use MAXERRORS to log bad rows before aborting.
--    Pair with ERRORFILE to capture rejected rows for inspection.

-- 7. BULK INSERT TEMPLATE
--    BULK INSERT [dbo].[MyTable]
--    FROM 'C:\data\file.csv'
--    WITH (
--        FIRSTROW = 2,
--        FIELDTERMINATOR = ',',
--        CODEPAGE = '65001',
--        TABLOCK
--    );

-- VALIDATION SQL AFTER LOAD
-- 1. Row count
SELECT COUNT(*) AS loaded_rows FROM [cert_schema].[cert_iris];

-- 2. Sample rows
SELECT TOP 10 [sepal_length], [sepal_width], [petal_length] FROM [cert_schema].[cert_iris];

-- 3. Null distribution check
SELECT SUM(CASE WHEN [sepal_length] IS NULL THEN 1 ELSE 0 END) AS [sepal_length_nulls], SUM(CASE WHEN [sepal_width] IS NULL THEN 1 ELSE 0 END) AS [sepal_width_nulls], SUM(CASE WHEN [petal_length] IS NULL THEN 1 ELSE 0 END) AS [petal_length_nulls] FROM [cert_schema].[cert_iris];

GO

-- ====================================================================
-- COPY INTO
-- NOT AVAILABLE on SQL Server 2025
-- ====================================================================
-- Recommended alternatives:
-- 1. BULK INSERT for high-speed CSV/text ingestion (see BULK INSERT tab).
-- 2. OPENROWSET for ad-hoc reads and ELT patterns (see OPENROWSET tab).
--    Use SELECT INTO or INSERT INTO ... SELECT FROM OPENROWSET for loading.
-- 3. OPENJSON / JSON_VALUE for JSON ingestion (see JSON Functions tab).

GO
