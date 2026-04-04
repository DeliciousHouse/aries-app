import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getBusinessProfile } from '../../backend/tenant/business-profile';
import { resolveProjectRoot } from '../helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

test('getBusinessProfile queries tenant slug fallback with SQL string literals', async () => {
  const previousDataRoot = process.env.DATA_ROOT;
  const tempDataRoot = mkdtempSync(path.join(os.tmpdir(), 'aries-business-profile-'));
  process.env.DATA_ROOT = tempDataRoot;

  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async query(sql: string, params: unknown[]) {
      queries.push({ sql, params });
      assert.match(sql, /NULLIF\(slug,\s*''\)/);
      assert.match(sql, /'org-' \|\| id::text/);
      assert.deepEqual(params, [11]);
      return {
        rowCount: 1,
        rows: [{ id: 11, name: 'Sugar & Leather', slug: 'org-11' }],
      };
    },
  };

  try {
    const profile = await getBusinessProfile(client as never, '11');
    assert.equal(profile.tenantId, '11');
    assert.equal(profile.businessName, 'Sugar & Leather');
    assert.equal(profile.tenantSlug, 'org-11');
    assert.equal(queries.length, 1);
  } finally {
    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }
    rmSync(tempDataRoot, { force: true, recursive: true });
  }
});

test('getBusinessProfile falls back to the latest workspace brief for brand voice and style vibe', async () => {
  const previousDataRoot = process.env.DATA_ROOT;
  const previousCodeRoot = process.env.CODE_ROOT;
  const tempDataRoot = mkdtempSync(path.join(os.tmpdir(), 'aries-business-profile-workspace-'));
  process.env.DATA_ROOT = tempDataRoot;
  process.env.CODE_ROOT = path.join(PROJECT_ROOT);

  const client = {
    async query() {
      return {
        rowCount: 1,
        rows: [{ id: 11, name: 'Sugar & Leather', slug: 'org-11' }],
      };
    },
  };

  try {
    const { createMarketingJobRuntimeDocument, saveMarketingJobRuntime } = await import('../../backend/marketing/runtime-state');
    const runtimeDoc = createMarketingJobRuntimeDocument({
      jobId: 'mkt_business_profile_workspace_fallback',
      tenantId: '11',
      payload: {
        brandUrl: 'https://sugarandleather.com',
      },
      brandKit: {
        path: path.join(tempDataRoot, 'generated', 'validated', '11', 'brand-kit.json'),
        source_url: 'https://sugarandleather.com',
        canonical_url: 'https://sugarandleather.com',
        brand_name: 'Sugar & Leather',
        logo_urls: [],
        colors: {
          primary: '#f6339a',
          secondary: '#a855f7',
          accent: '#e60076',
          palette: ['#f6339a', '#a855f7', '#e60076'],
        },
        font_families: ['Inter'],
        external_links: [],
        extracted_at: new Date().toISOString(),
        brand_voice_summary: null,
        offer_summary: null,
      },
    });
    saveMarketingJobRuntime(runtimeDoc.job_id, runtimeDoc);

    const workspacePath = path.join(
      tempDataRoot,
      'generated',
      'draft',
      'marketing-workspaces',
      runtimeDoc.job_id,
      'workspace.json',
    );
    mkdirSync(path.dirname(workspacePath), { recursive: true });
    writeFileSync(
      workspacePath,
      JSON.stringify({
        schema_name: 'marketing_campaign_workspace',
        schema_version: '1.0.0',
        job_id: runtimeDoc.job_id,
        tenant_id: '11',
        workflow_state: 'draft',
        brief: {
          websiteUrl: 'https://sugarandleather.com',
          businessName: 'Sugar & Leather',
          businessType: 'Coaching',
          approverName: '',
          goal: 'Book calls',
          offer: '',
          competitorUrl: '',
          channels: [],
          brandVoice: 'Warm, premium, proof-led.',
          styleVibe: 'Editorial luxury with bold gradient accents.',
          visualReferences: [],
          mustUseCopy: '',
          mustAvoidAesthetics: '',
          notes: '',
          brandAssets: [],
        },
        stage_reviews: {
          brand: { status: 'not_ready', latestNote: null, updatedAt: null, evidenceKind: null },
          strategy: { status: 'not_ready', latestNote: null, updatedAt: null, evidenceKind: null },
          creative: { status: 'not_ready', latestNote: null, updatedAt: null, evidenceKind: null },
        },
        creative_asset_reviews: {},
        status_history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2),
    );

    const profile = await getBusinessProfile(client as never, '11');
    assert.equal(profile.brandVoice, 'Warm, premium, proof-led.');
    assert.equal(profile.styleVibe, 'Editorial luxury with bold gradient accents.');
  } finally {
    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }
    if (previousCodeRoot === undefined) {
      delete process.env.CODE_ROOT;
    } else {
      process.env.CODE_ROOT = previousCodeRoot;
    }
    rmSync(tempDataRoot, { force: true, recursive: true });
  }
});
