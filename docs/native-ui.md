# The native VS Code interface

This document describes what happens between the moment a user clicks the
Activity Bar icon and the moment T-SQL appears on screen, and the trust
boundaries that make that safe. It is the companion to
[`docs/native-core.md`](native-core.md), which covers the analysis and SQL
generation engine underneath.

The short version: the extension is a single Node process. There is no virtual
environment, no `pip`, no Flask server, no TCP port, no Simple Browser and no
child process. Everything the user sees is a VS Code webview backed by
TypeScript running in the extension host.

## Module map

| Module | `vscode` import? | Responsibility |
| --- | --- | --- |
| `src/extension.ts` | yes | Activation. Registers seven commands and one `WebviewViewProvider`. Nothing else. |
| `src/nativeView.ts` | yes | The only other module that touches the VS Code API. Implements `UiHost` and `AuthEnvironment` and owns the sidebar and panel surfaces. |
| `src/ui/controller.ts` | no | All product logic. Receives untrusted messages, drives the native service, mutates the shared store. |
| `src/ui/host.ts` | no | The `UiHost` / `AzureBridge` seam. Everything the controller needs from the editor, expressed as an interface. |
| `src/ui/webviewShell.ts` | no | Builds the HTML shell, the CSP and the nonce. |
| `src/appState.ts` | no | The shared model, the file registry and the containment roots. |
| `src/protocol.ts` | no | The message contract and the single validation choke point. |
| `src/azure/*` | no | Storage URL parsing, blob browsing, connection and auth state. |
| `src/net/*` | no | The SSRF-hardened HTTPS client and the public dataset workflow. |
| `src/native/*` | no | Layer 1: analysis and SQL generation. |

Keeping `vscode` confined to two files is what makes the rest of the extension
testable with plain `node --test`, and it is what lets
`src/test/nativeRuntime.test.ts` walk the compiled module graph and assert that
nothing reachable from activation can spawn a process or bind a port.

## Startup

```mermaid
sequenceDiagram
    participant U as User
    participant C as VS Code
    participant E as Extension host
    participant W as Webview
    U->>C: Click the Activity Bar icon
    C->>E: onView:sqlFileDetectionTool.sidebar
    E->>E: activate() — register commands + provider
    C->>E: resolveWebviewView()
    E->>W: HTML shell (bundled CSS + JS, nonce, CSP)
    W->>E: { type: 'ready' }
    E->>W: { type: 'state', state: <frozen snapshot> }
```

Nothing in that sequence reads a file, resolves a host name or opens a socket.
Measured on the reference machine, activation is under 1 ms, the first render is
under 1 ms, and the first analysis of a small CSV is roughly 20 ms end to end
including the round trip. Those numbers are asserted, not just documented:
`src/test/nativeRuntime.test.ts` fails if activation exceeds 500 ms or first
render exceeds 1.5 s, and the output channel records all three timings so a slow
machine can be diagnosed from a bug report.

## Quick Analyze

Quick Analyze is the initial tab and the primary workflow. The left navigator
persists across tabs and keeps file, folder/workspace, public HTTPS, and Azure
Storage entry points together. The main view combines the selected file's
analyzed facts, bounded real preview rows, common parser options, source
readiness, and one selected production-generator statement. Metadata, Schema,
all statement details, Azure/URLs, Formats, copy/open, and export remain
available; there is no wizard or second expert mode.

Parser values carry explicit provenance: `Detected` for content evidence,
`Inferred` for sample/heuristic conclusions, `Assumed` for an unobserved safe
default, `Mapped` for a file fact translated to target SQL, `From source` for
path/auth-derived values, `Platform default`, `Unavailable`, `Unsupported`,
`Mixed`, and `Overridden`. Manual parser changes are optional
`parser_overrides`; reset removes the property entirely. Consequently a request
with no overrides enters the same certified generator with the same metadata and
retains byte-compatible output. In particular, overriding `CODEPAGE` does not
rewrite the analyzed file encoding.

Folder scans retain one metadata record per file. Their summary computes
consensus only for display and reports `Mixed` plus outliers where facts differ.
Generation and schema overrides remain selected-file scoped.

For Azure blobs, the source card derives a container-level base and a relative
blob path and suggests sanitized credential, data source, and file-format names.
Anonymous access marks the credential as not required. Local files never produce
readiness for fabricated cloud objects: SQL Server targets show direct
local/UNC-read requirements, while cloud targets show explicit staging.
PolyBase installation guidance appears only when SQL Server 2019 or 2022
external-table generation selects a construct that requires it. The guidance
distinguishes installing **PolyBase Query Service for External Data** in SQL
Server Setup from enabling the already-installed feature with
`sp_configure 'polybase enabled'`.

Generated-statement headers and relevant external-object readiness entries show
platform-aware Microsoft Learn links. The renderer receives only typed
documentation identifiers, never URLs. The extension host maps those identifiers
and the current platform to an exact `https://learn.microsoft.com` page and opens
it with `vscode.env.openExternal`. Unsupported command/platform combinations do
not receive a command link. SQL Server documentation is pinned to the 2019,
2022, or 2025 view; Azure SQL Database, Managed Instance, and Fabric use their
current product views.

## The message boundary

A webview is a browser context. Treat it as hostile: an XSS in a rendering bug,
a malicious file name, or a compromised dependency could all end up posting
messages. The extension therefore assumes every message is attacker-controlled.

**One entry point.** `parseWebviewRequest()` in `src/protocol.ts` is the only
way a message becomes a typed request. It:

- rejects anything that is not a plain object with a known `type`;
- looks the type up in a builder table rather than dispatching on the string, so
  an inherited or prototype-polluted property cannot select a handler;
- reads every field through `text()`, `member()` or `count()` helpers that bound
  length, reject control characters, and clamp numbers;
- returns `undefined` for anything it does not fully understand, which the
  controller logs and drops. There is no default case and no partial acceptance.

`UiController.handle()` never throws. A renderer must not be able to take down
the extension host by posting something unexpected, so every failure becomes a
redacted `error` field on the next state snapshot.

**The renderer never names a file.** This is the single most important property
of the design. The webview cannot send a path, a root, a URL for a local file,
or a directory to scan. It can only send an opaque `fileId` that the extension
host minted with `crypto.randomUUID()` when it registered the file. Each
registry entry carries its own `allowedRoot`, and every native call passes both
`filePath` and `allowedRoot` so the Layer 1 realpath containment check applies.
An id from a previous selection is simply not found, so a stale or forged id
fails closed.

Files enter the registry through paths the *user* chose: an open dialog, a
workspace folder pick, the active editor, or an explorer context menu — all
resolved in `src/nativeView.ts` with the real `vscode.Uri`.

**State flows one way.** The host owns an `AppStateStore`. After any change it
pushes a whole frozen snapshot to every attached surface. The sidebar and the
editor panel are two views of one store, so they cannot diverge, and a surface
that reconnects gets the current truth rather than a replayed diff.

**Display labels, not paths.** `metadataForDisplay()` replaces `file_path` with
a workspace-relative label before the metadata reaches a renderer. The real path
stays host-side in `UiController.rawMetadata`, because `BULK INSERT` genuinely
needs it. A test scans every snapshot in the controller suite for absolute paths.

## Content Security Policy

The shell is built by `buildWebviewHtml()` with a per-load nonce:

```
default-src 'none';
img-src {cspSource} data:;
style-src {cspSource} 'nonce-{nonce}';
script-src 'nonce-{nonce}';
font-src {cspSource};
```

- `default-src 'none'` with no `connect-src` means the renderer has **no network
  access at all**. It cannot fetch, it cannot open a WebSocket, and it cannot be
  used as an SSRF pivot.
- There is exactly one `<script>`, it carries the nonce, and it is a local
  bundled file. No CDN, no inline handler, no `eval`, no `new Function`.
- The renderer builds DOM with `textContent` and `<template>` cloning. It never
  assigns `innerHTML` from data.

`src/test/webviewShell.test.ts` enforces all of this statically: it strips
comments from `media/webview/main.js` and then fails the build on `innerHTML`,
`eval`, `fetch`, `XMLHttpRequest`, `localStorage`, `document.write`, inline
`on*=` attributes in the HTML, any second script tag, or any remote resource
reference.

## Azure Storage: authentication and threat model

Four authentication modes are offered, and one deliberately is not.

| Mode | Credential | Where it lives | Notes |
| --- | --- | --- | --- |
| `vscode` (recommended) | Microsoft account token from `authentication.getSession` | VS Code's own secret store; the token is held in extension-host memory only | Refreshed before expiry. Enables subscription and account discovery via ARM. |
| `sas` | SAS URL | Extension-host memory, or `SecretStorage` on explicit opt-in | The signature is split from the URL immediately and never rejoined for display. |
| `connectionString` | Account key | `showInputBox({ password: true })` → extension-host memory, or `SecretStorage` on explicit opt-in | Endpoint pinned from the string; a mismatched endpoint is refused. |
| `anonymous` | none | — | Public containers only. |

**Managed identity is not offered.** A desktop extension has no managed
identity; pretending otherwise would be security theatre. It remains a
deployment concern for the optional Python CLI and web application, and is
documented as such.

The threat model:

- **A credential never reaches the renderer.** Not in a state snapshot, not in a
  blob URL, not in an error. `AzureState` carries `identity` (an email address
  or the literal string `SAS token`) and `account`, and nothing else that could
  be a secret. A controller test walks every snapshot the Azure suites produce
  and fails on anything matching a key, a signature or a JWT.
- **A credential never reaches a log, a setting, a URL, a child process
  argument, or generated SQL.** `redactAzure()` scrubs bearer tokens, raw JWTs,
  `AccountKey=`/`SharedAccessSignature=` pairs and SAS query parameters from
  every string bound for the output channel or a message.
- **Remembering is opt-in.** The default answer to "remember this?" is no.
  Nothing is written to `SecretStorage` unless the user explicitly says yes.
- **Disconnect means disconnect.** `disconnect()` clears in-memory state *and*
  deletes any remembered secret. So does `deactivate()`, and so does the
  discovery that a VS Code session has disappeared.
- **`blobUrl()` is never signed.** It builds a display/analysis URL from account,
  container and blob only. Signing happens inside the request path.

Container, blob and prefix names are validated against the Azure naming rules
*before* any request is made, so a hostile name cannot be smuggled into a URL
path and reinterpreted.

## Public data and SSRF

`src/net/safeHttp.ts` implements a deliberately paranoid HTTPS client for the
"analyse a public dataset URL" workflow. It is stricter than the Python
`public_data.py` it replaces.

1. **HTTPS only.** No `http:`, no `file:`, no `data:`, no anything else.
2. **No credentials in the URL.** `user:password@` is rejected outright.
3. **No local names.** `localhost`, `*.local`, `*.internal`, and the cloud
   metadata host names are rejected before resolution.
4. **Default port only.** A non-443 port is refused, so the client cannot be
   driven as a port scanner against a publicly routable host.
5. **Every resolved address is classified.** `src/net/ipGuard.ts` rejects
   loopback, private, link-local, carrier-grade NAT, unique-local, multicast and
   reserved ranges, including IPv4-mapped and NAT64 forms. Leading-zero octets
   are rejected outright rather than guessed at, because `0177.0.0.1` is
   loopback to some resolvers and not to others.
6. **The guard is installed as the socket's DNS `lookup`.** This is the part
   that matters. Validating a host name and then handing the name to
   `https.request` leaves a DNS-rebinding window; validating inside the lookup
   callback means the address the socket actually connects to is the address
   that was checked.
7. **Every redirect hop is revalidated** from scratch, with a hop cap.
8. **Size is capped twice**: once against `Content-Length` if declared, and again
   while streaming, so a lying header cannot exhaust memory.
9. **Timeouts** apply to connection and to the whole response.
10. **Filenames are sanitised.** `safeFileName()` strips separators, traversal
   segments, control characters, and Windows reserved device names before
   anything is written into the bounded extension temp directory.
11. **The Learn catalog is an allowlist**, not a prefix match.
12. **A pasted signature never survives.** `storageUrlFor()` strips the query
    string and fragment, so if a user pastes a SAS-signed blob URL the `sig=`
    value cannot reach the state envelope, the output channel, or the T-SQL
    people save and commit. Signed access belongs in a
    `DATABASE SCOPED CREDENTIAL`.

Generic public hosts are analysed after a bounded download, but the generated
SQL says plainly that the data must be staged, because a SQL target cannot query
an arbitrary HTTPS URL. Azure Blob URLs keep their storage semantics.

None of this is tested against the live network. `src/test/net/*` inject a fake
resolver and a fake transport, which is what lets the suite cover rebinding,
lying `Content-Length`, redirect chains and metadata endpoints deterministically.

## Cancellation and stale results

Analysis is serialised through `createSerialQueue()`, so two concurrent requests
keep their own arguments and their own results rather than one being satisfied
by the other. On top of that:

- `begin()` bumps a monotonic `generation`, cancels the previous
  `CancellationTokenSource`, and aborts the previous `AbortController`.
- Every `await` is followed by `isCurrent(generation)`; a superseded task drops
  its result instead of writing it. A slow analysis of file A can therefore never
  overwrite a fast analysis of file B.
- The token reaches all the way down: into the native service, into the HTTPS
  client (as an `AbortSignal` on the request *and* a per-chunk check), and into
  blob downloads.
- Schema and SQL regeneration is debounced, so typing in the table name field
  does not start work on every keystroke.

## Limitations the UI states rather than hides

- **ORC.** The native reader cannot inspect ORC. The UI says
  *"The native extension cannot inspect ORC yet"*, explains why (a compressed
  footer and stripe layout the bundled reader does not implement), and offers a
  manual workaround: if you have separately installed the optional Python
  command line package, run it yourself. **The extension never installs or
  launches Python on your behalf**, and there is no code path that could.
- **RCFile** is recognition-only.
- **Virtual and remote schemes.** The native reader needs a real filesystem
  path. For a non-`file:` URI the extension says so and suggests saving a local
  copy, rather than silently doing nothing.

## The optional Python package

The Python CLI and Flask web application still exist and still work. They are
now **optional legacy compatibility**, not part of the extension runtime:

- No contributed command, view, menu or activation event reaches them.
- `src/backend.ts`, `src/pythonEnv.ts`, `src/process.ts` and
  `src/legacyBackendUrl.ts` remain as deprecated transition code, unreferenced
  by the native path. Layer 3 removes them along with the packaging changes.
- `src/legacyBackendUrl.ts` exists specifically so that port binding, loopback
  URL construction and health polling live in a module the native graph does not
  import — which `src/test/nativeRuntime.test.ts` verifies.
