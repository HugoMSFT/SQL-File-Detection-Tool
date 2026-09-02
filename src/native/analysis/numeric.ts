/**
 * Exact, lexical numeric inference shared by CSV and JSON analysis.
 *
 * JavaScript numbers are only used for preview values after a decimal
 * round-trip check. Type selection itself is based on token digits and BigInt
 * range checks, so SQL recommendations never inherit IEEE-754 rounding.
 */

const NUMERIC_PATTERN =
    /^([+-]?)(?:([0-9]+)(?:\.([0-9]*))?|\.([0-9]+))(?:[eE]([+-]?[0-9]+))?$/;

const INT32_MIN = -2_147_483_648n;
const INT32_MAX = 2_147_483_647n;
const INT64_MIN = -9_223_372_036_854_775_808n;
const INT64_MAX = 9_223_372_036_854_775_807n;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/** SQL Server's maximum exact-numeric precision. */
export const MAX_EXACT_NUMERIC_PRECISION = 38;

/** Numeric tokens beyond this bound are preserved as text without parsing. */
export const MAX_NUMERIC_TOKEN_CHARS = 256;

export type ExactNumericType =
    | 'int32'
    | 'int64'
    | `decimal(${number},${number})`;

interface CanonicalDecimal {
    negative: boolean;
    digits: string;
    scale: number;
}

export interface NumericToken {
    readonly raw: string;
    readonly integerSyntax: boolean;
    readonly hasExponent: boolean;
    readonly integerDigits: number;
    readonly scale: number;
    readonly precision: number;
    readonly canonical: CanonicalDecimal;
}

function boundedExponent(raw: string | undefined): number {
    if (!raw) {
        return 0;
    }
    const negative = raw.startsWith('-');
    const digits = raw.replace(/^[+-]?0*/, '');
    if (digits.length === 0) {
        return 0;
    }
    if (digits.length > 3) {
        return negative ? -1000 : 1000;
    }
    const value = Number.parseInt(digits, 10);
    return negative ? -value : value;
}

function canonicalDecimal(
    sign: string,
    integerPart: string,
    fractionPart: string,
    exponent: number,
): CanonicalDecimal {
    let digits = `${integerPart}${fractionPart}`.replace(/^0+/, '');
    if (digits.length === 0) {
        return { negative: false, digits: '0', scale: 0 };
    }

    let lastNonZero = digits.length - 1;
    while (lastNonZero >= 0 && digits[lastNonZero] === '0') {
        lastNonZero -= 1;
    }
    const trailingZeros = digits.length - lastNonZero - 1;
    digits = digits.slice(0, lastNonZero + 1);
    const scale = fractionPart.length - exponent - trailingZeros;
    return { negative: sign === '-', digits, scale };
}

/** Parse one decimal token without converting it through JavaScript Number. */
export function parseNumericToken(raw: string): NumericToken | null {
    if (raw.length > MAX_NUMERIC_TOKEN_CHARS) {
        return null;
    }
    const token = raw.trim();
    const match = NUMERIC_PATTERN.exec(token);
    if (!match) {
        return null;
    }

    const sign = match[1] ?? '';
    const integerPart = match[2] ?? '';
    const fractionPart = match[3] ?? match[4] ?? '';
    const exponent = boundedExponent(match[5]);
    const combined = `${integerPart}${fractionPart}`;
    const firstNonZero = combined.search(/[1-9]/);
    const decimalPosition = integerPart.length + exponent;
    const integerDigits =
        firstNonZero >= 0 ? Math.max(decimalPosition - firstNonZero, 0) : 0;
    const scale = Math.max(combined.length - decimalPosition, 0);

    return {
        raw: token,
        integerSyntax: !token.includes('.') && !/[eE]/.test(token),
        hasExponent: /[eE]/.test(token),
        integerDigits,
        scale,
        precision: Math.max(1, integerDigits + scale),
        canonical: canonicalDecimal(sign, integerPart, fractionPart, exponent),
    };
}

function canonicalEquals(left: CanonicalDecimal, right: CanonicalDecimal): boolean {
    return (
        left.negative === right.negative &&
        left.digits === right.digits &&
        left.scale === right.scale
    );
}

function canonicalIntegerValue(value: CanonicalDecimal): bigint | null {
    if (value.scale > 0 || value.digits.length + Math.max(-value.scale, 0) > 38) {
        return null;
    }
    const digits = `${value.digits}${'0'.repeat(Math.max(-value.scale, 0))}`;
    const integer = BigInt(digits);
    return value.negative ? -integer : integer;
}

/**
 * Return a numeric preview value only when converting it through Number keeps
 * the exact decimal value. Otherwise return the original token as text.
 */
export function exactNumericSample(raw: string): number | string {
    const parsed = parseNumericToken(raw);
    if (
        !parsed ||
        parsed.hasExponent ||
        parsed.precision > MAX_EXACT_NUMERIC_PRECISION
    ) {
        return raw;
    }

    if (parsed.integerSyntax) {
        const value = BigInt(parsed.raw);
        return value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT
            ? Number(value)
            : raw;
    }

    const exactInteger = canonicalIntegerValue(parsed.canonical);
    if (
        exactInteger !== null &&
        (exactInteger < MIN_SAFE_BIGINT || exactInteger > MAX_SAFE_BIGINT)
    ) {
        return raw;
    }

    const value = Number(parsed.raw);
    if (!Number.isFinite(value)) {
        return raw;
    }
    const roundTrip = parseNumericToken(String(value));
    return roundTrip && canonicalEquals(parsed.canonical, roundTrip.canonical)
        ? value
        : raw;
}

/** Constant-memory aggregate for a column of exact decimal tokens. */
export class NumericColumnAccumulator {
    private sawValue = false;
    private allIntegerSyntax = true;
    private maxIntegerDigits = 0;
    private maxScale = 0;
    private minimumInteger: bigint | null = null;
    private maximumInteger: bigint | null = null;
    private integerRangeKnown = true;
    private sawExponentSyntax = false;

    public add(raw: string): boolean {
        const parsed = parseNumericToken(raw);
        if (!parsed) {
            return false;
        }

        this.sawValue = true;
        this.allIntegerSyntax = this.allIntegerSyntax && parsed.integerSyntax;
        this.sawExponentSyntax = this.sawExponentSyntax || parsed.hasExponent;
        this.maxIntegerDigits = Math.max(this.maxIntegerDigits, parsed.integerDigits);
        this.maxScale = Math.max(this.maxScale, parsed.scale);

        if (parsed.integerSyntax) {
            if (parsed.integerDigits > 19) {
                this.integerRangeKnown = false;
            } else {
                const value = BigInt(parsed.raw);
                this.minimumInteger =
                    this.minimumInteger === null || value < this.minimumInteger
                        ? value
                        : this.minimumInteger;
                this.maximumInteger =
                    this.maximumInteger === null || value > this.maximumInteger
                        ? value
                        : this.maximumInteger;
            }
        }
        return true;
    }

    /** Return a lossless SQL-oriented detected type. */
    public detectedType(): ExactNumericType | null {
        if (!this.sawValue || this.sawExponentSyntax) {
            return null;
        }

        if (
            this.allIntegerSyntax &&
            this.integerRangeKnown &&
            this.minimumInteger !== null &&
            this.maximumInteger !== null
        ) {
            if (this.minimumInteger >= INT32_MIN && this.maximumInteger <= INT32_MAX) {
                return 'int32';
            }
            if (this.minimumInteger >= INT64_MIN && this.maximumInteger <= INT64_MAX) {
                return 'int64';
            }
        }

        const precision = Math.max(1, this.maxIntegerDigits + this.maxScale);
        return `decimal(${precision},${this.maxScale})`;
    }
}
