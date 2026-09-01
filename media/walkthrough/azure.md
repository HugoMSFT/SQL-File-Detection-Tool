# Set up external storage

Paste an `abs://`, `adls://`, or `abfss://` location in **Credential setup**.
The extension detects the storage service from the URL and generates the
compatible connector, credential, and external data source for the selected SQL
platform. Azure HTTPS and `s3://` locations remain supported.

Query strings and fragments are removed before SQL is generated. Secret values
remain placeholders.
