/*
 * The native SQL File Detection Tool webview.
 *
 * Runs inside a VS Code webview under a strict CSP: this file is the only
 * script the document may load, restricted to the extension's own origin. It
 * therefore avoids, on purpose and permanently:
 *
 *   * `innerHTML`, `outerHTML`, `insertAdjacentHTML` and `document.write`
 *   * `eval`, `new Function`, `setTimeout('string')`
 *   * inline event handler attributes
 *   * `fetch`, `XMLHttpRequest`, `WebSocket` and any other network API
 *
 * Every value that comes from the host is placed with `textContent` or as a
 * form control `value`, so analysed file content can never become markup. All
 * markup comes from cloning the `<template>` elements in the shell document.
 *
 * Product state always comes from the host snapshot. The renderer keeps only
 * transient view state such as pending edits, focus, scroll and collapsed
 * folders, so the Activity Bar view and editor panel cannot disagree on data.
 */

/* eslint-env browser */
(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    /** Tabs in display order. Statement tabs appear only when they have text. */
    const TABS = [
        { id: 'preview', label: 'Preview', always: true },
        { id: 'metadata', label: 'Metadata', always: true },
        { id: 'schema', label: 'Schema', always: true },
        { id: 'create_table', label: 'CREATE TABLE' },
        { id: 'bulk_insert', label: 'BULK INSERT' },
        { id: 'openrowset', label: 'OPENROWSET' },
        { id: 'create_external_table', label: 'EXT TABLE' },
        { id: 'external_file_format', label: 'File format' },
        { id: 'credential_setup', label: 'Credential setup' },
    ];

    const SUPPORT_LABEL = {
        supported: 'Fully analysed',
        recognition_only: 'Recognised only',
        unsupported_native: 'Not analysed natively',
    };

    let state = null;
    /** Values the user is mid-edit, so a state push cannot yank the caret. */
    const pendingEdits = new Map();
    const debounceTimers = new Map();
    const collapsedFolders = new Set();
    /** Renderer-only view state: the Explorer filter query and its source. */
    let fileFilter = '';
    let lastSourceLabel = null;
    let azureAccountQuery = '';
    let azureEntryQuery = '';
    let azureFormat = 'all';

    // -- helpers -------------------------------------------------------------

    function byId(id) {
        return document.getElementById(id);
    }

    function post(message) {
        vscode.postMessage(message);
    }

    function renderDocumentationLinks(container, links) {
        if (!links || links.length === 0) {
            return;
        }
        const group = element('div', 'documentation-links');
        links.forEach(function (link) {
            const button = element('button', 'documentation-link', link.label + ' (external)');
            button.type = 'button';
            button.dataset.documentation = link.id;
            button.title = link.label + ' - opens Microsoft Learn externally';
            button.setAttribute('aria-label', link.label + ' (opens externally)');
            group.appendChild(button);
        });
        container.appendChild(group);
    }

    function debounce(key, fn, ms) {
        const existing = debounceTimers.get(key);
        if (existing !== undefined) {
            clearTimeout(existing);
        }
        debounceTimers.set(
            key,
            setTimeout(function () {
                debounceTimers.delete(key);
                fn();
            }, ms),
        );
    }

    function cancelDebounce(key) {
        const timer = debounceTimers.get(key);
        if (timer !== undefined) {
            clearTimeout(timer);
            debounceTimers.delete(key);
        }
    }

    function clearFileEdits() {
        for (const key of Array.from(debounceTimers.keys())) {
            if (key.startsWith('parser:') || key.startsWith('override:')) {
                cancelDebounce(key);
            }
        }
        for (const key of Array.from(pendingEdits.keys())) {
            if (key.startsWith('parser:') || key.startsWith('override:')) {
                pendingEdits.delete(key);
            }
        }
    }

    function clear(node) {
        while (node.firstChild) {
            node.removeChild(node.firstChild);
        }
    }

    function template(id) {
        const tpl = byId(id);
        return tpl.content.firstElementChild.cloneNode(true);
    }

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined && text !== null) {
            node.textContent = String(text);
        }
        return node;
    }

    function formatBytes(bytes) {
        if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) {
            return '';
        }
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = bytes;
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit += 1;
        }
        return (unit === 0 ? value : value.toFixed(1)) + ' ' + units[unit];
    }

    function cellText(value) {
        if (value === null || value === undefined) {
            return 'NULL';
        }
        if (typeof value === 'boolean') {
            return value ? 'true' : 'false';
        }
        return String(value);
    }

    function editable(key, fallback) {
        return pendingEdits.has(key) ? pendingEdits.get(key) : fallback;
    }

    function captureFocus() {
        const active = document.activeElement;
        if (!active || !active.dataset) {
            return null;
        }
        const identity = {
            id: active.id || '',
            edit: active.dataset.edit || '',
            column: active.dataset.column || '',
            parserOption: active.dataset.parserOption || '',
        };
        if (!identity.id && !identity.edit && !identity.parserOption) {
            return null;
        }
        let start = null;
        let end = null;
        let direction = null;
        if (typeof active.selectionStart === 'number') {
            start = active.selectionStart;
            end = active.selectionEnd;
            direction = active.selectionDirection;
        }
        return { identity: identity, start: start, end: end, direction: direction };
    }

    function restoreFocus(snapshot) {
        if (!snapshot) {
            return;
        }
        const identity = snapshot.identity;
        let control = identity.id ? byId(identity.id) : null;
        if (!control) {
            const controls = document.querySelectorAll('[data-edit], [data-parser-option]');
            control = Array.prototype.find.call(controls, function (candidate) {
                return (
                    (candidate.dataset.edit || '') === identity.edit
                    && (candidate.dataset.column || '') === identity.column
                    && (candidate.dataset.parserOption || '') === identity.parserOption
                );
            });
        }
        if (!control) {
            return;
        }
        control.focus({ preventScroll: true });
        if (
            snapshot.start !== null
            && snapshot.end !== null
            && typeof control.setSelectionRange === 'function'
        ) {
            const length = typeof control.value === 'string' ? control.value.length : 0;
            control.setSelectionRange(
                Math.min(snapshot.start, length),
                Math.min(snapshot.end, length),
                snapshot.direction || 'none',
            );
        }
    }

    // -- rendering -----------------------------------------------------------

    function renderHeader() {
        byId('app-version').textContent = state.version ? 'v' + state.version : '';

        const platform = byId('platform');
        if (platform.options.length !== state.platforms.length) {
            clear(platform);
            state.platforms.forEach(function (entry) {
                const option = element('option', null, entry.label);
                option.value = entry.id;
                platform.appendChild(option);
            });
        }
        platform.value = state.platform;
    }

    function renderStatus() {
        byId('progress').textContent = state.progress || '';
        byId('error').textContent = state.error || '';
        byId('notice').textContent = state.notice || '';
        byId('cancel').hidden = !state.busy;
        byId('dismiss').hidden = !state.error && !state.notice;
        document.querySelectorAll('.toolbar .btn').forEach(function (button) {
            button.disabled = state.busy;
        });
    }

    function renderAzureConnection() {
        const connection = state.azureConnection;
        const browserIdentity = state.azure.identity;
        const identity = connection.identity || browserIdentity;
        const tenants = byId('azure-tenants');
        clear(tenants);

        const connected =
            connection.phase === 'connected' || browserIdentity !== null;
        const connecting = connection.phase === 'connecting';
        const failed = connection.phase === 'error';
        byId('azure-summary').textContent = identity
            ? 'Signed in as ' + identity.label + (connection.stale ? ' (cached)' : '')
            : connection.phase === 'disconnected'
                ? 'Not connected'
                : failed
                    ? 'Connection was not completed'
                    : 'Connecting…';
        byId('azure-detail').textContent =
            browserIdentity && connection.phase !== 'connected'
                ? 'Azure Storage browsing is available. Use Browse Azure to select a remote file; its bytes are not downloaded or analyzed.'
                : connection.message
                    + (
                        connected
                            ? ' Use Browse Azure to select a remote file; its bytes are not downloaded or analyzed.'
                            : ''
                    );
        connection.tenants.forEach(function (tenant) {
            const item = element('li', 'azure-tenant');
            item.appendChild(element('span', 'azure-tenant-label', tenant.label));
            item.appendChild(element('code', 'azure-tenant-id', tenant.id));
            tenants.appendChild(item);
        });

        byId('azure-connect').hidden =
            connected || connection.phase !== 'disconnected';
        byId('azure-connect').disabled = connecting;
        byId('azure-retry').hidden = !failed;
        byId('azure-retry').disabled = connecting;
        byId('azure-browse').hidden = !connected;
        byId('azure-browse').disabled = connecting;
        byId('azure-refresh').hidden = !connected;
        byId('azure-refresh').disabled = connecting;
        byId('azure-disconnect').hidden =
            !connected && connection.phase === 'disconnected';
        byId('azure-disconnect').disabled = connecting;
    }

    function azureStateCard(title, detail, primaryLabel, primaryAction) {
        const card = element('section', 'azure-state-card');
        card.appendChild(element('div', 'azure-cloud-mark', '☁'));
        card.appendChild(element('h2', null, title));
        card.appendChild(element('p', null, detail));
        if (primaryLabel && primaryAction) {
            card.appendChild(actionButton(primaryLabel, primaryAction, 'btn primary'));
        }
        return card;
    }

    function azureSelect(label, id, items, selected, key) {
        const field = element('label', 'field azure-identity-field');
        field.appendChild(element('span', null, label));
        const select = document.createElement('select');
        select.id = id;
        select.dataset.azureSelect = key;
        items.forEach(function (item) {
            const option = element('option', null, item.label);
            option.value = item.id;
            option.selected = item.id === selected;
            select.appendChild(option);
        });
        select.disabled = state.azure.phase === 'loading' || items.length === 0;
        field.appendChild(select);
        return field;
    }

    function selectedAzureAccount() {
        return state.azure.accounts.find(function (account) {
            return account.id === state.azure.selectedAccountId;
        }) || null;
    }

    function renderAzureBrowser() {
        const browser = byId('azure-browser');
        const standard = byId('standard-layout');
        const connection = byId('azure-connection');
        const azure = state.azure;
        browser.hidden = !azure.open;
        standard.hidden = azure.open;
        connection.hidden = azure.open;
        if (!azure.open) {
            return;
        }
        clear(browser);

        if (azure.phase === 'signedOut') {
            const signedOut = azureStateCard(
                'Browse Azure Storage',
                'Sign in with VS Code Microsoft authentication. Read-only management and Storage data scopes are requested only after you connect.',
                'Connect with Microsoft',
                'azureBrowserConnect',
            );
            signedOut.appendChild(
                element(
                    'p',
                    'azure-privacy-copy',
                    'Tokens remain in the extension host and are never stored, logged, or sent to this webview.',
                ),
            );
            signedOut.appendChild(
                element(
                    'p',
                    'azure-privacy-copy',
                    'Subscription Reader access lists accounts; account-level Storage Blob Data Reader is required to list containers and files.',
                ),
            );
            signedOut.appendChild(
                actionButton('Back', 'azureBrowserClose', 'btn subtle'),
            );
            browser.appendChild(signedOut);
            return;
        }

        const identity = element('header', 'azure-identity-bar');
        const identityCopy = element('div', 'azure-identity');
        identityCopy.appendChild(element('span', 'azure-avatar', 'MS'));
        const identityText = element('div');
        identityText.appendChild(
            element(
                'h2',
                null,
                azure.identity ? azure.identity.label : 'Microsoft account',
            ),
        );
        identityText.appendChild(
            element('p', null, 'Azure public cloud · read-only browsing'),
        );
        identityCopy.appendChild(identityText);
        identity.appendChild(identityCopy);
        identity.appendChild(
            azureSelect(
                'Tenant',
                'azure-browser-tenant',
                azure.tenants,
                azure.selectedTenantId,
                'tenant',
            ),
        );
        identity.appendChild(
            azureSelect(
                'Subscription',
                'azure-browser-subscription',
                azure.subscriptions,
                azure.selectedSubscriptionId,
                'subscription',
            ),
        );
        const identityActions = element('div', 'azure-identity-actions');
        identityActions.appendChild(
            actionButton('Disconnect', 'azureBrowserDisconnect', 'btn subtle'),
        );
        identityActions.appendChild(
            actionButton('Close', 'azureBrowserClose', 'btn subtle'),
        );
        identity.appendChild(identityActions);
        browser.appendChild(identity);

        if (azure.phase === 'loading' && azure.accounts.length === 0) {
            browser.appendChild(
                azureStateCard(
                    'Loading Azure…',
                    azure.message || 'Reading Azure metadata.',
                    null,
                    null,
                ),
            );
            return;
        }

        const layout = element('div', 'azure-layout');
        const accountsPane = element('aside', 'azure-accounts-pane');
        const accountsHeading = element('div', 'azure-pane-heading');
        accountsHeading.appendChild(element('h2', null, 'Storage accounts'));
        accountsHeading.appendChild(
            element('span', 'azure-count', String(azure.accounts.length)),
        );
        accountsPane.appendChild(accountsHeading);
        const accountSearch = document.createElement('input');
        accountSearch.type = 'search';
        accountSearch.id = 'azure-account-search';
        accountSearch.placeholder = 'Name, resource group, or region';
        accountSearch.setAttribute('aria-label', 'Search Storage accounts');
        accountSearch.value = azureAccountQuery;
        accountsPane.appendChild(accountSearch);
        const accountList = element('div', 'azure-account-list');
        const accountQuery = azureAccountQuery.trim().toLowerCase();
        const matchingAccounts = azure.accounts.filter(function (account) {
            return [
                account.name,
                account.resourceGroup,
                account.location,
                account.hns ? 'ADLS Gen2' : 'Blob Storage',
            ].join(' ').toLowerCase().includes(accountQuery);
        });
        matchingAccounts.forEach(function (account) {
            const button = element('button', 'azure-account-card');
            button.type = 'button';
            button.dataset.azureAccount = account.id;
            button.setAttribute(
                'aria-pressed',
                account.id === azure.selectedAccountId ? 'true' : 'false',
            );
            button.appendChild(element('strong', null, account.name));
            button.appendChild(
                element(
                    'span',
                    'azure-account-kind',
                    account.hns ? 'ADLS Gen2 / HNS' : 'Blob Storage',
                ),
            );
            button.appendChild(
                element(
                    'span',
                    'azure-account-meta',
                    account.resourceGroup + ' · ' + account.location,
                ),
            );
            accountList.appendChild(button);
        });
        if (matchingAccounts.length === 0) {
            accountList.appendChild(
                element('p', 'azure-empty', 'No Storage accounts match this filter.'),
            );
        }
        accountsPane.appendChild(accountList);
        layout.appendChild(accountsPane);

        const browsePane = element('section', 'azure-browse-pane');
        const selectedAccount = selectedAzureAccount();
        if (azure.phase === 'error' && !selectedAccount) {
            const title =
                azure.errorKind === 'controlAccess'
                    ? 'Azure management access denied'
                    : 'Could not list Azure resources';
            browsePane.appendChild(
                azureStateCard(
                    title,
                    azure.message || 'Retry the request.',
                    'Retry',
                    'azureBrowserRetry',
                ),
            );
            layout.appendChild(browsePane);
            browser.appendChild(layout);
            return;
        }
        if (!selectedAccount) {
            browsePane.appendChild(
                azureStateCard(
                    'Choose a Storage account',
                    azure.message
                        || 'Select an account to request its existing read-only data access.',
                    null,
                    null,
                ),
            );
            layout.appendChild(browsePane);
            browser.appendChild(layout);
            return;
        }

        const browseHeading = element('div', 'azure-browse-heading');
        const headingCopy = element('div');
        headingCopy.appendChild(
            element('p', 'azure-eyebrow', selectedAccount.resourceGroup),
        );
        headingCopy.appendChild(element('h2', null, selectedAccount.name));
        browseHeading.appendChild(headingCopy);
        const badges = element('div', 'azure-badges');
        badges.appendChild(
            element(
                'span',
                'azure-badge',
                selectedAccount.hns ? 'ADLS Gen2 / HNS' : 'Blob Storage',
            ),
        );
        badges.appendChild(
            element('span', 'azure-badge', selectedAccount.location),
        );
        browseHeading.appendChild(badges);
        browsePane.appendChild(browseHeading);

        const breadcrumbs = element('nav', 'azure-breadcrumbs');
        breadcrumbs.setAttribute('aria-label', 'Azure Storage location');
        const root = element('button', 'azure-breadcrumb');
        root.type = 'button';
        root.dataset.azureDepth = '0';
        root.textContent = selectedAccount.name;
        breadcrumbs.appendChild(root);
        azure.path.forEach(function (segment, index) {
            breadcrumbs.appendChild(
                element('span', 'azure-breadcrumb-separator', '›'),
            );
            const crumb = element('button', 'azure-breadcrumb', segment);
            crumb.type = 'button';
            crumb.dataset.azureDepth = String(index + 1);
            crumb.disabled = index === azure.path.length - 1;
            breadcrumbs.appendChild(crumb);
        });
        browsePane.appendChild(breadcrumbs);

        if (azure.phase === 'error') {
            const title =
                azure.errorKind === 'controlAccess'
                    ? 'Azure management access denied'
                    : azure.errorKind === 'dataAccess'
                        ? 'Storage data access denied'
                        : 'Could not list this Azure location';
            browsePane.appendChild(
                azureStateCard(
                    title,
                    azure.message || 'Retry the request or choose another account.',
                    'Retry',
                    'azureBrowserRetry',
                ),
            );
            layout.appendChild(browsePane);
            browser.appendChild(layout);
            return;
        }

        const filters = element('div', 'azure-entry-filters');
        const entrySearch = document.createElement('input');
        entrySearch.type = 'search';
        entrySearch.id = 'azure-entry-search';
        entrySearch.placeholder = 'Filter this location';
        entrySearch.setAttribute(
            'aria-label',
            'Filter containers, folders, and files',
        );
        entrySearch.value = azureEntryQuery;
        filters.appendChild(entrySearch);
        const format = document.createElement('select');
        format.id = 'azure-format-filter';
        format.setAttribute('aria-label', 'Filter by supported file format');
        [
            'all',
            'CSV',
            'TSV',
            'JSON',
            'JSONL',
            'NDJSON',
            'PARQUET',
            'ORC',
            'RC',
        ].forEach(function (value) {
            const option = element(
                'option',
                null,
                value === 'all' ? 'All supported formats' : value,
            );
            option.value = value;
            option.selected = value === azureFormat;
            format.appendChild(option);
        });
        filters.appendChild(format);
        browsePane.appendChild(filters);

        const entryList = element('div', 'azure-entry-list');
        entryList.setAttribute('role', 'list');
        const entryQuery = azureEntryQuery.trim().toLowerCase();
        const entries = azure.entries.filter(function (entry) {
            const matchesText = entry.name.toLowerCase().includes(entryQuery);
            const matchesFormat =
                entry.kind !== 'file'
                || (
                    entry.supported
                    && (azureFormat === 'all' || entry.format === azureFormat)
                );
            return matchesText && matchesFormat;
        });
        entries.forEach(function (entry) {
            const button = element('button', 'azure-entry');
            button.type = 'button';
            button.dataset.azureEntry = entry.id;
            button.setAttribute(
                'aria-pressed',
                entry.id === azure.selectedEntryId ? 'true' : 'false',
            );
            button.appendChild(
                element(
                    'span',
                    'azure-entry-icon',
                    entry.kind === 'container'
                        ? '▣'
                        : entry.kind === 'folder'
                            ? '▸'
                            : '◇',
                ),
            );
            const copy = element('span', 'azure-entry-copy');
            copy.appendChild(element('strong', null, entry.name));
            const meta = [];
            if (entry.kind === 'file') {
                meta.push(entry.format || 'FILE');
                if (entry.sizeBytes !== null) {
                    meta.push(formatBytes(entry.sizeBytes));
                }
                if (entry.modifiedAt) {
                    meta.push(new Date(entry.modifiedAt).toLocaleString());
                }
                if (!entry.supported) {
                    meta.push('Not a supported SQL source');
                }
            } else {
                meta.push(entry.kind);
            }
            copy.appendChild(
                element('span', 'azure-entry-meta', meta.join(' · ')),
            );
            button.appendChild(copy);
            entryList.appendChild(button);
        });
        if (entries.length === 0) {
            entryList.appendChild(
                element(
                    'p',
                    'azure-empty',
                    azure.message || 'No matching items in this location.',
                ),
            );
        }
        browsePane.appendChild(entryList);
        if (azure.hasMore) {
            browsePane.appendChild(
                actionButton('Load more', 'azureBrowserLoadMore', 'btn subtle'),
            );
        }
        if (azure.phase === 'loading') {
            browsePane.appendChild(
                element('p', 'azure-loading', azure.message || 'Loading…'),
            );
        }

        const selectedEntry = azure.entries.find(function (entry) {
            return entry.id === azure.selectedEntryId;
        });
        if (selectedEntry && selectedEntry.kind === 'file') {
            const details = element('aside', 'azure-selection');
            details.appendChild(element('strong', null, selectedEntry.name));
            details.appendChild(
                element(
                    'p',
                    null,
                    selectedEntry.supported
                        ? 'Use this remote location in Credential Setup. The extension does not download or analyze its bytes.'
                        : 'This file format is not supported as a SQL source.',
                ),
            );
            const use = actionButton(
                'Use selected file',
                'azureBrowserUseSelectedFile',
                'btn primary',
            );
            use.disabled = !selectedEntry.supported;
            details.appendChild(use);
            browsePane.appendChild(details);
        }

        layout.appendChild(browsePane);
        browser.appendChild(layout);
    }

    function rerenderAzureBrowser() {
        const focus = captureFocus();
        renderAzureBrowser();
        restoreFocus(focus);
    }

    function renderFiles() {
        const list = byId('file-list');
        const scrollTop = list.scrollTop;
        clear(list);
        byId('source-label').textContent = state.sourceLabel || '';

        // A new source starts with a clean filter: a leftover query that hides
        // every file in a folder the user just chose reads as "nothing found".
        if (state.sourceLabel !== lastSourceLabel) {
            lastSourceLabel = state.sourceLabel;
            fileFilter = '';
        }
        const filterRow = byId('file-filter-row');
        const filterInput = byId('file-filter');
        filterRow.hidden = state.files.length === 0;
        if (filterInput.value !== fileFilter) {
            filterInput.value = fileFilter;
        }

        const query = fileFilter.trim().toLowerCase();
        const matches = query
            ? state.files.filter(function (file) {
                  return (
                      String(file.label || '').toLowerCase().indexOf(query) > -1
                      || String(file.fileType || '').toLowerCase().indexOf(query) > -1
                      || String(file.folderLabel || '').toLowerCase().indexOf(query) > -1
                  );
              })
            : state.files;

        const empty = byId('file-empty');
        if (state.files.length === 0) {
            empty.hidden = false;
            empty.textContent = 'Select a file, folder, or URL to begin.';
        } else if (matches.length === 0) {
            empty.hidden = false;
            empty.textContent = 'No files match this filter.';
        } else {
            empty.hidden = true;
        }

        function treeNode() {
            return { folders: new Map(), files: [] };
        }

        function renderFile(parent, file) {
            const item = template('tpl-file-item');
            item.dataset.fileId = file.id;
            if (file.isDirectory) {
                item.classList.add('table-item');
                item.querySelector('.file-icon').className = 'table-icon';
            }
            item.setAttribute(
                'aria-selected',
                file.id === state.selectedFileId ? 'true' : 'false',
            );
            const name = item.querySelector('.file-name');
            name.textContent = file.label;
            name.title = file.label;
            const parts = [];
            parts.push(file.fileType);
            if (file.sizeBytes > 0) {
                parts.push(formatBytes(file.sizeBytes));
            }
            if (file.nativeSupport && file.nativeSupport !== 'supported') {
                parts.push(SUPPORT_LABEL[file.nativeSupport] || file.nativeSupport);
            }
            item.querySelector('.file-meta').textContent = parts.join(' · ');
            parent.appendChild(item);
        }

        function renderFolder(parent, name, node, folderPath) {
            const item = element('li', 'tree-folder');
            item.setAttribute('role', 'treeitem');
            const expanded = query ? true : !collapsedFolders.has(folderPath);
            item.setAttribute('aria-expanded', expanded ? 'true' : 'false');

            const button = element('button', 'tree-folder-label');
            button.type = 'button';
            button.dataset.folderPath = folderPath;
            button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            button.appendChild(element('span', 'folder-chevron'));
            button.appendChild(element('span', 'folder-icon'));
            button.appendChild(element('span', 'folder-name', name));
            item.appendChild(button);

            const group = element('ul', 'tree-group');
            group.setAttribute('role', 'group');
            group.hidden = !expanded;
            Array.from(node.folders.keys())
                .sort(function (left, right) {
                    return left.localeCompare(right);
                })
                .forEach(function (childName) {
                    renderFolder(
                        group,
                        childName,
                        node.folders.get(childName),
                        folderPath ? folderPath + '/' + childName : childName,
                    );
                });
            node.files
                .slice()
                .sort(function (left, right) {
                    return left.label.localeCompare(right.label);
                })
                .forEach(function (file) {
                    renderFile(group, file);
                });
            item.appendChild(group);
            parent.appendChild(item);
        }

        const root = treeNode();
        matches.forEach(function (file) {
            let node = root;
            String(file.folderLabel || '')
                .split('/')
                .filter(function (segment) {
                    return segment && segment !== '.' && segment !== '..';
                })
                .forEach(function (segment) {
                    if (!node.folders.has(segment)) {
                        node.folders.set(segment, treeNode());
                    }
                    node = node.folders.get(segment);
                });
            node.files.push(file);
        });

        Array.from(root.folders.keys())
            .sort(function (left, right) {
                return left.localeCompare(right);
            })
            .forEach(function (name) {
                renderFolder(list, name, root.folders.get(name), name);
            });
        root.files
            .slice()
            .sort(function (left, right) {
                return left.label.localeCompare(right.label);
            })
            .forEach(function (file) {
                renderFile(list, file);
            });
        list.scrollTop = scrollTop;
    }

    function visibleFileItems() {
        const list = byId('file-list');
        return Array.prototype.filter.call(list.querySelectorAll('.file-item'), function (item) {
            const hiddenGroup = item.closest('.tree-group[hidden]');
            return !hiddenGroup;
        });
    }

    function visibleTabs() {
        const statements = state.statements || {};
        return TABS.filter(function (tab) {
            if (tab.always) {
                return true;
            }
            const text = statements[tab.id];
            return typeof text === 'string' && text.trim().length > 0;
        });
    }

    function renderTabs() {
        const bar = byId('tablist');
        clear(bar);
        visibleTabs().forEach(function (tab) {
            const button = template('tpl-tab');
            button.textContent = tab.label;
            button.dataset.tab = tab.id;
            const selected = tab.id === state.activeTab;
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
            button.tabIndex = selected ? 0 : -1;
            bar.appendChild(button);
        });
    }

    function appendKv(list, label, value) {
        if (value === null || value === undefined || value === '') {
            return;
        }
        const row = template('tpl-kv');
        row.querySelector('dt').textContent = label;
        row.querySelector('dd').textContent = String(value);
        list.appendChild(row);
    }

    function renderLimitation(container) {
        if (!state.limitation) {
            return;
        }
        const node = template('tpl-limitation');
        node.querySelector('h3').textContent = state.limitation.title;
        node.querySelector('.limitation-detail').textContent = state.limitation.detail;
        node.querySelector('.limitation-workaround').textContent =
            state.limitation.manualWorkaround || '';
        container.appendChild(node);
    }

    function renderMetadata(container) {
        renderLimitation(container);
        const metadata = state.metadata;
        if (!metadata) {
            container.appendChild(
                element('p', 'empty', 'Choose a file to see its detected metadata.'),
            );
            return;
        }

        const list = element('dl', 'kv-list');
        appendKv(list, 'File', metadata.file_path);
        appendKv(list, 'Type', metadata.file_type);
        appendKv(list, 'Size', formatBytes(metadata.file_size));
        appendKv(list, 'Columns', metadata.column_count);
        appendKv(
            list,
            'Rows',
            metadata.row_count === null || metadata.row_count === undefined
                ? null
                : metadata.row_count + (metadata.row_count_estimated ? ' (estimated)' : ''),
        );
        appendKv(list, 'Delimiter', metadata.delimiter);
        appendKv(list, 'Header row', metadata.has_header ? 'Yes' : 'No');
        appendKv(list, 'Encoding', metadata.encoding);
        appendKv(list, 'Code page', metadata.codepage);
        appendKv(list, 'Compression', metadata.compression);
        appendKv(list, 'Schema source', metadata.schema_inference);
        appendKv(list, 'Sample size', metadata.schema_sample_size);
        appendKv(list, 'JSON shape', metadata.json_format);
        appendKv(list, 'Native support', SUPPORT_LABEL[metadata.native_support] || null);
        appendKv(list, 'Warning', metadata.warning);
        appendKv(list, 'Encoding warning', metadata.encoding_warning);
        appendKv(list, 'Error', metadata.error);
        if (state.lastAnalysisMs !== null && state.lastAnalysisMs !== undefined) {
            appendKv(list, 'Analysis time', state.lastAnalysisMs + ' ms');
        }
        container.appendChild(list);

        if (metadata.parquet_metadata) {
            container.appendChild(element('h3', null, 'Parquet footer'));
            const parquet = element('dl', 'kv-list');
            appendKv(parquet, 'Created by', metadata.parquet_metadata.created_by);
            appendKv(parquet, 'Row groups', metadata.parquet_metadata.num_row_groups);
            appendKv(parquet, 'Format version', metadata.parquet_metadata.format_version);
            container.appendChild(parquet);
        }
        if (metadata.delta_metadata) {
            container.appendChild(element('h3', null, 'Delta table'));
            const delta = element('dl', 'kv-list');
            appendKv(delta, 'Version', metadata.delta_metadata.version);
            appendKv(delta, 'Name', metadata.delta_metadata.name);
            appendKv(
                delta,
                'Partition columns',
                (metadata.delta_metadata.partition_columns || []).join(', '),
            );
            container.appendChild(delta);
        }
        if (metadata.iceberg_metadata) {
            container.appendChild(element('h3', null, 'Iceberg table'));
            const iceberg = element('dl', 'kv-list');
            appendKv(iceberg, 'Format version', metadata.iceberg_metadata.format_version);
            appendKv(iceberg, 'Metadata file', metadata.iceberg_metadata.metadata_file);
            appendKv(iceberg, 'Snapshots', metadata.iceberg_metadata.snapshot_count);
            container.appendChild(iceberg);
        }
    }

    function renderPreview(container) {
        if (!state.selectedFileId) {
            const start = element('div', 'start-state');
            start.appendChild(
                element('p', 'empty', 'Select a file, folder, or URL to begin.'),
            );
            container.appendChild(start);
            return;
        }

        const preview = state.preview;
        const rowsField = element('label', 'field');
        rowsField.appendChild(element('span', null, 'Preview rows'));
        const rowsInput = document.createElement('input');
        rowsInput.type = 'number';
        rowsInput.min = '1';
        rowsInput.max = '500';
        rowsInput.value = String(state.previewRows);
        rowsInput.dataset.edit = 'previewRows';
        rowsField.appendChild(rowsInput);
        container.appendChild(rowsField);

        if (!preview) {
            container.appendChild(
                element('p', 'empty', 'No preview is available for this file.'),
            );
            return;
        }
        if (preview.error) {
            container.appendChild(element('p', 'error', preview.error));
            return;
        }

        const scroll = element('div', 'table-scroll');
        const table = document.createElement('table');
        const caption = element(
            'caption',
            null,
            'Showing ' +
                preview.rows.length +
                (preview.truncated ? ' of more rows' : ' rows') +
                (preview.total_rows !== null && preview.total_rows !== undefined
                    ? ' · ' + preview.total_rows + ' total'
                    : ''),
        );
        table.appendChild(caption);

        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        preview.columns.forEach(function (column) {
            const cell = element('th', null, column.name + ' (' + column.type + ')');
            cell.scope = 'col';
            headRow.appendChild(cell);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        preview.rows.forEach(function (row) {
            const tr = document.createElement('tr');
            row.forEach(function (value) {
                tr.appendChild(element('td', null, cellText(value)));
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        scroll.appendChild(table);
        container.appendChild(scroll);
    }

    function renderSchema(container) {
        const metadata = state.metadata;
        if (!metadata || !metadata.schema || metadata.schema.length === 0) {
            renderLimitation(container);
            container.appendChild(
                element('p', 'empty', 'No schema was detected for this file.'),
            );
            return;
        }
        container.appendChild(
            element(
                'p',
                'help',
                'Recommended SQL types are generated from the detected schema. Edit a value to customize the generated SQL.',
            ),
        );

        const scroll = element('div', 'table-scroll');
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        ['Column', 'Source type', 'SQL Type'].forEach(function (label) {
            const cell = element('th', null, label);
            cell.scope = 'col';
            headRow.appendChild(cell);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        metadata.schema.forEach(function (field) {
            const row = template('tpl-schema-row');
            row.querySelector('.col-name').textContent = field[0];
            row.querySelector('.col-detected').textContent = field[1];
            const input = row.querySelector('.override-input');
            input.dataset.edit = 'override';
            input.dataset.column = field[0];
            input.setAttribute('aria-label', 'SQL type for ' + field[0]);
            input.value = editable(
                'override:' + field[0],
                state.columnOverrides[field[0]]
                    || (state.recommendedSqlTypes || {})[field[0]]
                    || '',
            );
            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        scroll.appendChild(table);
        container.appendChild(scroll);

        if (Object.keys(state.columnOverrides || {}).length > 0) {
            const clearButton = element('button', 'btn subtle', 'Reset SQL types');
            clearButton.type = 'button';
            clearButton.dataset.action = 'clearColumnOverrides';
            container.appendChild(clearButton);
        }
    }

    function renderNamingOptions(container) {
        const row = element('div', 'option-row');
        [
            { key: 'tableName', label: 'Table name', value: state.tableName },
            { key: 'schemaName', label: 'Schema', value: state.schemaName },
            { key: 'dataSource', label: 'External data source', value: state.dataSource },
            {
                key: 'formatName',
                label: 'External file format',
                value: state.formatName,
            },
            {
                key: 'credentialName',
                label: 'Credential name',
                value: state.credentialName,
            },
            { key: 'storageUrl', label: 'Storage URL', value: state.storageUrl },
        ].forEach(function (field) {
            const label = element('label', 'field');
            label.appendChild(element('span', null, field.label));
            const input = document.createElement('input');
            input.type = 'text';
            input.spellcheck = false;
            input.autocomplete = 'off';
            input.dataset.edit = field.key;
            input.value = editable(field.key, field.value || '');
            label.appendChild(input);
            row.appendChild(label);
        });

        container.appendChild(row);
    }

    function renderSqlBlock(container, kind, text) {
        if (!text) {
            container.appendChild(
                element('p', 'empty', 'Analyze a file to generate this statement.'),
            );
            return;
        }
        const block = template('tpl-sql');
        block.dataset.kind = kind;
        block.querySelector('code').textContent = text;
        block.querySelector('pre').setAttribute('aria-label', kind + ' statement');
        container.appendChild(block);
    }

    function renderStatement(container, kind) {
        renderNamingOptions(container);
        renderLimitation(container);
        renderDocumentationLinks(container, state.quickAnalyze.documentation);
        renderSqlBlock(container, kind, (state.statements || {})[kind]);
    }

    function selectControl(labelText, edit, options, selected) {
        const label = element('label', 'field wizard-field');
        label.appendChild(element('span', null, labelText));
        const select = document.createElement('select');
        select.dataset.edit = edit;
        options.forEach(function (option) {
            const node = document.createElement('option');
            node.value = option.id;
            node.textContent = option.label;
            node.selected = option.id === selected;
            select.appendChild(node);
        });
        label.appendChild(select);
        return label;
    }

    function textControl(labelText, edit, value, placeholder) {
        const label = element('label', 'field wizard-field');
        label.appendChild(element('span', null, labelText));
        const input = document.createElement('input');
        input.type = 'text';
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.dataset.edit = edit;
        input.value = editable(edit, value || '');
        if (placeholder) {
            input.placeholder = placeholder;
        }
        label.appendChild(input);
        return label;
    }

    function wizardStep(number, title, detail) {
        const card = element('section', 'wizard-step');
        const heading = element('div', 'wizard-step-heading');
        heading.appendChild(element('span', 'wizard-step-number', number));
        const copy = element('div');
        copy.appendChild(element('h3', null, title));
        copy.appendChild(element('p', 'wizard-step-detail', detail));
        heading.appendChild(copy);
        card.appendChild(heading);
        return card;
    }

    function actionButton(label, action, className) {
        const button = element('button', className || 'btn', label);
        button.type = 'button';
        button.dataset.action = action;
        return button;
    }

    function renderStorageSource() {
        const step = wizardStep(
            '1',
            'Storage URL',
            'Paste the location SQL should use. The connector is inferred from the URL.',
        );
        step.classList.add('storage-source-step');

        const options = element('div', 'storage-source-options');
        const known = element('section', 'storage-source-option');
        known.appendChild(element('h4', null, 'Provide a storage location'));
        known.appendChild(
            element(
                'p',
                'source-option-detail',
                'Use an abs://, adls://, or abfss:// location. Azure HTTPS and s3:// locations remain supported.',
            ),
        );
        const urlLabel = element('label', 'field');
        urlLabel.appendChild(element('span', null, 'Storage URL'));
        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.className = 'storage-url-input';
        urlInput.spellcheck = false;
        urlInput.autocomplete = 'off';
        urlInput.placeholder = 'abs://container@account.blob.core.windows.net/path';
        urlInput.dataset.edit = 'knownStorageUrl';
        urlInput.value = editable('knownStorageUrl', state.storageUrl || '');
        urlLabel.appendChild(urlInput);
        known.appendChild(urlLabel);
        const urlActions = element('div', 'storage-url-actions');
        urlActions.appendChild(actionButton('Use URL', 'useStorageUrl', 'btn primary'));
        const clearUrl = actionButton('Clear', 'clearStorageUrl', 'btn subtle');
        clearUrl.hidden = !state.storageUrl;
        urlActions.appendChild(clearUrl);
        known.appendChild(urlActions);
        known.appendChild(
            element(
                'p',
                'help',
                'The URL determines ABS, ADLS, or ABFSS formatting. Query strings and fragments are removed before SQL generation.',
            ),
        );
        options.appendChild(known);
        step.appendChild(options);
        return step;
    }

    function renderCredentialSetup(container) {
        const wizard = state.credentialSetup;
        const intro = element('div', 'credential-intro');
        intro.appendChild(element('div', 'credential-mark', 'SQL'));
        const introCopy = element('div');
        introCopy.appendChild(element('h2', null, 'Configure external storage access'));
        introCopy.appendChild(
            element(
                'p',
                null,
                'Provide a storage URL, then create the credential and external data source for your SQL platform.',
            ),
        );
        intro.appendChild(introCopy);
        container.appendChild(intro);
        container.appendChild(renderStorageSource());

        const steps = element('div', 'credential-steps');

        const platformStep = wizardStep(
            '2',
            'Target platform',
            'Choices are filtered for this SQL platform.',
        );
        platformStep.appendChild(
            selectControl(
                'SQL platform',
                'wizardPlatform',
                state.platforms,
                state.platform,
            ),
        );
        steps.appendChild(platformStep);

        const sourceOption = wizard.dataSourceOptions.find(function (option) {
            return option.id === wizard.dataSourceType;
        });
        const sourceStep = wizardStep(
            '3',
            'Detected external data source',
            state.storageUrl && sourceOption
                ? sourceOption.detail
                : 'Apply a storage URL to detect the storage service and connector.',
        );
        const detected = element('p', 'connector-prefix');
        detected.appendChild(element('span', null, 'Detected service'));
        detected.appendChild(
            element(
                'strong',
                null,
                state.storageUrl && sourceOption ? sourceOption.label : 'Waiting for URL',
            ),
        );
        sourceStep.appendChild(detected);
        const prefix = element('p', 'connector-prefix');
        prefix.appendChild(element('span', null, 'Generated connector'));
        prefix.appendChild(
            element('strong', null, state.storageUrl ? wizard.locationPrefix : '—'),
        );
        sourceStep.appendChild(prefix);
        steps.appendChild(sourceStep);

        const authOption = wizard.authOptions.find(function (option) {
            return option.id === wizard.authMethod;
        });
        const authStep = wizardStep(
            '4',
            'Authentication',
            authOption ? authOption.detail : '',
        );
        authStep.appendChild(
            selectControl(
                'Authentication method',
                'authMethod',
                wizard.authOptions,
                wizard.authMethod,
            ),
        );
        steps.appendChild(authStep);

        const objectStep = wizardStep(
            '5',
            'Object names',
            'Edit the generated database object names.',
        );
        const objectFields = element('div', 'wizard-object-fields');
        objectFields.appendChild(
            textControl('External data source name', 'dataSource', state.dataSource),
        );
        objectFields.appendChild(
            textControl(
                'Database scoped credential name',
                'credentialName',
                state.credentialName,
                'cred_' + (state.dataSource || 'storage'),
            ),
        );
        objectStep.appendChild(objectFields);
        steps.appendChild(objectStep);

        container.appendChild(steps);

        const flow = element('div', 'object-flow');
        [
            {
                number: '1',
                kind: 'Database scoped credential',
                name:
                    state.credentialName
                    || 'cred_' + (state.dataSource || 'storage'),
                status: authOption ? authOption.label : wizard.authMethod,
            },
            {
                number: '2',
                kind: 'External data source',
                name: state.dataSource || 'MyDataSource',
                status: wizard.locationPrefix + ' location',
            },
        ].forEach(function (object) {
            const card = element('div', 'object-card');
            card.appendChild(
                element('span', 'object-kind', object.number + '. ' + object.kind),
            );
            card.appendChild(element('strong', 'object-name', object.name));
            card.appendChild(element('span', 'object-status', object.status));
            flow.appendChild(card);
        });
        container.appendChild(flow);

        const note = element('aside', 'wizard-note');
        note.appendChild(element('strong', null, 'Platform guidance'));
        note.appendChild(element('p', null, wizard.note));
        note.appendChild(
            element(
                'p',
                'secret-note',
                'Secrets stay out of the extension; generated SQL uses placeholders.',
            ),
        );
        container.appendChild(note);

        renderLimitation(container);
        renderDocumentationLinks(container, state.quickAnalyze.documentation);
        renderSqlBlock(
            container,
            'credential_setup',
            (state.statements || {}).credential_setup,
        );
    }

    function renderPanel() {
        const panel = byId('panel');
        clear(panel);
        const tab = state.activeTab;
        if (tab === 'metadata') {
            renderMetadata(panel);
        } else if (tab === 'preview') {
            renderPreview(panel);
        } else if (tab === 'schema') {
            renderSchema(panel);
        } else if (tab === 'credential_setup') {
            renderCredentialSetup(panel);
        } else {
            renderStatement(panel, tab);
        }
    }

    function render() {
        if (!state) {
            return;
        }
        const focus = captureFocus();
        renderHeader();
        renderStatus();
        renderAzureConnection();
        renderAzureBrowser();
        renderFiles();
        renderTabs();
        renderPanel();
        restoreFocus(focus);
    }

    // -- events --------------------------------------------------------------

    document.addEventListener('click', function (event) {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        const fileItem = target.closest('.file-item');
        if (fileItem && fileItem.dataset.fileId) {
            post({ type: 'selectFile', fileId: fileItem.dataset.fileId });
            return;
        }

        const azureAccount = target.closest('[data-azure-account]');
        if (azureAccount && azureAccount.dataset.azureAccount) {
            post({
                type: 'azureBrowserSelectAccount',
                accountId: azureAccount.dataset.azureAccount,
            });
            return;
        }

        const azureEntry = target.closest('[data-azure-entry]');
        if (azureEntry && azureEntry.dataset.azureEntry) {
            post({
                type: 'azureBrowserOpenEntry',
                entryId: azureEntry.dataset.azureEntry,
            });
            return;
        }

        const azureCrumb = target.closest('[data-azure-depth]');
        if (azureCrumb && azureCrumb.dataset.azureDepth !== undefined) {
            post({
                type: 'azureBrowserNavigate',
                depth: Number(azureCrumb.dataset.azureDepth),
            });
            return;
        }

        const folder = target.closest('[data-folder-path]');
        if (folder && folder.dataset.folderPath) {
            // While filtering, every folder is force-expanded so matches stay
            // visible. Recording a toggle here would apply to state the user
            // cannot see and would surface later as folders they never
            // collapsed, so the click is ignored instead.
            if (fileFilter.trim() !== '') {
                return;
            }
            const folderPath = folder.dataset.folderPath;
            if (collapsedFolders.has(folderPath)) {
                collapsedFolders.delete(folderPath);
            } else {
                collapsedFolders.add(folderPath);
            }
            renderFiles();
            byId('file-list').focus({ preventScroll: true });
            return;
        }

        const tab = target.closest('.tab');
        if (tab && tab.dataset.tab) {
            post({ type: 'setTab', tab: tab.dataset.tab });
            return;
        }

        const sourceTab = target.closest('[data-source-tab]');
        if (sourceTab) {
            post({ type: 'setTab', tab: sourceTab.dataset.sourceTab });
            return;
        }

        const sqlAction = target.closest('[data-sql-action]');
        if (sqlAction) {
            const block = sqlAction.closest('.sql-block');
            const kind = block ? block.dataset.kind : null;
            if (kind) {
                post({
                    type:
                        sqlAction.dataset.sqlAction === 'copy'
                            ? 'copyStatement'
                            : 'openStatementInEditor',
                    kind: kind,
                });
            }
            return;
        }

        const documentation = target.closest('[data-documentation]');
        if (documentation) {
            post({ type: 'openDocumentation', id: documentation.dataset.documentation });
            return;
        }

        const action = target.closest('[data-action]');
        if (!action) {
            return;
        }
        const name = action.dataset.action;
        if (name === 'useStorageUrl') {
            const input = document.querySelector('.storage-url-input');
            pendingEdits.delete('knownStorageUrl');
            post({ type: 'setStorageUrl', value: input ? input.value.trim() : '' });
            return;
        }
        if (name === 'clearStorageUrl') {
            pendingEdits.delete('knownStorageUrl');
            post({ type: 'setStorageUrl', value: '' });
            return;
        }
        post({ type: name });
    });

    document.addEventListener('change', function (event) {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }
        if (target.id === 'platform') {
            post({ type: 'setPlatform', platform: target.value });
            return;
        }
        if (target.dataset && target.dataset.azureSelect === 'tenant') {
            post({
                type: 'azureBrowserSelectTenant',
                tenantId: target.value,
            });
            return;
        }
        if (target.dataset && target.dataset.azureSelect === 'subscription') {
            post({
                type: 'azureBrowserSelectSubscription',
                subscriptionId: target.value,
            });
            return;
        }
        if (target.id === 'azure-format-filter') {
            azureFormat = target.value;
            rerenderAzureBrowser();
            return;
        }
        const edit = target.dataset ? target.dataset.edit : null;
        if (edit === 'wizardPlatform') {
            post({ type: 'setPlatform', platform: target.value });
            return;
        }
        if (edit === 'authMethod') {
            post({ type: 'setAuthMethod', value: target.value });
            return;
        }
        if (target.dataset && target.dataset.parserOption) {
            const key = 'parser:' + target.dataset.parserOption;
            cancelDebounce(key);
            pendingEdits.delete(key);
            post({
                type: 'setParserOverride',
                fileId: state.selectedFileId,
                key: target.dataset.parserOption,
                value: target.value,
            });
            return;
        }
    });

    document.addEventListener('input', function (event) {
        const target = event.target;
        if (target instanceof Element && target.id === 'file-filter') {
            fileFilter = target.value;
            renderFiles();
            return;
        }
        if (target instanceof Element && target.id === 'azure-account-search') {
            azureAccountQuery = target.value;
            rerenderAzureBrowser();
            return;
        }
        if (target instanceof Element && target.id === 'azure-entry-search') {
            azureEntryQuery = target.value;
            rerenderAzureBrowser();
            return;
        }
        if (
            !(target instanceof Element) ||
            !target.dataset ||
            (!target.dataset.edit && !target.dataset.parserOption)
        ) {
            return;
        }
        const edit = target.dataset.edit;
        const value = target.value;

        if (target.dataset.parserOption) {
            const parserKey = target.dataset.parserOption;
            const fileId = state.selectedFileId;
            pendingEdits.set('parser:' + parserKey, value);
            debounce('parser:' + parserKey, function () {
                pendingEdits.delete('parser:' + parserKey);
                post({
                    type: 'setParserOverride',
                    fileId: fileId,
                    key: parserKey,
                    value: value,
                });
            }, 250);
            return;
        }

        if (edit === 'override') {
            const column = target.dataset.column;
            const fileId = state.selectedFileId;
            pendingEdits.set('override:' + column, value);
            debounce('override:' + column, function () {
                pendingEdits.delete('override:' + column);
                post({
                    type: 'setColumnOverride',
                    fileId: fileId,
                    column: column,
                    sqlType: value,
                });
            }, 250);
            return;
        }
        if (edit === 'previewRows') {
            const rows = Number(value);
            if (!isFinite(rows)) {
                return;
            }
            debounce('previewRows', function () {
                post({ type: 'setPreviewRows', rows: Math.trunc(rows) });
            }, 350);
            return;
        }
        if (edit === 'knownStorageUrl') {
            pendingEdits.set(edit, value);
            return;
        }

        const messageType = {
            tableName: 'setTableName',
            schemaName: 'setSchemaName',
            dataSource: 'setDataSource',
            credentialName: 'setCredentialName',
            formatName: 'setFormatName',
        }[edit];
        if (!messageType) {
            return;
        }
        pendingEdits.set(edit, value);
        debounce(edit, function () {
            pendingEdits.delete(edit);
            post({ type: messageType, value: value });
        }, 250);
    });

    document.addEventListener('keydown', function (event) {
        if (
            event.key === 'Enter'
            && event.target instanceof Element
            && event.target.matches('.storage-url-input')
        ) {
            event.preventDefault();
            pendingEdits.delete('knownStorageUrl');
            post({ type: 'setStorageUrl', value: event.target.value.trim() });
            return;
        }
        const list = byId('file-list');
        if (!list || !list.contains(event.target)) {
            return;
        }
        const items = visibleFileItems();
        if (items.length === 0) {
            return;
        }
        let index = items.findIndex(function (item) {
            return item.getAttribute('aria-selected') === 'true';
        });
        if (event.key === 'ArrowDown') {
            index = Math.min(items.length - 1, index + 1);
        } else if (event.key === 'ArrowUp') {
            index = Math.max(0, index - 1);
        } else if (event.key === 'Home') {
            index = 0;
        } else if (event.key === 'End') {
            index = items.length - 1;
        } else {
            return;
        }
        event.preventDefault();
        post({ type: 'selectFile', fileId: items[index].dataset.fileId });
    });

    window.addEventListener('message', function (event) {
        const message = event.data;
        if (!message || message.type !== 'state' || !message.state) {
            return;
        }
        if (state && state.selectedFileId !== message.state.selectedFileId) {
            clearFileEdits();
        }
        state = message.state;
        render();
    });

    post({ type: 'ready' });
})();
