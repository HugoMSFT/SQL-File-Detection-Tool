# Review the generated T-SQL

Each analyzed file gets its own tabs:

- **Preview** — real rows read from the file.
- **Metadata** — detected types, precision, nullability, encoding, collation.
- **CREATE TABLE**, **BULK INSERT**, **OPENROWSET**, **EXT TABLE** — generated
  scripts for the selected platform.

The **Target platform** selector defaults to **Azure SQL Database** and also
covers Azure SQL Managed Instance, SQL Server 2019/2022/2025 and Microsoft
Fabric SQL Database. Statements a platform does not support are returned as
explanatory comments with a practical alternative rather than being silently
omitted.

Column types can be overridden in the **Metadata** tab; the SQL regenerates as
you type.

Generated SQL is a starting point. Review types, credentials and paths before
running it against a database.
