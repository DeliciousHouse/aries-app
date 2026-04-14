import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('runtime error intake turns failed marketing jobs into repairable incidents', async () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'aries-runtime-errors-'));
  const previousDataRoot = process.env.DATA_ROOT;

  try {
    const jobsRoot = path.join(tmpRoot, 'generated', 'draft', 'marketing-jobs');
    mkdirSync(jobsRoot, { recursive: true });

    writeFileSync(
      path.join(jobsRoot, 'mkt_test_failure.json'),
      `${JSON.stringify(
        {
          schema_name: 'marketing_job_state_schema',
          schema_version: '1.0.0',
          job_id: 'mkt_test_failure',
          tenant_id: 'tenant_test',
          state: 'failed',
          status: 'failed',
          current_stage: 'strategy',
          updated_at: '2026-04-13T17:40:00.000Z',
          last_error: {
            code: 'tool_execution_failed',
            message: 'Synthetic campaign failure for automation test',
            stage: 'strategy',
            retryable: true,
            at: '2026-04-13T17:40:00.000Z',
            details: { command: 'synthetic' },
          },
        },
        null,
        2,
      )}\n`,
    );

    process.env.DATA_ROOT = tmpRoot;
    // @ts-expect-error runtime error scanner is implemented as an ESM .mjs helper
    const { scanRuntimeErrors } = await import('../scripts/automations/lib/runtime-errors.mjs');
    const result = scanRuntimeErrors({ dryRun: true });

    const incident = result.pending.find((item: any) => item.source === 'marketing-job-failure' && item.marketingJobId === 'mkt_test_failure');

    assert.ok(incident, 'expected failed marketing job to become a runtime incident');
    assert.match(String(incident?.errorMessage || ''), /mkt_test_failure/);
    assert.equal(incident?.marketingStage, 'strategy');
    assert.equal(incident?.marketingErrorCode, 'tool_execution_failed');
    assert.equal(incident?.validationCommand, 'node scripts/automations/runtime-error-intake.mjs scan --json');
    assert.ok(result.stats.scannedChecks >= 3);
    assert.ok(result.stats.failedChecks >= 1);
  } finally {
    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('recordStageFailure writes a runtime incident immediately', async () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'aries-runtime-bridge-'));
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;

  try {
    mkdirSync(path.join(tmpRoot, 'specs'), { recursive: true });
    mkdirSync(path.join(tmpRoot, 'app'), { recursive: true });
    mkdirSync(path.join(tmpRoot, 'backend'), { recursive: true });
    mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });
    writeFileSync(path.join(tmpRoot, 'package.json'), '{"name":"tmp-runtime-bridge-test"}\n');

    process.env.CODE_ROOT = tmpRoot;
    process.env.DATA_ROOT = path.join(tmpRoot, 'runtime-data');

    const { recordStageFailure } = await import('../backend/marketing/runtime-state');
    const doc: any = {
      job_id: 'mkt_direct_bridge',
      tenant_id: 'tenant_direct',
      state: 'running',
      status: 'running',
      current_stage: 'research',
      updated_at: '2026-04-13T18:00:00.000Z',
      stages: {
        research: {
          stage: 'research',
          status: 'in_progress',
          started_at: '2026-04-13T17:59:00.000Z',
          completed_at: null,
          failed_at: null,
          run_id: null,
          summary: null,
          primary_output: null,
          outputs: {},
          artifacts: [],
          errors: [],
        },
      },
      errors: [],
      last_error: null,
    };

    recordStageFailure(doc, 'research', {
      code: 'synthetic_direct_failure',
      message: 'direct bridge test failure',
      retryable: true,
      details: { test: true },
      at: '2026-04-13T18:00:01.000Z',
    });

    const log = JSON.parse(readFileSync(path.join(tmpRoot, 'data', 'runtime-error-incidents.json'), 'utf8'));
    const incident = log.items.find((item: any) => item.source === 'marketing-job-failure' && item.marketingJobId === 'mkt_direct_bridge');

    assert.ok(incident, 'expected direct stage failure to create a runtime incident');
    assert.equal(incident.status, 'open');
    assert.equal(incident.marketingStage, 'research');
    assert.equal(incident.marketingErrorCode, 'synthetic_direct_failure');
    assert.match(String(incident.errorMessage || ''), /direct bridge test failure/);
  } finally {
    if (previousCodeRoot === undefined) {
      delete process.env.CODE_ROOT;
    } else {
      process.env.CODE_ROOT = previousCodeRoot;
    }
    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
