import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ExecutionError,
  type ExecutionErrorCode,
  type WorkflowExecutionResult,
  type ExecutionProvider,
} from '../backend/execution';

describe('backend/execution provider-neutral contract', () => {
  it('exports an ExecutionError class with provider, code, message, status, and optional cause', () => {
    const cause = new Error('inner');
    const err = new ExecutionError({
      provider: 'openclaw',
      code: 'unreachable',
      message: 'gateway timed out',
      status: 504,
      cause,
    });

    assert.ok(err instanceof Error, 'ExecutionError should extend Error');
    assert.ok(err instanceof ExecutionError, 'instanceof ExecutionError');
    assert.equal(err.name, 'ExecutionError');
    assert.equal(err.provider, 'openclaw');
    assert.equal(err.code, 'unreachable');
    assert.equal(err.message, 'gateway timed out');
    assert.equal(err.status, 504);
    assert.equal(err.cause, cause);
  });

  it('allows ExecutionError without status or cause', () => {
    const err = new ExecutionError({
      provider: 'hermes',
      code: 'not_configured',
      message: 'missing config',
    });
    assert.equal(err.status, undefined);
    assert.equal(err.cause, undefined);
    assert.equal(err.provider, 'hermes');
  });

  it('covers the full provider-neutral error code set', () => {
    const codes: ExecutionErrorCode[] = [
      'not_configured',
      'unauthorized',
      'unreachable',
      'tool_unavailable',
      'request_invalid',
      'response_invalid',
      'server_error',
    ];
    // Each code must be constructible as an ExecutionError without TS errors at compile time
    // and must round-trip through .code at runtime.
    for (const code of codes) {
      const err = new ExecutionError({ provider: 'openclaw', code, message: code });
      assert.equal(err.code, code);
    }
  });

  it('models WorkflowExecutionResult as a discriminated union with ok | not_implemented | gateway_error', () => {
    const okResult: WorkflowExecutionResult = {
      kind: 'ok',
      envelope: { foo: 'bar' } as unknown as WorkflowExecutionResult extends { kind: 'ok'; envelope: infer E }
        ? E
        : never,
      primaryOutput: { hello: 'world' },
    };
    assert.equal(okResult.kind, 'ok');
    if (okResult.kind === 'ok') {
      assert.deepEqual(okResult.primaryOutput, { hello: 'world' });
    }

    const notImplemented: WorkflowExecutionResult = {
      kind: 'not_implemented',
      payload: {
        status: 'not_implemented',
        code: 'workflow_missing_for_route',
        route: '/api/test',
        message: 'no workflow',
      },
    };
    assert.equal(notImplemented.kind, 'not_implemented');
    if (notImplemented.kind === 'not_implemented') {
      assert.equal(notImplemented.payload.code, 'workflow_missing_for_route');
      assert.equal(notImplemented.payload.route, '/api/test');
    }

    const gatewayError: WorkflowExecutionResult = {
      kind: 'gateway_error',
      error: new ExecutionError({
        provider: 'openclaw',
        code: 'server_error',
        message: 'boom',
        status: 500,
      }),
    };
    assert.equal(gatewayError.kind, 'gateway_error');
    if (gatewayError.kind === 'gateway_error') {
      assert.ok(gatewayError.error instanceof ExecutionError);
      assert.equal(gatewayError.error.code, 'server_error');
    }
  });

  it('does not leak OpenClaw-specific names into the public surface', () => {
    // The exported codes must not include the openclaw_gateway_ prefix used by
    // backend/openclaw/gateway-client.ts. This guards against accidental
    // re-export of provider-coupled identifiers.
    const codes: ExecutionErrorCode[] = [
      'not_configured',
      'unauthorized',
      'unreachable',
      'tool_unavailable',
      'request_invalid',
      'response_invalid',
      'server_error',
    ];
    for (const code of codes) {
      assert.ok(!code.startsWith('openclaw_'), `code ${code} should be provider-neutral`);
      assert.ok(!code.includes('gateway_'), `code ${code} should not embed 'gateway_'`);
    }
  });

  it('describes an ExecutionProvider interface that runs workflows by key + input', async () => {
    // Structural / shape check: any object matching the interface must be
    // assignable to ExecutionProvider. We assert the runtime shape we expect.
    const fakeProvider: ExecutionProvider = {
      name: 'openclaw',
      async runWorkflow(_key, _input) {
        return {
          kind: 'not_implemented',
          payload: {
            status: 'not_implemented',
            code: 'workflow_missing_for_route',
            route: '/x',
            message: 'stub',
          },
        };
      },
    };

    const result = await fakeProvider.runWorkflow('marketing_demo', { foo: 1 });
    assert.equal(result.kind, 'not_implemented');
    assert.equal(fakeProvider.name, 'openclaw');
  });
});
