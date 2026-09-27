#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');

function pythonExecutable(env = process.env, platform = process.platform) {
    return env.PYTHON || (platform === 'win32' ? 'python' : 'python3');
}

if (require.main === module) {
    const child = spawn(pythonExecutable(), process.argv.slice(2), {
        stdio: 'inherit',
        shell: false,
    });
    const forwardInterrupt = () => child.kill('SIGINT');
    const forwardTermination = () => child.kill('SIGTERM');
    process.once('SIGINT', forwardInterrupt);
    process.once('SIGTERM', forwardTermination);
    child.once('error', () => {
        console.error('Could not start Python 3.9 or later. Install it or set PYTHON to its executable path.');
        process.exitCode = 1;
    });
    child.once('close', (code, signal) => {
        process.removeListener('SIGINT', forwardInterrupt);
        process.removeListener('SIGTERM', forwardTermination);
        process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
    });
}

module.exports = { pythonExecutable };
