/**
 * The webview document shell.
 *
 * The HTML is deliberately inert: a handful of empty landmark elements plus
 * `<template>` blocks the bundled script clones. All rendering happens in
 * `media/webview/main.js` using `textContent` and cloned templates, so no
 * host-side value is ever interpolated into markup and there is no path by
 * which analysed file content could become HTML.
 *
 * The policy the CSP encodes:
 *
 *   * `default-src 'none'` — nothing loads unless it is explicitly allowed.
 *   * scripts and styles only from the extension's own `cspSource`, and the
 *     script additionally requires the per-render nonce.
 *   * no `unsafe-inline`, no `unsafe-eval`, no remote origin, no `connect-src`,
 *     so the renderer cannot make a network request of its own even if a script
 *     injection were somehow achieved.
 *   * `font-src` is omitted, so VS Code's own font stack is used rather than a
 *     downloaded webfont.
 *
 * This module has no `vscode` import; the caller passes the already-resolved
 * webview URIs.
 */

import * as crypto from 'crypto';

/** A fresh, unguessable per-render nonce. */
export function createNonce(): string {
    return crypto.randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

export interface ShellOptions {
    readonly nonce: string;
    readonly cspSource: string;
    readonly scriptUri: string;
    readonly styleUri: string;
    readonly codiconUri?: string;
    /** `sidebar` is the narrow Activity Bar view; `panel` is the editor tab. */
    readonly surface: 'sidebar' | 'panel';
}

/** The Content-Security-Policy the webview runs under. */
export function contentSecurityPolicy(nonce: string, cspSource: string): string {
    return [
        "default-src 'none'",
        `img-src ${cspSource} data:`,
        `style-src ${cspSource}`,
        `font-src ${cspSource}`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ');
}

/**
 * Build the shell document.
 *
 * Only `nonce`, `cspSource` and the two extension-owned URIs are interpolated,
 * and all four are produced by the host rather than by any user input.
 */
export function buildWebviewHtml(options: ShellOptions): string {
    const { nonce, cspSource, scriptUri, styleUri, surface } = options;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(nonce, cspSource)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SQL File Detection Tool</title>
<link rel="stylesheet" href="${styleUri}">
</head>
<body class="surface-${surface}" data-surface="${surface}">
  <a class="skip-link" href="#main">Skip to content</a>

  <header class="app-header">
    <div class="title-row">
      <div class="title-copy">
        <h1 id="app-title">SQL File Detection Tool</h1>
        <p>Preview files &bull; Generate T-SQL &bull; Understand metadata</p>
      </div>
      <span class="version" id="app-version"></span>
    </div>
    <div class="toolbar" role="toolbar" aria-label="Sources and file actions">
      <span class="toolbar-title">Sources &amp; files</span>
      <button type="button" class="btn primary" data-action="openFileDialog">Browse files</button>
      <button type="button" class="btn" data-action="openFolderDialog">Browse folder</button>
      <button type="button" class="btn" data-source-tab="azure">HTTPS / Azure</button>
      <button type="button" class="btn" data-action="analyzeCurrentFile">Current file</button>
      <button type="button" class="btn" data-action="exportAllSql">Export all SQL</button>
      <button type="button" class="btn panel-only" data-action="openInEditor">Open in editor</button>
    </div>
    <div class="option-row">
      <label class="field">
        <span>Target platform</span>
        <select id="platform" aria-describedby="platform-help"></select>
      </label>
      <p id="platform-help" class="help">Azure SQL Database is the default target.</p>
      <label class="field">
        <span>Appearance</span>
        <select id="appearance">
          <option value="auto">Match VS Code</option>
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
      </label>
    </div>
  </header>

  <div class="status-region">
    <p id="progress" class="progress" role="status" aria-live="polite"></p>
    <p id="error" class="error" role="alert"></p>
    <p id="notice" class="notice" role="status" aria-live="polite"></p>
    <button type="button" class="btn subtle" id="cancel" data-action="cancel" hidden>Cancel</button>
    <button type="button" class="btn subtle" id="dismiss" data-action="dismissNotice" hidden>Dismiss</button>
  </div>

  <div class="layout">
    <nav class="file-pane" aria-labelledby="file-pane-title">
      <div class="explorer-heading">
        <h2 id="file-pane-title">Explorer</h2>
        <p class="source" id="source-label"></p>
      </div>
      <ul class="file-list" id="file-list" role="tree" aria-labelledby="file-pane-title" tabindex="0"></ul>
      <p class="empty" id="file-empty">Open a SQL-readable file or folder to begin.</p>
    </nav>

    <main class="content" id="main" tabindex="-1">
      <div class="tabs" role="tablist" aria-label="Result sections" id="tablist"></div>
      <section class="panel" id="panel" role="tabpanel" tabindex="0" aria-labelledby="tablist"></section>
    </main>
  </div>

  <!-- Templates. The script clones these; it never builds markup from strings. -->
  <template id="tpl-file-item">
    <li class="file-item" role="treeitem">
      <span class="file-icon" aria-hidden="true"></span>
      <span class="file-name"></span>
      <span class="file-meta"></span>
    </li>
  </template>

  <template id="tpl-tab">
    <button type="button" class="tab" role="tab"></button>
  </template>

  <template id="tpl-kv">
    <div class="kv"><dt></dt><dd></dd></div>
  </template>

  <template id="tpl-sql">
    <div class="sql-block">
      <div class="sql-actions">
        <button type="button" class="btn" data-sql-action="copy">Copy</button>
        <button type="button" class="btn" data-sql-action="open">Open in editor</button>
      </div>
      <pre class="sql" tabindex="0"><code></code></pre>
    </div>
  </template>

  <template id="tpl-limitation">
    <aside class="limitation" role="note">
      <h3></h3>
      <p class="limitation-detail"></p>
      <p class="limitation-workaround"></p>
      <button type="button" class="btn subtle" data-action="showOrcGuidance">Explain this limitation</button>
    </aside>
  </template>

  <template id="tpl-schema-row">
    <tr>
      <th scope="row" class="col-name"></th>
      <td class="col-detected"></td>
      <td class="col-override"><input type="text" class="override-input" spellcheck="false" autocomplete="off"></td>
    </tr>
  </template>

  <template id="tpl-azure">
    <div class="azure">
      <div class="azure-auth">
        <h3>Connect</h3>
        <p class="azure-identity"></p>
        <div class="azure-buttons">
          <button type="button" class="btn primary" data-azure-connect="vscode">Microsoft account</button>
          <button type="button" class="btn" data-azure-connect="sas">SAS URL</button>
          <button type="button" class="btn" data-azure-connect="connectionString">Connection string</button>
          <button type="button" class="btn" data-azure-connect="anonymous">Public (anonymous)</button>
          <button type="button" class="btn subtle" data-action="azureDisconnect">Disconnect</button>
        </div>
        <p class="azure-note">Managed identity applies to server-side deployments of the optional command line package, not to this desktop extension.</p>
      </div>
      <div class="azure-browse">
        <label class="field">
          <span>Subscription</span>
          <select class="azure-subscriptions"></select>
        </label>
        <label class="field">
          <span>Storage account</span>
          <select class="azure-accounts"></select>
        </label>
        <label class="field">
          <span>Container</span>
          <select class="azure-containers"></select>
        </label>
        <label class="field">
          <span>Prefix</span>
          <input type="text" class="azure-prefix" spellcheck="false" autocomplete="off">
        </label>
        <ul class="azure-blobs" aria-label="Blobs"></ul>
        <button type="button" class="btn subtle azure-more" hidden>Load more</button>
        <p class="azure-error" role="alert"></p>
      </div>
      <div class="public-url">
        <h3>Public dataset or HTTPS URL</h3>
        <label class="field">
          <span>URL</span>
          <input type="url" class="public-url-input" spellcheck="false" autocomplete="off" placeholder="https://…">
        </label>
        <button type="button" class="btn" data-action="publicUrlAnalyze">Analyze URL</button>
        <p class="help">Only https:// URLs that resolve to a public address are fetched. Redirects are re-checked on every hop.</p>
      </div>
    </div>
  </template>

<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
