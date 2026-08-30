/**
 * Pure helpers for the Activity Bar sidebar webview.
 *
 * Kept free of any `vscode` import so the HTML construction, the message
 * allowlist and the auto-open policy can all be unit tested with plain
 * `node --test`.
 */

import * as crypto from 'crypto';

/**
 * The only messages the sidebar webview may send to the extension host.
 *
 * Anything outside this list is dropped without being dispatched, so a
 * compromised or malformed webview cannot invoke arbitrary commands.
 */
export const SIDEBAR_COMMANDS = [
    'open',
    'analyzeCurrentFile',
    'connectAzure',
    'stopBackend',
    'setupBackend',
    'retry',
] as const;

export type SidebarCommand = (typeof SIDEBAR_COMMANDS)[number];

/** Map a sidebar message id to the contributed command it is allowed to run. */
export const SIDEBAR_COMMAND_MAP: Record<SidebarCommand, string> = {
    open: 'sqlFileDetectionTool.open',
    analyzeCurrentFile: 'sqlFileDetectionTool.analyzeCurrentFile',
    connectAzure: 'sqlFileDetectionTool.connectAzureStorage',
    stopBackend: 'sqlFileDetectionTool.stopBackend',
    setupBackend: 'sqlFileDetectionTool.setupBackend',
    retry: 'sqlFileDetectionTool.open',
};

/**
 * Validate a message posted by the webview.
 *
 * Returns the command id when the message is well formed and allowlisted, and
 * `undefined` for everything else.
 */
export function parseSidebarMessage(message: unknown): SidebarCommand | undefined {
    if (!message || typeof message !== 'object') {
        return undefined;
    }
    const candidate = message as { type?: unknown; id?: unknown };
    if (candidate.type !== 'command' || typeof candidate.id !== 'string') {
        return undefined;
    }
    return (SIDEBAR_COMMANDS as readonly string[]).includes(candidate.id)
        ? (candidate.id as SidebarCommand)
        : undefined;
}

/** A fresh per-render CSP nonce. */
export function createNonce(): string {
    return crypto.randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

/** Escape text for interpolation into HTML element content or an attribute. */
export function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export type SidebarState = 'stopped' | 'starting' | 'running' | 'failed';

export interface SidebarModel {
    state: SidebarState;
    /** Short human-readable detail. Must never contain a secret. */
    detail: string;
    version: string;
    platformLabel: string;
}

const STATE_LABELS: Record<SidebarState, string> = {
    stopped: 'Backend stopped',
    starting: 'Starting backend\u2026',
    running: 'Backend running',
    failed: 'Backend failed to start',
};

/**
 * How long after the window opened an *initial* view resolve is still treated
 * as VS Code restoring the previous layout rather than a deliberate click.
 *
 * The clock runs from extension-host start, but the host has to bootstrap, load
 * modules and activate other extensions before it resolves this view, so a
 * restore can legitimately land several seconds in. The window is therefore
 * generous on purpose: missing a very early click costs one press of the
 * visible **Open Tool** button, whereas a false positive spawns a Python
 * process and takes an editor tab the user never asked for.
 */
export const STARTUP_GRACE_MS = 15_000;

export interface AutoOpenInput {
    /** `sqlFileDetectionTool.openOnActivityBarClick`. */
    enabled: boolean;
    /** Whether the contributed view is actually visible. */
    visible: boolean;
    /** Milliseconds since the extension host started. */
    msSinceActivation: number;
    /**
     * True when the view became visible *after* it had already been resolved.
     *
     * Only the very first resolve is ambiguous between "VS Code restored the
     * container" and "the user clicked the icon". Every later hidden-to-visible
     * transition can only come from a user action, so it skips the grace check
     * entirely and a click is never swallowed.
     */
    userDriven?: boolean;
    /**
     * Whether the VS Code window currently has focus. A layout restore happens
     * while the window is still coming up, so an unfocused window is further
     * evidence that a reveal was not a click. Omitted means "unknown", which is
     * treated as focused so the check can never block a real click on its own.
     */
    windowFocused?: boolean;
}

/**
 * Decide whether revealing the sidebar should open the full tool.
 *
 * A reveal that happens as the window comes up is VS Code restoring the
 * last-used container, not a user asking for the tool, so it must not launch a
 * backend or steal an editor tab.
 */
export function shouldAutoOpen(input: AutoOpenInput): boolean {
    if (!input.enabled || !input.visible) {
        return false;
    }
    if (input.userDriven) {
        return true;
    }
    if (input.windowFocused === false) {
        return false;
    }
    return input.msSinceActivation >= STARTUP_GRACE_MS;
}

interface ButtonSpec {
    id: SidebarCommand;
    label: string;
    aria: string;
    primary?: boolean;
}

const BUTTONS: ButtonSpec[] = [
    {
        id: 'open',
        label: 'Open Tool',
        aria: 'Open the SQL File Detection Tool interface',
        primary: true,
    },
    {
        id: 'analyzeCurrentFile',
        label: 'Analyze Current File',
        aria: 'Analyze the file in the active editor',
    },
    {
        id: 'connectAzure',
        label: 'Connect Azure Storage',
        aria: 'Sign in to Azure Storage',
    },
    {
        id: 'stopBackend',
        label: 'Stop Backend',
        aria: 'Stop the local analysis backend',
    },
];

/**
 * Build the sidebar HTML.
 *
 * The document carries a restrictive CSP, a per-render nonce on the only style
 * and script blocks, and no token, URL or credential of any kind.
 */
export function buildSidebarHtml(
    model: SidebarModel,
    nonce: string,
    cspSource: string,
): string {
    const failed = model.state === 'failed';
    const busy = model.state === 'starting';
    const buttons = BUTTONS.map((button) => {
        const disabled =
            busy || (button.id === 'stopBackend' && model.state !== 'running');
        return `      <button class="action${button.primary ? ' primary' : ''}"
              data-id="${escapeHtml(button.id)}"
              aria-label="${escapeHtml(button.aria)}"
              title="${escapeHtml(button.aria)}"${disabled ? ' disabled' : ''}>
        ${escapeHtml(button.label)}
      </button>`;
    }).join('\n');

    const retry = failed
        ? `    <button class="action retry" data-id="retry"
            aria-label="Retry starting the backend"
            title="Retry starting the backend">Retry</button>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SQL File Detection Tool</title>
<style nonce="${nonce}">
  body {
    margin: 0;
    padding: 12px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
    background: transparent;
  }
  h1 { font-size: 13px; font-weight: 600; margin: 0 0 2px; }
  .version { font-size: 11px; opacity: 0.75; margin: 0 0 10px; }
  .status {
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; margin-bottom: 4px;
  }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--vscode-descriptionForeground);
    flex: 0 0 auto;
  }
  .running .dot { background: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
  .starting .dot { background: var(--vscode-charts-yellow, var(--vscode-descriptionForeground)); }
  .failed .dot { background: var(--vscode-testing-iconFailed, var(--vscode-errorForeground)); }
  .detail {
    font-size: 11px; opacity: 0.85; margin: 0 0 10px;
    word-break: break-word;
  }
  .failed .detail { color: var(--vscode-errorForeground); opacity: 1; }
  .actions { display: flex; flex-direction: column; gap: 6px; }
  button.action {
    width: 100%;
    padding: 5px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    text-align: center;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  button.action.primary {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  button.action:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  button.action.primary:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }
  button.action:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }
  button.action:disabled { opacity: 0.5; cursor: default; }
  .hint {
    font-size: 11px; opacity: 0.75; margin-top: 12px;
    border-top: 1px solid var(--vscode-sideBar-border, transparent);
    padding-top: 8px;
  }
</style>
</head>
<body class="${escapeHtml(model.state)}">
  <h1>SQL File Detection Tool</h1>
  <p class="version">Version ${escapeHtml(model.version)} &middot; ${escapeHtml(model.platformLabel)}</p>
  <div class="status" role="status" aria-live="polite">
    <span class="dot" aria-hidden="true"></span>
    <span>${escapeHtml(STATE_LABELS[model.state])}</span>
  </div>
  <p class="detail">${escapeHtml(model.detail)}</p>
  <div class="actions">
${buttons}
${retry}
  </div>
  <p class="hint">The full interface opens in an editor tab. Selecting this icon again focuses it.</p>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  for (const button of document.querySelectorAll('button.action')) {
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'command', id: button.dataset.id });
    });
  }
</script>
</body>
</html>`;
}
