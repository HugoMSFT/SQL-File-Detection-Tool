/**
 * A minimal reader for the Arrow IPC `Schema` FlatBuffer.
 *
 * Arrow writers store the logical Arrow schema in the Parquet key/value
 * metadata under `ARROW:schema`. Reading it is what lets the native core report
 * the same type names as `pyarrow` — notably `large_string` and `large_binary`,
 * which have no distinct Parquet representation and would otherwise collapse to
 * `string` and `binary`.
 *
 * Only the `Schema` message is decoded, and only the parts needed to render a
 * type name. Everything is bounds-checked against the supplied buffer.
 */

/** FlatBuffer `Type` union tags, from `Schema.fbs`. */
const enum ArrowTypeId {
    Null = 1,
    Int = 2,
    FloatingPoint = 3,
    Binary = 4,
    Utf8 = 5,
    Bool = 6,
    Decimal = 7,
    Date = 8,
    Time = 9,
    Timestamp = 10,
    Interval = 11,
    List = 12,
    Struct = 13,
    Union = 14,
    FixedSizeBinary = 15,
    FixedSizeList = 16,
    Map = 17,
    Duration = 18,
    LargeBinary = 19,
    LargeUtf8 = 20,
    LargeList = 21,
}

const TIME_UNITS = ['s', 'ms', 'us', 'ns'];

/** One decoded Arrow field. */
export interface ArrowField {
    name: string;
    nullable: boolean;
    /** `pyarrow`-compatible rendering of the field's type. */
    typeName: string;
}

/** Cursor over a FlatBuffer with bounds checking. */
class FlatBufferReader {
    private readonly view: DataView;

    constructor(private readonly bytes: Uint8Array) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    private check(offset: number, size: number): void {
        if (offset < 0 || offset + size > this.bytes.byteLength) {
            throw new RangeError('FlatBuffer read out of bounds');
        }
    }

    public int8(offset: number): number {
        this.check(offset, 1);
        return this.view.getInt8(offset);
    }

    public uint8(offset: number): number {
        this.check(offset, 1);
        return this.view.getUint8(offset);
    }

    public int16(offset: number): number {
        this.check(offset, 2);
        return this.view.getInt16(offset, true);
    }

    public uint16(offset: number): number {
        this.check(offset, 2);
        return this.view.getUint16(offset, true);
    }

    public int32(offset: number): number {
        this.check(offset, 4);
        return this.view.getInt32(offset, true);
    }

    public uint32(offset: number): number {
        this.check(offset, 4);
        return this.view.getUint32(offset, true);
    }

    /** Follow a `uoffset` stored at `offset`. */
    public indirect(offset: number): number {
        return offset + this.int32(offset);
    }

    /** Resolve the position of field `slot` of the table at `table`. */
    public fieldOffset(table: number, slot: number): number {
        const vtable = table - this.int32(table);
        const vtableSize = this.uint16(vtable);
        const slotOffset = 4 + slot * 2;
        if (slotOffset >= vtableSize) {
            return 0;
        }
        const relative = this.uint16(vtable + slotOffset);
        return relative === 0 ? 0 : table + relative;
    }

    public readString(offset: number): string {
        const start = this.indirect(offset);
        const length = this.uint32(start);
        this.check(start + 4, length);
        return Buffer.from(
            this.bytes.buffer,
            this.bytes.byteOffset + start + 4,
            length,
        ).toString('utf8');
    }

    /** Return the element positions of a vector of tables. */
    public tableVector(offset: number): number[] {
        const start = this.indirect(offset);
        const length = this.uint32(start);
        if (length > 1_000_000) {
            throw new RangeError('FlatBuffer vector is implausibly long');
        }
        const positions: number[] = [];
        for (let i = 0; i < length; i += 1) {
            const element = start + 4 + i * 4;
            positions.push(this.indirect(element));
        }
        return positions;
    }
}

function renderInt(reader: FlatBufferReader, type: number): string {
    const bitWidthAt = reader.fieldOffset(type, 0);
    const signedAt = reader.fieldOffset(type, 1);
    const bitWidth = bitWidthAt === 0 ? 32 : reader.int32(bitWidthAt);
    // `is_signed` defaults to `false` in `Schema.fbs`, and FlatBuffers omit
    // fields that hold their default — so an absent slot means *unsigned*.
    const signed = signedAt === 0 ? false : reader.int8(signedAt) !== 0;
    return `${signed ? '' : 'u'}int${bitWidth}`;
}

function renderFloat(reader: FlatBufferReader, type: number): string {
    const precisionAt = reader.fieldOffset(type, 0);
    const precision = precisionAt === 0 ? 0 : reader.int16(precisionAt);
    if (precision === 0) {
        return 'halffloat';
    }
    return precision === 1 ? 'float' : 'double';
}

function renderDecimal(reader: FlatBufferReader, type: number): string {
    const precisionAt = reader.fieldOffset(type, 0);
    const scaleAt = reader.fieldOffset(type, 1);
    const bitWidthAt = reader.fieldOffset(type, 2);
    const precision = precisionAt === 0 ? 0 : reader.int32(precisionAt);
    const scale = scaleAt === 0 ? 0 : reader.int32(scaleAt);
    const bitWidth = bitWidthAt === 0 ? 128 : reader.int32(bitWidthAt);
    return `decimal${bitWidth}(${precision}, ${scale})`;
}

function renderDate(reader: FlatBufferReader, type: number): string {
    const unitAt = reader.fieldOffset(type, 0);
    const unit = unitAt === 0 ? 1 : reader.int16(unitAt);
    return unit === 0 ? 'date32[day]' : 'date64[ms]';
}

function renderTime(reader: FlatBufferReader, type: number): string {
    const unitAt = reader.fieldOffset(type, 0);
    const bitWidthAt = reader.fieldOffset(type, 1);
    const unit = unitAt === 0 ? 1 : reader.int16(unitAt);
    const bitWidth = bitWidthAt === 0 ? 32 : reader.int32(bitWidthAt);
    return `time${bitWidth}[${TIME_UNITS[unit] ?? 'ms'}]`;
}

function renderTimestamp(reader: FlatBufferReader, type: number): string {
    const unitAt = reader.fieldOffset(type, 0);
    const timezoneAt = reader.fieldOffset(type, 1);
    const unit = unitAt === 0 ? 0 : reader.int16(unitAt);
    const unitName = TIME_UNITS[unit] ?? 's';
    if (timezoneAt === 0) {
        return `timestamp[${unitName}]`;
    }
    return `timestamp[${unitName}, tz=${reader.readString(timezoneAt)}]`;
}

function renderDuration(reader: FlatBufferReader, type: number): string {
    const unitAt = reader.fieldOffset(type, 0);
    const unit = unitAt === 0 ? 1 : reader.int16(unitAt);
    return `duration[${TIME_UNITS[unit] ?? 'ms'}]`;
}

function renderInterval(reader: FlatBufferReader, type: number): string {
    const unitAt = reader.fieldOffset(type, 0);
    const unit = unitAt === 0 ? 0 : reader.int16(unitAt);
    if (unit === 0) {
        return 'month_interval';
    }
    return unit === 1 ? 'day_time_interval' : 'month_day_nano_interval';
}

/** Decode one `Field` table into a name/nullability/type triple. */
function readField(reader: FlatBufferReader, field: number, depth: number): ArrowField {
    if (depth > 64) {
        throw new RangeError('Arrow schema nesting is too deep');
    }
    const nameAt = reader.fieldOffset(field, 0);
    const nullableAt = reader.fieldOffset(field, 1);
    const typeTypeAt = reader.fieldOffset(field, 2);
    const typeAt = reader.fieldOffset(field, 3);
    const childrenAt = reader.fieldOffset(field, 5);

    const name = nameAt === 0 ? '' : reader.readString(nameAt);
    const nullable = nullableAt === 0 ? false : reader.int8(nullableAt) !== 0;
    const typeId = typeTypeAt === 0 ? 0 : reader.uint8(typeTypeAt);
    const type = typeAt === 0 ? 0 : reader.indirect(typeAt);
    const children =
        childrenAt === 0
            ? []
            : reader.tableVector(childrenAt).map((child) => readField(reader, child, depth + 1));

    return { name, nullable, typeName: renderType(reader, typeId, type, children) };
}

function renderType(
    reader: FlatBufferReader,
    typeId: number,
    type: number,
    children: ArrowField[],
): string {
    switch (typeId) {
        case ArrowTypeId.Null:
            return 'null';
        case ArrowTypeId.Int:
            return renderInt(reader, type);
        case ArrowTypeId.FloatingPoint:
            return renderFloat(reader, type);
        case ArrowTypeId.Binary:
            return 'binary';
        case ArrowTypeId.LargeBinary:
            return 'large_binary';
        case ArrowTypeId.Utf8:
            return 'string';
        case ArrowTypeId.LargeUtf8:
            return 'large_string';
        case ArrowTypeId.Bool:
            return 'bool';
        case ArrowTypeId.Decimal:
            return renderDecimal(reader, type);
        case ArrowTypeId.Date:
            return renderDate(reader, type);
        case ArrowTypeId.Time:
            return renderTime(reader, type);
        case ArrowTypeId.Timestamp:
            return renderTimestamp(reader, type);
        case ArrowTypeId.Duration:
            return renderDuration(reader, type);
        case ArrowTypeId.Interval:
            return renderInterval(reader, type);
        case ArrowTypeId.List:
            return `list<${children[0]?.name ?? 'item'}: ${children[0]?.typeName ?? 'null'}>`;
        case ArrowTypeId.LargeList:
            return `large_list<${children[0]?.name ?? 'item'}: ${children[0]?.typeName ?? 'null'}>`;
        case ArrowTypeId.FixedSizeList: {
            const sizeAt = reader.fieldOffset(type, 0);
            const size = sizeAt === 0 ? 0 : reader.int32(sizeAt);
            const child = children[0];
            return `fixed_size_list<${child?.name ?? 'item'}: ${child?.typeName ?? 'null'}>[${size}]`;
        }
        case ArrowTypeId.FixedSizeBinary: {
            const widthAt = reader.fieldOffset(type, 0);
            const width = widthAt === 0 ? 0 : reader.int32(widthAt);
            return `fixed_size_binary[${width}]`;
        }
        case ArrowTypeId.Struct:
            return `struct<${children
                .map((child) => `${child.name}: ${child.typeName}`)
                .join(', ')}>`;
        case ArrowTypeId.Map: {
            // The single child is the `entries` struct holding key and value.
            const entries = children[0];
            const inner = entries?.typeName ?? '';
            const match = /^struct<[^:]+: (.*), [^:]+: (.*)>$/.exec(inner);
            if (match) {
                return `map<${match[1]}, ${match[2]}>`;
            }
            return `map<${inner}>`;
        }
        case ArrowTypeId.Union:
            return `union<${children.map((child) => child.typeName).join(', ')}>`;
        default:
            return 'unknown';
    }
}

/**
 * Decode the `ARROW:schema` metadata value.
 *
 * The value is a base64-encoded, encapsulated Arrow IPC message: an optional
 * `0xFFFFFFFF` continuation marker, a little-endian metadata length, then the
 * `Message` FlatBuffer whose header is a `Schema`.
 *
 * Returns `null` whenever the payload cannot be decoded, so callers can fall
 * back to the Parquet schema without special-casing errors.
 */
export function decodeArrowSchema(base64: string): ArrowField[] | null {
    let bytes: Buffer;
    try {
        bytes = Buffer.from(base64, 'base64');
    } catch {
        return null;
    }
    if (bytes.byteLength < 12) {
        return null;
    }
    try {
        let offset = 0;
        if (bytes.readUInt32LE(0) === 0xffffffff) {
            offset = 8;
        } else {
            // Older writers omit the continuation marker but keep the length.
            offset = 4;
        }
        const reader = new FlatBufferReader(bytes.subarray(offset));
        const message = reader.indirect(0);
        const headerTypeAt = reader.fieldOffset(message, 1);
        const headerAt = reader.fieldOffset(message, 2);
        if (headerAt === 0) {
            return null;
        }
        if (headerTypeAt !== 0 && reader.uint8(headerTypeAt) !== 1) {
            return null;
        }
        const schema = reader.indirect(headerAt);
        const fieldsAt = reader.fieldOffset(schema, 1);
        if (fieldsAt === 0) {
            return [];
        }
        return reader.tableVector(fieldsAt).map((field) => readField(reader, field, 0));
    } catch {
        return null;
    }
}
