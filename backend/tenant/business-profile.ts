import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { PoolClient } from 'pg';

import pool from '@/lib/db';
import {
  extractAndSaveTenantBrandKit,
  loadTenantBrandKit,
  repairLegacyMarketingText,
  sanitizeBrandKitSummaryText,
  type TenantBrandKit,
} from '@/backend/marketing/brand-kit';
import type { MarketingBrandIdentity } from '@/lib/api/marketing';
import {
  findLatestMarketingJobIdForTenant,
  loadMarketingJobRuntime,
} from '@/backend/marketing/runtime-state';
import {
  loadValidatedMarketingProfileDocs,
  loadValidatedMarketingProfileSnapshot,
  type ValidatedMarketingProfileSnapshot,
} from '@/backend/marketing/validated-profile-store';
import {
  derivePublicMarketingTenantId,
  normalizeMarketingWebsiteUrl,
  publicTenantSlug,
} from '@/lib/marketing-public-mode';
import {
  COMPETITOR_URL_INVALID_ERROR,
  COMPETITOR_URL_SOCIAL_ERROR,
  sanitizeLegacyCompetitorUrl,
  validateCanonicalCompetitorUrl,
} from '@/lib/marketing-competitor';
import { resolveDataPath } from '@/lib/runtime-paths';

export type BusinessProfileRecord = {
  tenant_id: string;
  business_name: string | null;
  tenant_slug: string | null;
  website_url: string | null;
  business_type: string | null;
  primary_goal: string | null;
  launch_approver_user_id: string | null;
  launch_approver_name: string | null;
  offer: string | null;
  brand_voice: string | null;
  style_vibe: string | null;
  notes: string | null;
  competitor_url: string | null;
  channels: string[];
  updated_at: string;
};

export type BusinessProfileView = {
  tenantId: string;
  businessName: string;
  tenantSlug: string;
  websiteUrl: string | null;
  businessType: string | null;
  primaryGoal: string | null;
  launchApproverUserId: string | null;
  launchApproverName: string | null;
  offer: string | null;
  brandVoice: string | null;
  styleVibe: string | null;
  notes: string | null;
  competitorUrl: string | null;
  channels: string[];
  brandIdentity: MarketingBrandIdentity | null;
  brandKit: TenantBrandKit | null;
  incomplete: boolean;
};

export type BusinessProfileBrandKitSource =
  | 'runtime_brand_kit'
  | 'validated_brand_kit_file'
  | 'none';

export type ResolvedBusinessProfile = {
  profile: BusinessProfileView;
  brandKitSource: BusinessProfileBrandKitSource;
  latestJobId: string | null;
};

export type PersistedMarketingProfileDefaults = {
  websiteUrl?: string;
  businessName?: string;
  businessType?: string;
  primaryGoal?: string;
  goal?: string;
  launchApproverName?: string;
  approverName?: string;
  offer?: string;
  brandVoice?: string;
  styleVibe?: string;
  competitorUrl?: string;
  channels?: string[];
};

type BusinessProfileUpdateInput = {
  tenantId: string;
  businessName?: string | null;
  websiteUrl?: string | null;
  businessType?: string | null;
  primaryGoal?: string | null;
  launchApproverUserId?: string | null;
  launchApproverName?: string | null;
  offer?: string | null;
  brandVoice?: string | null;
  styleVibe?: string | null;
  notes?: string | null;
  competitorUrl?: string | null;
  channels?: string[] | null;
};

type WorkspaceBrandContext = {
  brandVoice: string | null;
  styleVibe: string | null;
};

type MarketingProfilePersistenceInput = {
  tenantId: string;
  payload: Record<string, unknown>;
  tenantSlug?: string | null;
};

const DEFAULT_MARKETING_CHANNELS = ['meta-ads', 'instagram'];

function nowIso(): string {
  return new Date().toISOString();
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
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

function hasOwnField(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function firstPresentStringField(
  payload: Record<string, unknown>,
  keys: string[],
): { present: boolean; value: string | null } {
  for (const key of keys) {
    if (!hasOwnField(payload, key)) {
      continue;
    }
    return {
      present: true,
      value: stringOrNull(payload[key]),
    };
  }

  return {
    present: false,
    value: null,
  };
}

function firstPresentStringArrayField(
  payload: Record<string, unknown>,
  keys: string[],
): { present: boolean; value: string[] } {
  for (const key of keys) {
    if (!hasOwnField(payload, key)) {
      continue;
    }
    return {
      present: true,
      value: stringArray(payload[key]),
    };
  }

  return {
    present: false,
    value: [],
  };
}

function mergePersistedStringField(
  currentValue: string | null,
  nextValue: string | null | undefined,
  normalize?: (value: string) => string | null,
): { value: string | null; changed: boolean } {
  if (nextValue === undefined || nextValue === null) {
    return { value: currentValue, changed: false };
  }

  const trimmed = nextValue.trim();
  if (!trimmed) {
    return { value: currentValue, changed: false };
  }

  const resolved = normalize ? normalize(trimmed) || trimmed : trimmed;
  return {
    value: resolved,
    changed: resolved !== currentValue,
  };
}

function mergePersistedStringArrayField(
  currentValue: string[],
  nextValue: string[] | null | undefined,
): { value: string[]; changed: boolean } {
  if (nextValue === undefined || nextValue === null) {
    return { value: currentValue, changed: false };
  }

  const normalized = stringArray(nextValue);
  if (normalized.length === 0) {
    return { value: currentValue, changed: false };
  }

  const resolved = Array.from(new Set(normalized));
  return {
    value: resolved,
    changed: JSON.stringify(resolved) !== JSON.stringify(currentValue),
  };
}

function businessProfilePath(tenantId: string): string {
  return resolveDataPath('generated', 'validated', tenantId, 'business-profile.json');
}

function normalizeBusinessProfileRecord(
  tenantId: string,
  value: Record<string, unknown> | BusinessProfileRecord | null,
): BusinessProfileRecord | null {
  if (!value) {
    return null;
  }

  return {
    tenant_id: stringOrNull(value.tenant_id) || tenantId,
    business_name: stringOrNull(value.business_name),
    tenant_slug: stringOrNull(value.tenant_slug),
    website_url: normalizeMarketingWebsiteUrl(stringOrNull(value.website_url)) || null,
    business_type: stringOrNull(value.business_type),
    primary_goal: stringOrNull(value.primary_goal),
    launch_approver_user_id: stringOrNull(value.launch_approver_user_id),
    launch_approver_name: stringOrNull(value.launch_approver_name),
    offer: stringOrNull(value.offer),
    brand_voice: stringOrNull(value.brand_voice),
    style_vibe: stringOrNull(value.style_vibe),
    notes: stringOrNull(value.notes),
    competitor_url: sanitizeLegacyCompetitorUrl(stringOrNull(value.competitor_url)),
    channels: stringArray(value.channels),
    updated_at: stringOrNull(value.updated_at) || nowIso(),
  };
}

function mergePersistedCompetitorUrlField(
  currentValue: string | null,
  nextValue: string | null | undefined,
): { value: string | null; changed: boolean } {
  if (nextValue === undefined || nextValue === null) {
    return { value: currentValue, changed: false };
  }

  const trimmed = nextValue.trim();
  if (!trimmed) {
    return { value: currentValue, changed: false };
  }

  const validation = validateCanonicalCompetitorUrl(trimmed);
  if (validation.error === COMPETITOR_URL_SOCIAL_ERROR || validation.error === COMPETITOR_URL_INVALID_ERROR) {
    throw new Error(validation.error);
  }
  if (!validation.normalized) {
    return { value: currentValue, changed: false };
  }

  return {
    value: validation.normalized,
    changed: validation.normalized !== currentValue,
  };
}

function loadBusinessProfileRecord(tenantId: string): BusinessProfileRecord | null {
  const filePath = businessProfilePath(tenantId);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    return normalizeBusinessProfileRecord(tenantId, parsed);
  } catch {
    return null;
  }
}

function saveBusinessProfileRecordToFile(record: BusinessProfileRecord): void {
  const filePath = businessProfilePath(record.tenant_id);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ ...record, updated_at: nowIso() }, null, 2));
}

function saveBusinessProfileRecordToDb(record: BusinessProfileRecord): void {
  const numericId = Number(record.tenant_id);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    return;
  }

  pool.query(
    `INSERT INTO business_profiles (
      tenant_id, business_name, tenant_slug, website_url, business_type,
      primary_goal, launch_approver_user_id, launch_approver_name, offer,
      brand_voice, style_vibe, notes, competitor_url, channels, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
    ON CONFLICT (tenant_id) DO UPDATE SET
      business_name = EXCLUDED.business_name,
      tenant_slug = EXCLUDED.tenant_slug,
      website_url = EXCLUDED.website_url,
      business_type = EXCLUDED.business_type,
      primary_goal = EXCLUDED.primary_goal,
      launch_approver_user_id = EXCLUDED.launch_approver_user_id,
      launch_approver_name = EXCLUDED.launch_approver_name,
      offer = EXCLUDED.offer,
      brand_voice = EXCLUDED.brand_voice,
      style_vibe = EXCLUDED.style_vibe,
      notes = EXCLUDED.notes,
      competitor_url = EXCLUDED.competitor_url,
      channels = EXCLUDED.channels,
      updated_at = now()`,
    [
      numericId, record.business_name, record.tenant_slug,
      record.website_url, record.business_type, record.primary_goal,
      record.launch_approver_user_id, record.launch_approver_name, record.offer,
      record.brand_voice, record.style_vibe, record.notes,
      record.competitor_url, record.channels,
    ],
  ).catch((err) => {
    console.error('[business-profile] Failed to persist to database:', err);
  });
}

function saveBusinessProfileRecord(record: BusinessProfileRecord): void {
  saveBusinessProfileRecordToFile(record);
  saveBusinessProfileRecordToDb(record);
}

async function launchApproverName(client: PoolClient, approverUserId: string | null): Promise<string | null> {
  if (!approverUserId) return null;
  const result = await client.query(
    'SELECT full_name, email FROM users WHERE id = $1 LIMIT 1',
    [Number(approverUserId)],
  );
  if ((result.rowCount ?? 0) === 0) {
    return null;
  }
  return result.rows[0].full_name || result.rows[0].email || null;
}

async function runtimeBrandKitAsTenantBrandKit(tenantId: string): Promise<{ brandKit: TenantBrandKit | null; latestJobId: string | null }> {
  const latestJobId = await findLatestMarketingJobIdForTenant(tenantId);
  if (!latestJobId) {
    return { brandKit: null, latestJobId: null };
  }

  const runtimeDoc = await loadMarketingJobRuntime(latestJobId);
  const runtimeBrandKit = runtimeDoc?.brand_kit;
  if (!runtimeBrandKit) {
    return { brandKit: null, latestJobId };
  }

  return {
    latestJobId,
    brandKit: {
      tenant_id: tenantId,
      source_url: runtimeBrandKit.source_url,
      canonical_url: runtimeBrandKit.canonical_url,
      brand_name: runtimeBrandKit.brand_name,
      logo_urls: [...runtimeBrandKit.logo_urls],
      colors: {
        primary: runtimeBrandKit.colors.primary,
        secondary: runtimeBrandKit.colors.secondary,
        accent: runtimeBrandKit.colors.accent,
        palette: [...runtimeBrandKit.colors.palette],
      },
      font_families: [...runtimeBrandKit.font_families],
      external_links: [...runtimeBrandKit.external_links],
      extracted_at: runtimeBrandKit.extracted_at,
      brand_voice_summary: sanitizeBrandKitSummaryText(runtimeBrandKit.brand_voice_summary ?? null),
      offer_summary: sanitizeBrandKitSummaryText(runtimeBrandKit.offer_summary ?? null),
    },
  };
}

export async function resolveBusinessProfileBrandKit(tenantId: string): Promise<{
  brandKit: TenantBrandKit | null;
  source: BusinessProfileBrandKitSource;
  latestJobId: string | null;
}> {
  const runtime = await runtimeBrandKitAsTenantBrandKit(tenantId);
  if (runtime.brandKit) {
    return {
      brandKit: runtime.brandKit,
      source: 'runtime_brand_kit',
      latestJobId: runtime.latestJobId,
    };
  }

  const persisted = await loadTenantBrandKit(tenantId);
  if (persisted) {
    return {
      brandKit: persisted,
      source: 'validated_brand_kit_file',
      latestJobId: runtime.latestJobId,
    };
  }

  return {
    brandKit: null,
    source: 'none',
    latestJobId: runtime.latestJobId,
  };
}

function incompleteProfile(input: {
  businessName: string;
  websiteUrl: string | null;
  businessType: string | null;
  primaryGoal: string | null;
}): boolean {
  return !input.businessName.trim() || !input.websiteUrl || !input.businessType || !input.primaryGoal;
}

function joinedSourceText(values: Array<string | null | undefined>): string {
  return values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();
}

function inferBusinessTypeFromSignals(values: Array<string | null | undefined>): string | null {
  const text = joinedSourceText(values);
  if (!text) {
    return null;
  }
  if (/(coach|coaching)/.test(text) && /(network|membership|collective|community)/.test(text)) {
    return 'Executive and transformational coaching network';
  }
  if (/(coach|coaching|transformational coaching|executive coaching)/.test(text)) {
    return 'Executive and transformational coaching services';
  }
  if (/(consulting|consult|advisory|advisor)/.test(text)) {
    return 'Consulting and advisory services';
  }
  return null;
}

function inferPrimaryGoalFromSignals(values: Array<string | null | undefined>): string | null {
  const text = joinedSourceText(values);
  if (!text) {
    return null;
  }
  if (
    /(book|schedule|reserve).{0,32}(call|consult|consultation|session|appointment)/.test(text) ||
    /book a call|schedule a call|discovery call|consult/.test(text)
  ) {
    return 'Book more qualified calls';
  }
  if (/(sale|sales|purchase|buy|order|checkout|shop)/.test(text)) {
    return 'Increase offer sales';
  }
  if (/(lead|enquir|inquiry|membership|join now|apply now)/.test(text)) {
    return 'Generate more qualified leads';
  }
  if (/(visible|awareness|presence|stay in market)/.test(text)) {
    return 'Stay visible every week';
  }
  return null;
}

function resolvedChannels(channels: string[]): string[] {
  return channels.length > 0 ? channels : [...DEFAULT_MARKETING_CHANNELS];
}

function workspaceBrandContextPath(jobId: string): string {
  return resolveDataPath('generated', 'draft', 'marketing-workspaces', jobId, 'workspace.json');
}

function loadLatestWorkspaceBrandContext(latestJobId: string | null): WorkspaceBrandContext {
  if (!latestJobId) {
    return {
      brandVoice: null,
      styleVibe: null,
    };
  }

  const filePath = workspaceBrandContextPath(latestJobId);
  if (!existsSync(filePath)) {
    return {
      brandVoice: null,
      styleVibe: null,
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const brief = parsed.brief && typeof parsed.brief === 'object' && !Array.isArray(parsed.brief)
      ? (parsed.brief as Record<string, unknown>)
      : null;
    return {
      brandVoice: stringOrNull(brief?.brandVoice),
      styleVibe: stringOrNull(brief?.styleVibe),
    };
  } catch {
    return {
      brandVoice: null,
      styleVibe: null,
    };
  }
}

function buildBusinessProfileView(input: {
  tenantId: string;
  businessName: string;
  tenantSlug: string;
  record: BusinessProfileRecord | null;
  brandKit: TenantBrandKit | null;
  approverName: string | null;
  validatedProfile: ValidatedMarketingProfileSnapshot;
  workspaceBrandContext: WorkspaceBrandContext;
}): BusinessProfileView {
  const websiteUrl =
    input.validatedProfile.websiteUrl ??
    input.record?.website_url ??
    input.brandKit?.source_url ??
    null;
  const businessName =
    input.businessName.trim() ||
    input.validatedProfile.businessName ||
    input.record?.business_name ||
    input.brandKit?.brand_name ||
    '';
  const inferredBusinessType = inferBusinessTypeFromSignals([
    input.validatedProfile.businessType,
    input.validatedProfile.brandIdentity?.summary,
    input.validatedProfile.brandIdentity?.offer,
    input.validatedProfile.brandIdentity?.positioning,
    input.validatedProfile.offer,
    input.brandKit?.offer_summary,
  ]);
  const inferredPrimaryGoal = inferPrimaryGoalFromSignals([
    input.validatedProfile.primaryGoal,
    input.validatedProfile.brandIdentity?.ctaStyle,
    input.validatedProfile.brandIdentity?.summary,
    input.validatedProfile.offer,
    input.brandKit?.offer_summary,
    input.brandKit?.external_links.map((link) => link.platform).join(' '),
  ]);
  const effectiveBusinessType =
    input.validatedProfile.businessType ??
    input.record?.business_type ??
    inferredBusinessType;
  const effectivePrimaryGoal =
    input.validatedProfile.primaryGoal ??
    input.record?.primary_goal ??
    inferredPrimaryGoal;
  const effectiveChannels = resolvedChannels(
    input.validatedProfile.channels.length > 0 ? input.validatedProfile.channels : (input.record?.channels ?? []),
  );
  const effectiveOffer = repairLegacyMarketingText(
    input.validatedProfile.offer ?? input.record?.offer ?? input.brandKit?.offer_summary ?? null,
  );
  const effectiveBrandVoice = repairLegacyMarketingText(
    input.record?.brand_voice ??
      input.workspaceBrandContext.brandVoice ??
      input.validatedProfile.brandIdentity?.toneOfVoice ??
      (input.validatedProfile.brandVoice.length > 0 ? input.validatedProfile.brandVoice.join('\n') : null) ??
      input.brandKit?.brand_voice_summary ??
      null,
  );
  const effectiveStyleVibe = repairLegacyMarketingText(
    input.record?.style_vibe ??
      input.workspaceBrandContext.styleVibe ??
      input.validatedProfile.brandIdentity?.styleVibe ??
      null,
  );
  const effectiveNotes = repairLegacyMarketingText(
    input.record?.notes ?? input.validatedProfile.brandIdentity?.summary ?? null,
  );

  return {
    tenantId: input.tenantId,
    businessName,
    tenantSlug: input.tenantSlug,
    websiteUrl,
    businessType: effectiveBusinessType,
    primaryGoal: effectivePrimaryGoal,
    launchApproverUserId: input.record?.launch_approver_user_id ?? null,
    launchApproverName: input.approverName,
    offer: effectiveOffer,
    brandVoice: effectiveBrandVoice,
    styleVibe: effectiveStyleVibe,
    notes: effectiveNotes,
    competitorUrl: input.validatedProfile.competitorUrl ?? input.record?.competitor_url ?? null,
    channels: effectiveChannels,
    brandIdentity: input.validatedProfile.brandIdentity,
    brandKit: input.brandKit,
    incomplete: incompleteProfile({
      businessName,
      websiteUrl,
      businessType: effectiveBusinessType,
      primaryGoal: effectivePrimaryGoal,
    }),
  };
}

async function persistBrandKitIfNeeded(
  tenantId: string,
  nextWebsiteUrl: string | null,
  _previousWebsiteUrl: string | null,
): Promise<void> {
  if (!nextWebsiteUrl) {
    return;
  }

  await extractAndSaveTenantBrandKit({
    tenantId,
    brandUrl: nextWebsiteUrl,
  });
}

export async function getBusinessProfile(client: PoolClient, tenantId: string): Promise<BusinessProfileView> {
  const resolved = await getBusinessProfileWithDiagnostics(client, tenantId);
  return resolved.profile;
}

export async function getBusinessProfileWithDiagnostics(client: PoolClient, tenantId: string): Promise<ResolvedBusinessProfile> {
  const tenant = await client.query(
    "SELECT id, name, COALESCE(NULLIF(slug, ''), 'org-' || id::text) AS slug FROM organizations WHERE id = $1 LIMIT 1",
    [Number(tenantId)],
  );
  if ((tenant.rowCount ?? 0) === 0) {
    throw new Error('tenant_not_found');
  }

  const tenantRow = tenant.rows[0] as { id: number; name: string; slug: string };
  const record = loadBusinessProfileRecord(tenantId);
  const { brandKit, source, latestJobId } = await resolveBusinessProfileBrandKit(tenantId);
  const validatedProfile = await loadValidatedMarketingProfileSnapshot(tenantId, {
    currentSourceUrl: record?.website_url ?? brandKit?.canonical_url ?? brandKit?.source_url ?? null,
  });
  const workspaceBrandContext = loadLatestWorkspaceBrandContext(latestJobId);
  const resolvedApproverName =
    (await launchApproverName(client, record?.launch_approver_user_id ?? null)) ||
    validatedProfile.launchApproverName ||
    record?.launch_approver_name ||
    null;

  return {
    profile: buildBusinessProfileView({
      tenantId,
      businessName: validatedProfile.businessName || record?.business_name || tenantRow.name || brandKit?.brand_name || '',
      tenantSlug: record?.tenant_slug || tenantRow.slug,
      record,
      brandKit,
      approverName: resolvedApproverName,
      validatedProfile,
      workspaceBrandContext,
    }),
    brandKitSource: source,
    latestJobId,
  };
}

export async function updateBusinessProfile(
  client: PoolClient,
  input: BusinessProfileUpdateInput,
): Promise<BusinessProfileView> {
  const resolved = await updateBusinessProfileWithDiagnostics(client, input);
  return resolved.profile;
}

export async function updateBusinessProfileWithDiagnostics(
  client: PoolClient,
  input: BusinessProfileUpdateInput,
): Promise<ResolvedBusinessProfile> {
  const current = await getBusinessProfileWithDiagnostics(client, input.tenantId);

  const nextBusinessName =
    mergePersistedStringField(current.profile.businessName || null, input.businessName).value ||
    current.profile.businessName ||
    '';
  const nextWebsiteUrl = mergePersistedStringField(
    current.profile.websiteUrl,
    input.websiteUrl,
    normalizeMarketingWebsiteUrl,
  ).value;
  const nextBusinessType = mergePersistedStringField(current.profile.businessType, input.businessType).value;
  const nextPrimaryGoal = mergePersistedStringField(current.profile.primaryGoal, input.primaryGoal).value;
  const nextApproverUserId = mergePersistedStringField(
    current.profile.launchApproverUserId,
    input.launchApproverUserId,
  ).value;
  const nextApproverName = mergePersistedStringField(
    current.profile.launchApproverName,
    input.launchApproverName,
  ).value;
  const nextOffer = mergePersistedStringField(current.profile.offer, input.offer).value;
  const nextBrandVoice = mergePersistedStringField(current.profile.brandVoice, input.brandVoice).value;
  const nextStyleVibe = mergePersistedStringField(current.profile.styleVibe, input.styleVibe).value;
  const nextNotes = mergePersistedStringField(current.profile.notes, input.notes).value;
  const nextCompetitorUrl = mergePersistedCompetitorUrlField(
    current.profile.competitorUrl,
    input.competitorUrl,
  ).value;
  const nextChannels = mergePersistedStringArrayField(current.profile.channels, input.channels).value;

  if (!nextBusinessName?.trim()) {
    throw new Error('missing_required_fields:businessName');
  }

  await client.query('UPDATE organizations SET name = $1 WHERE id = $2', [nextBusinessName, Number(input.tenantId)]);

  saveBusinessProfileRecord({
    tenant_id: input.tenantId,
    business_name: nextBusinessName,
    tenant_slug: current.profile.tenantSlug,
    website_url: nextWebsiteUrl,
    business_type: nextBusinessType,
    primary_goal: nextPrimaryGoal,
    launch_approver_user_id: nextApproverUserId,
    launch_approver_name: nextApproverName,
    offer: nextOffer,
    brand_voice: nextBrandVoice,
    style_vibe: nextStyleVibe,
    notes: nextNotes,
    competitor_url: nextCompetitorUrl,
    channels: nextChannels,
    updated_at: nowIso(),
  });

  await persistBrandKitIfNeeded(input.tenantId, nextWebsiteUrl, current.profile.websiteUrl);
  return getBusinessProfileWithDiagnostics(client, input.tenantId);
}

export async function tenantHasStoredBusinessProfileState(tenantId: string): Promise<boolean> {
  const record = loadBusinessProfileRecord(tenantId);
  if (
    record &&
    [
      record.business_name,
      record.website_url,
      record.business_type,
      record.primary_goal,
      record.offer,
      record.brand_voice,
      record.style_vibe,
      record.notes,
      record.competitor_url,
      ...(record.channels || []),
    ].some((value) => typeof value === 'string' && value.trim().length > 0)
  ) {
    return true;
  }

  const docs = await loadValidatedMarketingProfileDocs(tenantId);
  return Boolean(docs.brandProfile || docs.websiteAnalysis || docs.businessProfile || docs.brandKit);
}

export async function getPublicBusinessProfile(websiteUrl?: string | null): Promise<ResolvedBusinessProfile> {
  const normalizedWebsiteUrl = normalizeMarketingWebsiteUrl(websiteUrl);
  const tenantId =
    derivePublicMarketingTenantId(normalizedWebsiteUrl) ||
    'public_campaign';
  const record = loadBusinessProfileRecord(tenantId);
  const { brandKit, source, latestJobId } = await resolveBusinessProfileBrandKit(tenantId);
  const validatedProfile = await loadValidatedMarketingProfileSnapshot(tenantId, {
    currentSourceUrl: normalizedWebsiteUrl || record?.website_url || brandKit?.canonical_url || brandKit?.source_url || null,
  });
  const tenantSlug = record?.tenant_slug || publicTenantSlug(tenantId);
  const businessName = validatedProfile.businessName || record?.business_name || brandKit?.brand_name || '';
  const workspaceBrandContext = loadLatestWorkspaceBrandContext(latestJobId);

  return {
    profile: buildBusinessProfileView({
      tenantId,
      businessName,
      tenantSlug,
      record,
      brandKit,
      approverName: validatedProfile.launchApproverName || record?.launch_approver_name || null,
      validatedProfile,
      workspaceBrandContext,
    }),
    brandKitSource: source,
    latestJobId,
  };
}

export async function updatePublicBusinessProfile(input: Omit<BusinessProfileUpdateInput, 'tenantId'>): Promise<ResolvedBusinessProfile> {
  const normalizedWebsiteUrl = normalizeMarketingWebsiteUrl(input.websiteUrl);
  if (!normalizedWebsiteUrl) {
    throw new Error('missing_required_fields:websiteUrl');
  }

  const tenantId = derivePublicMarketingTenantId(normalizedWebsiteUrl);
  if (!tenantId) {
    throw new Error('invalid_website_url');
  }

  const current = await getPublicBusinessProfile(normalizedWebsiteUrl);
  const nextBusinessName =
    mergePersistedStringField(current.profile.businessName || null, input.businessName).value ||
    current.profile.businessName ||
    current.profile.brandKit?.brand_name ||
    '';
  if (!nextBusinessName) {
    throw new Error('missing_required_fields:businessName');
  }

  saveBusinessProfileRecord({
    tenant_id: tenantId,
    business_name: nextBusinessName,
    tenant_slug: current.profile.tenantSlug || publicTenantSlug(tenantId),
    website_url: normalizedWebsiteUrl,
    business_type: mergePersistedStringField(current.profile.businessType, input.businessType).value,
    primary_goal: mergePersistedStringField(current.profile.primaryGoal, input.primaryGoal).value,
    launch_approver_user_id: mergePersistedStringField(
      current.profile.launchApproverUserId,
      input.launchApproverUserId,
    ).value,
    launch_approver_name: mergePersistedStringField(
      current.profile.launchApproverName,
      input.launchApproverName,
    ).value,
    offer: mergePersistedStringField(current.profile.offer, input.offer).value,
    brand_voice: mergePersistedStringField(current.profile.brandVoice, input.brandVoice).value,
    style_vibe: mergePersistedStringField(current.profile.styleVibe, input.styleVibe).value,
    notes: mergePersistedStringField(current.profile.notes, input.notes).value,
    competitor_url: mergePersistedCompetitorUrlField(
      current.profile.competitorUrl,
      input.competitorUrl,
    ).value,
    channels: mergePersistedStringArrayField(current.profile.channels, input.channels).value,
    updated_at: nowIso(),
  });

  await persistBrandKitIfNeeded(tenantId, normalizedWebsiteUrl, current.profile.websiteUrl);
  return await getPublicBusinessProfile(normalizedWebsiteUrl);
}

export function persistBusinessProfileFieldsFromMarketingPayload(
  input: MarketingProfilePersistenceInput,
): BusinessProfileRecord | null {
  const current = loadBusinessProfileRecord(input.tenantId);
  const websiteField = firstPresentStringField(input.payload, ['websiteUrl', 'brandUrl']);
  const businessTypeField = firstPresentStringField(input.payload, ['businessType']);
  const primaryGoalField = firstPresentStringField(input.payload, ['primaryGoal', 'goal']);
  const approverField = firstPresentStringField(input.payload, ['launchApproverName', 'approverName']);
  const offerField = firstPresentStringField(input.payload, ['offer']);
  const brandVoiceField = firstPresentStringField(input.payload, ['brandVoice']);
  const styleVibeField = firstPresentStringField(input.payload, ['styleVibe']);
  const competitorField = firstPresentStringField(input.payload, ['competitorUrl']);
  const channelsField = firstPresentStringArrayField(input.payload, ['channels']);

  const nextRecord: BusinessProfileRecord = {
    tenant_id: input.tenantId,
    business_name: current?.business_name ?? null,
    tenant_slug: current?.tenant_slug ?? stringOrNull(input.tenantSlug),
    website_url: current?.website_url ?? null,
    business_type: current?.business_type ?? null,
    primary_goal: current?.primary_goal ?? null,
    launch_approver_user_id: current?.launch_approver_user_id ?? null,
    launch_approver_name: current?.launch_approver_name ?? null,
    offer: current?.offer ?? null,
    brand_voice: current?.brand_voice ?? null,
    style_vibe: current?.style_vibe ?? null,
    notes: current?.notes ?? null,
    competitor_url: current?.competitor_url ?? null,
    channels: current?.channels ?? [],
    updated_at: nowIso(),
  };

  let shouldPersist = false;

  if (websiteField.present) {
    const websiteMerge = mergePersistedStringField(
      nextRecord.website_url,
      websiteField.value,
      normalizeMarketingWebsiteUrl,
    );
    if (websiteMerge.changed) {
      nextRecord.website_url = websiteMerge.value;
      shouldPersist = true;
    }
  }

  if (businessTypeField.present) {
    const businessTypeMerge = mergePersistedStringField(nextRecord.business_type, businessTypeField.value);
    if (businessTypeMerge.changed) {
      nextRecord.business_type = businessTypeMerge.value;
      shouldPersist = true;
    }
  }

  if (primaryGoalField.present) {
    const primaryGoalMerge = mergePersistedStringField(nextRecord.primary_goal, primaryGoalField.value);
    if (primaryGoalMerge.changed) {
      nextRecord.primary_goal = primaryGoalMerge.value;
      shouldPersist = true;
    }
  }

  if (approverField.present) {
    const approverMerge = mergePersistedStringField(nextRecord.launch_approver_name, approverField.value);
    if (approverMerge.changed) {
      nextRecord.launch_approver_name = approverMerge.value;
      shouldPersist = true;
    }
  }

  if (offerField.present) {
    const offerMerge = mergePersistedStringField(nextRecord.offer, offerField.value);
    if (offerMerge.changed) {
      nextRecord.offer = offerMerge.value;
      shouldPersist = true;
    }
  }

  if (brandVoiceField.present) {
    const brandVoiceMerge = mergePersistedStringField(nextRecord.brand_voice, brandVoiceField.value);
    if (brandVoiceMerge.changed) {
      nextRecord.brand_voice = brandVoiceMerge.value;
      shouldPersist = true;
    }
  }

  if (styleVibeField.present) {
    const styleVibeMerge = mergePersistedStringField(nextRecord.style_vibe, styleVibeField.value);
    if (styleVibeMerge.changed) {
      nextRecord.style_vibe = styleVibeMerge.value;
      shouldPersist = true;
    }
  }

  if (competitorField.present) {
    const competitorMerge = mergePersistedCompetitorUrlField(
      nextRecord.competitor_url,
      competitorField.value,
    );
    if (competitorMerge.changed) {
      nextRecord.competitor_url = competitorMerge.value;
      shouldPersist = true;
    }
  }

  if (channelsField.present) {
    const channelsMerge = mergePersistedStringArrayField(nextRecord.channels, channelsField.value);
    if (channelsMerge.changed) {
      nextRecord.channels = channelsMerge.value;
      shouldPersist = true;
    }
  }

  if (!current && !shouldPersist) {
    return null;
  }

  if (!shouldPersist && current) {
    return current;
  }

  saveBusinessProfileRecord(nextRecord);
  return nextRecord;
}

export async function marketingPayloadDefaultsFromBusinessProfile(tenantId: string): Promise<PersistedMarketingProfileDefaults> {
  const record = loadBusinessProfileRecord(tenantId);
  const { brandKit, latestJobId } = await resolveBusinessProfileBrandKit(tenantId);
  const validatedProfile = await loadValidatedMarketingProfileSnapshot(tenantId, {
    currentSourceUrl: record?.website_url ?? brandKit?.canonical_url ?? brandKit?.source_url ?? null,
  });
  const workspaceBrandContext = loadLatestWorkspaceBrandContext(latestJobId);

  const businessName =
    record?.business_name ??
    validatedProfile.businessName ??
    validatedProfile.brandName ??
    brandKit?.brand_name ??
    undefined;
  const primaryGoal =
    record?.primary_goal ??
    validatedProfile.primaryGoal ??
    inferPrimaryGoalFromSignals([
      validatedProfile.brandIdentity?.ctaStyle,
      validatedProfile.brandIdentity?.summary,
      validatedProfile.offer,
      brandKit?.offer_summary,
    ]) ??
    undefined;
  const approverName = record?.launch_approver_name ?? validatedProfile.launchApproverName ?? undefined;
  const offer = record?.offer ?? validatedProfile.offer ?? brandKit?.offer_summary ?? undefined;
  const brandVoice =
    record?.brand_voice ??
    workspaceBrandContext.brandVoice ??
    validatedProfile.brandIdentity?.toneOfVoice ??
    (validatedProfile.brandVoice.length > 0 ? validatedProfile.brandVoice.join('\n') : null) ??
    brandKit?.brand_voice_summary ??
    undefined;
  const channels =
    record?.channels && record.channels.length > 0
      ? [...record.channels]
      : validatedProfile.channels.length > 0
        ? [...validatedProfile.channels]
        : [...DEFAULT_MARKETING_CHANNELS];

  return {
    websiteUrl: record?.website_url ?? validatedProfile.websiteUrl ?? brandKit?.source_url ?? undefined,
    businessName,
    businessType:
      record?.business_type ??
      validatedProfile.businessType ??
      inferBusinessTypeFromSignals([
        validatedProfile.brandIdentity?.summary,
        validatedProfile.brandIdentity?.offer,
        validatedProfile.offer,
        brandKit?.offer_summary,
      ]) ??
      undefined,
    primaryGoal,
    goal: primaryGoal,
    launchApproverName: approverName,
    approverName,
    offer,
    brandVoice,
    styleVibe: record?.style_vibe ?? workspaceBrandContext.styleVibe ?? validatedProfile.brandIdentity?.styleVibe ?? undefined,
    competitorUrl: record?.competitor_url ?? validatedProfile.competitorUrl ?? undefined,
    channels,
  };
}
