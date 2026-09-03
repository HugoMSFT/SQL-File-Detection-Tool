# Azure Storage browser concept mockup

This directory contains a visual-only concept for adding Microsoft Entra sign-in,
Azure subscription discovery, Storage account search, and data-file browsing to
the editor-first SQL File Detection Tool experience.

The prototype uses local sample data only. It does not authenticate, make Azure
requests, retain credentials, load Azure SDKs, or change production extension
commands. Its Content Security Policy disables outbound connections.

## Preview

From the repository root, start any local static server. For example:

```bash
python3 -m http.server 4173
```

Then open:

```text
http://localhost:4173/design/azure-storage-browser-mockup/
```

You can also open `index.html` directly with a `file://` URL. The local server is
recommended because it matches how browser assets are normally served and keeps
the linked `../../media/webview/main.css` stylesheet easy to inspect.

Choose **Connect with Microsoft** to simulate sign-in. Try account and file
filters, browse containers and folders, select a data file, switch between
`adls://` and `abfss://` for an ADLS Gen2 account, and use the **UX state
preview** control to inspect loading, empty, access-denied, and retryable-error
states.

## Packaging

This mockup is excluded from production packaging. The repository's
`.vscodeignore` is a strict allowlist: everything is excluded first, and no
`design/` path is added back to the VSIX payload.
