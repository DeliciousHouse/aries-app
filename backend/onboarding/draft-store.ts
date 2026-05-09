import crypto from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import pool from '@/lib/db';
import { normalizeMarketingWebsiteUrl } from '@/lib/marketing-public-mode';
import { resolveDataPath } from '@/lib/runtime-paths';

export type OnboardingDraftStatus =
  | 'draft'
  | 'ready_for_auth'
  | 'materializing'
  | 'materialized';

export type OnboardingDraftPreview = {
  title: string;
  favicon: string;
  domain: string;
  description: string;
  canonicalUrl: string | null;
  brandKitPreview: {
    brandName: string;
    canonicalUrl: string | null;
    logoUrls: string[];
    colors: {
      primary: string | null;
      secondary: string | null;
      accent: string | null;
      palette: string[];
    };
    fontFamilies: string[];
    externalLinks: Array<{
      platform: string;
      url: string;
    }>;
    extractedAt: string;
    brandVoiceSummary: string | null;
    offerSummary: string | null;
    positioning: string | null;
    audience: string | null;
    toneOfVoice: string | null;
    styleVibe: string | null;
  } | null;
};

export type OnboardingDraftProvenance = {
  source_url: string | null;
  canonical_url: string | null;
  source_fingerprint: string | null;
};

export type OnboardingDraft = {
  draftId: string;
  status: OnboardingDraftStatus;
  websiteUrl: string;
  businessName: string;
  businessType: string;
  approverName: string;
  channels: string[];
  goal: string;
  offer: string;
  competitorUrl: string;
  preview: OnboardingDraftPreview | null;
  provenance: OnboardingDraftProvenance;
  createdAt: string;
  updatedAt: string;
  materializedTenantId: string | null;
  materializedJobId: string | null;
};

type OnboardingDraftMutation = Partial<{
  status: OnboardingDraftStatus;
  websiteUrl: string | null;
  businessName: string | null;
  businessType: string | null;
  approverName: string | null;
  channels: string[] | null;
  goal: string | null;
  offer: string | null;
  competitorUrl: string | null;
  preview: OnboardingDraftPreview | null;
  provenance: Partial<OnboardingDraftProvenance> | null;
  materializedTenantId: string | null;
  materializedJobId: string | null;
}>;

const DRAFT_ID_PATTERN = /^[a-f0-9-]{16,}$/i;

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringOrNull(value: unknown): string | null {
  const normalized = stringValue(value);
  return normalized || null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim()),
    ),
  );
}

function normalizeCompetitorUrl(value: string | null | undefined): string {
  return normalizeMarketingWebsiteUrl(value) || stringValue(value);
}

function normalizeDraftId(draftId: string): string {
  const normalized = draftId.trim();
  if (!DRAFT_ID_PATTERN.test(normalized)) {
    throw new Error('invalid_draft_token');
  }
  return normalized;
}

function emptyDraft(input?: Partial<OnboardingDraft>): OnboardingDraft {
  const timestamp = new Date().toISOString();
  const draftId = input?.draftId || crypto.randomUUID();

  return {
    draftId,
    status: input?.status || 'draft',
    websiteUrl: stringValue(input?.websiteUrl),
    businessName: stringValue(input?.businessName),
    businessType: stringValue(input?.businessType),
    approverName: stringValue(input?.approverName),
    channels: stringArray(input?.channels),
    goal: stringValue(input?.goal),
    offer: stringValue(input?.offer),
    competitorUrl: stringValue(input?.competitorUrl),
    preview: input?.preview || null,
    provenance: {
      source_url: input?.provenance?.source_url || null,
      canonical_url: input?.provenance?.canonical_url || null,
      source_fingerprint: input?.provenance?.source_fingerprint || null,
    },
    createdAt: input?.createdAt || timestamp,
    updatedAt: input?.updatedAt || timestamp,
    materializedTenantId: input?.materializedTenantId || null,
    materializedJobId: input?.materializedJobId || null,
  };
}

function sanitizePreview(value: unknown): OnboardingDraftPreview | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const preview = value as Record<string, unknown>;
  const brandKitPreview =
    preview.brandKitPreview && typeof preview.brandKitPreview === 'object' && !Array.isArray(preview.brandKitPreview)
      ? (preview.brandKitPreview as Record<string, unknown>)
      : null;
  const colors =
    brandKitPreview?.colors && typeof brandKitPreview.colors === 'object' && !Array.isArray(brandKitPreview.colors)
      ? (brandKitPreview.colors as Record<string, unknown>)
      : null;

  return {
    title: stringValue(preview.title),
    favicon: stringValue(preview.favicon),
    domain: stringValue(preview.domain),
    description: stringValue(preview.description),
    canonicalUrl: stringOrNull(preview.canonicalUrl),
    brandKitPreview: brandKitPreview
      ? {
          brandName: stringValue(brandKitPreview.brandName),
          canonicalUrl: stringOrNull(brandKitPreview.canonicalUrl),
          logoUrls: stringArray(brandKitPreview.logoUrls),
          colors: {
            primary: stringOrNull(colors?.primary),
            secondary: stringOrNull(colors?.secondary),
            accent: stringOrNull(colors?.accent),
            palette: stringArray(colors?.palette),
          },
          fontFamilies: stringArray(brandKitPreview.fontFamilies),
          externalLinks: Array.isArray(brandKitPreview.externalLinks)
            ? brandKitPreview.externalLinks
                .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
                .map((entry) => ({
                  platform: stringValue(entry.platform),
                  url: stringValue(entry.url),
                }))
                .filter((entry) => entry.platform || entry.url)
            : [],
          extractedAt: stringValue(brandKitPreview.extractedAt),
          brandVoiceSummary: stringOrNull(brandKitPreview.brandVoiceSummary),
          offerSummary: stringOrNull(brandKitPreview.offerSummary),
          positioning: stringOrNull(brandKitPreview.positioning),
          audience: stringOrNull(brandKitPreview.audience),
          toneOfVoice: stringOrNull(brandKitPreview.toneOfVoice),
          styleVibe: stringOrNull(brandKitPreview.styleVibe),
        }
      : null,
  };
}

function sanitizeProvenance(
  value: Partial<OnboardingDraftProvenance> | null | undefined,
): OnboardingDraftProvenance {
  return {
    source_url: normalizeMarketingWebsiteUrl(value?.source_url) || null,
    canonical_url: normalizeMarketingWebsiteUrl(value?.canonical_url) || null,
    source_fingerprint: normalizeMarketingWebsiteUrl(value?.source_fingerprint) || null,
  };
}

function draftSourceFingerprint(input: {
  websiteUrl?: string | null;
  provenance?: Partial<OnboardingDraftProvenance> | null;
}): string | null {
  return (
    normalizeMarketingWebsiteUrl(input.provenance?.source_fingerprint) ||
    normalizeMarketingWebsiteUrl(input.provenance?.canonical_url) ||
    normalizeMarketingWebsiteUrl(input.websiteUrl) ||
    null
  );
}

function applyDraftMutation(draft: OnboardingDraft, mutation: OnboardingDraftMutation): OnboardingDraft {
  const nextWebsiteUrl = mutation.websiteUrl === undefined
    ? draft.websiteUrl
    : normalizeMarketingWebsiteUrl(mutation.websiteUrl) || stringValue(mutation.websiteUrl);
  const nextPreview = mutation.preview === undefined ? draft.preview : sanitizePreview(mutation.preview);
  const nextProvenance = mutation.provenance === undefined
    ? draft.provenance
    : sanitizeProvenance({ ...draft.provenance, ...mutation.provenance });
  const nextFingerprintCandidate = mutation.provenance === undefined
    ? {
        source_url: normalizeMarketingWebsiteUrl(nextWebsiteUrl),
        canonical_url: null,
        source_fingerprint: normalizeMarketingWebsiteUrl(nextWebsiteUrl),
      }
    : nextProvenance;
  const sourceChanged =
    draftSourceFingerprint({ websiteUrl: draft.websiteUrl, provenance: draft.provenance }) !==
    draftSourceFingerprint({ websiteUrl: nextWebsiteUrl, provenance: nextFingerprintCandidate });

  return {
    ...draft,
    status: mutation.status || draft.status,
    websiteUrl: nextWebsiteUrl,
    businessName: mutation.businessName === undefined ? draft.businessName : stringValue(mutation.businessName),
    businessType: mutation.businessType === undefined ? draft.businessType : stringValue(mutation.businessType),
    approverName: mutation.approverName === undefined ? draft.approverName : stringValue(mutation.approverName),
    channels: mutation.channels === undefined ? draft.channels : stringArray(mutation.channels),
    goal: mutation.goal === undefined ? draft.goal : stringValue(mutation.goal),
    offer: mutation.offer === undefined ? draft.offer : stringValue(mutation.offer),
    competitorUrl:
      mutation.competitorUrl === undefined
        ? draft.competitorUrl
        : normalizeCompetitorUrl(mutation.competitorUrl),
    preview: sourceChanged && mutation.preview === undefined ? null : nextPreview,
    provenance: sourceChanged && mutation.provenance === undefined
      ? {
          source_url: normalizeMarketingWebsiteUrl(nextWebsiteUrl),
          canonical_url: null,
          source_fingerprint: normalizeMarketingWebsiteUrl(nextWebsiteUrl),
        }
      : nextProvenance,
    materializedTenantId:
      mutation.materializedTenantId === undefined ? draft.materializedTenantId : stringOrNull(mutation.materializedTenantId),
    materializedJobId:
      mutation.materializedJobId === undefined ? draft.materializedJobId : stringOrNull(mutation.materializedJobId),
  };
}

type DraftRow = {
  draft_id: string;
  status: string;
  website_url: string;
  business_name: string;
  business_type: string;
  approver_name: string;
  channels: string[];
  goal: string;
  offer: string;
  competitor_url: string;
  preview: OnboardingDraftPreview | null;
  provenance: OnboardingDraftProvenance;
  materialized_tenant_id: string | null;
  materialized_job_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

function toIsoString(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function rowToDraft(row: DraftRow): OnboardingDraft {
  return emptyDraft({
    draftId: row.draft_id,
    status: row.status as OnboardingDraftStatus,
    websiteUrl: row.website_url,
    businessName: row.business_name,
    businessType: row.business_type,
    approverName: row.approver_name,
    channels: row.channels,
    goal: row.goal,
    offer: row.offer,
    competitorUrl: row.competitor_url,
    preview: row.preview,
    provenance: row.provenance,
    materializedTenantId: row.materialized_tenant_id,
    materializedJobId: row.materialized_job_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  });
}

function draftToRow(draft: OnboardingDraft) {
  return {
    draft_id: draft.draftId,
    status: draft.status,
    website_url: draft.websiteUrl,
    business_name: draft.businessName,
    business_type: draft.businessType,
    approver_name: draft.approverName,
    channels: draft.channels,
    goal: draft.goal,
    offer: draft.offer,
    competitor_url: draft.competitorUrl,
    preview: draft.preview ? JSON.stringify(draft.preview) : null,
    provenance: JSON.stringify(draft.provenance),
    materialized_tenant_id: draft.materializedTenantId,
    materialized_job_id: draft.materializedJobId,
  };
}

function hasDatabaseConfig(): boolean {
  return Boolean(
    process.env.DB_HOST?.trim() &&
      process.env.DB_USER?.trim() &&
      process.env.DB_PASSWORD !== undefined &&
      process.env.DB_NAME?.trim(),
  );
}

function shouldUseFallbackDraftStore(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return (
    // Schema drift during deploys should not block public onboarding intake.
    code === '42P01' ||
    code === '42703' ||
    // Shared Postgres can be temporarily unavailable while the owning compose
    // stack is restarted or DNS/service aliases settle. Drafts are pre-auth
    // intake records, so falling back to DATA_ROOT is safer than hard-blocking
    // the first-run onboarding flow.
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === '08000' ||
    code === '08001' ||
    code === '08003' ||
    code === '08006' ||
    code === '53300' ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03'
  );
}

function fallbackDraftDirs(): string[] {
  return [
    resolveDataPath('onboarding-drafts'),
    path.join(tmpdir(), 'aries-data', 'onboarding-drafts'),
  ];
}

function fallbackDraftPath(dir: string, draftId: string): string {
  const normalizedDraftId = normalizeDraftId(draftId).toLowerCase();
  const safeDraftId = path.basename(normalizedDraftId);
  if (safeDraftId !== normalizedDraftId) {
    throw new Error('invalid_draft_token');
  }

  const baseDir = path.resolve(dir);
  const draftPath = path.resolve(baseDir, `${safeDraftId}.json`);
  if (!draftPath.startsWith(`${baseDir}${path.sep}`)) {
    throw new Error('invalid_draft_token');
  }

  return draftPath;
}

async function writeFallbackDraft(draft: OnboardingDraft): Promise<OnboardingDraft> {
  let lastError: unknown;
  for (const dir of fallbackDraftDirs()) {
    try {
      await mkdir(dir, { recursive: true });
      const finalPath = fallbackDraftPath(dir, draft.draftId);
      const tmpPath = `${finalPath}.tmp`;
      try {
        await writeFile(tmpPath, `${JSON.stringify(draft, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(tmpPath, finalPath);
      } catch (writeError) {
        await unlink(tmpPath).catch(() => undefined);
        throw writeError;
      }
      return draft;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'EACCES') {
        throw error;
      }
    }
  }
  throw lastError;
}

async function readFallbackDraft(draftId: string): Promise<OnboardingDraft | null> {
  for (const dir of fallbackDraftDirs()) {
    try {
      const parsed = JSON.parse(await readFile(fallbackDraftPath(dir, draftId), 'utf8')) as Partial<OnboardingDraft>;
      return emptyDraft(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }
  return null;
}

export function draftTenantId(draftId: string): string {
  return `draft_${normalizeDraftId(draftId).replace(/-/g, '')}`;
}

export async function createOnboardingDraft(initial?: Partial<OnboardingDraft>): Promise<OnboardingDraft> {
  const draft = emptyDraft(initial);
  if (!hasDatabaseConfig()) {
    return writeFallbackDraft(draft);
  }

  const row = draftToRow(draft);

  let result;
  try {
    result = await pool.query<DraftRow>(
      `INSERT INTO onboarding_drafts (
        draft_id, status, website_url, business_name, business_type,
        approver_name, channels, goal, offer, competitor_url,
        preview, provenance, materialized_tenant_id, materialized_job_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *`,
      [
        row.draft_id, row.status, row.website_url, row.business_name, row.business_type,
        row.approver_name, row.channels, row.goal, row.offer, row.competitor_url,
        row.preview, row.provenance, row.materialized_tenant_id, row.materialized_job_id,
      ],
    );
  } catch (error) {
    if (shouldUseFallbackDraftStore(error)) {
      return writeFallbackDraft(draft);
    }
    throw error;
  }

  return rowToDraft(result.rows[0]);
}

export async function getOnboardingDraft(draftId: string): Promise<OnboardingDraft | null> {
  let normalized: string;
  try {
    normalized = normalizeDraftId(draftId);
  } catch {
    return null;
  }

  if (!hasDatabaseConfig()) {
    return readFallbackDraft(normalized);
  }

  let result;
  try {
    result = await pool.query<DraftRow>(
      'SELECT * FROM onboarding_drafts WHERE draft_id = $1',
      [normalized],
    );
  } catch (error) {
    if (shouldUseFallbackDraftStore(error)) {
      return readFallbackDraft(normalized);
    }
    throw error;
  }

  if (result.rowCount === 0) {
    return null;
  }

  return rowToDraft(result.rows[0]);
}

export async function requireOnboardingDraft(draftId: string): Promise<OnboardingDraft> {
  const draft = await getOnboardingDraft(draftId);
  if (!draft) {
    throw new Error('draft_not_found');
  }
  return draft;
}

const LOCK_STALE_TTL_MS = 30_000;

async function claimFallbackMaterialization(
  normalized: string,
): Promise<{ draft: OnboardingDraft; claimed: boolean }> {
  // Use exclusive file creation as a per-draft CAS guard so two concurrent
  // requests cannot both observe `ready_for_auth` and both claim. Mirrors the
  // atomicity of `UPDATE ... WHERE status = 'ready_for_auth'` in Postgres.
  for (const dir of fallbackDraftDirs()) {
    const draftPath = fallbackDraftPath(dir, normalized);
    const lockPath = `${draftPath}.lock`;
    let lockHandle;

    // Allow one stale-lock recovery attempt per directory.
    for (let pass = 0; pass < 2; pass++) {
      try {
        lockHandle = await open(lockPath, 'wx');
        // Write creation timestamp so a future recovery pass can detect stale locks
        // left by processes that crashed before the finally cleanup ran.
        await lockHandle.writeFile(String(Date.now()));
        break;
      } catch (lockError) {
        const code = (lockError as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          if (pass === 0) {
            // Check whether the existing lock was left by a crashed process.
            const lockContent = await readFile(lockPath, 'utf8').catch(() => '');
            const lockTimestamp = Number(lockContent);
            if (lockContent && Number.isFinite(lockTimestamp) && Date.now() - lockTimestamp > LOCK_STALE_TTL_MS) {
              await unlink(lockPath).catch(() => undefined);
              continue; // retry lock acquisition for this dir
            }
          }
          // Fresh lock — another request holds the claim lock
          const draft = await requireOnboardingDraft(normalized);
          return { draft, claimed: false };
        }
        if (code === 'ENOENT' || code === 'EACCES') {
          lockHandle = undefined;
          break; // try next dir
        }
        throw lockError;
      }
    }

    if (!lockHandle) continue;

    try {
      const draft = await requireOnboardingDraft(normalized);
      if (draft.status !== 'ready_for_auth') {
        return { draft, claimed: false };
      }
      const claimedDraft = await writeFallbackDraft({
        ...draft,
        status: 'materializing',
        updatedAt: new Date().toISOString(),
      });
      return { draft: claimedDraft, claimed: true };
    } finally {
      await lockHandle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }
  throw new Error('draft_not_found');
}

export async function claimOnboardingDraftMaterialization(
  draftId: string,
): Promise<{ draft: OnboardingDraft; claimed: boolean }> {
  const normalized = normalizeDraftId(draftId);

  if (!hasDatabaseConfig()) {
    return claimFallbackMaterialization(normalized);
  }

  let result;
  try {
    result = await pool.query<DraftRow>(
      `UPDATE onboarding_drafts
        SET status = 'materializing', updated_at = now()
      WHERE draft_id = $1 AND status = 'ready_for_auth'
      RETURNING *`,
      [normalized],
    );
  } catch (error) {
    if (shouldUseFallbackDraftStore(error)) {
      return claimFallbackMaterialization(normalized);
    }
    throw error;
  }

  if ((result.rowCount ?? 0) > 0) {
    return {
      draft: rowToDraft(result.rows[0]),
      claimed: true,
    };
  }

  return {
    draft: await requireOnboardingDraft(normalized),
    claimed: false,
  };
}

export async function updateOnboardingDraft(
  draftId: string,
  mutation: OnboardingDraftMutation,
): Promise<OnboardingDraft> {
  const current = await requireOnboardingDraft(draftId);
  const next = applyDraftMutation(current, mutation);
  if (!hasDatabaseConfig()) {
    return writeFallbackDraft({ ...next, updatedAt: new Date().toISOString() });
  }

  const row = draftToRow(next);

  let result;
  try {
    result = await pool.query<DraftRow>(
      `UPDATE onboarding_drafts SET
        status = $2, website_url = $3, business_name = $4, business_type = $5,
        approver_name = $6, channels = $7, goal = $8, offer = $9, competitor_url = $10,
        preview = $11, provenance = $12, materialized_tenant_id = $13,
        materialized_job_id = $14, updated_at = now()
      WHERE draft_id = $1
      RETURNING *`,
      [
        row.draft_id, row.status, row.website_url, row.business_name, row.business_type,
        row.approver_name, row.channels, row.goal, row.offer, row.competitor_url,
        row.preview, row.provenance, row.materialized_tenant_id, row.materialized_job_id,
      ],
    );
  } catch (error) {
    if (shouldUseFallbackDraftStore(error)) {
      return writeFallbackDraft({ ...next, updatedAt: new Date().toISOString() });
    }
    throw error;
  }

  return rowToDraft(result.rows[0]);
}
