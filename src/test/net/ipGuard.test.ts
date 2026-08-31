/**
 * Tests for the address classifier that underpins the SSRF policy.
 *
 * The interesting cases are the encodings: the same private address can be
 * written as an IPv4 literal, an IPv4-mapped IPv6 address, a NAT64 address or a
 * compressed IPv6 form, and a guard that only understands one of them is not a
 * guard at all.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isIpLiteral, isPublicAddress } from '../../net/ipGuard';

const PRIVATE_V4 = [
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    '169.254.169.254',
    '169.254.0.1',
    '100.64.0.1',
    '100.127.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
];

const PUBLIC_V4 = [
    '1.1.1.1',
    '8.8.8.8',
    '20.60.128.4',
    '52.239.130.1',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '198.17.255.255',
    '198.20.0.1',
];

test('private and reserved IPv4 addresses are refused', () => {
    for (const address of PRIVATE_V4) {
        assert.equal(isPublicAddress(address), false, address);
    }
});

test('ordinary public IPv4 addresses are allowed', () => {
    for (const address of PUBLIC_V4) {
        assert.equal(isPublicAddress(address), true, address);
    }
});

test('private IPv6 addresses are refused', () => {
    for (const address of [
        '::1',
        '::',
        'fe80::1',
        'fe80::abcd:1234',
        'fc00::1',
        'fd12:3456:789a::1',
        'ff02::1',
        '2001:db8::1',
        '64:ff9b::7f00:1',
        '64:ff9b::a9fe:a9fe',
    ]) {
        assert.equal(isPublicAddress(address), false, address);
    }
});

test('public IPv6 addresses are allowed', () => {
    for (const address of ['2606:4700:4700::1111', '2620:1ec:bdf::1', '2a00:1450:4001::200e']) {
        assert.equal(isPublicAddress(address), true, address);
    }
});

test('IPv4-mapped forms of private addresses are refused', () => {
    for (const address of [
        '::ffff:127.0.0.1',
        '::ffff:169.254.169.254',
        '::ffff:10.0.0.1',
        '::ffff:192.168.1.1',
        '::ffff:7f00:1',
        '::ffff:a9fe:a9fe',
    ]) {
        assert.equal(isPublicAddress(address), false, address);
    }
});

test('an IPv4-mapped public address is still public', () => {
    assert.equal(isPublicAddress('::ffff:8.8.8.8'), true);
});

test('malformed input is refused rather than assumed public', () => {
    for (const address of [
        '',
        ' ',
        'not-an-address',
        '1.2.3',
        '1.2.3.4.5',
        '256.1.1.1',
        '01.02.03.04',
        '0177.0.0.1',
        'fe80::1::2',
        '0x7f000001',
        '2130706433',
        '127.1',
        null as unknown as string,
        undefined as unknown as string,
    ]) {
        assert.equal(isPublicAddress(address), false, JSON.stringify(address));
    }
});

test('isIpLiteral recognises the forms a URL host can take', () => {
    assert.ok(isIpLiteral('8.8.8.8'));
    assert.ok(isIpLiteral('[2606:4700::1111]'));
    assert.ok(isIpLiteral('2606:4700::1111'));
    assert.ok(!isIpLiteral('example.com'));
    assert.ok(!isIpLiteral('8.8.8.8.example.com'));
    assert.ok(!isIpLiteral(''));
});
