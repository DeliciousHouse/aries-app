import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HermesRunCallbackPayloadSchema,
  PROTOCOL_VERSION,
  isCompatibleProtocolVersion,
} from '../../packages/aries-hermes-protocol/src/index';
import type { HermesRunCallbackPayload } from '../../packages/aries-hermes-protocol/src/index';

describe('callback-envelope-shape', () => {
  it('exports PROTOCOL_VERSION string', () => {
    assert.equal(typeof PROTOCOL_VERSION, 'string');
    assert.match(PROTOCOL_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it('parses a minimal completed callback', () => {
    const payload: HermesRunCallbackPayload = {
      event_id: 'evt-123',
      aries_run_id: 'arun_00000000-0000-0000-0000-000000000001',
      status: 'completed',
    };
    const result = HermesRunCallbackPayloadSchema.safeParse(payload);
    assert.equal(result.success, true);
  });

  it('parses a requires_approval callback with next-stage convention', () => {
    // v0.1.3.43 normalization: research completes → approval.stage = 'strategy'
    const payload: HermesRunCallbackPayload = {
      event_id: 'evt-research-done',
      aries_run_id: 'arun_00000000-0000-0000-0000-000000000002',
      status: 'requires_approval',
      stage: 'research',
      approval: {
        stage: 'strategy',
        workflow_step_id: 'step-approve-strategy',
        prompt: 'Approve the strategy to continue.',
        approval_step: 'approve_weekly_plan',
        resume_token: 'tok-abc',
      },
    };
    const result = HermesRunCallbackPayloadSchema.safeParse(payload);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.approval?.stage, 'strategy');
  });

  it('parses strategy→production approval convention', () => {
    const raw = {
      event_id: 'evt-strategy-done',
      aries_run_id: 'arun_00000000-0000-0000-0000-000000000003',
      status: 'requires_approval',
      stage: 'strategy',
      approval: {
        stage: 'production',
        workflow_step_id: 'step-approve-prod',
        prompt: 'Approve creative production.',
      },
    };
    const result = HermesRunCallbackPayloadSchema.safeParse(raw);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.approval?.stage, 'production');
  });

  it('parses production→publish approval convention', () => {
    const raw = {
      event_id: 'evt-prod-done',
      aries_run_id: 'arun_00000000-0000-0000-0000-000000000004',
      status: 'requires_approval',
      stage: 'production',
      approval: {
        stage: 'publish',
        workflow_step_id: 'step-approve-publish',
        prompt: 'Approve publish.',
        approval_step: 'approve_publish',
      },
    };
    const result = HermesRunCallbackPayloadSchema.safeParse(raw);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.approval?.stage, 'publish');
  });

  it('parses a failed callback with error envelope', () => {
    const raw = {
      event_id: 'evt-fail',
      aries_run_id: 'arun_00000000-0000-0000-0000-000000000005',
      status: 'failed',
      error: { code: 'hermes_run_failed', message: 'Run timed out.', retryable: true },
    };
    const result = HermesRunCallbackPayloadSchema.safeParse(raw);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.error?.code, 'hermes_run_failed');
    assert.equal(result.data.error?.retryable, true);
  });

  it('rejects a payload missing event_id', () => {
    const raw = {
      aries_run_id: 'arun_00000000-0000-0000-0000-000000000006',
      status: 'completed',
    };
    const result = HermesRunCallbackPayloadSchema.safeParse(raw);
    assert.equal(result.success, false);
  });

  it('rejects an unknown status', () => {
    const raw = {
      event_id: 'evt-bad',
      aries_run_id: 'arun_00000000-0000-0000-0000-000000000007',
      status: 'pending',
    };
    const result = HermesRunCallbackPayloadSchema.safeParse(raw);
    assert.equal(result.success, false);
  });

  it('round-trips: build via TypeScript type, parse via Zod, assert equality', () => {
    const built: HermesRunCallbackPayload = {
      event_id: 'evt-roundtrip',
      aries_run_id: 'arun_00000000-0000-0000-0000-000000000008',
      hermes_run_id: 'hrun-abc',
      status: 'completed',
      stage: 'production',
      output: [{ images: ['img1', 'img2'] }],
    };
    const result = HermesRunCallbackPayloadSchema.safeParse(built);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(result.data.event_id, built.event_id);
    assert.deepEqual(result.data.aries_run_id, built.aries_run_id);
    assert.deepEqual(result.data.hermes_run_id, built.hermes_run_id);
    assert.deepEqual(result.data.status, built.status);
    assert.deepEqual(result.data.stage, built.stage);
  });

  it('accepts legacy approval stage values for backward compat', () => {
    // 'plan', 'creative', 'video' are kept in the schema for Hermes-side migration
    for (const stage of ['plan', 'creative', 'video'] as const) {
      const raw = {
        event_id: `evt-legacy-${stage}`,
        aries_run_id: 'arun_00000000-0000-0000-0000-000000000009',
        status: 'requires_approval',
        approval: {
          stage,
          workflow_step_id: `step-${stage}`,
          prompt: `Legacy ${stage} approval.`,
        },
      };
      const result = HermesRunCallbackPayloadSchema.safeParse(raw);
      assert.equal(result.success, true, `expected legacy stage '${stage}' to parse`);
    }
  });

  it('accepts stopped status (terminal cancellation)', () => {
    const raw = {
      event_id: 'evt-stopped',
      aries_run_id: 'arun_00000000-0000-0000-0000-000000000010',
      status: 'stopped',
    };
    const result = HermesRunCallbackPayloadSchema.safeParse(raw);
    assert.equal(result.success, true, 'stopped is a valid terminal status');
    if (!result.success) return;
    assert.equal(result.data.status, 'stopped');
  });

  it('accepts protocol_version field when present', () => {
    const raw = {
      event_id: 'evt-versioned',
      aries_run_id: 'arun_00000000-0000-0000-0000-000000000011',
      status: 'completed',
      protocol_version: PROTOCOL_VERSION,
    };
    const result = HermesRunCallbackPayloadSchema.safeParse(raw);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.protocol_version, PROTOCOL_VERSION);
  });

  it('accepts absent protocol_version for backward compat', () => {
    const raw = {
      event_id: 'evt-no-version',
      aries_run_id: 'arun_00000000-0000-0000-0000-000000000012',
      status: 'completed',
    };
    const result = HermesRunCallbackPayloadSchema.safeParse(raw);
    assert.equal(result.success, true, 'protocol_version is optional for migration compat');
  });

  it('isCompatibleProtocolVersion: same major version is compatible', () => {
    assert.equal(isCompatibleProtocolVersion('1.0.0'), true);
    assert.equal(isCompatibleProtocolVersion('1.99.0'), true);
    assert.equal(isCompatibleProtocolVersion(PROTOCOL_VERSION), true);
  });

  it('isCompatibleProtocolVersion: different major version is incompatible', () => {
    assert.equal(isCompatibleProtocolVersion('2.0.0'), false);
    assert.equal(isCompatibleProtocolVersion('0.9.0'), false);
  });

  it('isCompatibleProtocolVersion: malformed versions are always rejected', () => {
    assert.equal(isCompatibleProtocolVersion('1.not-semver'), false, '"1.not-semver" should fail');
    assert.equal(isCompatibleProtocolVersion('1'), false, '"1" alone should fail');
    assert.equal(isCompatibleProtocolVersion(''), false, 'empty string should fail');
    assert.equal(isCompatibleProtocolVersion('1.1'), false, '"1.1" missing patch should fail');
    assert.equal(isCompatibleProtocolVersion('foo'), false, '"foo" should fail');
  });

  it('schema rejects malformed protocol_version values', () => {
    for (const bad of ['1.not-semver', '1', 'foo']) {
      const raw = {
        event_id: `evt-badver`,
        aries_run_id: 'arun_00000000-0000-0000-0000-000000000013',
        status: 'completed',
        protocol_version: bad,
      };
      const result = HermesRunCallbackPayloadSchema.safeParse(raw);
      assert.equal(result.success, false, `protocol_version "${bad}" should be rejected by schema`);
    }
  });

  it('rejects empty event_id (empty string)', () => {
    const raw = {
      event_id: '',
      aries_run_id: 'arun_00000000-0000-0000-0000-000000000014',
      status: 'completed',
    };
    const result = HermesRunCallbackPayloadSchema.safeParse(raw);
    assert.equal(result.success, false, 'empty event_id must be rejected to prevent deduplication poisoning');
  });

  it('rejects whitespace-only event_id', () => {
    const raw = {
      event_id: '   ',
      aries_run_id: 'arun_00000000-0000-0000-0000-000000000015',
      status: 'completed',
    };
    const result = HermesRunCallbackPayloadSchema.safeParse(raw);
    assert.equal(result.success, false, 'whitespace-only event_id must be rejected');
  });

  it('accepts a valid non-empty event_id', () => {
    const raw = {
      event_id: 'evt-valid-id-123',
      aries_run_id: 'arun_00000000-0000-0000-0000-000000000016',
      status: 'completed',
    };
    const result = HermesRunCallbackPayloadSchema.safeParse(raw);
    assert.equal(result.success, true);
  });
});
