import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const original: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    original[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeRuntimeDoc(): Record<string, unknown> {
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: 'mkt_runtime_brand_kit_normalization',
    tenant_id: 'tenant_runtime_brand_kit_normalization',
    job_type: 'weekly_social_content',
    state: 'running',
    status: 'running',
    current_stage: 'strategy',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      strategy: { stage: 'strategy', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      production: { stage: 'production', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: {
      path: '/tmp/brand-kit.json',
      source_url: 'https://aries.example.com',
      canonical_url: 'https://aries.example.com',
      brand_name: 'Aries',
      logo_urls: [],
      colors: { primary: null, secondary: null, accent: null, palette: [] },
      font_families: [],
      external_links: [],
      extracted_at: '2026-05-19T00:00:00.000Z',
      brand_voice_summary: 'A, approval-safe social content operating system for small businesses.',
      offer_summary: 'An, automated weekly marketing workspace.',
      positioning: 'The, safe publishing workflow for teams.',
      audience: 'A, operators who need approval-safe content.',
      tone_of_voice: 'An, crisp and direct tone.',
      style_vibe: 'The, editorial dashboard feel.',
    },
    inputs: { request: {}, brand_url: 'https://aries.example.com' },
    errors: [],
    last_error: null,
    history: [],
    created_at: '2026-05-19T00:00:00.000Z',
    updated_at: '2026-05-19T00:00:00.000Z',
  };
}

test('loadSocialContentJobRuntime normalizes persisted runtime brand kit copy on read', async () => {
  const { loadSocialContentJobRuntime } = await import('../backend/marketing/runtime-state.js');
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-runtime-brand-kit-'));
  try {
    const doc = makeRuntimeDoc();
    const jobsDir = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs');
    await mkdir(jobsDir, { recursive: true });
    await writeFile(path.join(jobsDir, `${doc.job_id}.json`), JSON.stringify(doc, null, 2));

    await withEnv({ DATA_ROOT: dataRoot }, async () => {
      const loaded = await loadSocialContentJobRuntime(String(doc.job_id));

      assert.ok(loaded?.brand_kit, 'runtime doc should load a brand kit');
      assert.equal(loaded.brand_kit.brand_voice_summary, 'Approval-safe social content operating system for small businesses.');
      assert.equal(loaded.brand_kit.offer_summary, 'Automated weekly marketing workspace.');
      assert.equal(loaded.brand_kit.positioning, 'Safe publishing workflow for teams.');
      assert.equal(loaded.brand_kit.audience, 'Operators who need approval-safe content.');
      assert.equal(loaded.brand_kit.tone_of_voice, 'Crisp and direct tone.');
      assert.equal(loaded.brand_kit.style_vibe, 'Editorial dashboard feel.');
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
