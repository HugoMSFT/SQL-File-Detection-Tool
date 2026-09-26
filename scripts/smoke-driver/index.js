'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vscode = require('vscode');

function activate(context) {
    const root = fs.realpathSync(process.env.SQLFDT_SMOKE_ROOT);
    assert.ok(fs.existsSync(path.join(root, '.sqlfdt-owned')), 'Missing isolated-run marker');
    const mailbox = path.join(root, 'mailbox');
    const extension = vscode.extensions.getExtension('hvbqueiroz.sql-file-detection');
    assert.ok(extension, 'The packaged extension is not installed');
    assert.equal(extension.isActive, false, 'The driver must install its guards before activation');
    const installedPath = fs.realpathSync(extension.extensionPath);
    assert.ok(installedPath.startsWith(fs.realpathSync(path.join(root, 'extensions')) + path.sep));
    const bundle = fs.realpathSync(path.join(installedPath, extension.packageJSON.main));
    const bundleHash = crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex');
    assert.equal(bundleHash, process.env.SQLFDT_SMOKE_BUNDLE_SHA, 'Installed bytes differ from the VSIX');

    const attempts = [];
    const errors = [];
    let snapshot = null;
    let inFlight = 0;
    let snapshots = 0;
    let provisionalSnapshots = 0;
    const deny = (name) => () => {
        attempts.push(name);
        throw new Error(`Installed smoke forbids ${name}; no real sign-in or network is tested`);
    };
    const observe = (state) => {
        snapshots++;
        if (state.busy && state.metadata?.analysis_stage === 'provisional' && state.preview) {
            provisionalSnapshots++;
        }
        snapshot = {
            busy: state.busy, error: state.error, notice: state.notice,
            activeTab: state.activeTab, selectedFileId: state.selectedFileId,
            tableName: state.tableName, schemaName: state.schemaName,
            platform: state.platform, previewRows: state.previewRows,
            columnOverrides: state.columnOverrides, parserOverrides: state.parserOverrides,
            fileFilter: state.fileFilter, previewCount: state.preview?.rows?.length,
            analysisStage: state.metadata?.analysis_stage ?? null,
            metadataRows: state.metadata?.row_count,
            previewTotalRows: state.preview?.total_rows,
            azureOpen: state.azure?.open,
        };
    };
    const webviews = new WeakMap();
    const wrapSurface = (surface) => {
        if (webviews.has(surface)) {
            return webviews.get(surface);
        }
        const webview = surface.webview;
        const wrappedWebview = new Proxy(webview, {
            get(target, key) {
                if (key === 'postMessage') {
                    return (message) => {
                        if (message?.type === 'state') {
                            observe(message.state);
                        }
                        return target.postMessage(message);
                    };
                }
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
            set(target, key, value) { return Reflect.set(target, key, value, target); },
        });
        const wrapped = new Proxy(surface, {
            get(target, key) {
                if (key === 'webview') { return wrappedWebview; }
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
        webviews.set(surface, wrapped);
        return wrapped;
    };
    const originalLoad = Module._load;
    const adapt = (api, replacements) => Object.create(Object.getPrototypeOf(api), {
        ...Object.getOwnPropertyDescriptors(api),
        ...Object.fromEntries(Object.entries(replacements).map(([key, value]) =>
            [key, { value, enumerable: true, configurable: true }])),
    });
    const network = {
        http: ['get', 'request'], https: ['get', 'request'],
        net: ['connect', 'createConnection', 'createServer'],
        tls: ['connect', 'createServer'], dns: ['lookup', 'resolve'],
        child_process: ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
    };
    // Only the installed bundle's imports are adapted. VS Code, its filesystem,
    // the analyzer, renderer, commands and all posted state remain real.
    Module._load = function load(request, parent, isMain) {
        const api = originalLoad.call(this, request, parent, isMain);
        if (parent?.filename !== bundle) { return api; }
        if (request === 'vscode') {
            return adapt(api, {
                authentication: adapt(api.authentication, { getSession: deny('authentication.getSession') }),
                window: adapt(api.window, {
                    createWebviewPanel: (...args) => wrapSurface(api.window.createWebviewPanel(...args)),
                    registerWebviewViewProvider: (id, provider, options) =>
                        api.window.registerWebviewViewProvider(id, {
                            resolveWebviewView: (view, ...args) =>
                                provider.resolveWebviewView(wrapSurface(view), ...args),
                        }, options),
                }),
            });
        }
        const name = request.replace(/^node:/, '');
        if (network[name]) {
            return Object.assign({}, api, Object.fromEntries(
                network[name].map((method) => [method, deny(`${name}.${method}`)]),
            ));
        }
        return api;
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (...args) => {
        if (new Error().stack?.includes(bundle)) {
            return deny('fetch')();
        }
        return originalFetch(...args);
    };

    const probe = () => ({
        installed: true, active: extension.isActive,
        version: extension.packageJSON.version, bundleSha256: bundleHash,
        attempts, errors, snapshot, snapshots, provisionalSnapshots, inFlight,
        vscodeVersion: vscode.version,
        defaultView: vscode.workspace.getConfiguration('sqlFileDetectionTool').get('defaultView'),
        activeSqlDocument: Boolean(vscode.window.activeTextEditor?.document.isUntitled &&
            vscode.window.activeTextEditor.document.languageId === 'sql'),
        documents: vscode.workspace.textDocuments
            .filter((document) => document.isUntitled && document.languageId === 'sql')
            .map((document) => document.getText()),
    });
    const analyze = (sample) => {
        assert.ok(['samples', 'stress', 'large.csv', 'sample.csv', 'sample.json', 'sample-utf16.json'].includes(sample));
        const relative = ['samples', 'stress', 'large.csv'].includes(sample)
            ? sample : path.join('samples', sample);
        inFlight++;
        const pending = vscode.commands.executeCommand(
            'sqlFileDetectionTool.analyzeSelected',
            vscode.Uri.file(path.join(root, 'workspace', relative)),
        );
        pending.then(() => { inFlight--; }, () => {
            inFlight--;
            errors.push('Analyze command rejected');
        });
    };
    async function execute(request) {
        switch (request.action) {
            case 'activate':
                await extension.activate();
                await vscode.commands.executeCommand('sqlFileDetectionTool.open');
                break;
            case 'probe': break;
            case 'analyze': analyze(request.sample); break;
            case 'sidebar':
                await vscode.workspace.getConfiguration('sqlFileDetectionTool')
                    .update('defaultView', 'sidebar', vscode.ConfigurationTarget.Global);
                await vscode.commands.executeCommand('workbench.action.closeAllEditors');
                await vscode.commands.executeCommand('sqlFileDetectionTool.open');
                break;
            case 'hideSidebar':
                await vscode.commands.executeCommand('workbench.view.explorer');
                break;
            case 'editor':
                await vscode.commands.executeCommand('sqlFileDetectionTool.openInEditor');
                break;
            case 'closeSqlDocument':
                assert.ok(vscode.window.activeTextEditor?.document.isUntitled);
                assert.equal(vscode.window.activeTextEditor.document.languageId, 'sql');
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
                break;
            case 'closeEditors':
                await vscode.commands.executeCommand('workbench.action.closeAllEditors');
                break;
            default: throw new Error('Unknown smoke-driver action');
        }
        return probe();
    }
    let processing = false;
    const timer = setInterval(async () => {
        const file = path.join(mailbox, 'request.json');
        if (processing || !fs.existsSync(file)) { return; }
        processing = true;
        let id;
        try {
            const request = JSON.parse(fs.readFileSync(file, 'utf8'));
            fs.unlinkSync(file);
            id = request.id;
            const result = await execute(request);
            fs.writeFileSync(path.join(mailbox, 'response.tmp'), JSON.stringify({ id, result }));
        } catch (error) {
            fs.writeFileSync(path.join(mailbox, 'response.tmp'), JSON.stringify({ id, error: error.message }));
        } finally {
            fs.renameSync(path.join(mailbox, 'response.tmp'), path.join(mailbox, 'response.json'));
            processing = false;
        }
    }, 20);
    context.subscriptions.push({
        dispose() {
            clearInterval(timer);
            Module._load = originalLoad;
            globalThis.fetch = originalFetch;
        },
    });
    fs.writeFileSync(path.join(mailbox, 'ready.json'), JSON.stringify({ bundleSha256: bundleHash }));
}

module.exports = { activate };
