# Set up external storage

The **Credential setup** tab offers two paths:

1. Paste a known Azure Blob, ADLS, OneLake, or `s3://` location to generate the
   external data source.
2. Sign in with a Microsoft Entra work or school account, choose a storage
   account and container, and fetch a supported file for analysis.

The tenant ID is optional. Subscription discovery is optional too: enter the
storage account directly when you already know its name. Tokens remain in the
extension host; query strings are removed from known URLs before SQL is generated.
