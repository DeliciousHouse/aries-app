import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HermesRunCallbackPayloadSchema,
  PROTOCOL_VERSION,
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
});
