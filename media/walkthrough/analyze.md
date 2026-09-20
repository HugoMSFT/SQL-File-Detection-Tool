# Analyze a data file

Choose a local source in either of these ways:

- **Browse local** inside the view, then choose one folder or one or more files.
- Right-click a file or folder in the Explorer and choose
  **Analyze with SQL File Detection Tool**.

Choosing a folder checks it and one child level. Selecting any
listed source analyzes it immediately and opens Preview.

| Format | What is read |
| --- | --- |
| CSV, TSV, DAT, delimited text | Delimiter, encoding, sampled schema, row count |
| JSON, JSONL, NDJSON | Bounded schema sample, nesting, row count |
| Parquet | Schema, row groups, compression, row count |
| Delta Lake | Table metadata, current schema, partitioning |
| Apache Hudi | Underlying Parquet data files; Hudi metadata is not interpreted |
| Text | Encoding and streamed line count |
| ORC, RCFile | Recognized; schema detection is **not** available natively |

Unsupported files, including Python, Word, and Excel, are filtered before they
are opened. Supported files are read in bounded chunks.
