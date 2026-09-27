import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyStorageError } from '../../azure/errors';
import type { AzureBrowserErrorKind } from '../../azure/types';

test('structured Azure failures produce safe operation-specific diagnostics', () => {
    const cases: Array<[unknown, AzureBrowserErrorKind, RegExp]> = [
        [{ statusCode: 401, code: 'AuthenticationFailed' }, 'storageConsent', /Authorize Storage browsing again/],
        [{ statusCode: 403, code: 'AuthorizationPermissionMismatch' }, 'dataAccess', /Storage Blob Data Reader/],
        [{ statusCode: 403, details: { errorCode: 'AuthorizationPermissionMismatch' } }, 'dataAccess', /scope/],
        [{ statusCode: 403, code: 'AuthenticationFailed' }, 'storageAuthentication', /Microsoft Storage credential/],
        [{ statusCode: 403, code: 'AccountIsDisabled' }, 'accountDisabled', /account and subscription status/],
        [{ statusCode: 403, code: 'AuthorizationFailure' }, 'network', /firewall.*private endpoint.*DNS/],
        [{ statusCode: 403, code: 'AuthorizationSourceIPMismatch' }, 'network', /network/],
        [{ code: 'NetworkSecurityPerimeterAccessDenied' }, 'network', /perimeter/],
        [{ status: 404, code: 'ContainerNotFound' }, 'notFound', /not found or is not visible/],
        [{ statusCode: 404, code: 'ResourceNotFound' }, 'notFound', /endpoint and container/],
        [{ statusCode: 429 }, 'rateLimited', /Wait briefly/],
        [{ statusCode: 503, code: 'ServerBusy' }, 'rateLimited', /rate limiting/],
        [{ statusCode: 408 }, 'timeout', /timed out/],
        [{ code: 'OperationTimedOut' }, 'timeout', /timed out/],
        [{ code: 'REQUEST_SEND_ERROR', cause: { code: 'ETIMEDOUT' } }, 'timeout', /timed out/],
        [{ cause: { code: 'ENOTFOUND' } }, 'network', /DNS/],
        [{ code: 'EAI_AGAIN' }, 'network', /DNS/],
        [{ code: 'ECONNREFUSED' }, 'network', /could not be reached/],
        [{ code: 'ECONNRESET' }, 'network', /connectivity/],
        [{ statusCode: 503 }, 'temporary', /Retry/],
    ];
    for (const [error, kind, guidance] of cases) {
        for (const operation of ['containers', 'blobs'] as const) {
            const result = classifyStorageError(error, { operation, access: 'authenticated' });
            assert.equal(result.kind, kind);
            assert.match(result.message, guidance);
            assert.ok(result.message.startsWith(operation === 'containers' ? 'Container listing:' : 'Blob listing:'));
        }
    }
    assert.match(
        classifyStorageError({ code: 'AuthorizationPermissionMismatch' }, { operation: 'blobs', access: 'authenticated' }).message,
        /on this container, storage account, or a parent scope/,
    );
});

test('generic 403 stays uncertain and arbitrary service messages, bodies, and headers are never echoed', () => {
    for (const code of ['UnknownCode', 'AuthorizationPermissionMismatch SECRET', 'https://private/?sig=SECRET']) {
        const result = classifyStorageError({
            statusCode: 403, code,
            message: 'AuthenticationFailed AccountIsDisabled AuthorizationPermissionMismatch SECRET',
            body: '<Error>SECRET</Error>',
            request: { url: 'https://private/?sig=SECRET', headers: { Authorization: 'Bearer SECRET' } },
            response: { headers: { 'x-ms-secret': 'SECRET' } },
        });
        assert.equal(result.kind, 'dataAccess');
        assert.match(result.message, /permission or network policy/);
        assert.doesNotMatch(result.message, /SECRET|Bearer|https:|Assign|lacks permission|account is disabled/);
    }
    const noFacts = classifyStorageError(new Error('ENOTFOUND SECRET'));
    assert.equal(noFacts.kind, 'temporary');
    assert.doesNotMatch(noFacts.message, /SECRET|DNS/);
});

test('public failures never recommend OAuth retries or claim an RBAC role is missing', () => {
    for (const code of ['AuthenticationFailed', 'AuthorizationPermissionMismatch', 'UnknownCode']) {
        const result = classifyStorageError({ statusCode: 403, code }, { operation: 'blobs', access: 'public' });
        assert.equal(result.kind, 'publicAccess');
        assert.match(result.message, /Container-level public access/);
        assert.match(result.message, /Blob-level access only permits reading known blobs/);
        assert.doesNotMatch(result.message, /Authorize Storage|Storage Blob Data Reader|Microsoft Storage credential/);
    }
    const disabled = classifyStorageError({ statusCode: 403, code: 'AccountIsDisabled' }, { operation: 'blobs', access: 'public' });
    assert.equal(disabled.kind, 'accountDisabled');
    assert.match(disabled.message, /repeated sign-in will not fix/);
    const hidden = classifyStorageError({ statusCode: 404, code: 'ContainerNotFound' }, { operation: 'blobs', access: 'public' });
    assert.match(hidden.message, /private container can hide its existence/);
    assert.equal(
        classifyStorageError({ statusCode: 409, code: 'PublicAccessNotPermitted' }, { operation: 'blobs', access: 'public' }).kind,
        'publicAccess',
    );
});
