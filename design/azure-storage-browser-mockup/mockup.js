/*
 * Visual-only Azure Storage browser concept.
 *
 * All data is defined below and all interactions stay in this document. The
 * accompanying CSP also disables outbound connections.
 */

/* eslint-env browser */
(function () {
    'use strict';

    function file(name, format, size, modified) {
        return { type: 'file', name: name, format: format, size: size, modified: modified };
    }

    function folder(name, modified, children) {
        return { type: 'folder', name: name, modified: modified, children: children };
    }

    function container(name, modified, children) {
        return {
            type: 'container',
            name: name,
            access: 'Private',
            modified: modified,
            children: children,
        };
    }

    const ACCOUNTS = {
        sqldetectlandingdev: {
            id: 'sqldetectlandingdev',
            name: 'sqldetectlandingdev',
            resourceGroup: 'rg-sqldetect-dev',
            region: 'East US 2',
            kind: 'Blob Storage',
            hns: false,
            redundancy: 'LRS',
            defaultState: 'ready',
            containers: [
                container('incoming', 'Sep 2, 2026', [
                    folder('2026', 'Sep 2, 2026', [
                        folder('09', 'Sep 2, 2026', [
                            file('sales_orders_2026-09-01.csv', 'CSV', '18.6 MB', 'Sep 2, 2026, 08:42'),
                            file('sales_orders_2026-09-02.parquet', 'Parquet', '7.4 MB', 'Sep 2, 2026, 17:18'),
                            file('web_events_2026-09-02.jsonl', 'NDJSON', '42.1 MB', 'Sep 2, 2026, 17:05'),
                        ]),
                        folder('08', 'Aug 31, 2026', [
                            file('sales_orders_2026-08-31.csv', 'CSV', '17.9 MB', 'Aug 31, 2026, 23:48'),
                            file('returns_2026-08.orc', 'ORC', '4.8 MB', 'Aug 31, 2026, 22:14'),
                        ]),
                    ]),
                    folder('reference', 'Aug 28, 2026', [
                        file('product_catalog.json', 'JSON', '846 KB', 'Aug 28, 2026, 10:31'),
                        file('region_codes.csv', 'CSV', '14 KB', 'Aug 20, 2026, 14:02'),
                    ]),
                    file('drop_manifest.json', 'JSON', '3 KB', 'Sep 2, 2026, 17:20'),
                ]),
                container('curated', 'Sep 2, 2026', [
                    folder('sales', 'Sep 2, 2026', [
                        file('daily_sales.parquet', 'Parquet', '12.2 MB', 'Sep 2, 2026, 17:31'),
                        file('sales_summary.csv', 'CSV', '2.4 MB', 'Sep 2, 2026, 17:32'),
                    ]),
                    folder('inventory', 'Sep 1, 2026', [
                        file('inventory_snapshot.parquet', 'Parquet', '5.7 MB', 'Sep 1, 2026, 21:00'),
                    ]),
                ]),
                container('schemas', 'Aug 30, 2026', [
                    file('orders.schema.json', 'JSON', '8 KB', 'Aug 30, 2026, 12:10'),
                    file('events.schema.json', 'JSON', '11 KB', 'Aug 30, 2026, 12:11'),
                ]),
            ],
        },
        fabrikamlakehouse: {
            id: 'fabrikamlakehouse',
            name: 'fabrikamlakehouse',
            resourceGroup: 'rg-data-platform-nonprod',
            region: 'West US 2',
            kind: 'ADLS Gen2',
            hns: true,
            redundancy: 'ZRS',
            defaultState: 'ready',
            containers: [
                container('landing', 'Sep 2, 2026', [
                    folder('commerce', 'Sep 2, 2026', [
                        folder('orders', 'Sep 2, 2026', [
                            file('orders_0001.parquet', 'Parquet', '64.8 MB', 'Sep 2, 2026, 16:44'),
                            file('orders_0002.parquet', 'Parquet', '61.3 MB', 'Sep 2, 2026, 16:44'),
                            file('orders_quarantine.csv', 'CSV', '928 KB', 'Sep 2, 2026, 16:46'),
                        ]),
                        folder('customers', 'Sep 2, 2026', [
                            file('customers_current.parquet', 'Parquet', '28.9 MB', 'Sep 2, 2026, 15:30'),
                            file('customer_changes.jsonl', 'NDJSON', '6.2 MB', 'Sep 2, 2026, 15:31'),
                        ]),
                    ]),
                    folder('telemetry', 'Sep 1, 2026', [
                        file('sensor_readings.orc', 'ORC', '83.5 MB', 'Sep 1, 2026, 23:57'),
                    ]),
                ]),
                container('standardized', 'Sep 2, 2026', [
                    folder('finance', 'Sep 2, 2026', [
                        file('ledger_entries.parquet', 'Parquet', '114.2 MB', 'Sep 2, 2026, 12:04'),
                        file('currency_rates.csv', 'CSV', '61 KB', 'Sep 2, 2026, 08:00'),
                    ]),
                    folder('operations', 'Sep 1, 2026', [
                        file('shipments.parquet', 'Parquet', '39.7 MB', 'Sep 1, 2026, 20:26'),
                    ]),
                ]),
                container('sandbox', 'Aug 29, 2026', [
                    folder('avery', 'Aug 29, 2026', [
                        file('format_comparison.tsv', 'TSV', '2.8 MB', 'Aug 29, 2026, 16:11'),
                        file('nested_orders.json', 'JSON', '5.1 MB', 'Aug 29, 2026, 16:12'),
                    ]),
                ]),
            ],
        },
        northwindarchive: {
            id: 'northwindarchive',
            name: 'northwindarchive',
            resourceGroup: 'rg-records-central',
            region: 'Central US',
            kind: 'Blob Storage',
            hns: false,
            redundancy: 'GRS',
            defaultState: 'denied',
            containers: [
                container('records', 'Aug 31, 2026', [
                    folder('orders', 'Aug 31, 2026', [
                        file('orders_2025.parquet', 'Parquet', '782.4 MB', 'Jan 4, 2026, 02:00'),
                    ]),
                ]),
            ],
        },
        wingtipretrylab: {
            id: 'wingtipretrylab',
            name: 'wingtipretrylab',
            resourceGroup: 'rg-resilience-lab',
            region: 'North Europe',
            kind: 'ADLS Gen2',
            hns: true,
            redundancy: 'LRS',
            defaultState: 'error',
            containers: [
                container('experiments', 'Sep 2, 2026', [
                    file('retry_sample.parquet', 'Parquet', '1.6 MB', 'Sep 2, 2026, 09:14'),
                ]),
            ],
        },
        adventureworksraw: {
            id: 'adventureworksraw',
            name: 'adventureworksraw',
            resourceGroup: 'rg-adventureworks-data',
            region: 'West Europe',
            kind: 'ADLS Gen2',
            hns: true,
            redundancy: 'GZRS',
            defaultState: 'ready',
            containers: [
                container('raw', 'Sep 2, 2026', [
                    folder('manufacturing', 'Sep 2, 2026', [
                        file('work_orders.parquet', 'Parquet', '34.7 MB', 'Sep 2, 2026, 06:40'),
                        file('product_inventory.csv', 'CSV', '9.3 MB', 'Sep 2, 2026, 06:41'),
                    ]),
                    folder('sales', 'Sep 2, 2026', [
                        file('sales_transactions.parquet', 'Parquet', '91.5 MB', 'Sep 2, 2026, 07:15'),
                    ]),
                ]),
                container('quality', 'Sep 1, 2026', [
                    file('inspection_events.jsonl', 'NDJSON', '15.8 MB', 'Sep 1, 2026, 19:33'),
                ]),
            ],
        },
        contosobiarchive: {
            id: 'contosobiarchive',
            name: 'contosobiarchive',
            resourceGroup: 'rg-bi-shared',
            region: 'UK South',
            kind: 'Blob Storage',
            hns: false,
            redundancy: 'RA-GRS',
            defaultState: 'ready',
            containers: [
                container('exports', 'Sep 1, 2026', [
                    folder('power-bi', 'Sep 1, 2026', [
                        file('semantic_model_export.json', 'JSON', '320 KB', 'Sep 1, 2026, 18:05'),
                        file('finance_extract.csv', 'CSV', '21.4 MB', 'Sep 1, 2026, 18:06'),
                    ]),
                ]),
            ],
        },
        contosolakepreview: {
            id: 'contosolakepreview',
            name: 'contosolakepreview',
            resourceGroup: 'rg-contoso-analytics-lab',
            region: 'Australia East',
            kind: 'ADLS Gen2',
            hns: true,
            redundancy: 'LRS',
            defaultState: 'ready',
            containers: [
                container('demo', 'Sep 2, 2026', [
                    folder('retail', 'Sep 2, 2026', [
                        file('store_sales.parquet', 'Parquet', '13.9 MB', 'Sep 2, 2026, 11:44'),
                        file('stores.csv', 'CSV', '128 KB', 'Sep 2, 2026, 11:45'),
                    ]),
                    file('readme_data.json', 'JSON', '6 KB', 'Sep 2, 2026, 11:42'),
                ]),
            ],
        },
    };

    const TENANTS = [
        {
            id: 'fabrikam-demo',
            name: 'Fabrikam Demo',
            domain: 'fabrikam.example',
            subscriptions: [
                {
                    id: 'engineering-sandbox',
                    name: 'Engineering Sandbox',
                    sampleId: '00000000-0000-0000-0000-000000000101',
                    accountIds: [
                        'sqldetectlandingdev',
                        'fabrikamlakehouse',
                        'northwindarchive',
                        'wingtipretrylab',
                    ],
                },
                {
                    id: 'data-platform-nonprod',
                    name: 'Data Platform - Nonprod',
                    sampleId: '00000000-0000-0000-0000-000000000202',
                    accountIds: ['adventureworksraw', 'contosobiarchive'],
                },
            ],
        },
        {
            id: 'contoso-lab',
            name: 'Contoso Lab',
            domain: 'contoso.example',
            subscriptions: [
                {
                    id: 'analytics-preview',
                    name: 'Analytics Preview',
                    sampleId: '00000000-0000-0000-0000-000000000303',
                    accountIds: ['contosolakepreview'],
                },
            ],
        },
    ];

    const ui = {
        signedOut: byId('signed-out-view'),
        signedIn: byId('signed-in-view'),
        connectButton: byId('connect-button'),
        connectProgress: byId('connect-progress'),
        disconnectButton: byId('disconnect-button'),
        tenantSelect: byId('tenant-select'),
        subscriptionSelect: byId('subscription-select'),
        demoStateSelect: byId('demo-state-select'),
        resetDemoButton: byId('reset-demo-button'),
        accountSearch: byId('account-search'),
        clearAccountSearch: byId('clear-account-search'),
        accountList: byId('account-list'),
        accountCount: byId('account-count'),
        accountEmpty: byId('account-empty'),
        accountResourceGroup: byId('account-resource-group'),
        browserHeading: byId('browser-heading'),
        accountKindBadge: byId('account-kind-badge'),
        accountRegionBadge: byId('account-region-badge'),
        breadcrumbs: byId('breadcrumbs'),
        backButton: byId('back-button'),
        fileSearch: byId('file-search'),
        formatFilter: byId('format-filter'),
        entryList: byId('entry-list'),
        browseState: byId('browse-state'),
        detailsPlaceholder: byId('details-placeholder'),
        sourceDetails: byId('source-details'),
        selectedFileName: byId('selected-file-name'),
        selectedAccount: byId('selected-account'),
        selectedContainer: byId('selected-container'),
        selectedFormat: byId('selected-format'),
        selectedSize: byId('selected-size'),
        selectedModified: byId('selected-modified'),
        schemeSelect: byId('scheme-select'),
        sourceLocation: byId('source-location'),
        useFileButton: byId('use-file-button'),
        selectionConfirmation: byId('selection-confirmation'),
        confirmationCopy: byId('confirmation-copy'),
        toast: byId('toast'),
    };

    const state = {
        tenantId: TENANTS[0].id,
        subscriptionId: TENANTS[0].subscriptions[0].id,
        accountId: null,
        path: [],
        selected: null,
        scheme: 'abs',
        demoState: 'ready',
        injectedEmptySearch: false,
        toastTimer: null,
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function clear(node) {
        while (node.firstChild) {
            node.removeChild(node.firstChild);
        }
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

    function listItem(node, className) {
        const item = element('div', className || '');
        item.setAttribute('role', 'listitem');
        item.appendChild(node);
        return item;
    }

    function currentTenant() {
        return TENANTS.find(function (tenant) {
            return tenant.id === state.tenantId;
        }) || TENANTS[0];
    }

    function currentSubscription() {
        const tenant = currentTenant();
        return tenant.subscriptions.find(function (subscription) {
            return subscription.id === state.subscriptionId;
        }) || tenant.subscriptions[0];
    }

    function currentAccounts() {
        return currentSubscription().accountIds.map(function (accountId) {
            return ACCOUNTS[accountId];
        });
    }

    function currentAccount() {
        return state.accountId ? ACCOUNTS[state.accountId] : null;
    }

    function populateTenants() {
        clear(ui.tenantSelect);
        TENANTS.forEach(function (tenant) {
            const option = element('option', '', tenant.name + ' · ' + tenant.domain);
            option.value = tenant.id;
            option.selected = tenant.id === state.tenantId;
            ui.tenantSelect.appendChild(option);
        });
    }

    function populateSubscriptions() {
        const tenant = currentTenant();
        if (!tenant.subscriptions.some(function (subscription) {
            return subscription.id === state.subscriptionId;
        })) {
            state.subscriptionId = tenant.subscriptions[0].id;
        }

        clear(ui.subscriptionSelect);
        tenant.subscriptions.forEach(function (subscription) {
            const option = element('option', '', subscription.name);
            option.value = subscription.id;
            option.title = 'Sample subscription ' + subscription.sampleId;
            option.selected = subscription.id === state.subscriptionId;
            ui.subscriptionSelect.appendChild(option);
        });
    }

    function connect() {
        ui.connectButton.disabled = true;
        ui.connectProgress.hidden = false;
        ui.connectProgress.textContent = '';
        const spinner = element('span', 'spinner');
        spinner.setAttribute('aria-hidden', 'true');
        ui.connectProgress.appendChild(spinner);
        ui.connectProgress.appendChild(document.createTextNode('Simulating Microsoft Entra sign-in…'));

        window.setTimeout(function () {
            populateTenants();
            populateSubscriptions();
            state.accountId = currentAccounts()[0].id;
            state.path = [];
            state.selected = null;
            setDemoState('ready', false);
            ui.signedOut.hidden = true;
            ui.signedIn.hidden = false;
            ui.connectProgress.hidden = true;
            ui.connectButton.disabled = false;
            renderAll();
            ui.accountSearch.focus();
            announce('Simulated sign-in complete. No Azure request was made.');
        }, 650);
    }

    function disconnect() {
        state.path = [];
        state.selected = null;
        state.accountId = null;
        ui.accountSearch.value = '';
        ui.fileSearch.value = '';
        ui.formatFilter.value = 'all';
        ui.signedIn.hidden = true;
        ui.signedOut.hidden = false;
        ui.connectButton.focus();
        announce('Disconnected from the simulated identity.');
    }

    function resetForScopeChange() {
        const accounts = currentAccounts();
        state.accountId = accounts.length > 0 ? accounts[0].id : null;
        state.path = [];
        state.selected = null;
        state.scheme = currentAccount() && currentAccount().hns ? 'adls' : 'abs';
        ui.accountSearch.value = '';
        ui.fileSearch.value = '';
        ui.formatFilter.value = 'all';
        state.injectedEmptySearch = false;
        setDemoState(currentAccount() ? currentAccount().defaultState : 'ready', false);
        renderAll();
    }

    function selectAccount(accountId) {
        const account = ACCOUNTS[accountId];
        if (!account) {
            return;
        }
        state.accountId = accountId;
        state.path = [];
        state.selected = null;
        state.scheme = account.hns ? 'adls' : 'abs';
        ui.fileSearch.value = '';
        ui.formatFilter.value = 'all';
        state.injectedEmptySearch = false;
        setDemoState(account.defaultState, false);
        renderAll();
        announce(
            account.name + ' selected. '
            + (account.defaultState === 'ready'
                ? 'Showing containers.'
                : 'Showing the ' + readableDemoState(account.defaultState) + ' example.'),
        );
    }

    function renderAll() {
        renderAccountList();
        renderBrowser();
        renderDetails();
    }

    function normalize(value) {
        return String(value || '').trim().toLowerCase();
    }

    function renderAccountList() {
        const query = normalize(ui.accountSearch.value);
        const accounts = currentAccounts().filter(function (account) {
            const searchable = [
                account.name,
                account.resourceGroup,
                account.region,
                account.kind,
            ].join(' ').toLowerCase();
            return searchable.includes(query);
        });

        clear(ui.accountList);
        ui.accountCount.textContent = String(accounts.length);
        ui.accountEmpty.hidden = accounts.length !== 0;
        ui.accountList.hidden = accounts.length === 0;

        accounts.forEach(function (account) {
            const button = element('button', 'account-card');
            button.type = 'button';
            button.setAttribute('aria-pressed', String(account.id === state.accountId));
            button.setAttribute(
                'aria-label',
                account.name + ', ' + account.kind + ', ' + account.resourceGroup + ', ' + account.region,
            );
            button.addEventListener('click', function () {
                selectAccount(account.id);
            });

            const icon = element('span', 'storage-icon' + (account.hns ? ' hns' : ''));
            icon.setAttribute('aria-hidden', 'true');
            button.appendChild(icon);
            button.appendChild(element('strong', '', account.name));
            button.appendChild(element('span', 'account-kind', account.kind));

            const meta = element('span', 'account-meta');
            meta.appendChild(element('span', '', account.resourceGroup));
            meta.appendChild(element('span', '', account.region));
            button.appendChild(meta);

            if (account.defaultState === 'denied') {
                button.appendChild(element('span', 'account-health denied', 'No data role'));
            } else if (account.defaultState === 'error') {
                button.appendChild(element('span', 'account-health', 'Retry example'));
            }

            ui.accountList.appendChild(listItem(button, 'account-list-item'));
        });
    }

    function renderBrowser() {
        const account = currentAccount();
        if (!account) {
            ui.accountResourceGroup.textContent = 'Resource group';
            ui.browserHeading.textContent = 'Select a storage account';
            ui.accountKindBadge.textContent = '';
            ui.accountRegionBadge.textContent = '';
            ui.backButton.disabled = true;
            clear(ui.breadcrumbs);
            clear(ui.entryList);
            return;
        }

        ui.accountResourceGroup.textContent = account.resourceGroup + ' · ' + account.redundancy;
        ui.browserHeading.textContent = account.name;
        ui.accountKindBadge.textContent = account.kind;
        ui.accountRegionBadge.textContent = account.region;
        ui.backButton.disabled = state.path.length === 0 || state.demoState !== 'ready';
        renderBreadcrumbs(account);

        if (state.demoState === 'loading') {
            renderLoadingState();
            return;
        }
        if (state.demoState === 'denied') {
            renderDeniedState();
            return;
        }
        if (state.demoState === 'error') {
            renderErrorState();
            return;
        }

        renderEntries(account);
    }

    function renderBreadcrumbs(account) {
        clear(ui.breadcrumbs);
        appendBreadcrumb(
            account.name,
            state.path.length === 0,
            function () {
                state.path = [];
                renderBrowser();
            },
        );

        state.path.forEach(function (segment, index) {
            ui.breadcrumbs.appendChild(element('span', 'breadcrumb-separator', '›'));
            appendBreadcrumb(
                segment,
                index === state.path.length - 1,
                function () {
                    state.path = state.path.slice(0, index + 1);
                    renderBrowser();
                },
            );
        });
    }

    function appendBreadcrumb(label, current, onClick) {
        if (current) {
            const span = element('span', 'breadcrumb-current', label);
            span.setAttribute('aria-current', 'location');
            ui.breadcrumbs.appendChild(span);
            return;
        }
        const button = element('button', 'breadcrumb-button', label);
        button.type = 'button';
        button.addEventListener('click', onClick);
        ui.breadcrumbs.appendChild(button);
    }

    function entriesAtPath(account) {
        if (state.path.length === 0) {
            return account.containers;
        }

        let node = account.containers.find(function (candidate) {
            return candidate.name === state.path[0];
        });
        for (let index = 1; node && index < state.path.length; index += 1) {
            node = (node.children || []).find(function (candidate) {
                return candidate.type === 'folder' && candidate.name === state.path[index];
            });
        }
        return node ? node.children || [] : [];
    }

    function renderEntries(account) {
        const query = normalize(ui.fileSearch.value);
        const format = ui.formatFilter.value;
        const entries = entriesAtPath(account).filter(function (entry) {
            const matchesQuery = normalize(entry.name).includes(query);
            if (!matchesQuery) {
                return false;
            }
            if (entry.type !== 'file') {
                return true;
            }
            return format === 'all' || entry.format === format;
        }).sort(function (left, right) {
            if (left.type === 'file' && right.type !== 'file') {
                return 1;
            }
            if (left.type !== 'file' && right.type === 'file') {
                return -1;
            }
            return left.name.localeCompare(right.name);
        });

        clear(ui.entryList);
        clear(ui.browseState);
        ui.entryList.hidden = entries.length === 0;
        ui.browseState.hidden = entries.length !== 0;

        if (entries.length === 0) {
            renderEmptyState(query, format);
            return;
        }

        entries.forEach(function (entry) {
            if (entry.type === 'file') {
                ui.entryList.appendChild(listItem(fileRow(account, entry), 'entry-list-item'));
            } else {
                ui.entryList.appendChild(listItem(directoryRow(entry), 'entry-list-item'));
            }
        });
    }

    function directoryRow(entry) {
        const button = element('button', 'entry-row directory-entry');
        button.type = 'button';
        button.setAttribute('aria-label', 'Open ' + entry.type + ' ' + entry.name);
        button.addEventListener('click', function () {
            state.path.push(entry.name);
            renderBrowser();
            announce(entry.name + ' opened.');
        });

        const nameCell = element('span', 'entry-name-cell');
        const icon = element('span', 'entry-icon ' + entry.type);
        icon.setAttribute('aria-hidden', 'true');
        nameCell.appendChild(icon);
        const nameCopy = element('span', 'entry-name-copy');
        nameCopy.appendChild(element('strong', '', entry.name));
        nameCopy.appendChild(element(
            'span',
            '',
            entry.type === 'container'
                ? entry.access + ' container'
                : 'Folder / prefix',
        ));
        nameCell.appendChild(nameCopy);
        button.appendChild(nameCell);
        button.appendChild(element('span', 'entry-cell', '—'));
        button.appendChild(element('span', 'entry-cell', '—'));
        button.appendChild(element('span', 'entry-cell', entry.modified));
        return button;
    }

    function fileRow(account, entry) {
        const button = element('button', 'entry-row file-entry');
        const selected = state.selected
            && state.selected.accountId === account.id
            && state.selected.file === entry;
        button.type = 'button';
        button.setAttribute('aria-pressed', String(Boolean(selected)));
        button.setAttribute(
            'aria-label',
            'Select ' + entry.name + ', ' + entry.format + ', ' + entry.size + ', modified ' + entry.modified,
        );
        button.addEventListener('click', function () {
            selectFile(account, entry);
        });

        const nameCell = element('span', 'entry-name-cell');
        const icon = element('span', 'entry-icon file');
        icon.setAttribute('aria-hidden', 'true');
        nameCell.appendChild(icon);
        const nameCopy = element('span', 'entry-name-copy');
        nameCopy.appendChild(element('strong', '', entry.name));
        nameCopy.appendChild(element('span', '', selected ? 'Selected source' : 'Supported data file'));
        nameCell.appendChild(nameCopy);
        button.appendChild(nameCell);

        const formatCell = element('span', 'entry-cell');
        formatCell.appendChild(element('span', 'format-badge', entry.format));
        button.appendChild(formatCell);
        button.appendChild(element('span', 'entry-cell', entry.size));
        button.appendChild(element('span', 'entry-cell', entry.modified));
        return button;
    }

    function selectFile(account, entry) {
        state.selected = {
            accountId: account.id,
            path: state.path.slice(),
            file: entry,
        };
        state.scheme = account.hns ? 'adls' : 'abs';
        ui.selectionConfirmation.hidden = true;
        ui.useFileButton.textContent = 'Use selected file';
        renderBrowser();
        renderDetails();
        announce(entry.name + ' selected. Source details are ready.');
    }

    function stateCard(iconClass, iconText, heading, message) {
        const card = element('div', 'state-card');
        const icon = element('span', 'state-icon ' + iconClass, iconText || '');
        icon.setAttribute('aria-hidden', 'true');
        card.appendChild(icon);
        card.appendChild(element('h3', '', heading));
        card.appendChild(element('p', '', message));
        return card;
    }

    function showState(card) {
        clear(ui.entryList);
        clear(ui.browseState);
        ui.entryList.hidden = true;
        ui.browseState.hidden = false;
        ui.browseState.appendChild(card);
    }

    function renderLoadingState() {
        const card = stateCard(
            'loading',
            '',
            'Loading this location…',
            'Simulating container and file discovery. No Azure request is running.',
        );
        const icon = card.querySelector('.state-icon');
        icon.appendChild(element('span', 'spinner'));
        const button = element('button', 'btn subtle', 'Finish loading');
        button.type = 'button';
        button.addEventListener('click', function () {
            setDemoState('ready');
        });
        card.appendChild(button);
        showState(card);
    }

    function renderDeniedState() {
        const account = currentAccount();
        const card = stateCard(
            'denied',
            '',
            'You can see the account, but not its data',
            'Subscription discovery succeeded in this scenario. Container access is separate and requires Storage Blob Data Reader on the account or container.',
        );
        card.appendChild(element('code', '', account ? account.name : 'sample-storage-account'));
        const actions = element('div', 'state-actions');
        const chooseButton = element('button', 'btn primary', 'Choose another account');
        chooseButton.type = 'button';
        chooseButton.addEventListener('click', function () {
            setDemoState('ready', false);
            ui.accountSearch.focus();
            announce('Choose a different mocked storage account.');
        });
        const retryButton = element('button', 'btn subtle', 'Retry');
        retryButton.type = 'button';
        retryButton.addEventListener('click', function () {
            retryFromState();
        });
        actions.appendChild(chooseButton);
        actions.appendChild(retryButton);
        card.appendChild(actions);
        showState(card);
    }

    function renderErrorState() {
        const card = stateCard(
            'error',
            '!',
            'Couldn’t list this location',
            'A simulated temporary service error interrupted browsing. Your mocked sign-in and current path are preserved.',
        );
        card.appendChild(element('code', '', 'Example: 503 Service Unavailable'));
        const actions = element('div', 'state-actions');
        const retryButton = element('button', 'btn primary', 'Retry');
        retryButton.type = 'button';
        retryButton.addEventListener('click', function () {
            retryFromState();
        });
        const accountButton = element('button', 'btn subtle', 'Choose another account');
        accountButton.type = 'button';
        accountButton.addEventListener('click', function () {
            setDemoState('ready', false);
            ui.accountSearch.focus();
        });
        actions.appendChild(retryButton);
        actions.appendChild(accountButton);
        card.appendChild(actions);
        showState(card);
    }

    function renderEmptyState(query, format) {
        const filterCopy = query
            ? 'No item name contains “' + ui.fileSearch.value.trim() + '”.'
            : 'No ' + format + ' files are present in this location.';
        const card = stateCard(
            '',
            '⌕',
            'No matching files',
            filterCopy + ' Your current account and folder selection have not changed.',
        );
        const clearButton = element('button', 'btn primary', 'Clear file filters');
        clearButton.type = 'button';
        clearButton.addEventListener('click', function () {
            ui.fileSearch.value = '';
            ui.formatFilter.value = 'all';
            setDemoState('ready');
            ui.fileSearch.focus();
        });
        card.appendChild(clearButton);
        ui.browseState.appendChild(card);
    }

    function retryFromState() {
        setDemoState('loading');
        announce('Retrying the simulated request.');
        window.setTimeout(function () {
            if (state.demoState === 'loading') {
                setDemoState('ready');
                announce('The simulated retry succeeded.');
            }
        }, 700);
    }

    function readableDemoState(value) {
        const labels = {
            ready: 'ready state',
            loading: 'loading state',
            empty: 'empty search',
            denied: 'access-denied state',
            error: 'retryable-error state',
        };
        return labels[value] || value;
    }

    function setDemoState(value, announceChange) {
        if (state.injectedEmptySearch && value !== 'empty') {
            ui.fileSearch.value = '';
            state.injectedEmptySearch = false;
        }
        state.demoState = value;
        ui.demoStateSelect.value = value;

        if (value === 'empty') {
            ui.fileSearch.value = 'quarterly-budget.xlsx';
            ui.formatFilter.value = 'all';
            state.injectedEmptySearch = true;
        }

        renderBrowser();
        if (announceChange !== false) {
            announce('Showing the ' + readableDemoState(value) + ' example.');
        }
    }

    function renderDetails() {
        if (!state.selected) {
            ui.detailsPlaceholder.hidden = false;
            ui.sourceDetails.hidden = true;
            return;
        }

        const account = ACCOUNTS[state.selected.accountId];
        const selectedFile = state.selected.file;
        const containerName = state.selected.path[0];

        ui.detailsPlaceholder.hidden = true;
        ui.sourceDetails.hidden = false;
        ui.selectedFileName.textContent = selectedFile.name;
        ui.selectedAccount.textContent = account.name;
        ui.selectedContainer.textContent = containerName;
        ui.selectedFormat.textContent = selectedFile.format;
        ui.selectedSize.textContent = selectedFile.size;
        ui.selectedModified.textContent = selectedFile.modified;

        const allowedSchemes = account.hns
            ? [
                { value: 'adls', label: 'adls:// · SQL data source' },
                { value: 'abfss', label: 'abfss:// · Filesystem URI' },
            ]
            : [
                { value: 'abs', label: 'abs:// · Blob Storage' },
            ];
        if (!allowedSchemes.some(function (item) {
            return item.value === state.scheme;
        })) {
            state.scheme = allowedSchemes[0].value;
        }

        clear(ui.schemeSelect);
        allowedSchemes.forEach(function (item) {
            const option = element('option', '', item.label);
            option.value = item.value;
            option.selected = item.value === state.scheme;
            ui.schemeSelect.appendChild(option);
        });
        ui.sourceLocation.textContent = selectedLocation();
    }

    function encodeSegment(value) {
        return encodeURIComponent(value);
    }

    function selectedLocation() {
        if (!state.selected) {
            return '';
        }
        const account = ACCOUNTS[state.selected.accountId];
        const containerName = encodeSegment(state.selected.path[0]);
        const filePath = state.selected.path
            .slice(1)
            .concat(state.selected.file.name)
            .map(encodeSegment)
            .join('/');
        const host = account.name
            + (state.scheme === 'abs' ? '.blob.core.windows.net' : '.dfs.core.windows.net');
        return state.scheme + '://' + containerName + '@' + host + '/' + filePath;
    }

    function useSelectedFile() {
        if (!state.selected) {
            return;
        }
        const location = selectedLocation();
        ui.useFileButton.textContent = 'Selected for analysis';
        ui.confirmationCopy.textContent = 'The next step would receive ' + location + '. No file was opened.';
        ui.selectionConfirmation.hidden = false;
        announce('Selection confirmed. This mock action did not open or download a file.');
    }

    function resetDemo() {
        const accounts = currentAccounts();
        state.accountId = accounts.length > 0 ? accounts[0].id : null;
        state.path = [];
        state.selected = null;
        state.scheme = currentAccount() && currentAccount().hns ? 'adls' : 'abs';
        state.injectedEmptySearch = false;
        ui.accountSearch.value = '';
        ui.fileSearch.value = '';
        ui.formatFilter.value = 'all';
        ui.selectionConfirmation.hidden = true;
        ui.useFileButton.textContent = 'Use selected file';
        setDemoState('ready', false);
        renderAll();
        announce('The mocked browser was reset.');
    }

    function announce(message) {
        ui.toast.textContent = message;
        ui.toast.hidden = false;
        if (state.toastTimer !== null) {
            window.clearTimeout(state.toastTimer);
        }
        state.toastTimer = window.setTimeout(function () {
            ui.toast.hidden = true;
            state.toastTimer = null;
        }, 3200);
    }

    ui.connectButton.addEventListener('click', connect);
    ui.disconnectButton.addEventListener('click', disconnect);
    ui.tenantSelect.addEventListener('change', function () {
        state.tenantId = ui.tenantSelect.value;
        populateSubscriptions();
        state.subscriptionId = ui.subscriptionSelect.value;
        resetForScopeChange();
        announce('Mock tenant changed to ' + currentTenant().name + '.');
    });
    ui.subscriptionSelect.addEventListener('change', function () {
        state.subscriptionId = ui.subscriptionSelect.value;
        resetForScopeChange();
        announce('Mock subscription changed to ' + currentSubscription().name + '.');
    });
    ui.demoStateSelect.addEventListener('change', function () {
        setDemoState(ui.demoStateSelect.value);
    });
    ui.resetDemoButton.addEventListener('click', resetDemo);
    ui.accountSearch.addEventListener('input', renderAccountList);
    ui.clearAccountSearch.addEventListener('click', function () {
        ui.accountSearch.value = '';
        renderAccountList();
        ui.accountSearch.focus();
    });
    ui.fileSearch.addEventListener('input', function () {
        if (state.demoState === 'empty') {
            state.demoState = 'ready';
            state.injectedEmptySearch = false;
            ui.demoStateSelect.value = 'ready';
        }
        renderBrowser();
    });
    ui.formatFilter.addEventListener('change', function () {
        if (state.demoState === 'empty') {
            state.demoState = 'ready';
            state.injectedEmptySearch = false;
            ui.demoStateSelect.value = 'ready';
        }
        renderBrowser();
    });
    ui.backButton.addEventListener('click', function () {
        if (state.path.length === 0) {
            return;
        }
        state.path.pop();
        renderBrowser();
        announce('Moved back one level.');
    });
    ui.schemeSelect.addEventListener('change', function () {
        state.scheme = ui.schemeSelect.value;
        ui.sourceLocation.textContent = selectedLocation();
        ui.selectionConfirmation.hidden = true;
        ui.useFileButton.textContent = 'Use selected file';
        announce('Source location changed to ' + state.scheme + ' syntax.');
    });
    ui.useFileButton.addEventListener('click', useSelectedFile);

    document.addEventListener('keydown', function (event) {
        const isShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
        if (isShortcut && !ui.signedIn.hidden) {
            event.preventDefault();
            ui.accountSearch.focus();
            ui.accountSearch.select();
        }
    });
}());
