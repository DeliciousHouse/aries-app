/**
 * AA-159 — execution-run records carry their processing-engine classification.
 *
 * Every execution run is submitted to Hermes and executed by a model, so the
 * stamp is always AI_LLM. The field is OPTIONAL on the record type: records
 * written before it shipped omit it entirely, and those must still load (same
 * back-compat contract as `target_profile`).
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withDataRoot<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-execution-engine-'));

  process.env.DATA_ROOT = dataRoot;
  try {
    return await run(dataRoot);
  } finally {
    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('a new execution run is stamped AI_LLM', async () => {
  await withDataRoot(async () => {
    const { createExecutionRunRecord, loadExecutionRunRecord } = await import(
      '../backend/execution/run-store'
    );

    const created = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'marketing_pipeline',
      action: 'run',
      tenantId: 'tenant-123',
      stage: 'production',
    });

    assert.equal(created.execution_engine, 'AI_LLM');
    // And it survives the round-trip to disk, which is what a reader sees.
    assert.equal(loadExecutionRunRecord(created.aries_run_id)?.execution_engine, 'AI_LLM');
  });
});

test('a pre-AA-159 record with no execution_engine still loads', async () => {
  await withDataRoot(async (dataRoot) => {
    const { loadExecutionRunRecord } = await import('../backend/execution/run-store');

    const runId = 'arun_legacy-record';
    const dir = path.join(dataRoot, 'generated', 'draft', 'execution-runs');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `${runId}.json`),
      JSON.stringify({
        schema_name: 'aries_execution_run',
        schema_version: '1.0.0',
        aries_run_id: runId,
        provider: 'hermes',
        domain: 'marketing',
        workflow_key: 'marketing_pipeline',
        action: 'run',
        tenant_id: 'tenant-1',
        marketing_job_id: null,
        approval_id: null,
        stage: 'research',
        workflow_step_id: null,
        external_run_id: 'hermes-1',
        status: 'running',
        event_ids: [],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        last_error: null,
        result: null,
      }),
      'utf8',
    );

    const loaded = loadExecutionRunRecord(runId);
    assert.ok(loaded, 'legacy record loads');
    assert.equal(loaded?.status, 'running');
    // Absent means "unclassified" — readers must not see a fabricated default.
    assert.equal(loaded?.execution_engine, undefined);
  });
});
