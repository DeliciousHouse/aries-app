import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import pool from '@/lib/db';
import { normalizeMetaLocatorUrl, normalizeMetaPageId } from '@/lib/marketing-competitor';
import { describeSpecResolution, resolveDataPath } from '@/lib/runtime-paths';
import { ingestRuntimeDocAssets } from './asset-ingest';
import { loadTenantBrandKit, tenantBrandKitPath, type TenantBrandKit } from './brand-kit';
import { recordMarketingFailureRuntimeIncident } from './runtime-error-bridge';

const REQUIRED_SCHEMA_FILES = [
  'marketing_job_state_schema.v1.json',
] as const;
const MARKETING_RUNTIME_SCHEMA_NAME = 'marketing_job_state_schema';
const LEGACY_MARKETING_RUNTIME_SCHEMA_NAME = 'job_runtime_state_schema';
const MARKETING_RUNTIME_SCHEMA_VERSION = '1.0.0';

export type MarketingStage = 'research' | 'strategy' | 'production' | 'publish';
export type MarketingJobState = 'queued' | 'running' | 'approval_required' | 'completed' | 'failed' | 'needs_connection';
/**
 * `failed_stale` is reserved for the stale-run reaper script
 * (`scripts/reap-stale-runs.ts`). The reaper sets it when an in-flight run has
 * exceeded the allowed silence window for its current stage (defaults:
 * research 10m, strategy 5m, production 90m, publish 30m; optional global
 * override `STALE_RUN_REAPER_THRESHOLD_MS`). It is never produced by the
 * orchestrator or callback handlers; existing code paths treat it identically
 * to `failed`.
 */
export type MarketingJobStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'needs_connection'
  | 'failed_stale';
export type MarketingStageStatus =
  | 'not_started'
  | 'in_progress'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'skipped'
  // Stage is gated on a channel (Meta/IG/etc) being connected. Used by Stage 4
  // when the operator has not yet connected a publishing channel. Stages 1-3
  // artifacts are preserved; the stage is paused with an informational status,
  // not an approval pause.
  | 'requires_channel_connection';

type MarketingStageArtifactBase = {
  id: string;
  stage: MarketingStage;
  title: string;
  category: string;
  status: string;
  summary: string;
  details: string[];
  path?: string | null;
  preview_path?: string | null;
  action_label?: string | null;
  action_href?: string | null;
};

export type MarketingVideoStageArtifact = MarketingStageArtifactBase & {
  type: 'video';
  contentType: 'video/mp4';
  url: string;
  posterUrl: string;
  platformSlug: string;
  familyId: string;
  durationSeconds: number;
  aspectRatio: string;
};

export type MarketingStageArtifact = MarketingStageArtifactBase | MarketingVideoStageArtifact;

export type MarketingStageSummary = {
  summary: string;
  highlight?: string | null;
};

export type MarketingStageError = {
  code: string;
  message: string;
  stage: MarketingStage;
  retryable?: boolean;
  details?: Record<string, unknown>;
  at: string;
};

export type MarketingStageRecord = {
  stage: MarketingStage;
  status: MarketingStageStatus;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  run_id: string | null;
  summary: MarketingStageSummary | null;
  primary_output: Record<string, unknown> | null;
  outputs: Record<string, unknown>;
  artifacts: MarketingStageArtifact[];
  errors: MarketingStageError[];
};

export type MarketingPublishConfig = {
  platforms: string[];
  live_publish_platforms: string[];
  video_render_platforms: string[];
};

export type MarketingBrandKitReference = Omit<TenantBrandKit, 'tenant_id'> & {
  path: string;
};

export type MarketingApprovalCheckpoint = {
  stage: Extract<MarketingStage, 'strategy' | 'production' | 'publish'>;
  status: 'awaiting_approval';
  approval_id?: string | null;
  workflow_name?: string | null;
  workflow_step_id?: string | null;
  title: string;
  message: string;
  requested_at: string;
  resume_token?: string | null;
  action_label?: string | null;
  publish_config?: MarketingPublishConfig | null;
};

export type MarketingApprovalHistoryEntry = {
  stage: Extract<MarketingStage, 'strategy' | 'production' | 'publish'>;
  status: 'requested' | 'approved' | 'denied' | 'cleared';
  at: string;
  approval_id?: string | null;
  workflow_step_id?: string | null;
  approved_by?: string | null;
  message?: string | null;
  publish_config?: MarketingPublishConfig | null;
};

export type MarketingHistoryEntry = {
  at: string;
  state: string;
  status: string;
  stage: MarketingStage | null;
  note: string;
};

export type SocialContentJobRuntimeDocument = {
  schema_name: typeof MARKETING_RUNTIME_SCHEMA_NAME;
  schema_version: typeof MARKETING_RUNTIME_SCHEMA_VERSION;
  job_id: string;
  tenant_id: string;
  /**
   * The kind of marketing job. Derived from `inputs.request.jobType` so it
   * always agrees with `requestedJobTypeFromDoc()`, which drives the pipeline.
   * Recurring brand pieces vs one-off campaigns; the orchestrator branches on
   * this label to assemble a one_off_brief Hermes payload and the schedule
   * path uses it to populate `scheduled_posts.campaign_end_date`.
   */
  job_type: 'weekly_social_content' | 'one_off_post' | 'one_off_campaign';
  state: MarketingJobState;
  status: MarketingJobStatus;
  current_stage: MarketingStage;
  stage_order: MarketingStage[];
  stages: Record<MarketingStage, MarketingStageRecord>;
  approvals: {
    current: MarketingApprovalCheckpoint | null;
    history: MarketingApprovalHistoryEntry[];
  };
  publish_config: MarketingPublishConfig;
  brand_kit: MarketingBrandKitReference | null;
  inputs: {
    request: Record<string, unknown>;
    brand_url: string;
    competitor_url?: string | null;
    competitor_brand?: string | null;
    facebook_page_url?: string | null;
    ad_library_url?: string | null;
    meta_page_id?: string | null;
    competitor_facebook_url?: string | null;
  };
  summary?: {
    headline?: string;
    subheadline?: string;
  };
  errors: MarketingStageError[];
  last_error: MarketingStageError | null;
  history: MarketingHistoryEntry[];
  created_at: string;
  updated_at: string;
  /** Optional projection used by Hermes weekly social-content flows. */
  social_content_runtime?: Record<string, unknown> | null;
  /** Optional. When set, identifies the user that originated the campaign.
   * Used by the campaign delete permission check (tenant_admin OR creator).
   * Existing campaigns predating this field have `created_by === null` and
   * are treated as admin-only to delete. */
  created_by?: string | null;
  /** Optional. When set, the campaign is soft-deleted — hidden from the
   * regular campaign list / dashboard queries, but still resolvable via its
   * direct jobId for the "Deleted campaigns" restore section and for
   * support queries. Clearing this field restores the campaign. */
  deleted_at?: string | null;
  /** Optional. User id of whoever soft-deleted the campaign. Paired with
   * `deleted_at`. `null` when the campaign is live. */
  deleted_by?: string | null;
  /** Optional. Set when a soft-delete lands while the pipeline is still
   * executing. The orchestrator checks this before starting each stage and
   * short-circuits to the `cancelled` terminal status if set. */
  soft_cancel_requested_at?: string | null;
  /** Optional machine-readable reason set when a non-orchestrator process
   * forces the run into a terminal failed status. Currently only used by
   * the stale-run reaper (`scripts/reap-stale-runs.ts`), which sets
   * `'marketing_job_stalled'` when a submitted/running run has been silent
   * past the staleness threshold for its current stage. Treated as advisory
   * metadata. */
  failure_reason?: string | null;
};

const STAGES: MarketingStage[] = ['research', 'strategy', 'production', 'publish'];

export function nowIso(): string {
  return new Date().toISOString();
}

export function defaultPublishConfig(input: Partial<MarketingPublishConfig> = {}): MarketingPublishConfig {
  return {
    platforms: normalizePlatformList(input.platforms, ['meta-ads', 'tiktok']),
    live_publish_platforms: normalizePlatformList(input.live_publish_platforms, ['meta-ads']),
    video_render_platforms: normalizePlatformList(input.video_render_platforms, ['tiktok']),
  };
}

/**
 * Map onboarding/business-profile channel ids (e.g. `meta-ads`, `instagram`,
 * `email`, `google-business`, `linkedin`) into a publish config. Channels that
 * do not correspond to a publish platform (e.g. `email`, `google-business`)
 * are retained in `platforms` so downstream surfaces can display them, but
 * only platforms we actually publish to are wired into `live_publish_platforms`
 * and `video_render_platforms`.
 */
export function publishConfigFromChannels(
  channels: string[] | null | undefined,
  fallback: Partial<MarketingPublishConfig> = {},
): MarketingPublishConfig {
  if (!Array.isArray(channels) || channels.length === 0) {
    return defaultPublishConfig(fallback);
  }

  const normalized = Array.from(
    new Set(
      channels
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim().toLowerCase())
        .map((entry) => (entry === 'facebook' || entry === 'meta' ? 'meta-ads' : entry)),
    ),
  );

  if (normalized.length === 0) {
    return defaultPublishConfig(fallback);
  }

  const videoPlatforms = new Set(['tiktok', 'youtube']);
  const livePublishPlatforms = new Set(['meta-ads', 'instagram', 'linkedin', 'x', 'tiktok', 'youtube']);

  return {
    platforms: normalized,
    live_publish_platforms: normalized.filter((platform) => livePublishPlatforms.has(platform)),
    video_render_platforms: normalized.filter((platform) => videoPlatforms.has(platform)),
  };
}

function normalizePlatformList(value: unknown, fallback: string[] = []): string[] {
  const items = Array.isArray(value) ? value : fallback;
  return Array.from(
    new Set(
      items
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim().toLowerCase())
    )
  );
}

function defaultStageRecord(stage: MarketingStage): MarketingStageRecord {
  return {
    stage,
    status: 'not_started',
    started_at: null,
    completed_at: null,
    failed_at: null,
    run_id: null,
    summary: null,
    primary_output: null,
    outputs: {},
    artifacts: [],
    errors: [],
  };
}

export function createSocialContentJobRuntimeDocument(input: {
  jobId: string;
  tenantId: string;
  payload: Record<string, unknown>;
  brandKit: MarketingBrandKitReference;
  publishConfig?: Partial<MarketingPublishConfig>;
  /** Optional. User id of the caller that created the campaign. Persisted so
   * delete permissions can allow the creator (in addition to tenant_admin)
   * to soft-delete their own campaign. */
  createdBy?: string | null;
}): SocialContentJobRuntimeDocument {
  const ts = nowIso();
  const payloadChannels = Array.isArray(input.payload?.channels)
    ? (input.payload.channels as unknown[]).filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
      )
    : [];
  const resolvedPublishConfig = input.publishConfig
    ? defaultPublishConfig(input.publishConfig)
    : publishConfigFromChannels(payloadChannels);
  // Label the doc with the actual job type. Compared against the raw
  // `request.jobType` value with the exact same strict equality that
  // `requestedJobTypeFromDoc()` uses (no trimming/coercion on either side),
  // so the top-level label can never disagree with what drives the pipeline.
  // Unknown jobType values fall back to 'weekly_social_content' -- the legacy
  // behaviour for any tenant submitting without an explicit jobType.
  const resolvedJobType: SocialContentJobRuntimeDocument['job_type'] =
    input.payload?.jobType === 'one_off_post' || input.payload?.jobType === 'one_off_campaign'
      ? 'one_off_post'
      : 'weekly_social_content';
  return {
    schema_name: MARKETING_RUNTIME_SCHEMA_NAME,
    schema_version: MARKETING_RUNTIME_SCHEMA_VERSION,
    job_id: input.jobId,
    tenant_id: input.tenantId,
    job_type: resolvedJobType,
    state: 'queued',
    status: 'pending',
    current_stage: 'research',
    stage_order: [...STAGES],
    stages: {
      research: defaultStageRecord('research'),
      strategy: defaultStageRecord('strategy'),
      production: defaultStageRecord('production'),
      publish: defaultStageRecord('publish'),
    },
    approvals: {
      current: null,
      history: [],
    },
    publish_config: resolvedPublishConfig,
    brand_kit: input.brandKit,
    inputs: {
      request: input.payload,
      brand_url: asString(input.payload.brandUrl) || '',
      competitor_url: asString(input.payload.competitorUrl) || asString(input.payload.brandUrl),
      competitor_brand: asString(input.payload.competitorBrand),
      facebook_page_url:
        normalizeMetaLocatorUrl(asString(input.payload.facebookPageUrl) || asString(input.payload.competitorFacebookUrl)),
      ad_library_url: normalizeMetaLocatorUrl(asString(input.payload.adLibraryUrl)),
      meta_page_id: normalizeMetaPageId(asString(input.payload.metaPageId)),
      competitor_facebook_url: normalizeMetaLocatorUrl(asString(input.payload.competitorFacebookUrl)),
    },
    errors: [],
    last_error: null,
    history: [
      {
        at: ts,
        state: 'queued',
        status: 'pending',
        stage: 'research',
        note: 'marketing job created',
      },
    ],
    created_at: ts,
    updated_at: ts,
    social_content_runtime: null,
    created_by: input.createdBy ?? null,
    deleted_at: null,
    deleted_by: null,
    soft_cancel_requested_at: null,
  };
}

/** Returns true when the pipeline has unfinished work. Used by soft-delete
 * to decide whether to arm the cancel signal (in-progress) or just hide
 * the campaign (already terminal). */
export function isPipelineActive(doc: SocialContentJobRuntimeDocument): boolean {
  if (doc.state === 'completed' || doc.state === 'failed') {
    return false;
  }
  return true;
}

export async function assertMarketingRuntimeSchemas(): Promise<void> {
  for (const fileName of REQUIRED_SCHEMA_FILES) {
    const resolution = describeSpecResolution(fileName);
    console.info('[marketing-runtime-schema]', {
      event: 'resolve',
      requestedCodeRoot: resolution.requestedCodeRoot,
      resolvedCodeRoot: resolution.resolvedCodeRoot,
      resolvedSpecPath: resolution.resolvedSpecPath,
      cwd: process.cwd(),
      triedSpecPaths: resolution.triedSpecPaths,
    });

    const schemaPath = resolution.resolvedSpecPath;
    if (!existsSync(schemaPath)) {
      throw new Error(
        `marketing_runtime_schema_resolution_failed: requestedCodeRoot=${resolution.requestedCodeRoot || 'unset'} cwd=${process.cwd()} resolvedCodeRoot=${resolution.resolvedCodeRoot} triedSpecPaths=${resolution.triedSpecPaths.join(', ')}`,
      );
    }

    try {
      const raw = await readFile(schemaPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('schema root must be an object');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`HARD_FAILURE: invalid required schema input ${schemaPath}: ${message}`);
    }
  }
}

export function marketingRuntimePath(jobId: string): string {
  return resolveDataPath('generated', 'draft', 'marketing-jobs', `${jobId}.json`);
}

function marketingRuntimeRoot(): string {
  return resolveDataPath('generated', 'draft', 'marketing-jobs');
}

export function marketingBrandKitReferenceFromTenantBrandKit(
  brandKit: TenantBrandKit,
  filePath: string,
): MarketingBrandKitReference {
  return {
    path: filePath,
    source_url: brandKit.source_url,
    canonical_url: brandKit.canonical_url,
    brand_name: brandKit.brand_name,
    logo_urls: [...brandKit.logo_urls],
    colors: {
      primary: brandKit.colors.primary,
      secondary: brandKit.colors.secondary,
      accent: brandKit.colors.accent,
      palette: [...brandKit.colors.palette],
      background: brandKit.colors.background ?? null,
      mode: brandKit.colors.mode ?? null,
    },
    font_families: [...brandKit.font_families],
    external_links: brandKit.external_links.map((entry) => ({ ...entry })),
    extracted_at: brandKit.extracted_at,
    brand_voice_summary: brandKit.brand_voice_summary ?? null,
    offer_summary: brandKit.offer_summary ?? null,
    positioning: brandKit.positioning ?? null,
    audience: brandKit.audience ?? null,
    tone_of_voice: brandKit.tone_of_voice ?? null,
    style_vibe: brandKit.style_vibe ?? null,
  };
}

function runtimeBrandKitReferenceFromTenantBrandKit(
  tenantId: string,
  brandKit: TenantBrandKit,
): MarketingBrandKitReference {
  return marketingBrandKitReferenceFromTenantBrandKit(brandKit, tenantBrandKitPath(tenantId));
}

async function recoverLegacyRuntimeBrandKit(doc: SocialContentJobRuntimeDocument): Promise<MarketingBrandKitReference | null> {
  try {
    const persistedBrandKit = await loadTenantBrandKit(doc.tenant_id);
    if (!persistedBrandKit) {
      console.warn('[marketing-runtime-state]', {
        event: 'legacy-runtime-brand-kit-missing',
        jobId: doc.job_id,
        tenantId: doc.tenant_id,
        recovered: false,
        source: 'none',
      });
      return null;
    }

    const recoveredBrandKit = runtimeBrandKitReferenceFromTenantBrandKit(doc.tenant_id, persistedBrandKit);
    console.warn('[marketing-runtime-state]', {
      event: 'legacy-runtime-brand-kit-missing',
      jobId: doc.job_id,
      tenantId: doc.tenant_id,
      recovered: true,
      source: 'validated_brand_kit_file',
      brandKitPath: recoveredBrandKit.path,
    });
    return recoveredBrandKit;
  } catch (error) {
    console.warn('[marketing-runtime-state]', {
      event: 'legacy-runtime-brand-kit-missing',
      jobId: doc.job_id,
      tenantId: doc.tenant_id,
      recovered: false,
      source: 'none',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function assertMarketingRuntimeDocument(doc: SocialContentJobRuntimeDocument): void {
  if (!doc.brand_kit) {
    throw new Error('invalid_marketing_runtime_document:brand_kit_required');
  }
  if (!doc.inputs?.brand_url || doc.inputs.brand_url.trim().length === 0) {
    throw new Error('invalid_marketing_runtime_document:brand_url_required');
  }
  if (doc.brand_kit.source_url !== doc.inputs.brand_url) {
    throw new Error('invalid_marketing_runtime_document:brand_kit_source_mismatch');
  }
  if (!Number.isFinite(Date.parse(doc.brand_kit.extracted_at))) {
    throw new Error('invalid_marketing_runtime_document:brand_kit_extracted_at_invalid');
  }
}

export async function loadSocialContentJobRuntime(jobId: string): Promise<SocialContentJobRuntimeDocument | null> {
  const filePath = marketingRuntimePath(jobId);
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const schemaName = parsed.schema_name;
    const isKnownSchema =
      schemaName === MARKETING_RUNTIME_SCHEMA_NAME || schemaName === LEGACY_MARKETING_RUNTIME_SCHEMA_NAME;
    if (!isKnownSchema) {
      return null;
    }
    if (typeof parsed.job_id !== 'string' || parsed.job_id.length === 0) {
      return null;
    }
    if (typeof parsed.tenant_id !== 'string' || parsed.tenant_id.length === 0) {
      return null;
    }

    const doc = parsed as SocialContentJobRuntimeDocument;
    if (!doc.stage_order || !Array.isArray(doc.stage_order) || doc.stage_order.length === 0) {
      doc.stage_order = [...STAGES];
    }
    if (!doc.current_stage || !STAGES.includes(doc.current_stage)) {
      doc.current_stage = 'research';
    }
    if (!doc.stages || typeof doc.stages !== 'object' || Array.isArray(doc.stages)) {
      return null;
    }
    if (
      !doc.stages.research &&
      !doc.stages.strategy &&
      !doc.stages.production &&
      !doc.stages.publish
    ) {
      return null;
    }
    for (const stage of STAGES) {
      if (!doc.stages[stage]) {
        doc.stages[stage] = defaultStageRecord(stage);
      }
    }
    if (!doc.publish_config || typeof doc.publish_config !== 'object' || Array.isArray(doc.publish_config)) {
      doc.publish_config = defaultPublishConfig();
    } else {
      doc.publish_config = defaultPublishConfig(doc.publish_config);
    }
    if (!doc.brand_kit) {
      doc.brand_kit = await recoverLegacyRuntimeBrandKit(doc);
    }
    return doc;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

async function collectMarketingJobRefsForTenant(
  tenantId: string,
  options: { includeDeleted?: boolean; onlyDeleted?: boolean; limit?: number } = {},
): Promise<Array<{ jobId: string; updatedAt: number }>> {
  const root = marketingRuntimeRoot();
  const refs: Array<{ jobId: string; updatedAt: number }> = [];
  let entries: string[];
  try {
    entries = (await readdir(root)).filter((entry) => entry.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  for (const entry of entries) {
    try {
      const raw = await readFile(path.join(root, entry), 'utf8');
      const doc = JSON.parse(raw) as Record<string, unknown>;
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        continue;
      }
      const schemaName = doc.schema_name;
      const isKnownSchema =
        schemaName === MARKETING_RUNTIME_SCHEMA_NAME || schemaName === LEGACY_MARKETING_RUNTIME_SCHEMA_NAME;
      if (!isKnownSchema) {
        continue;
      }
      const stages = doc.stages as Record<string, unknown> | undefined;
      if (!stages || typeof stages !== 'object' || Array.isArray(stages)) {
        continue;
      }
      const hasAtLeastOneStage =
        'research' in stages || 'strategy' in stages || 'production' in stages || 'publish' in stages;
      if (!hasAtLeastOneStage) {
        continue;
      }
      if (typeof doc.job_id !== 'string' || doc.job_id.length === 0) {
        continue;
      }
      if (typeof doc.tenant_id !== 'string' || doc.tenant_id.length === 0) {
        continue;
      }
      if (doc.tenant_id !== tenantId) {
        continue;
      }
      // Soft-delete filter. By default the list view skips deleted campaigns.
      // Callers that need to see the Recycle Bin pass { onlyDeleted: true }.
      // Callers that need both (e.g. internal migration / support tooling)
      // pass { includeDeleted: true }.
      const deletedAtRaw = typeof doc.deleted_at === 'string' ? doc.deleted_at.trim() : '';
      const isDeleted = deletedAtRaw.length > 0;
      if (options.onlyDeleted && !isDeleted) {
        continue;
      }
      if (!options.onlyDeleted && !options.includeDeleted && isDeleted) {
        continue;
      }
      const updatedAt = Date.parse(typeof doc.updated_at === 'string' ? doc.updated_at : '');
      if (!Number.isFinite(updatedAt)) {
        continue;
      }
      refs.push({ jobId: doc.job_id, updatedAt });
    } catch {
      continue;
    }
  }

  const sorted = refs.sort((left, right) => right.updatedAt - left.updatedAt);
  return options.limit !== undefined ? sorted.slice(0, options.limit) : sorted;
}

export async function listSocialContentJobIdsForTenant(
  tenantId: string,
  options: { limit?: number } = {},
): Promise<string[]> {
  return (await collectMarketingJobRefsForTenant(tenantId, options)).map((entry) => entry.jobId);
}

/**
 * Returns true when the requesting tenant owns the given media basename. This
 * is the legacy basename-addressed ownership check, kept as a back-compat
 * fallback for the Hermes media route; id-addressed reads enforce ownership
 * authoritatively in SQL (WHERE id=$1 AND tenant_id=$2) and never reach here.
 *
 * Implementation notes (re: operational guardrail #1):
 * - Primary check: a single authoritative `creative_assets` query keyed on
 *   tenant_id (basename match against served_asset_ref / storage_key). One
 *   indexed lookup, no Promise.all fan-out.
 * - Fallback (DB unavailable only): a sequential filesystem scan of the
 *   tenant's JSON runtime files. Serial I/O (no fan-out); a single tenant
 *   rarely has more than a handful of active jobs, so the cost is bounded.
 * - We include soft-deleted jobs (includeDeleted: true) because an operator
 *   viewing a media URL that was generated before a soft-delete should still
 *   pass the ownership check rather than getting a spurious 404.
 *
 * NOTE: the basename match is collision-prone on the flat, non-tenant-namespaced
 * Hermes cache (two tenants can share `image.png`); the id route exists to close
 * that. Do not extend this path — address new media by creative_assets.id.
 */
export async function tenantOwnsHermesMediaBasename(
  tenantId: string,
  basename: string,
): Promise<boolean> {
  if (!tenantId || !basename) {
    return false;
  }

  // Primary check: the creative_assets table is the authoritative ownership
  // record and covers all runtime-document shapes (social-content, brand-campaign,
  // etc.). Fall through to the filesystem scan only on DB error.
  const tenantIdInt = Number(tenantId);
  if (Number.isFinite(tenantIdInt) && tenantIdInt > 0) {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query<{ found: number }>(
          `SELECT 1 AS found FROM creative_assets
           WHERE tenant_id = $1
             AND $2 IN (
               regexp_replace(served_asset_ref, '^.*/', ''),
               regexp_replace(storage_key, '^.*/', '')
             )
           LIMIT 1`,
          [tenantIdInt, basename],
        );
        if ((result.rowCount ?? 0) > 0) {
          return true;
        }
      } finally {
        client.release();
      }
    } catch {
      // DB unavailable — fall through to filesystem scan.
    }
  }

  const root = marketingRuntimeRoot();
  let entries: string[];
  try {
    entries = (await readdir(root)).filter((entry) => entry.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  for (const entry of entries) {
    try {
      const raw = await readFile(path.join(root, entry), 'utf8');
      const doc = JSON.parse(raw) as Record<string, unknown>;
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        continue;
      }
      const schemaName = doc.schema_name;
      const isKnownSchema =
        schemaName === MARKETING_RUNTIME_SCHEMA_NAME || schemaName === LEGACY_MARKETING_RUNTIME_SCHEMA_NAME;
      if (!isKnownSchema || typeof doc.tenant_id !== 'string' || doc.tenant_id !== tenantId) {
        continue;
      }
      if (socialContentRuntimeContainsBasename(doc.social_content_runtime, basename)) {
        return true;
      }
      // Fallback: when auto-approve resume overwrites the social-content stage
      // output with a resume-context payload, the bridged image_creatives end
      // up only in doc.stages[stage].primary_output (marketing-side). Walk
      // those as a secondary ownership source so /api/internal/hermes/media
      // doesn't 404 on legitimate tenant-owned assets. Mirror of the v0.1.3.16
      // dashboard projection fallback.
      if (marketingStagesContainBasename(doc.stages, basename)) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

/**
 * Mirror of socialContentRuntimeContainsBasename that walks the marketing-side
 * stage records (doc.stages[stage].primary_output.weekly_content_plan.image_creatives)
 * instead of social_content_runtime stages. Used as a fallback by
 * tenantOwnsHermesMediaBasename when the social-content runtime stages
 * don't carry the bridged image_creatives.
 */
function marketingStagesContainBasename(stages: unknown, basename: string): boolean {
  if (!stages || typeof stages !== 'object' || Array.isArray(stages)) {
    return false;
  }
  for (const stageValue of Object.values(stages as Record<string, unknown>)) {
    if (!stageValue || typeof stageValue !== 'object' || Array.isArray(stageValue)) {
      continue;
    }
    const primaryOutput = (stageValue as Record<string, unknown>).primary_output;
    if (!primaryOutput || typeof primaryOutput !== 'object' || Array.isArray(primaryOutput)) {
      continue;
    }
    const plan = (primaryOutput as Record<string, unknown>).weekly_content_plan;
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
      continue;
    }
    const creatives = (plan as Record<string, unknown>).image_creatives;
    if (!Array.isArray(creatives)) {
      continue;
    }
    for (const creative of creatives) {
      if (!creative || typeof creative !== 'object' || Array.isArray(creative)) {
        continue;
      }
      const artifactUrl = (creative as Record<string, unknown>).artifact_url;
      if (typeof artifactUrl !== 'string' || !artifactUrl) {
        continue;
      }
      const lastSlash = artifactUrl.lastIndexOf('/');
      const urlBasename = lastSlash >= 0 ? artifactUrl.slice(lastSlash + 1) : artifactUrl;
      if (urlBasename === basename) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Walks the stages of a raw `social_content_runtime` blob and returns true
 * when any `image_creatives[].artifact_url` has `basename` as its URL
 * basename.  Operates on the raw parsed JSON to avoid the full normalization
 * cost of `readSocialContentRuntimeState`.
 */
function socialContentRuntimeContainsBasename(
  runtime: unknown,
  basename: string,
): boolean {
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    return false;
  }
  const stages = (runtime as Record<string, unknown>).stages;
  if (!stages || typeof stages !== 'object' || Array.isArray(stages)) {
    return false;
  }
  for (const stageValue of Object.values(stages as Record<string, unknown>)) {
    if (!stageValue || typeof stageValue !== 'object' || Array.isArray(stageValue)) {
      continue;
    }
    const output = (stageValue as Record<string, unknown>).output;
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
      continue;
    }
    const plan = (output as Record<string, unknown>).weekly_content_plan;
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
      continue;
    }
    const creatives = (plan as Record<string, unknown>).image_creatives;
    if (!Array.isArray(creatives)) {
      continue;
    }
    for (const creative of creatives) {
      if (!creative || typeof creative !== 'object' || Array.isArray(creative)) {
        continue;
      }
      const artifactUrl = (creative as Record<string, unknown>).artifact_url;
      if (typeof artifactUrl !== 'string' || !artifactUrl) {
        continue;
      }
      // Extract basename from the artifact_url without allocating a URL object
      // for every entry: the URL format is always `.../hermes/media/<basename>`.
      const lastSlash = artifactUrl.lastIndexOf('/');
      const urlBasename = lastSlash >= 0 ? artifactUrl.slice(lastSlash + 1) : artifactUrl;
      if (urlBasename === basename) {
        return true;
      }
    }
  }
  return false;
}

export async function listDeletedSocialContentJobIdsForTenant(
  tenantId: string,
  options: { limit?: number } = {},
): Promise<string[]> {
  return (await collectMarketingJobRefsForTenant(tenantId, { onlyDeleted: true, ...options })).map(
    (entry) => entry.jobId,
  );
}

/**
 * Soft-delete a social content job. Marks `deleted_at` + `deleted_by` on the
 * runtime document so it drops out of the default list queries but stays
 * resolvable via its direct jobId (for the Deleted campaigns Recycle Bin
 * restore flow).
 *
 * **Idempotent.** If the campaign is already soft-deleted, the existing
 * `deleted_at` / `deleted_by` / `soft_cancel_requested_at` are preserved
 * and the call returns the current document unchanged. Otherwise a repeat
 * DELETE request would clobber the original deletion timestamp/actor and
 * weaken the audit trail.
 *
 * If the pipeline is still running when the delete lands, also arms
 * `soft_cancel_requested_at`. The orchestrator checks that field before
 * starting each stage and short-circuits to the `cancelled` terminal status
 * so no new stages execute.
 *
 * Returns the updated document, or `null` if the job is not found or
 * belongs to a different tenant.
 */
export async function softDeleteSocialContentJob(input: {
  jobId: string;
  tenantId: string;
  deletedBy: string;
}): Promise<SocialContentJobRuntimeDocument | null> {
  const doc = await loadSocialContentJobRuntime(input.jobId);
  if (!doc || doc.tenant_id !== input.tenantId) {
    return null;
  }
  // Already soft-deleted — preserve the original audit fields so a repeat
  // DELETE does not rewrite history. Return the current document so the
  // caller can still echo back the existing deleted_at / deleted_by.
  if (doc.deleted_at) {
    return doc;
  }
  const ts = nowIso();
  doc.deleted_at = ts;
  doc.deleted_by = input.deletedBy;
  if (isPipelineActive(doc)) {
    doc.soft_cancel_requested_at = ts;
  }
  saveSocialContentJobRuntime(input.jobId, doc);
  return doc;
}

/**
 * Restore a soft-deleted social content job by clearing `deleted_at` /
 * `deleted_by` / `soft_cancel_requested_at`.
 *
 * **Idempotent.** If the campaign is already live (not deleted), the
 * current document is returned unchanged — a repeat restore request is a
 * safe no-op. The only case that returns `null` is when the job is not
 * found at all or belongs to a different tenant.
 */
export async function restoreMarketingJob(input: {
  jobId: string;
  tenantId: string;
}): Promise<SocialContentJobRuntimeDocument | null> {
  const doc = await loadSocialContentJobRuntime(input.jobId);
  if (!doc || doc.tenant_id !== input.tenantId) {
    return null;
  }
  if (!doc.deleted_at) {
    return doc;
  }
  doc.deleted_at = null;
  doc.deleted_by = null;
  // Clear the cancel arm on restore too so the orchestrator does not
  // immediately re-cancel a restored campaign on its next stage boundary.
  doc.soft_cancel_requested_at = null;
  saveSocialContentJobRuntime(input.jobId, doc);
  return doc;
}

export async function listMarketingTenantIds(): Promise<string[]> {
  const root = marketingRuntimeRoot();
  const tenants = new Set<string>();
  let entries: string[];
  try {
    entries = (await readdir(root)).filter((entry) => entry.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  for (const entry of entries) {
    try {
      const raw = await readFile(path.join(root, entry), 'utf8');
      const doc = JSON.parse(raw) as Record<string, unknown>;
      const tenantId = typeof doc.tenant_id === 'string' ? doc.tenant_id.trim() : '';
      if (tenantId) {
        tenants.add(tenantId);
      }
    } catch {
      continue;
    }
  }

  return [...tenants];
}

export async function findLatestMarketingTenantId(): Promise<string | null> {
  const root = marketingRuntimeRoot();
  let latest: { tenantId: string; updatedAt: number } | null = null;
  let entries: string[];
  try {
    entries = (await readdir(root)).filter((entry) => entry.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  for (const entry of entries) {
    try {
      const raw = await readFile(path.join(root, entry), 'utf8');
      const doc = JSON.parse(raw) as Record<string, unknown>;
      const tenantId = typeof doc.tenant_id === 'string' ? doc.tenant_id.trim() : '';
      const updatedAt = Date.parse(typeof doc.updated_at === 'string' ? doc.updated_at : '');
      if (!tenantId || !Number.isFinite(updatedAt)) {
        continue;
      }
      if (!latest || updatedAt > latest.updatedAt) {
        latest = { tenantId, updatedAt };
      }
    } catch {
      continue;
    }
  }

  return latest?.tenantId ?? null;
}

export async function findLatestMarketingJobIdForTenant(tenantId: string): Promise<string | null> {
  return (await collectMarketingJobRefsForTenant(tenantId))[0]?.jobId ?? null;
}

export function saveSocialContentJobRuntime(jobId: string, doc: SocialContentJobRuntimeDocument): string {
  assertMarketingRuntimeDocument(doc);
  const ingest = ingestRuntimeDocAssets(doc as unknown as Record<string, unknown>);
  if (ingest.rewrites.length > 0) {
    console.info('[asset-ingest] rewrote runtime-doc paths', {
      jobId,
      rewrites: ingest.rewrites.length,
      sample: ingest.rewrites.slice(0, 3).map(({ from, to }) => ({ from, to })),
    });
  }
  doc.updated_at = nowIso();
  const filePath = marketingRuntimePath(jobId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(doc, null, 2));
  return filePath;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

export function getStageRecord(doc: SocialContentJobRuntimeDocument, stage: MarketingStage): MarketingStageRecord {
  const existing = doc.stages?.[stage];
  if (existing) {
    return existing;
  }
  const created = defaultStageRecord(stage);
  doc.stages[stage] = created;
  return created;
}

export function appendHistory(
  doc: SocialContentJobRuntimeDocument,
  note: string,
  input: { state?: string; status?: string; stage?: MarketingStage | null; at?: string } = {}
): void {
  doc.history.push({
    at: input.at ?? nowIso(),
    state: input.state ?? doc.state,
    status: input.status ?? doc.status,
    stage: input.stage ?? doc.current_stage ?? null,
    note,
  });
}

export function setJobRunning(doc: SocialContentJobRuntimeDocument, stage: MarketingStage, note: string): void {
  doc.state = 'running';
  doc.status = 'running';
  doc.current_stage = stage;
  appendHistory(doc, note, { stage });
}

export function markStageInProgress(doc: SocialContentJobRuntimeDocument, stage: MarketingStage): MarketingStageRecord {
  const record = getStageRecord(doc, stage);
  if (!record.started_at) {
    record.started_at = nowIso();
  }
  record.status = 'in_progress';
  doc.state = 'running';
  doc.status = 'running';
  doc.current_stage = stage;
  return record;
}

export function markStageCompleted(
  doc: SocialContentJobRuntimeDocument,
  stage: MarketingStage,
  input: {
    runId?: string | null;
    summary?: MarketingStageSummary | null;
    primaryOutput?: Record<string, unknown> | null;
    outputs?: Record<string, unknown>;
    artifacts?: MarketingStageArtifact[];
  } = {}
): MarketingStageRecord {
  const record = getStageRecord(doc, stage);
  if (!record.started_at) {
    record.started_at = nowIso();
  }
  record.status = 'completed';
  record.completed_at = nowIso();
  record.failed_at = null;
  record.run_id = input.runId ?? record.run_id;
  record.summary = input.summary ?? record.summary;
  record.primary_output = input.primaryOutput ?? record.primary_output;
  record.outputs = input.outputs ?? record.outputs;
  record.artifacts = input.artifacts ?? record.artifacts;
  return record;
}

export function markStageRequiresChannelConnection(
  doc: SocialContentJobRuntimeDocument,
  stage: MarketingStage,
  input: {
    summary?: MarketingStageSummary | null;
    artifactId?: string;
    artifactTitle?: string;
    outputs?: Record<string, unknown>;
    artifacts?: MarketingStageArtifact[];
  } = {}
): MarketingStageRecord {
  const record = getStageRecord(doc, stage);
  if (!record.started_at) {
    record.started_at = nowIso();
  }
  // Clear terminal timestamps and errors so a stage transitioning into
  // requires_channel_connection from a previously completed or failed state
  // doesn't appear simultaneously completed/failed AND awaiting a connection.
  // Timeline derivations and status badges both branch on these fields.
  record.completed_at = null;
  record.failed_at = null;
  record.errors = [];
  record.status = 'requires_channel_connection';
  record.summary = input.summary ?? record.summary ?? {
    summary: 'Connect a publishing channel to enable auto-publish.',
    highlight: null,
  };
  if (input.outputs) {
    record.outputs = input.outputs;
  }
  if (input.artifacts && input.artifacts.length > 0) {
    record.artifacts = input.artifacts;
  } else {
    const id = input.artifactId ?? 'publish-needs-channel';
    const title = input.artifactTitle ?? 'Connect a publishing channel';
    const existing = record.artifacts.findIndex((a) => a.id === id);
    const artifact: MarketingStageArtifact = {
      id,
      stage,
      title,
      category: 'channel_connection',
      status: 'requires_channel_connection',
      summary:
        input.summary?.summary ??
        'Stage is ready. Connect Meta in Settings to enable auto-publish.',
      details: [],
      action_label: 'Connect Meta',
      action_href: '/dashboard/settings/channel-integrations',
    };
    if (existing >= 0) {
      record.artifacts[existing] = artifact;
    } else {
      record.artifacts.push(artifact);
    }
  }
  doc.state = 'needs_connection';
  doc.status = 'needs_connection';
  doc.current_stage = stage;
  return record;
}

export function markStageAwaitingApproval(
  doc: SocialContentJobRuntimeDocument,
  stage: Extract<MarketingStage, 'strategy' | 'production' | 'publish'>,
  checkpoint: Omit<MarketingApprovalCheckpoint, 'stage' | 'status' | 'requested_at'> & {
    requested_at?: string;
  },
  input: {
    runId?: string | null;
    summary?: MarketingStageSummary | null;
    primaryOutput?: Record<string, unknown> | null;
    outputs?: Record<string, unknown>;
    artifacts?: MarketingStageArtifact[];
  } = {}
): MarketingStageRecord {
  const record = getStageRecord(doc, stage);
  if (!record.started_at) {
    record.started_at = nowIso();
  }
  record.status = 'awaiting_approval';
  record.run_id = input.runId ?? record.run_id;
  record.summary = input.summary ?? record.summary;
  record.primary_output = input.primaryOutput ?? record.primary_output;
  record.outputs = input.outputs ?? record.outputs;
  record.artifacts = input.artifacts ?? record.artifacts;

  doc.state = 'approval_required';
  doc.status = 'awaiting_approval';
  doc.current_stage = stage;
  doc.approvals.current = {
    stage,
    status: 'awaiting_approval',
    approval_id: checkpoint.approval_id ?? null,
    workflow_name: checkpoint.workflow_name ?? null,
    workflow_step_id: checkpoint.workflow_step_id ?? null,
    title: checkpoint.title,
    message: checkpoint.message,
    requested_at: checkpoint.requested_at ?? nowIso(),
    resume_token: checkpoint.resume_token ?? null,
    action_label: checkpoint.action_label ?? null,
    publish_config: checkpoint.publish_config ?? null,
  };
  doc.approvals.history.push({
    stage,
    status: 'requested',
    at: doc.approvals.current.requested_at,
    approval_id: doc.approvals.current.approval_id ?? null,
    workflow_step_id: doc.approvals.current.workflow_step_id ?? null,
    message: checkpoint.message,
    publish_config: checkpoint.publish_config ?? null,
  });
  return record;
}

export function clearApprovalCheckpoint(doc: SocialContentJobRuntimeDocument, note: string): void {
  const current = doc.approvals.current;
  if (current) {
    doc.approvals.history.push({
      stage: current.stage,
      status: 'cleared',
      at: nowIso(),
      approval_id: current.approval_id ?? null,
      workflow_step_id: current.workflow_step_id ?? null,
      message: current.message,
      publish_config: current.publish_config ?? null,
    });
  }
  doc.approvals.current = null;
  appendHistory(doc, note);
}

export function recordApproval(
  doc: SocialContentJobRuntimeDocument,
  input: {
    stage: Extract<MarketingStage, 'strategy' | 'production' | 'publish'>;
    approvedBy: string;
    message?: string;
    publishConfig?: Partial<MarketingPublishConfig>;
    approvalId?: string | null;
    workflowStepId?: string | null;
  }
): void {
  if (input.stage === 'publish' && input.publishConfig) {
    doc.publish_config = defaultPublishConfig({
      ...doc.publish_config,
      ...input.publishConfig,
    });
  }
  doc.approvals.history.push({
    stage: input.stage,
    status: 'approved',
    at: nowIso(),
    approval_id: input.approvalId ?? doc.approvals.current?.approval_id ?? null,
    workflow_step_id: input.workflowStepId ?? doc.approvals.current?.workflow_step_id ?? null,
    approved_by: input.approvedBy,
    message: input.message ?? null,
    publish_config: input.stage === 'publish' ? doc.publish_config : null,
  });
}

export function recordApprovalDenied(
  doc: SocialContentJobRuntimeDocument,
  input: {
    stage: Extract<MarketingStage, 'strategy' | 'production' | 'publish'>;
    deniedBy: string;
    message?: string;
    publishConfig?: Partial<MarketingPublishConfig>;
    approvalId?: string | null;
    workflowStepId?: string | null;
  }
): void {
  if (input.stage === 'publish' && input.publishConfig) {
    doc.publish_config = defaultPublishConfig({
      ...doc.publish_config,
      ...input.publishConfig,
    });
  }
  doc.approvals.history.push({
    stage: input.stage,
    status: 'denied',
    at: nowIso(),
    approval_id: input.approvalId ?? doc.approvals.current?.approval_id ?? null,
    workflow_step_id: input.workflowStepId ?? doc.approvals.current?.workflow_step_id ?? null,
    approved_by: input.deniedBy,
    message: input.message ?? null,
    publish_config: input.stage === 'publish' ? doc.publish_config : null,
  });
}

export function recordStageFailure(
  doc: SocialContentJobRuntimeDocument,
  stage: MarketingStage,
  error: Omit<MarketingStageError, 'stage' | 'at'> & { at?: string }
): MarketingStageError {
  const normalized: MarketingStageError = {
    code: error.code,
    message: error.message,
    stage,
    retryable: error.retryable,
    details: error.details,
    at: error.at ?? nowIso(),
  };
  const record = getStageRecord(doc, stage);
  if (!record.started_at) {
    record.started_at = normalized.at;
  }
  record.status = 'failed';
  record.failed_at = normalized.at;
  record.errors.push(normalized);
  doc.state = 'failed';
  doc.status = 'failed';
  doc.current_stage = stage;
  doc.last_error = normalized;
  doc.errors.push(normalized);
  recordMarketingFailureRuntimeIncident({
    jobId: doc.job_id,
    tenantId: doc.tenant_id,
    runtimePath: marketingRuntimePath(doc.job_id),
    state: doc.state,
    status: doc.status,
    currentStage: doc.current_stage,
    updatedAt: doc.updated_at,
    error: normalized,
  });
  return normalized;
}

/**
 * Reset a failed stage back to a fresh `not_started` state so the orchestrator
 * can re-enter it cleanly. Used by the operator-facing "Retry research" path
 * after a transient upstream failure (e.g. Hermes-side `'NoneType' object is
 * not iterable`).
 *
 * Returns false (no-op) when the stage is NOT in a `failed` state — callers
 * should check this and surface a 409 rather than silently re-running a stage
 * that's already in_progress or completed. Per the resumability rule, partial
 * artifacts on completed sibling stages are preserved; only the failed stage's
 * record + the top-level error pointers are cleared.
 */
export function resetStageForRetry(
  doc: SocialContentJobRuntimeDocument,
  stage: MarketingStage,
): boolean {
  const record = getStageRecord(doc, stage);
  if (record.status !== 'failed') {
    return false;
  }

  // Reset the stage record so the orchestrator sees it as never-started.
  record.status = 'not_started';
  record.started_at = null;
  record.completed_at = null;
  record.failed_at = null;
  record.errors = [];
  record.summary = null;
  record.primary_output = null;
  record.outputs = {};
  record.artifacts = [];
  record.run_id = null;

  // Clear top-level error pointers if they referenced this stage. Sibling stage
  // failures (rare, but possible if multiple stages failed in sequence) keep
  // their own records intact.
  if (doc.last_error && doc.last_error.stage === stage) {
    doc.last_error = null;
  }
  doc.errors = (doc.errors ?? []).filter((entry) => entry.stage !== stage);

  // Drop the terminal flags so isPipelineActive() returns true again and the
  // orchestrator can proceed. Matches the fresh-doc initial values: state is
  // loose-typed and set to 'queued'; status is `MarketingJobStatus` and uses
  // 'pending' (the pre-running init value). runResearchStage will flip both
  // to 'running' via setJobRunning() once it picks the stage up.
  doc.state = 'queued';
  doc.status = 'pending';
  doc.current_stage = stage;

  appendHistory(doc, `retry requested for ${stage} stage`, { stage, state: 'queued', status: 'pending' });
  return true;
}

export function responseStageStatus(record: MarketingStageRecord): string {
  switch (record.status) {
    case 'not_started':
      return 'ready';
    case 'in_progress':
      return 'in_progress';
    case 'awaiting_approval':
      return 'awaiting_approval';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    case 'requires_channel_connection':
      return 'requires_channel_connection';
    default:
      return 'ready';
  }
}

/**
 * Returns the effective output record for a given stage, preferring the legacy
 * `outputs` map (non-empty object) over the new flat `primary_output` emitted
 * by the 3-profile Hermes decomposition. Returns `null` when neither is
 * populated.
 *
 * Precedence (outputs-wins) preserves backward compatibility for tenants whose
 * runtime docs pre-date the Hermes decomposition and still have `outputs.*`
 * filesystem-path keys populated.
 */
export function resolveStageOutput(
  doc: SocialContentJobRuntimeDocument,
  stageName: MarketingStage,
): Record<string, unknown> | null {
  const stage = doc.stages[stageName];
  if (!stage) return null;
  if (stage.outputs && Object.keys(stage.outputs).length > 0) {
    return stage.outputs;
  }
  if (stage.primary_output && Object.keys(stage.primary_output).length > 0) {
    return stage.primary_output;
  }
  return null;
}
