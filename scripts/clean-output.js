#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const output = path.join(path.resolve(__dirname, '..'), 'out');
if (path.basename(output) !== 'out') {
    throw new Error(`Refusing to clean unexpected output path: ${output}`);
}
fs.rmSync(output, { recursive: true, force: true });
