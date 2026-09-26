import type { FileType, ParserOverrides } from './native';

export const MAX_SETTING_NAME_LENGTH = 128;
export const MAX_PROFILE_NAME_LENGTH = 64;
export const MAX_COLUMN_OVERRIDES = 128;
export const MAX_SETTINGS_BYTES = 32 * 1024;
export const MAX_FILE_SETTINGS = 50;
export const MAX_FILE_HISTORY_BYTES = 512 * 1024;
export const MAX_IMPORT_PROFILES = 20;
export const MAX_IMPORT_PROFILE_BYTES = 32 * 1024;
export const MAX_IMPORT_PROFILES_BYTES = 256 * 1024;
export const IMPORT_PROFILES_PREFERENCE = 'importProfiles';

export const OBJECT_NAME_KEYS = [
    'tableName', 'schemaName', 'dataSource', 'credentialName', 'formatName',
] as const;
export type ObjectNameKey = (typeof OBJECT_NAME_KEYS)[number];

export const PARSER_OVERRIDE_KEYS = [
    'format', 'firstRow', 'fieldDelimiter', 'rowTerminator',
    'quoteCharacter', 'codepage', 'compression',
] as const satisfies readonly (keyof ParserOverrides)[];

const SETTINGS_KEYS = [...OBJECT_NAME_KEYS, 'parserOverrides', 'columnOverrides'];
const PROFILE_KEYS = ['version', 'name', ...SETTINGS_KEYS];
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const FORMATS = [
    'csv', 'text', 'json', 'parquet', 'orc', 'rc', 'delta', 'iceberg',
] as const satisfies readonly FileType[];
const COMPRESSIONS = new Set([
    'NONE', 'UNCOMPRESSED', 'GZIP', 'SNAPPY', 'ZSTD', 'BROTLI',
    'LZ4', 'LZ4_RAW', 'LZO', 'DEFLATE', 'BZIP2',
]);

/** Only user-authored SQL settings; never source, identity, or analysis data. */
export interface FileSettings {
    readonly tableName: string;
    readonly schemaName: string;
    readonly dataSource: string;
    readonly credentialName: string;
    readonly formatName: string;
    readonly parserOverrides: Readonly<ParserOverrides>;
    readonly columnOverrides: Readonly<Record<string, string>>;
}

export interface ImportProfile extends FileSettings {
    readonly version: 1;
    readonly name: string;
}

export const DEFAULT_FILE_SETTINGS: FileSettings = Object.freeze({
    tableName: '',
    schemaName: 'dbo',
    dataSource: 'MyDataSource',
    credentialName: '',
    formatName: '',
    parserOverrides: Object.freeze({}),
    columnOverrides: Object.freeze({}),
});

/** Messages deliberately describe the rule, never the rejected value. */
export class SettingsValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SettingsValidationError';
    }
}

function invalid(message: string): never {
    throw new SettingsValidationError(message);
}

function hasOwn(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function containsSensitiveContent(value: string): boolean {
    let decoded = value;
    for (let index = 0; index < 3; index += 1) {
        decoded = decoded.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
            String.fromCharCode(Number.parseInt(hex, 16)));
    }
    return /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\./i.test(decoded)
        || /(?:sig|token|access[_-]?token|accountkey|sharedaccesssignature|password|pwd|secret|clientsecret|connectionstring|defaultendpointsprotocol|authorization)\s*=/i.test(decoded)
        || /\b(?:Bearer|SharedKey)\s+\S/i.test(decoded)
        || /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/.test(decoded)
        || /(?:^|;)\s*(?:server|data source)\s*=[^;]*;/i.test(decoded);
}

function record(
    value: unknown,
    allowed: readonly string[],
    required: readonly string[] = allowed,
): Record<string, unknown> {
    if (
        typeof value !== 'object' || value === null || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    ) {
        return invalid('Settings must contain plain, explicitly supported fields.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
        if (
            typeof key !== 'string' || FORBIDDEN_KEYS.has(key) || !allowed.includes(key)
            || !('value' in descriptors[key]) || !descriptors[key].enumerable
        ) {
            return invalid('Settings contain an unsupported field.');
        }
    }
    if (required.some((key) => !hasOwn(descriptors, key))) {
        return invalid('Settings are missing a required field.');
    }
    return value as Record<string, unknown>;
}

export function settingName(
    value: unknown,
    maximum = MAX_SETTING_NAME_LENGTH,
    allowEmpty = true,
): string {
    if (
        typeof value !== 'string' || value.length > maximum
        || !/^[\p{L}\p{M}\p{N}_ .'\-()[\]@$#]*$/u.test(value)
        || containsSensitiveContent(value)
        || (!allowEmpty && value.trim().length === 0)
    ) {
        return invalid(
            `Use a name of at most ${maximum} characters without URLs, paths, credentials, query strings, or control characters.`,
        );
    }
    return value.trim();
}

export function validateParserOverrides(value: unknown): Readonly<ParserOverrides> {
    const source = record(value, PARSER_OVERRIDE_KEYS, []);
    const parsed: ParserOverrides = {};
    if (hasOwn(source, 'format')) {
        const format = FORMATS.find((entry) => entry === source.format);
        if (!format) {
            return invalid('Choose a supported SQL-readable file format.');
        }
        parsed.format = format;
    }
    if (hasOwn(source, 'firstRow')) {
        const firstRow = source.firstRow;
        if (typeof firstRow !== 'number' || !Number.isInteger(firstRow) || firstRow < 1 || firstRow > 1_000_000) {
            return invalid('FIRSTROW must be an integer from 1 to 1000000.');
        }
        parsed.firstRow = firstRow;
    }
    for (const key of ['fieldDelimiter', 'quoteCharacter'] as const) {
        if (!hasOwn(source, key)) {
            continue;
        }
        const delimiter = source[key];
        if (
            typeof delimiter !== 'string' || [...delimiter].length !== 1
            // eslint-disable-next-line no-control-regex
            || /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/.test(delimiter)
        ) {
            return invalid('A field delimiter or quote character must be one printable character or a tab.');
        }
        parsed[key] = delimiter;
    }
    if (hasOwn(source, 'rowTerminator')) {
        const terminator = source.rowTerminator;
        if (
            typeof terminator !== 'string' || containsSensitiveContent(terminator)
            || !(
                ['\n', '\r', '\r\n', '\\n', '\\r', '\\r\\n'].includes(terminator)
                || /^0x(?:[0-9a-f]{2}){1,8}$/i.test(terminator)
                || /^[\x20-\x7e]{1,8}$/.test(terminator)
            )
        ) {
            return invalid('Use a short row terminator, a line ending, or a hexadecimal byte sequence.');
        }
        parsed.rowTerminator = terminator;
    }
    if (hasOwn(source, 'codepage')) {
        const codepage = source.codepage;
        if (
            typeof codepage !== 'string'
            || !(
                /^(?:ACP|OEM|RAW)$/i.test(codepage)
                || (/^[0-9]{1,5}$/.test(codepage) && Number(codepage) >= 1 && Number(codepage) <= 65535)
            )
        ) {
            return invalid('CODEPAGE must be ACP, OEM, RAW, or a number from 1 to 65535.');
        }
        parsed.codepage = codepage.toUpperCase();
    }
    if (hasOwn(source, 'compression')) {
        const compression = source.compression;
        if (compression === null || compression === '') {
            parsed.compression = null;
        } else if (typeof compression === 'string' && COMPRESSIONS.has(compression.toUpperCase())) {
            parsed.compression = compression.toUpperCase();
        } else {
            return invalid('Choose a supported compression name, such as GZIP, SNAPPY, ZSTD, or NONE.');
        }
    }
    return Object.freeze(parsed);
}

const SIMPLE_SQL_TYPES = new Set([
    'BIGINT', 'INT', 'INTEGER', 'SMALLINT', 'TINYINT', 'BIT', 'MONEY', 'SMALLMONEY',
    'REAL', 'DATE', 'DATETIME', 'SMALLDATETIME', 'UNIQUEIDENTIFIER', 'XML',
    'SQL_VARIANT', 'TEXT', 'NTEXT', 'IMAGE', 'TIMESTAMP', 'ROWVERSION',
]);

/** Validate real type names and their argument ranges, not merely SQL-shaped text. */
export function validatedSqlType(value: unknown): string {
    const message = 'Use a supported SQL type, such as BIGINT, NVARCHAR(200), or DECIMAL(18,4), with valid length, precision, and scale.';
    if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9_ (),]+$/.test(value)) {
        return invalid(message);
    }
    const match = /^([A-Z][A-Z0-9_]*)(?: *\( *([0-9]+|MAX) *(?:, *([0-9]+) *)?\))?$/.exec(value.trim().toUpperCase());
    if (!match) {
        return invalid(message);
    }
    const [, type, first, second] = match;
    const candidate = first === undefined ? type : `${type}(${first}${second === undefined ? '' : `,${second}`})`;
    const number = Number(first);
    if (SIMPLE_SQL_TYPES.has(type) && first === undefined) {
        return candidate;
    }
    if (['DECIMAL', 'NUMERIC', 'DEC'].includes(type)) {
        if (
            first === undefined
            || (number >= 1 && number <= 38 && (second === undefined || Number(second) <= number))
        ) {
            return candidate;
        }
    } else if (['CHAR', 'VARCHAR', 'NCHAR', 'NVARCHAR', 'BINARY', 'VARBINARY'].includes(type) && second === undefined) {
        const maximum = type.startsWith('N') ? 4000 : 8000;
        if (
            first === undefined || (number >= 1 && number <= maximum)
            || (first === 'MAX' && ['VARCHAR', 'NVARCHAR', 'VARBINARY'].includes(type))
        ) {
            return candidate;
        }
    } else if (type === 'FLOAT' && second === undefined) {
        if (first === undefined || (number >= 1 && number <= 53)) {
            return candidate;
        }
    } else if (['TIME', 'DATETIME2', 'DATETIMEOFFSET'].includes(type) && second === undefined) {
        if (first === undefined || (number >= 0 && number <= 7)) {
            return candidate;
        }
    }
    return invalid(message);
}

export function validateColumnName(value: unknown): string {
    if (
        typeof value !== 'string' || value.length > MAX_SETTING_NAME_LENGTH || value.trim().length === 0
        || FORBIDDEN_KEYS.has(value) || /[\p{C}\u2028\u2029]/u.test(value) || containsSensitiveContent(value)
        || /^(?:[a-z]:[\\/]|[\\/]|~[\\/])/i.test(value.trim())
    ) {
        return invalid('Column override names must be bounded source column names without prototype keys, paths, URLs, credentials, or control characters.');
    }
    return value;
}

export function validateColumnOverrides(value: unknown): Readonly<Record<string, string>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return invalid('SQL type overrides must be keyed by column name.');
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_COLUMN_OVERRIDES) {
        return invalid(`At most ${MAX_COLUMN_OVERRIDES} SQL type overrides can be retained.`);
    }
    const source = record(value, keys);
    const columns: Record<string, string> = {};
    for (const key of keys) {
        columns[validateColumnName(key)] = validatedSqlType(source[key]);
    }
    return Object.freeze(columns);
}

/** Pick fields explicitly even when the input is the much larger AppState. */
export function fileSettingsFrom(value: FileSettings): FileSettings {
    return {
        tableName: value.tableName,
        schemaName: value.schemaName,
        dataSource: value.dataSource,
        credentialName: value.credentialName,
        formatName: value.formatName,
        parserOverrides: value.parserOverrides,
        columnOverrides: value.columnOverrides,
    };
}

export function settingsBytes(value: FileSettings | ImportProfile): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function validateFileSettings(value: unknown): FileSettings {
    const source = record(value, SETTINGS_KEYS);
    const settings: FileSettings = Object.freeze({
        tableName: settingName(source.tableName),
        schemaName: settingName(source.schemaName),
        dataSource: settingName(source.dataSource),
        credentialName: settingName(source.credentialName),
        formatName: settingName(source.formatName),
        parserOverrides: validateParserOverrides(source.parserOverrides),
        columnOverrides: validateColumnOverrides(source.columnOverrides),
    });
    if (settingsBytes(settings) > MAX_SETTINGS_BYTES) {
        return invalid('File settings exceed the 32 KiB limit.');
    }
    return settings;
}

export function validateImportProfile(value: unknown): ImportProfile {
    const source = record(value, PROFILE_KEYS);
    if (source.version !== 1) {
        return invalid('The saved import profile version is not supported.');
    }
    const profile: ImportProfile = Object.freeze({
        version: 1,
        name: settingName(source.name, MAX_PROFILE_NAME_LENGTH, false),
        ...validateFileSettings({
            tableName: source.tableName,
            schemaName: source.schemaName,
            dataSource: source.dataSource,
            credentialName: source.credentialName,
            formatName: source.formatName,
            parserOverrides: source.parserOverrides,
            columnOverrides: source.columnOverrides,
        }),
    });
    if (settingsBytes(profile) > MAX_IMPORT_PROFILE_BYTES) {
        return invalid('An import profile exceeds the 32 KiB limit.');
    }
    return profile;
}

export function validateImportProfiles(value: unknown): readonly ImportProfile[] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_IMPORT_PROFILES) {
        return invalid(`Saved import profiles must be a list of at most ${MAX_IMPORT_PROFILES} profiles.`);
    }
    if (Reflect.ownKeys(value).length !== value.length + 1) {
        return invalid('The saved import profile list contains unsupported fields or missing entries.');
    }
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
            return invalid('The saved import profile list contains unsupported entries.');
        }
    }
    const profiles = Array.from(value, validateImportProfile);
    const names = new Set(profiles.map((profile) => profile.name));
    if (names.size !== profiles.length) {
        return invalid('Saved import profile names must be unique.');
    }
    if (Buffer.byteLength(JSON.stringify(profiles), 'utf8') > MAX_IMPORT_PROFILES_BYTES) {
        return invalid('Saved import profiles exceed the 256 KiB limit.');
    }
    return Object.freeze(profiles);
}

interface HistoryEntry {
    readonly current: FileSettings;
    readonly previous: FileSettings | undefined;
    readonly bytes: number;
}

/** Session-only LRU. Its byte budget includes the single undo snapshot. */
export class FileSettingsHistory {
    private readonly entries = new Map<string, HistoryEntry>();
    private bytes = 0;

    get size(): number { return this.entries.size; }
    get byteSize(): number { return this.bytes; }

    get(identity: string, fallback: FileSettings = DEFAULT_FILE_SETTINGS): FileSettings {
        const entry = this.entries.get(identity);
        if (!entry) {
            return fallback;
        }
        this.entries.delete(identity);
        this.entries.set(identity, entry);
        return entry.current;
    }

    canUndo(identity: string): boolean {
        return this.entries.get(identity)?.previous !== undefined;
    }

    write(identity: string, value: FileSettings, rememberUndo = true): FileSettings {
        const current = validateFileSettings(fileSettingsFrom(value));
        const old = this.entries.get(identity);
        if (old && JSON.stringify(old.current) === JSON.stringify(current)) {
            return this.get(identity);
        }
        const previous = rememberUndo
            ? old?.current ?? DEFAULT_FILE_SETTINGS
            : old?.previous;
        this.put(identity, current, previous);
        return current;
    }

    undo(identity: string): FileSettings | undefined {
        const previous = this.entries.get(identity)?.previous;
        if (previous) {
            this.put(identity, previous, undefined);
        }
        return previous;
    }

    clear(): void {
        this.entries.clear();
        this.bytes = 0;
    }

    private put(identity: string, current: FileSettings, previous: FileSettings | undefined): void {
        this.bytes -= this.entries.get(identity)?.bytes ?? 0;
        this.entries.delete(identity);
        const bytes = Buffer.byteLength(JSON.stringify({ identity, current, previous }), 'utf8');
        this.entries.set(identity, { current, previous, bytes });
        this.bytes += bytes;
        while (this.entries.size > MAX_FILE_SETTINGS || this.bytes > MAX_FILE_HISTORY_BYTES) {
            const oldest = this.entries.entries().next().value as [string, HistoryEntry] | undefined;
            if (!oldest) {
                break;
            }
            this.entries.delete(oldest[0]);
            this.bytes -= oldest[1].bytes;
        }
    }
}
