/**
 * Bounds on the folder scan.
 *
 * Raising the scan past a single level is what makes partitioned lake layouts
 * usable, so the two guards that keep it from becoming unbounded work - a depth
 * ceiling and a file ceiling - are asserted here rather than assumed.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { DIRECTORY_SCAN_MAX_DEPTH, DIRECTORY_SCAN_MAX_FILES } from '../../native/limits';
import { nativeAnalysisService } from '../../native/service';

function tree(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sqlfd-scan-'));
}

test('the scan reaches a partitioned layout within its depth ceiling', async () => {
    const root = tree();
    try {
        const deep = path.join(root, 'sales', 'year=2026', 'month=09', 'day=02');
        fs.mkdirSync(deep, { recursive: true });
        fs.writeFileSync(path.join(deep, 'part-0000.csv'), 'id,amount\n1,10\n');

        const result = await nativeAnalysisService.analyzeDirectory({
            filePath: root,
            allowedRoot: root,
            maxDepth: DIRECTORY_SCAN_MAX_DEPTH,
            maxFiles: DIRECTORY_SCAN_MAX_FILES,
        });

        assert.deepEqual(
            result.files.map((file: { file_path: string }) => path.basename(file.file_path)),
            ['part-0000.csv'],
        );
        assert.equal(result.truncated, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a file below the depth ceiling is not analysed', async () => {
    const root = tree();
    try {
        const shallow = path.join(root, 'a');
        const deeper = path.join(root, 'a', 'b', 'c');
        fs.mkdirSync(deeper, { recursive: true });
        fs.writeFileSync(path.join(shallow, 'near.csv'), 'id\n1\n');
        fs.writeFileSync(path.join(deeper, 'far.csv'), 'id\n2\n');

        const result = await nativeAnalysisService.analyzeDirectory({
            filePath: root,
            allowedRoot: root,
            maxDepth: 1,
            maxFiles: DIRECTORY_SCAN_MAX_FILES,
        });

        assert.deepEqual(
            result.files.map((file: { file_path: string }) => path.basename(file.file_path)),
            ['near.csv'],
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the file ceiling stops the scan and is reported, not hidden', async () => {
    const root = tree();
    try {
        for (let index = 0; index < 6; index += 1) {
            fs.writeFileSync(path.join(root, `part-${index}.csv`), 'id\n1\n');
        }

        const result = await nativeAnalysisService.analyzeDirectory({
            filePath: root,
            allowedRoot: root,
            maxDepth: DIRECTORY_SCAN_MAX_DEPTH,
            maxFiles: 4,
        });

        assert.equal(result.files.length, 4);
        assert.equal(result.truncated, true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a scan that fits under its ceiling is not reported as truncated', async () => {
    const root = tree();
    try {
        fs.writeFileSync(path.join(root, 'only.csv'), 'id\n1\n');

        const result = await nativeAnalysisService.analyzeDirectory({
            filePath: root,
            allowedRoot: root,
            maxDepth: DIRECTORY_SCAN_MAX_DEPTH,
            maxFiles: DIRECTORY_SCAN_MAX_FILES,
        });

        assert.equal(result.files.length, 1);
        assert.equal(result.truncated, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a malformed file ceiling is rejected rather than silently ignored', async () => {
    const root = tree();
    try {
        fs.writeFileSync(path.join(root, 'only.csv'), 'id\n1\n');
        await assert.rejects(
            () =>
                nativeAnalysisService.analyzeDirectory({
                    filePath: root,
                    allowedRoot: root,
                    maxFiles: 0,
                }),
            /positive integer/i,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
