/**
 * IP address classification used by the SSRF guard.
 *
 * The extension host can reach anything the user's machine can reach,
 * including link-local metadata endpoints, private RFC 1918 ranges and the
 * loopback interface where the user's own services live. A URL supplied
 * through the webview must therefore be proved to point at a publicly routable
 * address before a single byte is sent.
 *
 * Nothing here does I/O, so the whole classification is unit testable.
 */

/** Parse a dotted-quad into its four octets, or `null`. */
function parseIPv4(address: string): number[] | null {
    const parts = address.split('.');
    if (parts.length !== 4) {
        return null;
    }
    const octets: number[] = [];
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) {
            return null;
        }
        // A leading zero is ambiguous: several resolvers read `0177.0.0.1` as
        // octal loopback. Refusing the form outright is the only safe reading.
        if (part.length > 1 && part.startsWith('0')) {
            return null;
        }
        const value = Number(part);
        if (value > 255) {
            return null;
        }
        octets.push(value);
    }
    return octets;
}

function ipv4IsPublic(octets: number[]): boolean {
    const [a, b] = octets;
    if (a === 0) return false; // "this network"
    if (a === 10) return false; // RFC 1918
    if (a === 127) return false; // loopback
    if (a === 169 && b === 254) return false; // link-local (incl. 169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return false; // RFC 1918
    if (a === 192 && b === 168) return false; // RFC 1918
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT, RFC 6598
    if (a === 192 && b === 0 && octets[2] === 0) return false; // IETF protocol
    if (a === 192 && b === 0 && octets[2] === 2) return false; // TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51 && octets[2] === 100) return false; // TEST-NET-2
    if (a === 203 && b === 0 && octets[2] === 113) return false; // TEST-NET-3
    if (a >= 224) return false; // multicast, reserved and broadcast
    return true;
}

/** Expand an IPv6 literal to its eight 16-bit groups, or `null`. */
function parseIPv6(address: string): number[] | null {
    let value = (address ?? '').trim();
    if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1);
    }
    // A zone index (fe80::1%eth0) is never publicly routable, but strip it so
    // the remainder still parses and is rejected on its own merits.
    const zone = value.indexOf('%');
    if (zone >= 0) {
        value = value.slice(0, zone);
    }
    if (value.length === 0 || !value.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(value)) {
        return null;
    }

    // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two hex groups.
    const lastColon = value.lastIndexOf(':');
    const tail = value.slice(lastColon + 1);
    if (tail.includes('.')) {
        const octets = parseIPv4(tail);
        if (!octets) {
            return null;
        }
        const high = ((octets[0] << 8) | octets[1]).toString(16);
        const low = ((octets[2] << 8) | octets[3]).toString(16);
        value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
    }

    const doubleColon = value.indexOf('::');
    let head: string[];
    let rest: string[];
    if (doubleColon >= 0) {
        if (value.indexOf('::', doubleColon + 1) >= 0) {
            return null;
        }
        head = value
            .slice(0, doubleColon)
            .split(':')
            .filter((part) => part !== '');
        rest = value
            .slice(doubleColon + 2)
            .split(':')
            .filter((part) => part !== '');
        if (head.length + rest.length > 7) {
            return null;
        }
    } else {
        head = value.split(':');
        rest = [];
        if (head.length !== 8) {
            return null;
        }
    }

    const groups: number[] = [];
    for (const part of head) {
        if (!/^[0-9A-Fa-f]{1,4}$/.test(part)) {
            return null;
        }
        groups.push(parseInt(part, 16));
    }
    while (groups.length + rest.length < 8) {
        groups.push(0);
    }
    for (const part of rest) {
        if (!/^[0-9A-Fa-f]{1,4}$/.test(part)) {
            return null;
        }
        groups.push(parseInt(part, 16));
    }
    return groups.length === 8 ? groups : null;
}

function ipv6IsPublic(groups: number[]): boolean {
    const isZeroPrefix = groups.slice(0, 5).every((group) => group === 0);
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses
    // are classified by their embedded IPv4 address, otherwise ::ffff:127.0.0.1
    // would sail straight past a naive IPv6 check.
    if (isZeroPrefix && (groups[5] === 0xffff || groups[5] === 0)) {
        if (groups.every((group) => group === 0)) {
            return false; // unspecified ::
        }
        if (groups[5] === 0 && groups[6] === 0 && groups[7] === 1) {
            return false; // loopback ::1
        }
        const embedded = [
            groups[6] >> 8,
            groups[6] & 0xff,
            groups[7] >> 8,
            groups[7] & 0xff,
        ];
        if (groups[5] === 0xffff) {
            return ipv4IsPublic(embedded);
        }
        // ::a.b.c.d is deprecated; treat the whole ::/96 block as non-public.
        return false;
    }
    // NAT64 well-known prefix 64:ff9b::/96 also embeds IPv4.
    if (
        groups[0] === 0x0064 &&
        groups[1] === 0xff9b &&
        groups.slice(2, 6).every((group) => group === 0)
    ) {
        return ipv4IsPublic([
            groups[6] >> 8,
            groups[6] & 0xff,
            groups[7] >> 8,
            groups[7] & 0xff,
        ]);
    }
    const first = groups[0];
    if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
    if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
    if ((first & 0xff00) === 0xff00) return false; // multicast ff00::/8
    if (first === 0x2001 && groups[1] === 0x0db8) return false; // documentation
    if (first === 0x0100 && groups.slice(1, 4).every((g) => g === 0)) return false; // discard
    return true;
}

/**
 * True when *address* is a publicly routable unicast address.
 *
 * Anything that cannot be parsed is treated as non-public: an address the
 * guard does not understand is exactly the case where it must not allow a
 * connection.
 */
export function isPublicAddress(address: string): boolean {
    const candidate = (address ?? '').trim();
    if (candidate.length === 0) {
        return false;
    }
    const v4 = parseIPv4(candidate);
    if (v4) {
        return ipv4IsPublic(v4);
    }
    const v6 = parseIPv6(candidate);
    if (v6) {
        return ipv6IsPublic(v6);
    }
    return false;
}

/** True when *value* parses as an IP literal of either family. */
export function isIpLiteral(value: string): boolean {
    const candidate = (value ?? '').trim().replace(/^\[/, '').replace(/\]$/, '');
    return parseIPv4(candidate) !== null || parseIPv6(candidate) !== null;
}
