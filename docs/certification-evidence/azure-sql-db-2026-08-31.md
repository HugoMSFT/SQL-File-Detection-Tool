# Certification evidence — azure (azure_sql_db)

* run id: `ad1ade11`
* engine: Microsoft SQL Azure (RTM) - 12.0.2000.8 Aug 19 2026 12:09:01 Copyright (C) 2026 Microsoft Corporation
* cleanup verified: **True** (residue: 0)

| verdict | count |
| --- | ---: |
| PASS | 29 |
| FAIL | 0 |
| EXEC_AFTER_SUBSTITUTION | 0 |
| NOT_EXECUTABLE | 6 |
| UNSUPPORTED_EXPECTED | 0 |
| BLOCKED | 1 |
| DRY_RUN_ACCEPTED | 0 |

**36/36 cells accepted, 0 defect(s).**

| cell | hypothesis | fixture | statement | access | verdict | accepted |
| --- | --- | --- | --- | --- | --- | --- |
| C01 | H1 | csv_scalar | create_table | none | PASS | yes |
| C02 | H2 | utf8_bom | bulk_insert | blob_storage | PASS | yes |
| C03 | H2 | utf16le_bom | bulk_insert | blob_storage | PASS | yes |
| C04 | H2 | cp932 | bulk_insert | blob_storage | PASS | yes |
| C05 | H2 | utf16le_bom | external_file_format | abs | PASS | yes |
| C06 | H2 | cp932 | external_file_format | abs | PASS | yes |
| C07 | H3 | json_array | json_functions | engine_local | NOT_EXECUTABLE | yes |
| C08 | H3 | json_array | openrowset | blob_storage | PASS | yes |
| C09 | H3 | ndjson | openrowset | abs | PASS | yes |
| C10 | H3 | json_array | openrowset | abs | PASS | yes |
| C11 | H3 | json_nested | json_functions | engine_local | NOT_EXECUTABLE | yes |
| C12 | H3 | json_object | for_json | none | PASS | yes |
| C13 | H6 | csv_scalar | openrowset | abs | PASS | yes |
| C14 | H6 | csv_scalar | bulk_insert | blob_storage | PASS | yes |
| C16 | H_FIRSTROW | csv_scalar | external_file_format | abs | PASS | yes |
| C17 | H_FIRSTROW | csv_scalar | create_external_table | abs | PASS | yes |
| C18 | H10 | parquet_all_types | create_external_table | abs | NOT_EXECUTABLE | yes |
| C19 | H10 | parquet_all_types | create_table | none | PASS | yes |
| C20 | H5 | csv_scalar | external_file_format | abs | PASS | yes |
| C21 | H4 | excel | external_file_format | abs | NOT_EXECUTABLE | yes |
| C22 | H4 | iceberg | external_file_format | abs | NOT_EXECUTABLE | yes |
| C32 | H4 | json_array | external_file_format | abs | NOT_EXECUTABLE | yes |
| C24 | H4 | text | create_table | none | PASS | yes |
| C25 | H10 | delta | openrowset | abs | PASS | yes |
| C26 | H8 | csv_scalar | credential_setup | abs | PASS | yes |
| C27 | H8 | csv_scalar | credential_setup | abs | PASS | yes |
| C28 | H7 | csv_scalar | complete_ddl | abs | PASS | yes |
| C29 | H7 | csv_scalar | complete_ddl | abs | PASS | yes |
| C30 | H1 | csv_scalar | create_table | none | BLOCKED | yes |
| C31 | H9 | csv_scalar | external_file_format | none | PASS | yes |
| C33 | H10 | parquet_sales | create_external_table | abs | PASS | yes |
| C34 | H6 | tsv | openrowset | abs | PASS | yes |
| C35 | H6 | pipe | openrowset | abs | PASS | yes |
| C36 | H2 | utf8 | bulk_insert | blob_storage | PASS | yes |
| C37 | H2 | collation | openrowset | abs | PASS | yes |
| C38 | H2 | utf16le_bom_tsv | bulk_insert | blob_storage | PASS | yes |

## Cleanup

63/63 cleanup statements succeeded.
