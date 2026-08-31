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
        { id: 'azure', label: 'Azure & URLs', always: true },
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
        const scrollTop = list.scrollTop;
        clear(list);
        byId('source-label').textContent = state.sourceLabel || '';
        byId('file-empty').hidden = state.files.length > 0;

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
            item.querySelector('.file-name').textContent = file.label;
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
            const expanded = !collapsedFolders.has(folderPath);
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
        state.files.forEach(function (file) {
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
                'Create the credential and external data source for your SQL platform.',
            ),
        );
        intro.appendChild(introCopy);
        container.appendChild(intro);

        const steps = element('div', 'credential-steps');

        const platformStep = wizardStep(
            '1',
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
            '2',
            'External data source',
            sourceOption ? sourceOption.detail : '',
        );
        sourceStep.appendChild(
            selectControl(
                'Storage service',
                'dataSourceType',
                wizard.dataSourceOptions,
                wizard.dataSourceType,
            ),
        );
        const prefix = element('p', 'connector-prefix');
        prefix.appendChild(element('span', null, 'Generated connector'));
        prefix.appendChild(element('strong', null, wizard.locationPrefix));
        sourceStep.appendChild(prefix);
        steps.appendChild(sourceStep);

        const authOption = wizard.authOptions.find(function (option) {
            return option.id === wizard.authMethod;
        });
        const authStep = wizardStep(
            '3',
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
            '4',
            'Names and location',
            'Edit the generated object names and location.',
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
        objectFields.appendChild(
            textControl(
                'Storage URL (optional)',
                'storageUrl',
                state.storageUrl,
                'Leave blank to generate safe placeholders',
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
        } else if (tab === 'azure') {
            renderAzure(panel);
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

        const folder = target.closest('[data-folder-path]');
        if (folder && folder.dataset.folderPath) {
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
        if (edit === 'wizardPlatform') {
            post({ type: 'setPlatform', platform: target.value });
            return;
        }
        if (edit === 'dataSourceType') {
            post({ type: 'setDataSourceType', value: target.value });
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
