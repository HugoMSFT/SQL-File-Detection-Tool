# Attach Azure Storage

The **Azure & URLs** tab offers four explicit sign-in modes, with no silent
fallback between them:

| Mode | What it uses |
| --- | --- |
| Microsoft account | A delegated token from VS Code's Microsoft authentication provider |
| SAS URL | The SAS you paste, for one account or container |
| Connection string | An account key or SAS embedded in a connection string |
| Public (anonymous) | No credential at all |

Remembering a credential in VS Code `SecretStorage` is opt-in and off by
default. Disconnecting clears it from memory and deletes the stored copy. No
credential ever reaches the webview: the renderer only sees names and sizes.

**Public dataset or HTTPS URL** analyzes any `https://` data file that resolves
to a public address. Redirects are re-checked on every hop, so a URL cannot be
used to reach a private network.
