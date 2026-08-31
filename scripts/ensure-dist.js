#!/usr/bin/env node
// `vsce package --out <path>` treats <path> as a file unless it is an existing
// directory, and npm strips the trailing separator on Windows. Creating the
// directory first makes `--out dist` behave the same on every platform.
'use strict';

const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(dist) && !fs.statSync(dist).isDirectory()) {
  fs.rmSync(dist);
}
fs.mkdirSync(dist, { recursive: true });
