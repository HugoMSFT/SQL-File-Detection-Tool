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
    const restored = vscode.getState();
    const restoredViewState = restored && typeof restored === 'object' ? restored : {};

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

    const AZURE_FORMATS = [
        'all',
        'CSV',
        'TSV',
        'JSON',
        'JSONL',
        'NDJSON',
        'PARQUET',
        'ORC',
        'RC',
    ];

    function restoredText(value, maximumLength) {
        return typeof value === 'string' ? value.slice(0, maximumLength) : '';
    }

    function sanitizeStorageUrlDraft(value) {
        const text = restoredText(value, 4096);
        const query = text.indexOf('?');
        const fragment = text.indexOf('#');
        const suffixes = [query, fragment].filter(function (index) {
            return index >= 0;
        });
        return suffixes.length === 0 ? text : text.slice(0, Math.min.apply(null, suffixes));
    }

    let state = null;
    /** Values the user is mid-edit, so a state push cannot yank the caret. */
    const pendingEdits = new Map();
    const debounceTimers = new Map();
    const collapsedFolders = new Set(
        Array.isArray(restoredViewState.collapsedFolders)
            ? restoredViewState.collapsedFolders
                .filter(function (value) {
                    return typeof value === 'string';
                })
                .slice(0, 200)
            : [],
    );
    /** Renderer-only view state: the Explorer filter query and its source. */
    let fileFilter = restoredText(restoredViewState.fileFilter, 256);
    let lastSourceLabel = restoredText(restoredViewState.lastSourceLabel, 1024) || null;
    let azureSubscriptionQuery = restoredText(restoredViewState.azureSubscriptionQuery, 256);
    let azureAccountQuery = restoredText(restoredViewState.azureAccountQuery, 256);
    let azureEntryQuery = restoredText(restoredViewState.azureEntryQuery, 256);
    let azureFormat = AZURE_FORMATS.includes(restoredViewState.azureFormat)
        ? restoredViewState.azureFormat
        : 'all';
    let focusAzureLauncherAfterClose = false;
    const restoredStorageUrlDraft = sanitizeStorageUrlDraft(
        restoredViewState.storageUrlDraft,
    );
    if (restoredStorageUrlDraft) {
        pendingEdits.set('knownStorageUrl', restoredStorageUrlDraft);
    }
    const restoredPreviewRows = restoredText(restoredViewState.previewRowsDraft, 8);
    if (restoredPreviewRows) {
        pendingEdits.set('previewRows', restoredPreviewRows);
    }

    // -- helpers -------------------------------------------------------------

    function byId(id) {
        return document.getElementById(id);
    }

    function post(message) {
        vscode.postMessage(message);
    }

    function persistViewState() {
        vscode.setState({
            fileFilter: fileFilter,
            lastSourceLabel: lastSourceLabel,
            collapsedFolders: Array.from(collapsedFolders).slice(0, 200),
            azureSubscriptionQuery: azureSubscriptionQuery,
            azureAccountQuery: azureAccountQuery,
            azureEntryQuery: azureEntryQuery,
            azureFormat: azureFormat,
            storageUrlDraft: sanitizeStorageUrlDraft(
                pendingEdits.get('knownStorageUrl') || '',
            ),
            previewRowsDraft: restoredText(
                pendingEdits.get('previewRows'),
                8,
            ),
        });
    }

    function acknowledgePendingEdits(nextState) {
        const scalarFields = {
            tableName: 'tableName',
            schemaName: 'schemaName',
            dataSource: 'dataSource',
            credentialName: 'credentialName',
            formatName: 'formatName',
        };
        Object.keys(scalarFields).forEach(function (key) {
            if (
                pendingEdits.has(key)
                && String(nextState[scalarFields[key]] || '') === pendingEdits.get(key)
            ) {
                pendingEdits.delete(key);
            }
        });
        if (
            pendingEdits.has('previewRows')
            && String(nextState.previewRows) === pendingEdits.get('previewRows')
        ) {
            pendingEdits.delete('previewRows');
        }
        for (const key of Array.from(pendingEdits.keys())) {
            if (key.startsWith('parser:')) {
                const option = key.slice('parser:'.length);
                if (String(nextState.parserOverrides[option] ?? '') === pendingEdits.get(key)) {
                    pendingEdits.delete(key);
                }
            } else if (key.startsWith('override:')) {
                const column = key.slice('override:'.length);
                if (String(nextState.columnOverrides[column] ?? '') === pendingEdits.get(key)) {
                    pendingEdits.delete(key);
                }
            }
        }
        persistViewState();
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
        persistViewState();
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

    function azureSubscriptionSelect(items, selected) {
        const field = element('label', 'field azure-identity-field azure-subscription-field');
        field.appendChild(element('span', null, 'Subscription'));

        const search = document.createElement('input');
        search.id = 'azure-subscription-search';
        search.type = 'search';
        search.placeholder = 'Search subscriptions';
        search.autocomplete = 'off';
        search.spellcheck = false;
        search.value = azureSubscriptionQuery;
        search.disabled = state.azure.phase === 'loading' || items.length === 0;
        search.setAttribute('aria-label', 'Search subscriptions');
        field.appendChild(search);

        const query = azureSubscriptionQuery.trim().toLocaleLowerCase();
        const filtered = items.filter(function (item) {
            return (
                !query
                || item.id === selected
                || item.label.toLocaleLowerCase().includes(query)
            );
        });
        const select = document.createElement('select');
        select.id = 'azure-browser-subscription';
        select.dataset.azureSelect = 'subscription';
        filtered.forEach(function (item) {
            const option = element('option', null, item.label);
            option.value = item.id;
            option.selected = item.id === selected;
            select.appendChild(option);
        });
        select.disabled = state.azure.phase === 'loading' || filtered.length === 0;
        field.appendChild(select);

        if (query) {
            const matchCount = filtered.filter(function (item) {
                return item.label.toLocaleLowerCase().includes(query);
            }).length;
            field.appendChild(
                element(
                    'span',
                    'azure-subscription-count',
                    matchCount + ' of ' + items.length + ' subscriptions',
                ),
            );
        }
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
        const azure = state.azure;
        browser.hidden = !azure.open;
        standard.hidden = azure.open;
        if (!azure.open) {
            return;
        }
        clear(browser);

        if (azure.phase === 'signedOut') {
            const signedOut = azureStateCard(
                'Browse Azure Storage',
                'Connect with VS Code Microsoft authentication to browse Azure public cloud read-only.',
                'Connect to Azure',
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
                actionButton('Close', 'azureBrowserClose', 'btn subtle'),
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
            azureSubscriptionSelect(
                azure.subscriptions,
                azure.selectedSubscriptionId,
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
        if (azure.path.length > 0) {
            const folderActions = element('div', 'azure-folder-actions');
            folderActions.appendChild(
                actionButton(
                    'Use this folder for setup',
                    'azureBrowserUseCurrentFolder',
                    'btn primary',
                ),
            );
            folderActions.appendChild(
                element(
                    'span',
                    'help',
                    'Uses this folder URL and lists its contents without downloading files.',
                ),
            );
            browsePane.appendChild(folderActions);
        }

        if (azure.phase === 'error') {
            const storageConsent = azure.errorKind === 'storageConsent';
            let title = 'Could not list this Azure location';
            if (azure.errorKind === 'controlAccess') {
                title = 'Azure management access denied';
            } else if (storageConsent) {
                title = 'Authorize Storage browsing';
            } else if (azure.errorKind === 'dataAccess') {
                title = 'Storage data access denied';
            }
            browsePane.appendChild(
                azureStateCard(
                    title,
                    azure.message || 'Retry the request or choose another account.',
                    storageConsent ? 'Authorize storage access' : 'Retry',
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
        AZURE_FORMATS.forEach(function (value) {
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
            collapsedFolders.clear();
            persistViewState();
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
        if (state.azureFolderPreview) {
            const folder = state.azureFolderPreview;
            const summary = element('section', 'azure-folder-preview');
            summary.appendChild(element('h2', null, folder.label));
            summary.appendChild(
                element(
                    'p',
                    'help',
                    'Azure folder setup · files are listed from metadata only and are not downloaded.',
                ),
            );
            summary.appendChild(element('code', 'azure-folder-url', folder.url));
            container.appendChild(summary);

            const scroll = element('div', 'table-scroll');
            const table = document.createElement('table');
            const caption = element(
                'caption',
                null,
                'Showing ' + folder.items.length + ' browsed items'
                    + (folder.truncated ? ' · more items are available' : ''),
            );
            table.appendChild(caption);
            const thead = document.createElement('thead');
            const headRow = document.createElement('tr');
            ['Name', 'Kind', 'Format', 'Size', 'Modified'].forEach(function (label) {
                const cell = element('th', null, label);
                cell.scope = 'col';
                headRow.appendChild(cell);
            });
            thead.appendChild(headRow);
            table.appendChild(thead);
            const tbody = document.createElement('tbody');
            folder.items.forEach(function (item) {
                const row = document.createElement('tr');
                [
                    item.name,
                    item.kind,
                    item.format || '—',
                    item.sizeBytes === null ? '—' : formatBytes(item.sizeBytes),
                    item.modifiedAt ? new Date(item.modifiedAt).toLocaleString() : '—',
                ].forEach(function (value) {
                    row.appendChild(element('td', null, value));
                });
                tbody.appendChild(row);
            });
            table.appendChild(tbody);
            scroll.appendChild(table);
            container.appendChild(scroll);
            return;
        }
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
                element(
                    'p',
                    'empty',
                    state.remoteSchema && state.remoteSchema.status === 'format_required'
                        ? 'Choose a file format before generating SQL for this folder.'
                        : 'Analyze a file to generate this statement.',
                ),
            );
            return;
        }
        const block = template('tpl-sql');
        block.dataset.kind = kind;
        if (kind === 'credential_setup') {
            block.querySelector('[data-sql-action="copy"]').textContent =
                'Copy full T-SQL';
            block.querySelector('[data-sql-action="open"]').textContent =
                'Open in MSSQL editor';
            block.querySelector('[data-sql-action="open"]').classList.add('primary');
        }
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
        if (selected === null || selected === undefined || selected === '') {
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = 'Choose an option';
            placeholder.disabled = true;
            placeholder.selected = true;
            select.appendChild(placeholder);
        }
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
        known.appendChild(
            element(
                'h4',
                null,
                state.storageUrl ? 'Selected storage location' : 'Provide a storage location',
            ),
        );
        known.appendChild(
            element(
                'p',
                'source-option-detail',
                state.storageUrl
                    ? 'Ready to generate the complete script for the selected goal.'
                    : 'Use an abs://, adls://, or abfss:// location. Azure HTTPS and s3:// locations remain supported.',
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
        urlInput.readOnly = state.sourceKind === 'azure';
        urlLabel.appendChild(urlInput);
        known.appendChild(urlLabel);
        const urlActions = element('div', 'storage-url-actions');
        urlActions.appendChild(
            state.sourceKind === 'azure'
                ? actionButton('Change Azure selection', 'openAzureBrowser', 'btn')
                : actionButton('Use URL', 'useStorageUrl', 'btn primary'),
        );
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

        const steps = element('div', 'credential-steps');
        const goalStep = wizardStep(
            '1',
            'Goal',
            'Choose the SQL operation you want to configure.',
        );
        goalStep.classList.add('storage-goal-step');
        const goals = [
            {
                id: 'create_external_table',
                label: 'External Table',
                detail: 'Create a persistent virtual table over the file.',
            },
            {
                id: 'openrowset',
                label: 'OPENROWSET',
                detail: 'Query the file directly without creating a table.',
            },
            {
                id: 'bulk_insert',
                label: 'BULK INSERT',
                detail: 'Load delimited rows into an existing table.',
            },
        ];
        const goalOptions = element('div', 'storage-goal-options');
        goals.forEach(function (goal) {
            const label = element(
                'label',
                'storage-goal-option'
                    + (state.storageGoal === goal.id ? ' selected' : ''),
            );
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = 'storage-goal';
            input.value = goal.id;
            input.dataset.edit = 'storageGoal';
            input.checked = state.storageGoal === goal.id;
            label.appendChild(input);
            const copy = element('span');
            copy.appendChild(element('strong', null, goal.label));
            copy.appendChild(element('small', null, goal.detail));
            label.appendChild(copy);
            goalOptions.appendChild(label);
        });
        goalStep.appendChild(goalOptions);
        steps.appendChild(goalStep);

        const sourceStep = renderStorageSource();
        sourceStep.querySelector('.wizard-step-number').textContent = '2';
        steps.appendChild(sourceStep);

        if (state.remoteSchema) {
            const schemaState = element(
                'section',
                'remote-schema-state'
                    + (state.remoteSchema.status === 'format_required'
                        ? ' blocking'
                        : ''),
            );
            schemaState.setAttribute('role', 'alert');
            schemaState.appendChild(
                element(
                    'h3',
                    null,
                    state.remoteSchema.status === 'format_required'
                        ? 'Format selection required'
                        : 'Remote schema has not been analyzed',
                ),
            );
            schemaState.appendChild(element('p', null, state.remoteSchema.message));
            schemaState.appendChild(
                element(
                    'p',
                    'remote-schema-impact',
                    state.remoteSchema.status === 'format_required'
                        ? 'SQL generation is blocked to prevent a mixed-folder guess.'
                        : 'Generated schema-bound SQL contains a placeholder column and is not ready to execute until you replace it with the real schema.',
                ),
            );
            if (state.remoteSchema.formats.length > 1) {
                schemaState.appendChild(
                    selectControl(
                        'File format to target',
                        'azureFolderFormat',
                        state.remoteSchema.formats.map(function (format) {
                            return {
                                id: format,
                                label: format.toUpperCase(),
                            };
                        }),
                        state.remoteSchema.selectedFormat,
                    ),
                );
            }
            steps.appendChild(schemaState);
        }

        const platformStep = wizardStep(
            '3',
            'Platform and authentication',
            'Choose where the script will run and how SQL will access storage.',
        );
        const accessFields = element('div', 'wizard-object-fields');
        accessFields.appendChild(
            selectControl(
                'SQL platform',
                'wizardPlatform',
                state.platforms,
                state.platform,
            ),
        );
        const authOption = wizard.authOptions.find(function (option) {
            return option.id === wizard.authMethod;
        });
        accessFields.appendChild(
            selectControl(
                'Authentication method',
                'authMethod',
                wizard.authOptions,
                wizard.authMethod,
            ),
        );
        platformStep.appendChild(accessFields);
        const connectorSummary = element('p', 'connector-summary');
        connectorSummary.textContent = state.storageUrl
            ? 'Connector: '
                + (state.storageGoal === 'bulk_insert'
                    ? 'HTTPS + BLOB_STORAGE'
                    : wizard.locationPrefix)
                + (authOption ? ' · ' + authOption.label : '')
            : 'Add a storage source to determine the connector.';
        platformStep.appendChild(connectorSummary);
        steps.appendChild(platformStep);

        const objectStep = wizardStep(
            '4',
            'Object names',
            'Optional advanced names for generated database objects.',
        );
        objectStep.classList.add('advanced-object-step');
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
        container.appendChild(
            element(
                'h2',
                'generated-goal-heading',
                state.remoteSchema && state.remoteSchema.status === 'not_analyzed'
                    ? 'T-SQL template for selected goal'
                    : 'Complete T-SQL for selected goal',
            ),
        );
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
        renderAzureBrowser();
        renderFiles();
        renderTabs();
        renderPanel();
        restoreFocus(focus);
        if (focusAzureLauncherAfterClose && !state.azure.open) {
            focusAzureLauncherAfterClose = false;
            const launcher = document.querySelector('[data-action="openAzureBrowser"]');
            if (launcher instanceof HTMLElement) {
                launcher.focus({ preventScroll: true });
            }
        }
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
            persistViewState();
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
        if (name === 'azureBrowserClose') {
            focusAzureLauncherAfterClose = true;
        }
        if (name === 'useStorageUrl') {
            const input = document.querySelector('.storage-url-input');
            pendingEdits.delete('knownStorageUrl');
            persistViewState();
            post({ type: 'setStorageUrl', value: input ? input.value.trim() : '' });
            return;
        }
        if (name === 'clearStorageUrl') {
            pendingEdits.delete('knownStorageUrl');
            persistViewState();
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
            persistViewState();
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
        if (edit === 'storageGoal') {
            post({ type: 'setStorageGoal', value: target.value });
            return;
        }
        if (edit === 'azureFolderFormat') {
            post({ type: 'setAzureFolderFormat', value: target.value });
            return;
        }
        if (target.dataset && target.dataset.parserOption) {
            const key = 'parser:' + target.dataset.parserOption;
            cancelDebounce(key);
            pendingEdits.delete(key);
            persistViewState();
            post({
                type: 'setParserOverride',
                fileId: state.selectedFileId,
                key: target.dataset.parserOption,
                value: target.value,
            });
            return;
        }
        if (edit === 'previewRows') {
            const rows = Number(target.value);
            if (isFinite(rows)) {
                cancelDebounce('previewRows');
                pendingEdits.delete('previewRows');
                persistViewState();
                post({ type: 'setPreviewRows', rows: Math.trunc(rows) });
            }
            return;
        }
    });

    document.addEventListener('input', function (event) {
        const target = event.target;
        if (target instanceof Element && target.id === 'file-filter') {
            const value = target.value;
            fileFilter = value;
            persistViewState();
            renderFiles();
            post({ type: 'setFileFilter', value: value });
            return;
        }
        if (target instanceof Element && target.id === 'azure-account-search') {
            azureAccountQuery = target.value;
            persistViewState();
            rerenderAzureBrowser();
            return;
        }
        if (target instanceof Element && target.id === 'azure-subscription-search') {
            azureSubscriptionQuery = target.value;
            persistViewState();
            rerenderAzureBrowser();
            return;
        }
        if (target instanceof Element && target.id === 'azure-entry-search') {
            azureEntryQuery = target.value;
            persistViewState();
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
            post({
                type: 'setParserOverride',
                fileId: fileId,
                key: parserKey,
                value: value,
            });
            return;
        }

        if (edit === 'override') {
            const column = target.dataset.column;
            const fileId = state.selectedFileId;
            pendingEdits.set('override:' + column, value);
            post({
                type: 'setColumnOverride',
                fileId: fileId,
                column: column,
                sqlType: value,
            });
            return;
        }
        if (edit === 'previewRows') {
            const rows = Number(value);
            if (!isFinite(rows)) {
                return;
            }
            pendingEdits.set('previewRows', value);
            persistViewState();
            debounce('previewRows', function () {
                pendingEdits.delete('previewRows');
                persistViewState();
                post({ type: 'setPreviewRows', rows: Math.trunc(rows) });
            }, 350);
            return;
        }
        if (edit === 'knownStorageUrl') {
            pendingEdits.set(edit, value);
            persistViewState();
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
        post({ type: messageType, value: value });
    });

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && state && state.azure.open) {
            event.preventDefault();
            focusAzureLauncherAfterClose = true;
            post({ type: 'azureBrowserClose' });
            return;
        }
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
        acknowledgePendingEdits(message.state);
        fileFilter = message.state.fileFilter || '';
        state = message.state;
        render();
    });

    post({ type: 'ready' });
})();
