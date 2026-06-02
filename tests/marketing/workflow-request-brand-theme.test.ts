/**
 * The production image brief must carry the brand's dark/light theme + the real
 * brand logo so Hermes renders on-brand.
 *
 * Bug (found via live E2E, 2026-06-02): the image brief sent `Brand palette:
 * #ffffff` and never told Hermes the brand is dark or which logo to use, so the
 * pipeline rendered white images with invented logos. The fix carries
 * colors.background + colors.mode + the first non-data logo URL into the brief.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/marketing/workflow-request-brand-theme.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProductionResumeContext } from '../../backend/social-content/workflow-request';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';

const BRAND_URL = 'https://aries.sugarandleather.com/';
const LOGO_URL = 'https://aries.sugarandleather.com/aries-logo.webp';

function makeDoc(colors: NonNullable<SocialContentJobRuntimeDocument['brand_kit']>['colors'], logoUrls: string[]): SocialContentJobRuntimeDocument {
  const ts = new Date().toISOString();
  const stage = (status: string) => ({
    stage: 'research' as const, status, started_at: ts, completed_at: null, failed_at: null,
    run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [],
  });
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: 'job_brand_theme_test',
    tenant_id: '15',
    job_type: 'weekly_social_content',
    state: 'running',
    status: 'running',
    current_stage: 'production',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: { ...stage('completed'), stage: 'research' },
      strategy: { ...stage('completed'), stage: 'strategy' },
      production: { ...stage('in_progress'), stage: 'production' },
      publish: { ...stage('not_started'), stage: 'publish' },
    } as SocialContentJobRuntimeDocument['stages'],
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: {
      source_url: BRAND_URL, canonical_url: BRAND_URL, brand_name: 'Aries AI',
      logo_urls: logoUrls, colors,
      font_families: ['Inter'], external_links: [], extracted_at: ts,
      brand_voice_summary: 'Marketing on autopilot.', offer_summary: null,
      positioning: null, audience: null, tone_of_voice: null, style_vibe: null,
      path: '/tmp/brand-kit.json',
    },
    inputs: { request: { imageCreativeCount: 1 }, brand_url: BRAND_URL },
    errors: [], last_error: null, history: [], created_at: ts, updated_at: ts,
    social_content_runtime: null, created_by: null, deleted_at: null, deleted_by: null,
    soft_cancel_requested_at: null,
  } as SocialContentJobRuntimeDocument;
}

test('dark brand → brief instructs a dark background and the real logo', () => {
  const doc = makeDoc(
    { primary: '#ffffff', secondary: null, accent: '#ec4899', palette: ['#ec4899', '#ffffff'], background: '#000000', mode: 'dark' },
    [LOGO_URL],
  );
  const { contextBlock } = buildProductionResumeContext({ doc, researchOutput: null, strategyOutput: null });

  assert.match(contextBlock, /Brand theme: DARK/, 'brief must declare a DARK theme');
  assert.match(contextBlock, /do NOT use a white or light background/i, 'brief must forbid white backgrounds for dark brands');
  assert.ok(contextBlock.includes('#000000'), 'brief must name the dark background color');
  assert.ok(contextBlock.includes(LOGO_URL), 'brief must reference the real brand logo URL');
  assert.match(contextBlock, /do NOT invent, redraw, or substitute a different logo/i, 'brief must forbid inventing a logo');
});

test('light brand → brief does not force a dark background', () => {
  const doc = makeDoc(
    { primary: '#1d4ed8', secondary: null, accent: null, palette: ['#1d4ed8'], background: '#ffffff', mode: 'light' },
    [],
  );
  const { contextBlock } = buildProductionResumeContext({ doc, researchOutput: null, strategyOutput: null });

  assert.doesNotMatch(contextBlock, /Brand theme: DARK/, 'light brand must not get a DARK instruction');
  assert.match(contextBlock, /Brand theme: light/, 'light brand should declare a light theme');
});

test('unknown theme (legacy kit) → no theme instruction, no crash', () => {
  const doc = makeDoc(
    { primary: '#333333', secondary: null, accent: null, palette: ['#333333'], background: null, mode: null },
    [],
  );
  const { contextBlock } = buildProductionResumeContext({ doc, researchOutput: null, strategyOutput: null });

  assert.doesNotMatch(contextBlock, /Brand theme:/, 'legacy kit without a detected theme must not emit a theme line');
});
