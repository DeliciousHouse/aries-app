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

test('marketingPayloadDefaultsFromBusinessProfile derives defaults from validated brand analysis sources', async () => {
  const previousDataRoot = process.env.DATA_ROOT;
  const tempDataRoot = mkdtempSync(path.join(os.tmpdir(), 'aries-business-profile-defaults-'));
  process.env.DATA_ROOT = tempDataRoot;

  try {
    const { marketingPayloadDefaultsFromBusinessProfile } = await import('../../backend/tenant/business-profile');
    const validatedRoot = path.join(tempDataRoot, 'generated', 'validated', '11');
    mkdirSync(validatedRoot, { recursive: true });
    writeFileSync(
      path.join(validatedRoot, 'brand-profile.json'),
      JSON.stringify(
        {
          business_name: 'Sugar & Leather',
          website_url: 'https://sugarandleather.com',
          business_type: 'Executive coaching',
          primary_goal: 'Book elite coaching calls',
          launch_approver_name: 'Audrey',
          offer: 'Elite coaching network',
          brand_voice: ['Sophisticated', 'Provocative', 'Authoritative'],
          competitor_url: 'https://betterup.com',
          channels: ['meta-ads', 'landing-page'],
        },
        null,
        2,
      ),
    );

    const defaults = marketingPayloadDefaultsFromBusinessProfile('11');

    assert.equal(defaults.websiteUrl, 'https://sugarandleather.com');
    assert.equal(defaults.businessName, 'Sugar & Leather');
    assert.equal(defaults.businessType, 'Executive coaching');
    assert.equal(defaults.primaryGoal, 'Book elite coaching calls');
    assert.equal(defaults.goal, 'Book elite coaching calls');
    assert.equal(defaults.launchApproverName, 'Audrey');
    assert.equal(defaults.approverName, 'Audrey');
    assert.equal(defaults.offer, 'Elite coaching network');
    assert.equal(defaults.brandVoice, 'Sophisticated and Authoritative.');
    assert.equal(defaults.competitorUrl, 'https://betterup.com/');
    assert.deepEqual(defaults.channels, ['meta-ads', 'landing-page']);
  } finally {
    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }
    rmSync(tempDataRoot, { force: true, recursive: true });
  }
});

test('getBusinessProfile fills inferable client-facing fields with polished current-source values', async () => {
  const previousDataRoot = process.env.DATA_ROOT;
  const tempDataRoot = mkdtempSync(path.join(os.tmpdir(), 'aries-business-profile-complete-'));
  process.env.DATA_ROOT = tempDataRoot;

  const client = {
    async query() {
      return {
        rowCount: 1,
        rows: [{ id: 11, name: 'The Framex', slug: 'theframex' }],
      };
    },
  };

  try {
    const validatedRoot = path.join(tempDataRoot, 'generated', 'validated', '11');
    mkdirSync(validatedRoot, { recursive: true });
    writeFileSync(
      path.join(validatedRoot, 'brand-profile.json'),
      JSON.stringify(
        {
          tenant_id: '11',
          brand_name: 'The Framex',
          website_url: 'https://theframex.com',
          canonical_url: 'https://theframex.com',
          business_type: 'Custom framing studio',
          primary_goal: 'Book more framing consults',
          offer: 'Custom framing and installation packages for modern interiors.',
          channels: ['meta-ads', 'landing-page'],
          audience: 'Homeowners and design-forward teams planning custom framing.',
          positioning: 'Custom framing with modern installation support for fast-moving interiors.',
          primary_cta: 'Schedule a framing consult',
          proof_points: [
            'Installation support keeps launches on schedule.',
            'Design-forward framing packages reduce vendor overhead.',
            'Clear consult-first next steps improve conversion quality.',
          ],
          brand_voice: ['Direct', 'Modern', 'Assured'],
          hooks: {
            'landing-page': ['Frame the room without slowing the project down.'],
          },
          brand_kit: {
            brand_name: 'The Framex',
            source_url: 'https://theframex.com',
            canonical_url: 'https://theframex.com',
            logo_urls: ['https://theframex.com/assets/logo.svg'],
            colors: {
              primary: '#111111',
              secondary: '#f4f4f4',
              accent: '#c24d2c',
              palette: ['#111111', '#f4f4f4', '#c24d2c'],
            },
            font_families: ['Manrope'],
            external_links: [],
            extracted_at: '2026-04-06T00:00:00.000Z',
            brand_voice_summary: 'Direct and modern.',
            offer_summary: 'Custom framing and installation packages for modern interiors.',
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      path.join(validatedRoot, 'brand-kit.json'),
      JSON.stringify(
        {
          tenant_id: '11',
          source_url: 'https://theframex.com',
          canonical_url: 'https://theframex.com',
          brand_name: 'The Framex',
          logo_urls: ['https://theframex.com/assets/logo.svg'],
          colors: {
            primary: '#111111',
            secondary: '#f4f4f4',
            accent: '#c24d2c',
            palette: ['#111111', '#f4f4f4', '#c24d2c'],
          },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-04-06T00:00:00.000Z',
          brand_voice_summary: 'Direct and modern.',
          offer_summary: 'Custom framing and installation packages for modern interiors.',
        },
        null,
        2,
      ),
    );

    const profile = await getBusinessProfile(client as never, '11');

    assert.equal(profile.businessName, 'The Framex');
    assert.equal(profile.websiteUrl, 'https://theframex.com');
    assert.equal(profile.businessType, 'Custom framing studio');
    assert.equal(profile.primaryGoal, 'Book more framing consults');
    assert.equal(profile.offer, 'Custom framing and installation packages for modern interiors.');
    assert.deepEqual(profile.channels, ['meta-ads', 'landing-page']);
    assert.equal(profile.brandVoice, 'Direct, Modern, and Assured.');
    assert.equal(profile.styleVibe, 'Minimal and editorial.');
    assert.equal(typeof profile.notes, 'string');
    assert.equal(profile.notes?.includes('Custom framing with modern installation support for fast-moving interiors.'), true);
    assert.equal(profile.notes?.includes('Custom framing and installation packages for modern interiors.'), true);
    assert.equal(profile.brandIdentity?.ctaStyle, 'Direct, action-oriented CTAs led by "Schedule a framing consult".');
    assert.equal(
      profile.brandIdentity?.proofStyle,
      'Proof-led messaging grounded in concrete outcomes and credibility signals.',
    );
  } finally {
    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }
    rmSync(tempDataRoot, { force: true, recursive: true });
  }
});

test('getBusinessProfile infers a polished coaching profile when the current-source cues are strong but stored fields are blank', async () => {
  const previousDataRoot = process.env.DATA_ROOT;
  const tempDataRoot = mkdtempSync(path.join(os.tmpdir(), 'aries-business-profile-coaching-'));
  process.env.DATA_ROOT = tempDataRoot;

  const client = {
    async query() {
      return {
        rowCount: 1,
        rows: [{ id: 11, name: 'Sugar & Leather', slug: 'sugarandleather' }],
      };
    },
  };

  try {
    const validatedRoot = path.join(tempDataRoot, 'generated', 'validated', '11');
    mkdirSync(validatedRoot, { recursive: true });
    writeFileSync(
      path.join(validatedRoot, 'brand-profile.json'),
      JSON.stringify(
        {
          tenant_id: '11',
          brand_name: 'Sugar & Leather',
          website_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          offer: 'Executive and transformational coaching memberships with private coaching support.',
          audience: 'Professionals looking for guided transformation and high-trust coaching support.',
          positioning: 'A premium coaching network built around personal transformation and direct support.',
          primary_cta: 'Book a call',
          proof_points: [
            'Private coaching and memberships create a high-touch support model.',
            'Clear next steps move visitors into discovery calls.',
          ],
          brand_voice: ['Confident', 'Encouraging', 'High-trust'],
          hooks: {
            'landing-page': ['Unlock your full potential with elite coaching.'],
          },
          brand_kit: {
            brand_name: 'Sugar & Leather',
            source_url: 'https://sugarandleather.com',
            canonical_url: 'https://sugarandleather.com',
            logo_urls: ['https://sugarandleather.com/assets/wordmark.png'],
            colors: {
              primary: '#f6339a',
              secondary: '#0f172a',
              accent: '#a855f7',
              palette: ['#f6339a', '#0f172a', '#a855f7'],
            },
            font_families: ['Inter'],
            external_links: [{ platform: 'instagram', url: 'https://instagram.com/sugarandleather' }],
            extracted_at: '2026-04-06T00:00:00.000Z',
            brand_voice_summary: 'Confident and encouraging.',
            offer_summary: 'Executive and transformational coaching memberships with private coaching support.',
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      path.join(validatedRoot, 'brand-kit.json'),
      JSON.stringify(
        {
          tenant_id: '11',
          source_url: 'https://sugarandleather.com',
          canonical_url: 'https://sugarandleather.com',
          brand_name: 'Sugar & Leather',
          logo_urls: ['https://sugarandleather.com/assets/wordmark.png'],
          colors: {
            primary: '#f6339a',
            secondary: '#0f172a',
            accent: '#a855f7',
            palette: ['#f6339a', '#0f172a', '#a855f7'],
          },
          font_families: ['Inter'],
          external_links: [{ platform: 'instagram', url: 'https://instagram.com/sugarandleather' }],
          extracted_at: '2026-04-06T00:00:00.000Z',
          brand_voice_summary: 'Confident and encouraging.',
          offer_summary: 'Executive and transformational coaching memberships with private coaching support.',
        },
        null,
        2,
      ),
    );

    const profile = await getBusinessProfile(client as never, '11');

    assert.equal(profile.businessType, 'Executive and transformational coaching network');
    assert.equal(profile.primaryGoal, 'Book more qualified calls');
    assert.equal(
      profile.offer,
      'Executive and transformational coaching memberships with private coaching support.',
    );
    assert.deepEqual(profile.channels, ['meta-ads', 'instagram']);
    assert.equal(typeof profile.notes, 'string');
    assert.equal((profile.notes || '').length > 0, true);
  } finally {
    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }
    rmSync(tempDataRoot, { force: true, recursive: true });
  }
});
