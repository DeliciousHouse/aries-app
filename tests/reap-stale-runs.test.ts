import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  runStaleRunReaper,
  staleRunReaperThresholdMs,
  staleRunReaperThresholdsByStage,
} from '../backend/marketing/stale-run-reaper';

type RuntimeDocStub = {
  schema_name: string;
  schema_version: string;
  job_id: string;
  tenant_id: string;
  job_type: string;
  state: string;
  status: string;
  current_stage: string;
  stage_order: string[];
  stages: Record<string, unknown>;
  approvals: { current: null; history: never[] };
  publish_config: { platforms: string[]; live_publish_platforms: string[]; video_render_platforms: string[] };
  brand_kit: Record<string, unknown>;
  inputs: { request: Record<string, unknown>; brand_url: string };
  errors: unknown[];
  last_error: unknown | null;
  history: Array<{ at: string; state: string; status: string; stage: string | null; note: string }>;
  created_at: string;
  updated_at: string;
  failure_reason?: string | null;
};

function makeRuntimeDoc(input: {
  jobId: string;
  tenantId: string;
  state: string;
  status: string;
  updatedAtIso: string;
  stage?: string;
}): RuntimeDocStub {
  const stage = input.stage ?? 'research';
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: input.jobId,
    tenant_id: input.tenantId,
    job_type: 'brand_campaign',
    state: input.state,
    status: input.status,
    current_stage: stage,
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: {
        stage: 'research',
        status: 'in_progress',
        started_at: input.updatedAtIso,
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
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: {
      path: '/tmp/brand-kit.json',
      source_url: 'https://example.com',
      canonical_url: 'https://example.com',
      brand_name: 'Example',
      logo_urls: [],
      colors: { primary: null, secondary: null, accent: null, palette: [] },
      font_families: [],
      external_links: [],
      extracted_at: input.updatedAtIso,
      brand_voice_summary: null,
      offer_summary: null,
    },
    inputs: { request: {}, brand_url: 'https://example.com' },
    errors: [],
    last_error: null,
    history: [
      { at: input.updatedAtIso, state: input.state, status: input.status, stage, note: 'created for test' },
    ],
    created_at: input.updatedAtIso,
    updated_at: input.updatedAtIso,
  };
}

async function withScratch<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'aries-stale-reaper-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeRuntimeDoc(dataRoot: string, doc: RuntimeDocStub): Promise<string> {
  const dir = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${doc.job_id}.json`);
  await writeFile(filePath, JSON.stringify(doc, null, 2));
  return filePath;
}

test('staleRunReaperThresholdMs defaults to 30 minutes', () => {
  const prior = process.env.STALE_RUN_REAPER_THRESHOLD_MS;
  delete process.env.STALE_RUN_REAPER_THRESHOLD_MS;
  try {
    assert.equal(staleRunReaperThresholdMs(), 30 * 60 * 1000);
  } finally {
    if (prior !== undefined) process.env.STALE_RUN_REAPER_THRESHOLD_MS = prior;
  }
});

test('staleRunReaperThresholdMs honors env override', () => {
  const prior = process.env.STALE_RUN_REAPER_THRESHOLD_MS;
  process.env.STALE_RUN_REAPER_THRESHOLD_MS = '60000';
  try {
    assert.equal(staleRunReaperThresholdMs(), 60_000);
  } finally {
    if (prior === undefined) delete process.env.STALE_RUN_REAPER_THRESHOLD_MS;
    else process.env.STALE_RUN_REAPER_THRESHOLD_MS = prior;
  }
});

test('staleRunReaperThresholdsByStage defaults to per-stage windows', () => {
  const prior = {
    global: process.env.STALE_RUN_REAPER_THRESHOLD_MS,
    research: process.env.STALE_RUN_REAPER_RESEARCH_THRESHOLD_MS,
    strategy: process.env.STALE_RUN_REAPER_STRATEGY_THRESHOLD_MS,
    production: process.env.STALE_RUN_REAPER_PRODUCTION_THRESHOLD_MS,
    publish: process.env.STALE_RUN_REAPER_PUBLISH_THRESHOLD_MS,
  };
  delete process.env.STALE_RUN_REAPER_THRESHOLD_MS;
  delete process.env.STALE_RUN_REAPER_RESEARCH_THRESHOLD_MS;
  delete process.env.STALE_RUN_REAPER_STRATEGY_THRESHOLD_MS;
  delete process.env.STALE_RUN_REAPER_PRODUCTION_THRESHOLD_MS;
  delete process.env.STALE_RUN_REAPER_PUBLISH_THRESHOLD_MS;
  try {
    assert.deepEqual(staleRunReaperThresholdsByStage(), {
      research: 10 * 60 * 1000,
      strategy: 5 * 60 * 1000,
      production: 90 * 60 * 1000,
      publish: 30 * 60 * 1000,
    });
  } finally {
    if (prior.global === undefined) delete process.env.STALE_RUN_REAPER_THRESHOLD_MS;
    else process.env.STALE_RUN_REAPER_THRESHOLD_MS = prior.global;
    if (prior.research === undefined) delete process.env.STALE_RUN_REAPER_RESEARCH_THRESHOLD_MS;
    else process.env.STALE_RUN_REAPER_RESEARCH_THRESHOLD_MS = prior.research;
    if (prior.strategy === undefined) delete process.env.STALE_RUN_REAPER_STRATEGY_THRESHOLD_MS;
    else process.env.STALE_RUN_REAPER_STRATEGY_THRESHOLD_MS = prior.strategy;
    if (prior.production === undefined) delete process.env.STALE_RUN_REAPER_PRODUCTION_THRESHOLD_MS;
    else process.env.STALE_RUN_REAPER_PRODUCTION_THRESHOLD_MS = prior.production;
    if (prior.publish === undefined) delete process.env.STALE_RUN_REAPER_PUBLISH_THRESHOLD_MS;
    else process.env.STALE_RUN_REAPER_PUBLISH_THRESHOLD_MS = prior.publish;
  }
});

test('reaper returns empty report when marketing-jobs dir is missing', async () => {
  await withScratch(async (dataRoot) => {
    const report = await runStaleRunReaper({ dataRoot, dryRun: true });
    assert.equal(report.scanned, 0);
    assert.equal(report.candidates.length, 0);
    assert.equal(report.mutated, 0);
    assert.equal(report.errors, 0);
  });
});

test('dry-run identifies a stale running run without mutating the file', async () => {
  await withScratch(async (dataRoot) => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    const staleAt = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const doc = makeRuntimeDoc({
      jobId: 'job-stale-running',
      tenantId: 'tenant-1',
      state: 'running',
      status: 'running',
      updatedAtIso: staleAt,
    });
    const filePath = await writeRuntimeDoc(dataRoot, doc);

    const report = await runStaleRunReaper({
      dataRoot,
      dryRun: true,
      now: () => now,
      thresholdMs: 30 * 60 * 1000,
    });

    assert.equal(report.scanned, 1, 'one runtime doc scanned');
    assert.equal(report.candidates.length, 1, 'one candidate identified');
    assert.equal(report.mutated, 0, 'dry-run must not mutate');
    assert.equal(report.candidates[0]!.jobId, 'job-stale-running');
    assert.equal(report.candidates[0]!.state, 'running');
    assert.equal(report.candidates[0]!.status, 'running');
    assert.ok(report.candidates[0]!.silentMs > 30 * 60 * 1000, 'silent ms exceeds threshold');

    const after = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    assert.equal(after.state, 'running', 'state unchanged on dry-run');
    assert.equal(after.status, 'running', 'status unchanged on dry-run');
    assert.equal(after.failure_reason ?? null, null, 'failure_reason not set on dry-run');
  });
});

test('uses stage-specific thresholds and reaps a job stalled after research completed but never advanced', async () => {
  await withScratch(async (dataRoot) => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    const elevenMinutesAgo = new Date(now.getTime() - 11 * 60 * 1000).toISOString();
    const productionFresh = new Date(now.getTime() - 11 * 60 * 1000).toISOString();

    const stalledResearch = makeRuntimeDoc({
      jobId: 'job-research-stalled',
      tenantId: 'tenant-1',
      state: 'running',
      status: 'running',
      updatedAtIso: elevenMinutesAgo,
      stage: 'research',
    });
    (stalledResearch.stages.research as Record<string, unknown>).status = 'completed';
    (stalledResearch.stages.research as Record<string, unknown>).completed_at = elevenMinutesAgo;
    stalledResearch.history.push({
      at: elevenMinutesAgo,
      state: 'running',
      status: 'running',
      stage: 'research',
      note: 'research completed from Hermes callback',
    });
    await writeRuntimeDoc(dataRoot, stalledResearch);

    const freshProduction = makeRuntimeDoc({
      jobId: 'job-production-not-stale',
      tenantId: 'tenant-1',
      state: 'running',
      status: 'running',
      updatedAtIso: productionFresh,
      stage: 'production',
    });
    freshProduction.stages.production = {
      stage: 'production',
      status: 'in_progress',
      started_at: productionFresh,
      completed_at: null,
      failed_at: null,
      run_id: null,
      summary: null,
      primary_output: null,
      outputs: {},
      artifacts: [],
      errors: [],
    };
    await writeRuntimeDoc(dataRoot, freshProduction);

    const report = await runStaleRunReaper({
      dataRoot,
      dryRun: false,
      now: () => now,
    });

    assert.equal(report.scanned, 2);
    assert.equal(report.candidates.length, 1, 'only the research-stalled job is reaped');
    assert.equal(report.candidates[0]!.jobId, 'job-research-stalled');
    assert.equal(report.candidates[0]!.stage, 'research');
    assert.equal(report.candidates[0]!.thresholdMs, 10 * 60 * 1000);
    assert.ok(report.skipped >= 1, 'production job is skipped because 11 minutes is below the 90 minute production threshold');
  });
});

test('apply mutates the doc to failed_stale and is idempotent on re-run', async () => {
  await withScratch(async (dataRoot) => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    const staleAt = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const doc = makeRuntimeDoc({
      jobId: 'job-stale-running',
      tenantId: 'tenant-1',
      state: 'running',
      status: 'running',
      updatedAtIso: staleAt,
      stage: 'production',
    });
    const filePath = await writeRuntimeDoc(dataRoot, doc);

    const first = await runStaleRunReaper({
      dataRoot,
      dryRun: false,
      now: () => now,
      thresholdMs: 30 * 60 * 1000,
    });
    assert.equal(first.mutated, 1, 'first apply mutates one doc');
    assert.equal(first.candidates.length, 1);
    assert.equal(first.candidates[0]!.mutated, true);

    const after = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    assert.equal(after.state, 'failed', 'state moved to failed');
    assert.equal(after.status, 'failed_stale', 'status moved to failed_stale');
    assert.equal(after.failure_reason, 'marketing_job_stalled');
    const lastError = after.last_error as Record<string, unknown> | null;
    assert.ok(lastError, 'last_error populated');
    assert.equal(lastError!.code, 'marketing_job_stalled');
    assert.equal(lastError!.stage, 'production');

    const history = after.history as Array<{ note: string; state: string; status: string }>;
    assert.equal(history.at(-1)!.state, 'failed');
    assert.equal(history.at(-1)!.status, 'failed_stale');

    const second = await runStaleRunReaper({
      dataRoot,
      dryRun: false,
      now: () => now,
      thresholdMs: 30 * 60 * 1000,
    });
    assert.equal(second.candidates.length, 0, 'idempotent: no new candidates on re-run');
    assert.equal(second.mutated, 0, 'idempotent: no further mutations on re-run');
    assert.ok(second.skipped >= 1, 'already-reaped doc skipped on re-run');

    const afterSecond = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    assert.equal(afterSecond.status, 'failed_stale', 'status remains failed_stale after re-run');
    assert.equal(afterSecond.failure_reason, 'marketing_job_stalled');
  });
});

test('does not reap fresh in-flight runs', async () => {
  await withScratch(async (dataRoot) => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    const fresh = new Date(now.getTime() - 60_000).toISOString();
    await writeRuntimeDoc(
      dataRoot,
      makeRuntimeDoc({
        jobId: 'job-fresh',
        tenantId: 'tenant-1',
        state: 'running',
        status: 'running',
        updatedAtIso: fresh,
      }),
    );

    const report = await runStaleRunReaper({
      dataRoot,
      dryRun: false,
      now: () => now,
      thresholdMs: 30 * 60 * 1000,
    });
    assert.equal(report.scanned, 1);
    assert.equal(report.candidates.length, 0);
    assert.equal(report.mutated, 0);
    assert.ok(report.skipped >= 1);
  });
});

test('does not reap terminal docs (completed, failed, needs_connection)', async () => {
  await withScratch(async (dataRoot) => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    const ancient = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    for (const [state, status] of [
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['needs_connection', 'needs_connection'],
    ] as const) {
      await writeRuntimeDoc(
        dataRoot,
        makeRuntimeDoc({
          jobId: `job-${state}`,
          tenantId: 'tenant-1',
          state,
          status,
          updatedAtIso: ancient,
        }),
      );
    }

    const report = await runStaleRunReaper({
      dataRoot,
      dryRun: false,
      now: () => now,
      thresholdMs: 30 * 60 * 1000,
    });
    assert.equal(report.candidates.length, 0, 'no candidates for terminal docs');
    assert.equal(report.mutated, 0, 'no mutations for terminal docs');
  });
});

test('reaps approval_required runs (still in-flight)', async () => {
  await withScratch(async (dataRoot) => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    const stale = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const filePath = await writeRuntimeDoc(
      dataRoot,
      makeRuntimeDoc({
        jobId: 'job-approval',
        tenantId: 'tenant-1',
        state: 'approval_required',
        status: 'awaiting_approval',
        updatedAtIso: stale,
      }),
    );

    const report = await runStaleRunReaper({
      dataRoot,
      dryRun: false,
      now: () => now,
      thresholdMs: 30 * 60 * 1000,
    });
    assert.equal(report.candidates.length, 1, 'awaiting_approval should be reaped when stale');
    assert.equal(report.mutated, 1);

    const after = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    assert.equal(after.status, 'failed_stale');
    assert.equal(after.failure_reason, 'marketing_job_stalled');
  });
});

test('skips already-reaped docs even on a forced re-scan with old timestamps', async () => {
  await withScratch(async (dataRoot) => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    const stale = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const doc = makeRuntimeDoc({
      jobId: 'job-already-reaped',
      tenantId: 'tenant-1',
      state: 'failed',
      status: 'failed_stale',
      updatedAtIso: stale,
    });
    doc.failure_reason = 'marketing_job_stalled';
    await writeRuntimeDoc(dataRoot, doc);

    const report = await runStaleRunReaper({
      dataRoot,
      dryRun: false,
      now: () => now,
      thresholdMs: 30 * 60 * 1000,
    });
    assert.equal(report.candidates.length, 0, 'already-reaped doc is not a candidate');
    assert.equal(report.mutated, 0);
  });
});

test('skips runtime docs missing any parseable progress timestamp', async () => {
  await withScratch(async (dataRoot) => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    const doc = makeRuntimeDoc({
      jobId: 'job-no-timestamp',
      tenantId: 'tenant-1',
      state: 'running',
      status: 'running',
      updatedAtIso: '2026-05-06T11:00:00.000Z',
    });
    doc.updated_at = 'not-a-date';
    (doc.stages.research as Record<string, unknown>).started_at = 'not-a-date';
    (doc.stages.research as Record<string, unknown>).completed_at = 'not-a-date';
    (doc.stages.research as Record<string, unknown>).failed_at = 'not-a-date';
    doc.history = [{ at: 'not-a-date', state: 'running', status: 'running', stage: 'research', note: 'bad timestamp' }];
    await writeRuntimeDoc(dataRoot, doc);

    const report = await runStaleRunReaper({
      dataRoot,
      dryRun: false,
      now: () => now,
      thresholdMs: 30 * 60 * 1000,
    });
    assert.equal(report.candidates.length, 0, 'unparseable progress timestamps must not produce a candidate');
    assert.equal(report.mutated, 0);
    assert.ok(report.skipped >= 1);
  });
});

test('--threshold-ms override propagates into report.thresholdsByStage and report.thresholdMs', async () => {
  await withScratch(async (dataRoot) => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    const staleAt = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const doc = makeRuntimeDoc({
      jobId: 'job-override-propagation',
      tenantId: 'tenant-1',
      state: 'running',
      status: 'running',
      updatedAtIso: staleAt,
      stage: 'production',
    });
    await writeRuntimeDoc(dataRoot, doc);

    const overrideMs = 45 * 60 * 1000; // 45 minutes
    const report = await runStaleRunReaper({
      dataRoot,
      dryRun: true,
      now: () => now,
      thresholdMs: overrideMs,
    });

    // report.thresholdMs must reflect the explicit override, not null
    assert.equal(report.thresholdMs, overrideMs, 'report.thresholdMs must equal the override');

    // report.thresholdsByStage must use the override for every stage, not env/default values
    assert.equal(report.thresholdsByStage.research, overrideMs, 'research threshold must equal override');
    assert.equal(report.thresholdsByStage.strategy, overrideMs, 'strategy threshold must equal override');
    assert.equal(report.thresholdsByStage.production, overrideMs, 'production threshold must equal override');
    assert.equal(report.thresholdsByStage.publish, overrideMs, 'publish threshold must equal override');

    // The production job is 2 hours stale — well past 45 min override — so it should be a candidate
    assert.equal(report.candidates.length, 1, 'stale job should be candidate with override threshold');
    assert.equal(report.candidates[0]!.thresholdMs, overrideMs, 'candidate.thresholdMs must equal override');
  });
});

test('without --threshold-ms override, report.thresholdMs is null and thresholdsByStage reflects per-stage defaults', async () => {
  await withScratch(async (dataRoot) => {
    // Clean env to ensure defaults apply
    const savedEnvKeys = [
      'STALE_RUN_REAPER_THRESHOLD_MS',
      'STALE_RUN_REAPER_RESEARCH_THRESHOLD_MS',
      'STALE_RUN_REAPER_STRATEGY_THRESHOLD_MS',
      'STALE_RUN_REAPER_PRODUCTION_THRESHOLD_MS',
      'STALE_RUN_REAPER_PUBLISH_THRESHOLD_MS',
    ] as const;
    const saved: Record<string, string | undefined> = {};
    for (const key of savedEnvKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }

    try {
      const report = await runStaleRunReaper({ dataRoot, dryRun: true });

      assert.equal(report.thresholdMs, null, 'report.thresholdMs must be null when no override');
      assert.equal(report.thresholdsByStage.research, 10 * 60 * 1000);
      assert.equal(report.thresholdsByStage.strategy, 5 * 60 * 1000);
      assert.equal(report.thresholdsByStage.production, 90 * 60 * 1000);
      assert.equal(report.thresholdsByStage.publish, 30 * 60 * 1000);
    } finally {
      for (const key of savedEnvKeys) {
        if (saved[key] !== undefined) process.env[key] = saved[key];
      }
    }
  });
});

test('ignores files with unknown schema_name', async () => {
  await withScratch(async (dataRoot) => {
    const dir = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'foreign.json'),
      JSON.stringify({ schema_name: 'something_else', updated_at: '2025-01-01T00:00:00.000Z' }),
    );

    const report = await runStaleRunReaper({
      dataRoot,
      dryRun: false,
      now: () => new Date('2026-05-06T12:00:00.000Z'),
      thresholdMs: 1000,
    });
    assert.equal(report.candidates.length, 0);
    assert.equal(report.mutated, 0);
    assert.ok(report.skipped >= 1);
  });
});
