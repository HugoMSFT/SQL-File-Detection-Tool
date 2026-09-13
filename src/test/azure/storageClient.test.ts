import assert from 'node:assert/strict';
import test from 'node:test';

import { runStorageRequest } from '../../azure/storageClient';

test('Storage requests abort when their wall-clock timeout expires', async () => {
    let requestSignal: AbortSignal | undefined;
    await assert.rejects(
        runStorageRequest(undefined, 5, async (signal) => {
            requestSignal = signal;
            await new Promise(() => undefined);
        }),
        /timed out/,
    );
    assert.equal(requestSignal?.aborted, true);
});

test('Storage requests combine caller cancellation with their timeout', async () => {
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const request = runStorageRequest(caller.signal, 10_000, async (signal) => {
        requestSignal = signal;
        await new Promise(() => undefined);
    });
    caller.abort();
    await assert.rejects(request, /cancelled/);
    assert.equal(requestSignal?.aborted, true);
});
