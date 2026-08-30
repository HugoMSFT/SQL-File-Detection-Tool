# Analyze a data file

Three ways in, all local and all native:

- **Browse files** or **Browse folder** inside the view.
- **Current file** analyzes the file in the active editor.
- Right-click a file or folder in the Explorer and choose
  **Analyze with SQL File Detection Tool**.

| Format | What is read |
| --- | --- |
| CSV, TSV, delimited text | Delimiter, encoding, sampled schema, row count |
| JSON, JSONL, NDJSON | Bounded schema sample, nesting, row count |
| Parquet | Schema, row groups, compression, row count |
| Delta Lake, Apache Iceberg | Table metadata, current schema, partitioning |
| Excel (.xlsx) | Bounded worksheet sample |
| Text | Encoding and streamed line count |
| ORC, RCFile | Recognized; schema detection is **not** available natively |

Files are read in bounded chunks, so a large file is never loaded whole.
