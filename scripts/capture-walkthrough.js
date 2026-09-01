/**
 * Regenerate the README walkthrough GIF from the *current* native webview.
 *
 * This is developer tooling, not part of the extension and not part of the
 * package. It exists because the previous GIF was captured from the Flask web
 * UI that version 2.0 removed, and a screenshot of a UI that no longer exists
 * is worse than no screenshot at all.
 *
 * How it works, and why:
 *
 * 1. The UI states are produced by the *real* controller. `out/` is activated
 *    against the same mock `vscode` the tests use, real demo files are
 *    analysed, and the `UiState` snapshots the host posts to the renderer are
 *    captured verbatim. Nothing in the frames is mocked-up product copy: the
 *    column types, the row counts and the generated T-SQL are what the shipped
 *    engine actually produces for those files.
 *
 * 2. Those states are replayed into the *real* renderer. The page loads the
 *    shipped `media/webview/main.css` and `media/webview/main.js` and the shell
 *    markup from `buildWebviewHtml`, with `acquireVsCodeApi` shimmed. The
 *    surrounding VS Code chrome (title bar, Activity Bar, the click) is drawn
 *    by this script, because driving the real VS Code window is not something
 *    a headless capture can do reliably. Every pixel inside the panel is the
 *    product; every pixel outside it is a frame around the product.
 *
 * 3. Frames are screenshotted through an already-installed Chromium (Edge) via
 *    `playwright-core`, then quantised and encoded to a GIF with `gifenc`. No
 *    browser download and no ffmpeg.
 *
 * Storage setup uses non-secret ABS, ADLS, and ABFSS example locations. Paths
 * shown are repo-relative demo files.
 *
 * Usage: `npm run capture:gif` (requires the optional devDependencies
 * `playwright-core`, `pngjs` and `gifenc`, and an installed Edge or Chrome).
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'out');
const MEDIA = path.join(REPO, 'media');
const TARGET = path.join(MEDIA, 'sql-file-detection-tool-walkthrough.gif');

const WIDTH = 960;
const HEIGHT = 540;

/** Chromium builds this script is willing to reuse. */
const BROWSERS = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

function findBrowser() {
    for (const candidate of BROWSERS) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error('No installed Edge or Chrome found to capture with.');
}

/**
 * Run the real extension against the mock `vscode` and collect the UI states it
 * posts. Returns the states in the order the renderer would have received them.
 */
async function collectStates() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createMockVscode } = require(path.join(OUT, 'test', 'mocks', 'vscode.js'));
    const mock = createMockVscode();

    const Module = require('node:module');
    const load = Module._load;
    Module._load = function patched(request, parent, isMain) {
        return request === 'vscode' ? mock.module : load.call(this, request, parent, isMain);
    };

    const captured = {};
    try {
        const extension = require(path.join(OUT, 'extension.js'));
        extension.activate(mock.state.context);
        const provider = mock.state.views.get('sqlFileDetectionTool.sidebar');
        const view = mock.state.makeView();
        await provider.resolveWebviewView(view, {}, { isCancellationRequested: false });

        const analyzeSelected = mock.state.commands.get('sqlFileDetectionTool.analyzeSelected');
        const settle = async (budgetMs) => {
            const deadline = Date.now() + budgetMs;
            const seen = view.webview.posted.length;
            while (Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 25));
                if (view.webview.posted.length > seen) {
                    break;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
        };

        // Beat 1: the shell as it renders on the first Activity Bar click.
        await settle(1000);
        captured.shell = latestState(view.webview.posted);

        // Beat 2+: a real analysis of a committed demo fixture, then each tab
        // selected the way the renderer selects it, so the statements in the
        // frames are the statements the shipped generator produces.
        const samples = path.join(REPO, 'data sample');
        const sample = path.join(samples, 'parquet', 'sales.parquet');
        if (!fs.existsSync(sample)) {
            throw new Error(`Missing demo fixture: ${sample}`);
        }
        await analyzeSelected(mock.module.Uri.file(samples));
        await settle(8000);
        const folderState = latestState(view.webview.posted);
        const sampleEntry = folderState.files.find(
            (entry) => entry.label === 'sales.parquet' && entry.folderLabel === 'parquet',
        );
        if (!sampleEntry) {
            throw new Error('The demo folder did not expose parquet/sales.parquet.');
        }
        await view.receive({ type: 'selectFile', fileId: sampleEntry.id });
        await settle(8000);

        for (const tab of [
            'preview',
            'metadata',
            'schema',
            'credential_setup',
            'create_table',
            'openrowset',
        ]) {
            await view.receive({ type: 'setTab', tab });
            await settle(4000);
            captured[tab] = latestState(view.webview.posted);
        }
        await view.receive({ type: 'setTab', tab: 'credential_setup' });
        await settle(1000);
        await view.receive({
            type: 'setStorageUrl',
            value: 'abs://datasets@contosodemo.blob.core.windows.net/sales.parquet',
        });
        await settle(4000);
        captured.known_url = latestState(view.webview.posted);

        extension.deactivate();
    } finally {
        Module._load = load;
    }

    for (const [name, state] of Object.entries(captured)) {
        if (!state) {
            throw new Error(`The controller produced no state for ${name}.`);
        }
    }
    return captured;
}

function latestState(posted) {
    for (let index = posted.length - 1; index >= 0; index -= 1) {
        if (posted[index] && posted[index].state) {
            return JSON.parse(JSON.stringify(posted[index].state));
        }
    }
    return null;
}

/** Derive the scene list: which state, and how long to hold it. */
function buildScenes(states) {
    const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
    const clone = (state, extra) =>
        Object.assign(JSON.parse(JSON.stringify(state)), { version }, extra || {});

    return [
        { caption: 'activity-bar', state: clone(states.shell), hold: 1200, panel: false },
        { caption: 'preview', state: clone(states.preview), hold: 2200, panel: true },
        {
            caption: 'credential-setup',
            state: clone(states.credential_setup),
            hold: 2400,
            panel: true,
        },
        { caption: 'known-url', state: clone(states.known_url), hold: 2400, panel: true },
        {
            caption: 'create-table',
            state: clone(states.create_table),
            hold: 2400,
            panel: true,
            scroll: 180,
        },
        {
            caption: 'openrowset',
            state: clone(states.openrowset),
            hold: 2200,
            panel: true,
            scroll: 180,
        },
    ];
}

/** VS Code Dark+ and Light+ values for the variables the stylesheet reads. */
const THEMES = {
    dark: {
        chrome: '#1f1f1f',
        chromeBorder: '#2b2b2b',
        activityBar: '#181818',
        activityFg: '#d7d7d7',
        vars: {
            'font-family': "'Segoe UI', system-ui, sans-serif",
            'font-size': '13px',
            foreground: '#cccccc',
            descriptionForeground: '#9d9d9d',
            errorForeground: '#f48771',
            focusBorder: '#0078d4',
            contrastBorder: 'transparent',
            'panel-border': '#2b2b2b',
            'editor-background': '#1f1f1f',
            'editor-font-family': "'Cascadia Mono', Consolas, monospace",
            'editor-font-size': '12px',
            'button-background': '#0078d4',
            'button-foreground': '#ffffff',
            'button-border': 'transparent',
            'button-hoverBackground': '#026ec1',
            'button-secondaryBackground': '#313131',
            'button-secondaryForeground': '#cccccc',
            'button-secondaryHoverBackground': '#3c3c3c',
            'input-background': '#313131',
            'input-foreground': '#cccccc',
            'input-border': '#3c3c3c',
            'inputValidation-warningBackground': '#352a05',
            'list-activeSelectionBackground': '#04395e',
            'list-activeSelectionForeground': '#ffffff',
            'list-hoverBackground': '#2a2d2e',
            'textCodeBlock-background': '#181818',
            'textLink-foreground': '#4daafc',
            'charts-yellow': '#d7ba7d',
            'editorWarning-foreground': '#cca700',
            'notificationsInfoIcon-foreground': '#3794ff',
        },
    },
    light: {
        chrome: '#ffffff',
        chromeBorder: '#e5e5e5',
        activityBar: '#f8f8f8',
        activityFg: '#3b3b3b',
        vars: {
            'font-family': "'Segoe UI', system-ui, sans-serif",
            'font-size': '13px',
            foreground: '#3b3b3b',
            descriptionForeground: '#666666',
            errorForeground: '#a1260d',
            focusBorder: '#005fb8',
            contrastBorder: 'transparent',
            'panel-border': '#e5e5e5',
            'editor-background': '#ffffff',
            'editor-font-family': "'Cascadia Mono', Consolas, monospace",
            'editor-font-size': '12px',
            'button-background': '#005fb8',
            'button-foreground': '#ffffff',
            'button-border': 'transparent',
            'button-hoverBackground': '#0258a8',
            'button-secondaryBackground': '#e5e5e5',
            'button-secondaryForeground': '#3b3b3b',
            'button-secondaryHoverBackground': '#cccccc',
            'input-background': '#ffffff',
            'input-foreground': '#3b3b3b',
            'input-border': '#cecece',
            'inputValidation-warningBackground': '#fdf6d4',
            'list-activeSelectionBackground': '#0060c0',
            'list-activeSelectionForeground': '#ffffff',
            'list-hoverBackground': '#f2f2f2',
            'textCodeBlock-background': '#f3f3f3',
            'textLink-foreground': '#005fb8',
            'charts-yellow': '#b5900f',
            'editorWarning-foreground': '#bf8803',
            'notificationsInfoIcon-foreground': '#1a85ff',
        },
    },
};

function themeCss(name) {
    const theme = THEMES[name];
    const vars = Object.entries(theme.vars)
        .map(([key, value]) => `  --vscode-${key}: ${value};`)
        .join('\n');
    return `:root {\n${vars}\n}\nbody { background: ${theme.vars['editor-background']}; }`;
}

/**
 * The capture page: composed VS Code chrome with the real webview inside it.
 *
 * The shell's `Content-Security-Policy` meta tag is dropped here because the
 * page is loaded from `file://`, where `'self'` cannot authorise the stylesheet
 * or the script. The policy itself is asserted in `src/test/native/` and in
 * `bundleRuntime.test.ts`; this page is only responsible for pixels.
 */
function buildPage(shellHtml, activityIcon) {
    const body = shellHtml
        .replace(/^[\s\S]*?<body([^>]*)>/, '<div id="webview-root"$1>')
        .replace(/<\/body>[\s\S]*$/, '</div>');
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="./main.css">
<style id="theme"></style>
<style>
  html, body { margin: 0; padding: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  body { font-family: var(--vscode-font-family); }
  #chrome { display: flex; flex-direction: column; width: ${WIDTH}px; height: ${HEIGHT}px; }
  #titlebar { height: 34px; flex: 0 0 34px; display: flex; align-items: center;
    justify-content: center; font-size: 12px; color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--chrome-border); background: var(--chrome-bg); }
  #dots { position: absolute; left: 12px; display: flex; gap: 6px; }
  #dots i { width: 10px; height: 10px; border-radius: 50%; display: block; }
  #body { flex: 1; display: flex; min-height: 0; }
  #activitybar { width: 48px; flex: 0 0 48px; background: var(--activity-bg);
    border-right: 1px solid var(--chrome-border); display: flex; flex-direction: column;
    align-items: center; padding-top: 8px; gap: 10px; }
  .act { width: 48px; height: 40px; display: flex; align-items: center; justify-content: center;
    opacity: .55; position: relative; }
  .act svg, .act img { width: 22px; height: 22px; }
  .act.active { opacity: 1; }
  .act.active::before { content: ''; position: absolute; left: 0; top: 6px; bottom: 6px;
    width: 2px; background: var(--vscode-foreground); }
  #stage { flex: 1; min-width: 0; display: flex; }
  #webview-root { flex: 1; min-width: 0; overflow: hidden;
    background: var(--vscode-editor-background); color: var(--vscode-foreground); }
  #placeholder { flex: 1; display: flex; align-items: center; justify-content: center;
    color: var(--vscode-descriptionForeground); font-size: 13px;
    background: var(--vscode-editor-background); }
  #cursor { position: fixed; width: 18px; height: 18px; pointer-events: none; z-index: 99;
    transform: translate(-2px, -2px); display: none; }
  #cursor svg { filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); }
  #ripple { position: fixed; width: 34px; height: 34px; border-radius: 50%; z-index: 98;
    border: 2px solid var(--vscode-focusBorder); opacity: 0; pointer-events: none;
    transform: translate(-50%, -50%); }
  #caption { position: fixed; left: 0; right: 0; bottom: 0; padding: 6px 12px; font-size: 12px;
    background: var(--chrome-bg); border-top: 1px solid var(--chrome-border);
    color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div id="chrome">
  <div id="titlebar"><div id="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div><span id="title">sales.parquet — SQL File Detection Tool</span></div>
  <div id="body">
    <div id="activitybar">
      <div class="act" id="act-files">${FILES_ICON}</div>
      <div class="act" id="act-search">${SEARCH_ICON}</div>
      <div class="act" id="act-tool">${activityIcon}</div>
    </div>
    <div id="stage">
      <div id="placeholder">Select the SQL File Detection Tool icon</div>
      ${body}
    </div>
  </div>
  <div id="caption"></div>
</div>
<div id="cursor">${CURSOR_ICON}</div>
<div id="ripple"></div>
<script src="./main-shim.js"></script>
<script src="./main.js"></script>
</body></html>`;
}

const FILES_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4h6l2 2h8v12H4z"/></svg>';
const SEARCH_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/></svg>';
const CURSOR_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 3l14 8-6 1.4L10.5 19z" fill="#ffffff" stroke="#1f1f1f" stroke-width="1.2" stroke-linejoin="round"/></svg>';

/** The shim the renderer expects instead of the real VS Code webview API. */
const SHIM = `
window.__posted = [];
window.acquireVsCodeApi = function () {
    var stored = {};
    return {
        postMessage: function (message) { window.__posted.push(message); },
        getState: function () { return stored; },
        setState: function (value) { stored = value; },
    };
};
window.__apply = function (state) {
    window.postMessage({ type: 'state', state: state }, '*');
};
`;

async function main() {
    const { chromium } = require('playwright-core');
    const { PNG } = require('pngjs');
    const { GIFEncoder, quantize, applyPalette } = require('gifenc');

    const states = await collectStates();
    const scenes = buildScenes(states);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildWebviewHtml } = require(path.join(OUT, 'ui', 'webviewShell.js'));
    const shellHtml = buildWebviewHtml({
        nonce: 'capture',
        cspSource: 'self',
        scriptUri: './main.js',
        styleUri: './main.css',
        surface: 'panel',
    });

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sfdt-gif-'));
    fs.copyFileSync(path.join(MEDIA, 'webview', 'main.css'), path.join(work, 'main.css'));
    fs.copyFileSync(path.join(MEDIA, 'webview', 'main.js'), path.join(work, 'main.js'));
    fs.writeFileSync(path.join(work, 'main-shim.js'), SHIM);
    const activityIcon = fs.readFileSync(path.join(MEDIA, 'activity-bar.svg'), 'utf8');
    fs.writeFileSync(path.join(work, 'index.html'), buildPage(shellHtml, activityIcon));

    const browser = await chromium.launch({ executablePath: findBrowser() });
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    await page.goto(`file://${path.join(work, 'index.html').replace(/\\/g, '/')}`);

    await page.evaluate((state) => window.__apply(state), states.shell);
    await page.waitForTimeout(80);
    const startState = await page.evaluate(() => ({
        message: document.querySelector('.start-state .empty')?.textContent?.trim(),
        hasPreviewRows: Boolean(document.querySelector('[data-edit="previewRows"]')),
    }));
    if (
        startState.message !== 'Select a file, folder, or URL to begin.'
        || startState.hasPreviewRows
    ) {
        await browser.close();
        fs.rmSync(work, { recursive: true, force: true });
        throw new Error('The empty Preview did not render the source-selection start state.');
    }

    // A delayed schema edit must not survive a file change or post back for the
    // newly selected file.
    await page.evaluate((state) => {
        window.__posted = [];
        window.__apply(state);
    }, states.schema);
    await page.waitForTimeout(80);
    await page.evaluate(() => {
        const input = document.querySelector('[data-edit="override"]');
        input.value = 'DECIMAL(18,4)';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(
        (state) => window.__apply(Object.assign({}, state, {
            selectedFileId: state.selectedFileId + '-next',
        })),
        states.schema,
    );
    await page.waitForTimeout(300);
    const staleEditCleared = await page.evaluate(() => {
        const input = document.querySelector('[data-edit="override"]');
        return Boolean(
            input
            && input.value !== 'DECIMAL(18,4)'
            && !window.__posted.some((message) => message.type === 'setColumnOverride'),
        );
    });
    if (!staleEditCleared) {
        await browser.close();
        fs.rmSync(work, { recursive: true, force: true });
        throw new Error('A pending SQL type edit survived a file selection change.');
    }

    // The credential form is rebuilt after every host snapshot. Prove the
    // focused field and caret survive that replacement before recording.
    await page.evaluate((state) => window.__apply(state), states.credential_setup);
    await page.waitForTimeout(80);
    await page.evaluate(() => {
        const input = document.querySelector('[data-edit="credentialName"]');
        input.value = 'credential_name';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        input.setSelectionRange(2, 2);
    });
    await page.evaluate(
        (state) => window.__apply(Object.assign({}, state, { notice: 'focus check' })),
        states.credential_setup,
    );
    await page.waitForTimeout(80);
    const focusRestored = await page.evaluate(() => {
        const active = document.activeElement;
        return Boolean(
            active
            && active.dataset.edit === 'credentialName'
            && active.selectionStart === 2
            && active.selectionEnd === 2,
        );
    });
    if (!focusRestored) {
        await browser.close();
        fs.rmSync(work, { recursive: true, force: true });
        throw new Error('Credential input focus or caret was lost after a state refresh.');
    }

    // Exercise every connector prefix accepted by the URL-only storage setup.
    await page.evaluate((state) => {
        window.__posted = [];
        window.__apply(state);
    }, states.credential_setup);
    await page.waitForTimeout(80);
    const storageUrls = [
        'abs://datasets@contosodemo.blob.core.windows.net/sales.parquet',
        'adls://datasets@contosodemo.dfs.core.windows.net/sales.parquet',
        'abfss://workspace@onelake.dfs.fabric.microsoft.com/lakehouse/Files/sales.parquet',
    ];
    const urlMessages = await page.evaluate((urls) => {
        urls.forEach((url) => {
            const input = document.querySelector('.storage-url-input');
            input.value = url;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('[data-action="useStorageUrl"]').click();
        });
        return window.__posted.slice();
    }, storageUrls);
    if (
        urlMessages.length !== storageUrls.length
        || urlMessages.some((message, index) =>
            message.type !== 'setStorageUrl' || message.value !== storageUrls[index])
    ) {
        await browser.close();
        fs.rmSync(work, { recursive: true, force: true });
        throw new Error('ABS, ADLS, or ABFSS URL submission is not wired.');
    }
    const signInRemoved = await page.evaluate(() => {
        const text = document.body.textContent || '';
        return (
            !text.includes('Sign in with Microsoft Entra')
            && !text.includes('Browse Microsoft storage')
            && !document.querySelector('[data-azure-connect], .azure-tenant, .storage-browser')
        );
    });
    if (!signInRemoved) {
        await browser.close();
        fs.rmSync(work, { recursive: true, force: true });
        throw new Error('Microsoft storage sign-in remains in Credential Setup.');
    }

    const frames = [];
    const frameDir = process.env.SFDT_FRAME_DIR;
    if (frameDir) {
        fs.mkdirSync(frameDir, { recursive: true });
    }
    const shoot = async (delayMs) => {
        const buffer = await page.screenshot({ type: 'png' });
        if (frameDir) {
            fs.writeFileSync(
                path.join(frameDir, `frame-${String(frames.length).padStart(2, '0')}.png`),
                buffer,
            );
        }
        frames.push({ png: PNG.sync.read(buffer), delayMs });
    };

    for (const scene of scenes) {
        await page.evaluate(
            ([css, showPanel, state, caption, theme]) => {
                document.getElementById('theme').textContent = css;
                document.documentElement.style.setProperty(
                    '--chrome-bg',
                    theme === 'light' ? '#ffffff' : '#1f1f1f',
                );
                document.documentElement.style.setProperty(
                    '--chrome-border',
                    theme === 'light' ? '#e5e5e5' : '#2b2b2b',
                );
                document.documentElement.style.setProperty(
                    '--activity-bg',
                    theme === 'light' ? '#f8f8f8' : '#181818',
                );
                window.scrollTo(0, 0);
                for (const id of ['webview-root', 'panel']) {
                    const element = document.getElementById(id);
                    if (element) {
                        element.scrollTop = 0;
                    }
                }
                document.getElementById('act-tool').classList.toggle('active', showPanel);
                document.getElementById('placeholder').style.display = showPanel ? 'none' : 'flex';
                document.getElementById('webview-root').style.display = showPanel ? '' : 'none';
                document.getElementById('caption').textContent = caption;
                if (showPanel) {
                    window.__apply(state);
                }
            },
            [
                themeCss(scene.theme || 'dark'),
                scene.panel,
                scene.state,
                CAPTIONS[scene.caption],
                scene.theme || 'dark',
            ],
        );
        await page.waitForTimeout(120);
        if (scene.scroll) {
            await page.evaluate((offset) => {
                const root = document.getElementById('webview-root');
                const panel = document.getElementById('panel');
                for (const element of [panel, root]) {
                    if (element && element.scrollHeight > element.clientHeight) {
                        element.scrollTop = offset;
                        return;
                    }
                }
                if (root) {
                    root.scrollTop = offset;
                }
            }, scene.scroll);
            await page.waitForTimeout(60);
        }

        if (scene.caption === 'activity-bar') {
            // Move a cursor to the Activity Bar icon and click it, so the GIF
            // opens on the gesture a new user has to discover.
            await page.evaluate(() => {
                const cursor = document.getElementById('cursor');
                cursor.style.display = 'block';
                cursor.style.left = '420px';
                cursor.style.top = '380px';
            });
            const path2 = [
                [420, 380],
                [300, 300],
                [170, 210],
                [60, 150],
                [26, 124],
            ];
            for (const [x, y] of path2) {
                await page.evaluate(
                    ([left, top]) => {
                        const cursor = document.getElementById('cursor');
                        cursor.style.left = `${left}px`;
                        cursor.style.top = `${top}px`;
                    },
                    [x, y],
                );
                await page.waitForTimeout(40);
                await shoot(160);
            }
            await page.evaluate(() => {
                const ripple = document.getElementById('ripple');
                ripple.style.left = '30px';
                ripple.style.top = '128px';
                ripple.style.opacity = '1';
            });
            await shoot(320);
            await page.evaluate(() => {
                document.getElementById('ripple').style.opacity = '0';
                document.getElementById('cursor').style.display = 'none';
            });
            continue;
        }

        await shoot(scene.hold);
    }

    await browser.close();
    fs.rmSync(work, { recursive: true, force: true });

    // Encode. One shared palette keeps the file small; the frames are flat UI
    // colours, so a 256-entry palette is visually lossless here.
    const encoder = GIFEncoder();
    const sample = frames[Math.floor(frames.length / 2)].png.data;
    const palette = quantize(sample, 256, { format: 'rgb565' });
    for (const frame of frames) {
        const indexed = applyPalette(frame.png.data, palette, 'rgb565');
        encoder.writeFrame(indexed, WIDTH, HEIGHT, {
            palette,
            delay: frame.delayMs,
        });
    }
    encoder.finish();
    fs.writeFileSync(TARGET, Buffer.from(encoder.bytes()));

    const totalMs = frames.reduce((sum, frame) => sum + frame.delayMs, 0);
    const bytes = fs.statSync(TARGET).size;
    // eslint-disable-next-line no-console
    console.log(
        `wrote ${path.relative(REPO, TARGET)}: ${WIDTH}x${HEIGHT}, ${frames.length} frames, ` +
            `${(totalMs / 1000).toFixed(1)}s, ${(bytes / 1024 / 1024).toFixed(2)} MB`,
    );
    if (bytes > 5 * 1024 * 1024) {
        throw new Error('The GIF exceeds the 5 MB hard limit.');
    }
}

const CAPTIONS = {
    'activity-bar': 'Open SQL File Detection Tool',
    preview: 'Select a file and preview its rows',
    'credential-setup': 'Paste the storage URL',
    'known-url': 'Detect ABS, ADLS, or ABFSS from the URL',
    'create-table': 'Generate CREATE TABLE',
    openrowset: 'Generate OPENROWSET and EXT TABLE',
};

main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
});
