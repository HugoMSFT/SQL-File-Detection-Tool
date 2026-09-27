'use strict';

const fs = require('node:fs');
const path = require('node:path');

function comparablePath(value, platform = process.platform) {
    return platform === 'win32' ? value.replace(/\\/g, '/').toLowerCase() : value;
}

/** Match the installed file even when Windows module paths use drive-case or short-name aliases. */
function sameFile(candidate, canonical, platform = process.platform) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
        return false;
    }
    try {
        return comparablePath(fs.realpathSync.native(candidate), platform) === comparablePath(canonical, platform);
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') { return false; }
        throw error;
    }
}

function stackContainsBundle(stack, aliases, platform = process.platform) {
    const text = comparablePath(stack || '', platform);
    return [...aliases].some((alias) => text.includes(comparablePath(alias, platform)));
}

module.exports = { sameFile, stackContainsBundle };
