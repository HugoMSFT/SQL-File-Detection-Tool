'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fixtureRows(count = 100) {
    if (!Number.isInteger(count) || count < 1 || count > 100) {
        throw new Error('Regression fixtures must contain between 1 and 100 rows');
    }
    return Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        label: `fixture_${String(index + 1).padStart(3, '0')}`,
        amount: (index + 1) * 7,
    }));
}

function fixtureBytes(count = 100) {
    const rows = fixtureRows(count);
    const json = JSON.stringify(rows);
    return {
        'sample.csv': Buffer.from('\ufeffid,label,amount\n' +
            rows.map(({ id, label, amount }) => `${id},${label},${amount}\n`).join('')),
        'sample.json': Buffer.from(json),
        'sample-utf16.json': Buffer.from('\ufeff' + json, 'utf16le'),
    };
}

function writeFixtures(root, count = 100) {
    fs.mkdirSync(root, { recursive: true });
    const fixtures = fixtureBytes(count);
    for (const [name, bytes] of Object.entries(fixtures)) {
        fs.writeFileSync(path.join(root, name), bytes);
    }
    return fixtures;
}

module.exports = { fixtureRows, fixtureBytes, writeFixtures };
