/*
 * The native SQL File Detection Tool webview.
 *
 * Runs inside a VS Code webview under a strict CSP: this file is the only
 * script the document may load, and it is loaded with a per-render nonce. It
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
 * The webview holds no state of its own beyond scroll and focus: it renders
 * whatever snapshot the host last sent, which is what keeps the Activity Bar
 * view and the editor panel from ever disagreeing.
 */

/* eslint-env browser */
(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    /** Tabs in display order. Statement tabs appear only when they have text. */
    const TABS = [
        { id: 'quick_analyze', label: 'Quick Analyze', always: true },
        { id: 'metadata', label: 'Metadata', always: true },
        { id: 'preview', label: 'Preview', always: true },
        { id: 'schema', label: 'Schema', always: true },
        { id: 'create_table', label: 'CREATE TABLE' },
        { id: 'bulk_insert', label: 'BULK INSERT' },
        { id: 'openrowset', label: 'OPENROWSET' },
        { id: 'copy_into', label: 'COPY INTO' },
        { id: 'external_file_format', label: 'File format' },
        { id: 'create_external_table', label: 'External table' },
        { id: 'credential_setup', label: 'Credential setup' },
        { id: 'json_functions', label: 'JSON' },
        { id: 'for_json', label: 'FOR JSON' },
        { id: 'best_practices', label: 'Best practices' },
        { id: 'azure', label: 'Azure & URLs', always: true },
        { id: 'formats', label: 'Formats', always: true },
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

    // -- helpers -------------------------------------------------------------

    function byId(id) {
        return document.getElementById(id);
    }

    function post(message) {
        vscode.postMessage(message);
    }

    function debounce(key, fn, ms) {
        const existing = debounceTimers.get(key);
        if (existing !== undefined) {
            clearTimeout(existing);
        }

        function cancelDebounce(key) {
            const timer = debounceTimers.get(key);
            if (timer !== undefined) {
                clearTimeout(timer);
                debounceTimers.delete(key);
            }
        }
        debounceTimers.set(
            key,
            setTimeout(function () {
                debounceTimers.delete(key);
                fn();
            }, ms),
        );
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
        byId('appearance').value = state.appearance;
        document.body.classList.toggle('density-compact', state.appearance === 'compact');
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

    function renderFiles() {
        const list = byId('file-list');
        clear(list);
        byId('source-label').textContent = state.sourceLabel || '';
        byId('file-empty').hidden = state.files.length > 0;

        state.files.forEach(function (file) {
            const item = template('tpl-file-item');
            item.dataset.fileId = file.id;
            item.setAttribute(
                'aria-selected',
                file.id === state.selectedFileId ? 'true' : 'false',
            );
            item.querySelector('.file-name').textContent = file.label;
            const parts = [];
            if (file.folderLabel) {
                parts.push(file.folderLabel);
            }
            parts.push(file.fileType);
            if (file.sizeBytes > 0) {
                parts.push(formatBytes(file.sizeBytes));
            }
            if (file.nativeSupport && file.nativeSupport !== 'supported') {
                parts.push(SUPPORT_LABEL[file.nativeSupport] || file.nativeSupport);
            }
            item.querySelector('.file-meta').textContent = parts.join(' · ');
            list.appendChild(item);
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

        function renderParserOption(container, option) {
            const node = template('tpl-parser-option');
            node.classList.toggle('has-warning', Boolean(option.warning));
            node.querySelector('label').textContent = option.label;
            node.querySelector('.provenance').textContent = option.provenance;
            node.querySelector('.expected').textContent =
                'Expected: ' + option.expectedValue + ' · ' + option.provenance;
            node.querySelector('.evidence').textContent =
                option.warning || option.evidence || '';
            const control = node.querySelector('.parser-control');
            if (option.label === 'File encoding') {
                control.appendChild(element('strong', null, option.value));
            } else {
                let input;
                if (option.key === 'format') {
                    input = document.createElement('select');
                    (state.formats || []).forEach(function (format) {
                        const entry = element('option', null, format.label);
                        entry.value = format.fileType;
                        input.appendChild(entry);
                    });
                } else {
                    input = document.createElement('input');
                    input.type = option.key === 'firstRow' ? 'number' : 'text';
                    input.spellcheck = false;
                    input.autocomplete = 'off';
                }
                input.value = editable('parser:' + option.key, option.value);
                input.dataset.parserOption = option.key;
                input.setAttribute('aria-label', option.label);
                control.appendChild(input);
            }
            const reset = node.querySelector('.reset-option');
            reset.hidden = !option.overridden;
            reset.dataset.resetParser = option.key;
            container.appendChild(node);
        }

        function renderQuickAnalyze(container) {
            const metadata = state.metadata;
            container.appendChild(element('h2', null, 'Quick Analyze'));
            renderLimitation(container);
            if (!metadata) {
                container.appendChild(
                    element('p', 'empty', 'Choose a source and file to analyze it.'),
                );
                return;
            }

            const summary = element('dl', 'kv-list quick-facts');
            appendKv(summary, 'Selected file', metadata.file_path);
            appendKv(summary, 'Rows', metadata.row_count);
            appendKv(summary, 'Columns', metadata.column_count);
            appendKv(summary, 'Schema', metadata.schema_inference ? 'Inferred' : 'Unavailable');
            appendKv(summary, 'Encoding', metadata.encoding + ' (file fact)');
            container.appendChild(summary);

            if (state.folderProfile) {
                const profile = element('aside', 'folder-profile');
                profile.appendChild(element('h3', null, 'Folder profile · per-file detection'));
                profile.appendChild(
                    element(
                        'p',
                        'help',
                        state.folderProfile.fileCount +
                            ' files · format ' +
                            state.folderProfile.format +
                            ' · delimiter ' +
                            state.folderProfile.delimiter +
                            ' · encoding ' +
                            state.folderProfile.encoding +
                            ' · schema ' +
                            state.folderProfile.schema +
                            (state.folderProfile.outlierCount
                                ? ' · ' + state.folderProfile.outlierCount + ' outlier(s)'
                                : ''),
                    ),
                );
                container.appendChild(profile);
            }

            container.appendChild(element('h3', null, 'Common parser options'));
            const common = element('div', 'parser-grid');
            state.quickAnalyze.options
                .filter(function (option) {
                    return !option.advanced;
                })
                .forEach(function (option) {
                    renderParserOption(common, option);
                });
            container.appendChild(common);

            const advanced = document.createElement('details');
            if (
                state.quickAnalyze.options.some(function (option) {
                    return option.advanced && option.warning;
                })
            ) {
                advanced.open = true;
            }
            advanced.appendChild(element('summary', null, 'Advanced parser details'));
            const advancedGrid = element('div', 'parser-grid');
            state.quickAnalyze.options
                .filter(function (option) {
                    return option.advanced;
                })
                .forEach(function (option) {
                    renderParserOption(advancedGrid, option);
                });
            advanced.appendChild(advancedGrid);
            container.appendChild(advanced);

            container.appendChild(element('h3', null, 'Row preview'));
            renderPreview(container);

            const source = state.quickAnalyze.source;
            const readiness = element(
                'aside',
                source.stagingRequired ? 'source-readiness has-warning' : 'source-readiness',
            );
            readiness.appendChild(element('h3', null, 'Source readiness'));
            readiness.appendChild(
                element(
                    'p',
                    'help',
                    source.detail +
                        (source.baseLocation ? ' Base: ' + source.baseLocation + '.' : '') +
                        (source.relativePath ? ' Relative path: ' + source.relativePath + '.' : ''),
                ),
            );
            if (source.objects.length > 0) {
                const list = element('ul', 'readiness-list');
                source.objects.forEach(function (object) {
                    const item = template('tpl-readiness');
                    item.querySelector('.readiness-name').textContent =
                        object.name + (object.required ? ' · required' : ' · not required');
                    item.querySelector('.provenance').textContent = object.provenance;
                    item.querySelector('.readiness-detail').textContent = object.detail;
                    list.appendChild(item);
                });
                readiness.appendChild(list);
            }
            container.appendChild(readiness);

            const statementLabel = element('label', 'field statement-picker');
            statementLabel.appendChild(element('span', null, 'Generated statement'));
            const statementSelect = document.createElement('select');
            statementSelect.dataset.edit = 'statementKind';
            TABS.filter(function (tab) {
                return (
                    !tab.always &&
                    typeof (state.statements || {})[tab.id] === 'string' &&
                    (state.statements || {})[tab.id].trim()
                );
            }).forEach(function (tab) {
                const choice = element('option', null, tab.label);
                choice.value = tab.id;
                statementSelect.appendChild(choice);
            });
            statementSelect.value = state.quickAnalyze.selectedStatement;
            statementLabel.appendChild(statementSelect);
            container.appendChild(statementLabel);
            if (state.quickAnalyze.polybase.visible) {
                container.appendChild(
                    element('aside', 'polybase-guidance has-warning', state.quickAnalyze.polybase.detail),
                );
            }
            const kind = state.quickAnalyze.selectedStatement;
            const sql = (state.statements || {})[kind];
            if (sql) {
                const block = template('tpl-sql');
                block.dataset.kind = kind;
                block.querySelector('code').textContent = sql;
                block.querySelector('pre').setAttribute('aria-label', kind + ' statement');
                container.appendChild(block);
            }
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
                'Override a detected type to force the generated SQL to use it. Leave a box empty to keep the detected type.',
            ),
        );

        const scroll = element('div', 'table-scroll');
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        ['Column', 'Detected type', 'Override'].forEach(function (label) {
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
            input.setAttribute('aria-label', 'SQL type override for ' + field[0]);
            input.value = editable(
                'override:' + field[0],
                state.columnOverrides[field[0]] || '',
            );
            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        scroll.appendChild(table);
        container.appendChild(scroll);

        const clearButton = element('button', 'btn subtle', 'Clear all overrides');
        clearButton.type = 'button';
        clearButton.dataset.action = 'clearColumnOverrides';
        container.appendChild(clearButton);
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

        const authLabel = element('label', 'field');
        authLabel.appendChild(element('span', null, 'Storage authentication'));
        const authSelect = document.createElement('select');
        authSelect.dataset.edit = 'authMethod';
        [
            ['', 'Recommended for platform'],
            ['managed_identity', 'Managed identity (no secret)'],
            ['sas', 'Shared access signature'],
            ['storage_key', 'Storage account key'],
            ['public', 'Public / anonymous'],
        ].forEach(function (option) {
            const node = document.createElement('option');
            node.value = option[0];
            node.textContent = option[1];
            if ((state.authMethod || '') === option[0]) {
                node.selected = true;
            }
            authSelect.appendChild(node);
        });
        authLabel.appendChild(authSelect);
        row.appendChild(authLabel);

        container.appendChild(row);
    }

    function renderStatement(container, kind) {
        renderNamingOptions(container);
        renderLimitation(container);
        const text = (state.statements || {})[kind];
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

    function renderAzure(container) {
        const node = template('tpl-azure');
        const azure = state.azure;

        node.querySelector('.azure-identity').textContent = azure.connected
            ? 'Connected' +
              (azure.identity ? ' as ' + azure.identity : '') +
              (azure.account ? ' · account ' + azure.account : '')
            : 'Not connected.';

        const subscriptions = node.querySelector('.azure-subscriptions');
        subscriptions.dataset.edit = 'subscription';
        subscriptions.appendChild(element('option', null, 'Select a subscription…'));
        azure.subscriptions.forEach(function (subscription) {
            const option = element('option', null, subscription.name);
            option.value = subscription.id;
            subscriptions.appendChild(option);
        });
        subscriptions.disabled = !azure.canListSubscriptions;

        const accounts = node.querySelector('.azure-accounts');
        accounts.dataset.edit = 'account';
        accounts.appendChild(element('option', null, 'Select an account…'));
        azure.accounts.forEach(function (name) {
            const option = element('option', null, name);
            option.value = name;
            accounts.appendChild(option);
        });
        if (azure.account) {
            accounts.value = azure.account;
        }

        const containers = node.querySelector('.azure-containers');
        containers.dataset.edit = 'container';
        containers.appendChild(element('option', null, 'Select a container…'));
        azure.containers.forEach(function (name) {
            const option = element('option', null, name);
            option.value = name;
            containers.appendChild(option);
        });
        if (azure.container) {
            containers.value = azure.container;
        }

        const prefix = node.querySelector('.azure-prefix');
        prefix.dataset.edit = 'prefix';
        prefix.value = editable('prefix', azure.prefix || '');

        const blobs = node.querySelector('.azure-blobs');
        azure.blobs.forEach(function (blob) {
            const item = document.createElement('li');
            const button = element('button', null, blob.name);
            button.type = 'button';
            button.dataset.blob = blob.name;
            button.disabled = !blob.supported;
            item.appendChild(button);
            item.appendChild(
                element(
                    'span',
                    'blob-size',
                    blob.sizeBytes === null || blob.sizeBytes === undefined
                        ? 'folder'
                        : formatBytes(blob.sizeBytes),
                ),
            );
            blobs.appendChild(item);
        });

        const more = node.querySelector('.azure-more');
        more.hidden = !azure.continuation;
        more.dataset.action = 'azureLoadMore';

        node.querySelector('.azure-error').textContent = azure.error || '';
        node.querySelector('.public-url-input').dataset.edit = 'publicUrl';
        node.querySelector('.public-url-input').value = editable('publicUrl', '');

        container.appendChild(node);
    }

    function renderFormats(container) {
        container.appendChild(
            element(
                'p',
                'help',
                'What the bundled TypeScript reader can do with each format. Nothing here launches an external process.',
            ),
        );
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        ['Format', 'Extensions', 'Support', 'Notes'].forEach(function (label) {
            const cell = element('th', null, label);
            cell.scope = 'col';
            headRow.appendChild(cell);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        (state.formats || []).forEach(function (format) {
            const row = template('tpl-format-row');
            row.querySelector('th').textContent = format.label;
            row.querySelector('.fmt-ext').textContent = (format.extensions || []).join(', ');
            row.querySelector('.fmt-support').textContent =
                SUPPORT_LABEL[format.support] || format.support;
            row.querySelector('.fmt-notes').textContent = format.notes || '';
            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        container.appendChild(table);
    }

    function renderPanel() {
        const panel = byId('panel');
        clear(panel);
        const tab = state.activeTab;
        if (tab === 'quick_analyze') {
            renderQuickAnalyze(panel);
        } else if (tab === 'metadata') {
            renderMetadata(panel);
        } else if (tab === 'preview') {
            renderPreview(panel);
        } else if (tab === 'schema') {
            renderSchema(panel);
        } else if (tab === 'azure') {
            renderAzure(panel);
        } else if (tab === 'formats') {
            renderFormats(panel);
        } else {
            renderStatement(panel, tab);
        }
    }

    function render() {
        if (!state) {
            return;
        }
        renderHeader();
        renderStatus();
        renderFiles();
        renderTabs();
        renderPanel();
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

        const resetParser = target.closest('[data-reset-parser]');
        if (resetParser) {
            const key = 'parser:' + resetParser.dataset.resetParser;
            cancelDebounce(key);
            pendingEdits.delete(key);
            post({ type: 'resetParserOverride', key: resetParser.dataset.resetParser });
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

        const connect = target.closest('[data-azure-connect]');
        if (connect) {
            post({ type: 'azureConnect', mode: connect.dataset.azureConnect });
            return;
        }

        const blob = target.closest('[data-blob]');
        if (blob) {
            const name = blob.dataset.blob;
            if (name.endsWith('/')) {
                post({
                    type: 'azureListBlobs',
                    container: state.azure.container || '',
                    prefix: name,
                    continuation: '',
                });
            } else {
                post({
                    type: 'azureAnalyzeBlob',
                    container: state.azure.container || '',
                    blob: name,
                });
            }
            return;
        }

        const action = target.closest('[data-action]');
        if (!action) {
            return;
        }
        const name = action.dataset.action;
        if (name === 'publicUrlAnalyze') {
            const input = document.querySelector('.public-url-input');
            post({ type: 'publicUrlAnalyze', url: input ? input.value.trim() : '' });
            return;
        }
        if (name === 'azureLoadMore') {
            post({
                type: 'azureListBlobs',
                container: state.azure.container || '',
                prefix: state.azure.prefix || '',
                continuation: state.azure.continuation || '',
            });
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
        if (target.id === 'appearance') {
            post({ type: 'setPreference', appearance: target.value });
            return;
        }
        const edit = target.dataset ? target.dataset.edit : null;
        if (edit === 'authMethod') {
            post({ type: 'setAuthMethod', value: target.value });
            return;
        }
        if (edit === 'statementKind') {
            post({ type: 'setStatementKind', kind: target.value });
            return;
        }
        if (target.dataset && target.dataset.parserOption) {
            const key = 'parser:' + target.dataset.parserOption;
            cancelDebounce(key);
            pendingEdits.delete(key);
            post({
                type: 'setParserOverride',
                key: target.dataset.parserOption,
                value: target.value,
            });
            return;
        }
        if (edit === 'subscription' && target.value) {
            post({ type: 'azureListAccounts', subscriptionId: target.value });
        } else if (edit === 'account' && target.value) {
            post({ type: 'azureSetAccount', account: target.value });
        } else if (edit === 'container' && target.value) {
            pendingEdits.delete('prefix');
            post({
                type: 'azureListBlobs',
                container: target.value,
                prefix: '',
                continuation: '',
            });
        }
    });

    document.addEventListener('input', function (event) {
        const target = event.target;
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
            pendingEdits.set('parser:' + parserKey, value);
            debounce('parser:' + parserKey, function () {
                pendingEdits.delete('parser:' + parserKey);
                post({ type: 'setParserOverride', key: parserKey, value: value });
            }, 250);
            return;
        }

        if (edit === 'override') {
            const column = target.dataset.column;
            pendingEdits.set('override:' + column, value);
            debounce('override:' + column, function () {
                pendingEdits.delete('override:' + column);
                post({ type: 'setColumnOverride', column: column, sqlType: value });
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
        if (edit === 'prefix' || edit === 'publicUrl') {
            pendingEdits.set(edit, value);
            return;
        }

        const messageType = {
            tableName: 'setTableName',
            schemaName: 'setSchemaName',
            dataSource: 'setDataSource',
            credentialName: 'setCredentialName',
            storageUrl: 'setStorageUrl',
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
        const list = byId('file-list');
        if (!list || !list.contains(event.target)) {
            return;
        }
        const items = Array.prototype.slice.call(list.querySelectorAll('.file-item'));
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
        state = message.state;
        render();
    });

    post({ type: 'ready' });
})();
