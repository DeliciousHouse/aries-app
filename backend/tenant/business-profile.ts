import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { PoolClient } from 'pg';

import {
  extractAndSaveTenantBrandKit,
  loadTenantBrandKit,
  tenantBrandKitPath,
  type TenantBrandKit,
} from '@/backend/marketing/brand-kit';
import {
  findLatestMarketingJobIdForTenant,
  findLatestMarketingTenantId,
  loadMarketingJobRuntime,
} from '@/backend/marketing/runtime-state';
import {
  derivePublicMarketingTenantId,
  normalizeMarketingWebsiteUrl,
  publicTenantSlug,
} from '@/lib/marketing-public-mode';
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
  notes: string | null;
  competitorUrl: string | null;
  channels: string[];
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
  notes?: string | null;
  competitorUrl?: string | null;
  channels?: string[] | null;
};

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
    notes: stringOrNull(value.notes),
    competitor_url: normalizeMarketingWebsiteUrl(stringOrNull(value.competitor_url)) || stringOrNull(value.competitor_url),
    channels: stringArray(value.channels),
    updated_at: stringOrNull(value.updated_at) || nowIso(),
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

function saveBusinessProfileRecord(record: BusinessProfileRecord): string {
  const filePath = businessProfilePath(record.tenant_id);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ ...record, updated_at: nowIso() }, null, 2));
  return filePath;
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

function runtimeBrandKitAsTenantBrandKit(tenantId: string): { brandKit: TenantBrandKit | null; latestJobId: string | null } {
  const latestJobId = findLatestMarketingJobIdForTenant(tenantId);
  if (!latestJobId) {
    return { brandKit: null, latestJobId: null };
  }

  const runtimeDoc = loadMarketingJobRuntime(latestJobId);
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
      brand_voice_summary: runtimeBrandKit.brand_voice_summary ?? null,
      offer_summary: runtimeBrandKit.offer_summary ?? null,
    },
  };
}

export function resolveBusinessProfileBrandKit(tenantId: string): {
  brandKit: TenantBrandKit | null;
  source: BusinessProfileBrandKitSource;
  latestJobId: string | null;
} {
  const runtime = runtimeBrandKitAsTenantBrandKit(tenantId);
  if (runtime.brandKit) {
    return {
      brandKit: runtime.brandKit,
      source: 'runtime_brand_kit',
      latestJobId: runtime.latestJobId,
    };
  }

  const persisted = loadTenantBrandKit(tenantId);
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

function buildBusinessProfileView(input: {
  tenantId: string;
  businessName: string;
  tenantSlug: string;
  record: BusinessProfileRecord | null;
  brandKit: TenantBrandKit | null;
  approverName: string | null;
}): BusinessProfileView {
  const websiteUrl = input.record?.website_url ?? input.brandKit?.source_url ?? null;
  const businessName = input.businessName.trim() || input.record?.business_name || input.brandKit?.brand_name || '';

  return {
    tenantId: input.tenantId,
    businessName,
    tenantSlug: input.tenantSlug,
    websiteUrl,
    businessType: input.record?.business_type ?? null,
    primaryGoal: input.record?.primary_goal ?? null,
    launchApproverUserId: input.record?.launch_approver_user_id ?? null,
    launchApproverName: input.approverName,
    offer: input.record?.offer ?? null,
    notes: input.record?.notes ?? null,
    competitorUrl: input.record?.competitor_url ?? null,
    channels: input.record?.channels ?? [],
    brandKit: input.brandKit,
    incomplete: incompleteProfile({
      businessName,
      websiteUrl,
      businessType: input.record?.business_type ?? null,
      primaryGoal: input.record?.primary_goal ?? null,
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
  const { brandKit, source, latestJobId } = resolveBusinessProfileBrandKit(tenantId);
  const resolvedApproverName =
    (await launchApproverName(client, record?.launch_approver_user_id ?? null)) ||
    record?.launch_approver_name ||
    null;

  return {
    profile: buildBusinessProfileView({
      tenantId,
      businessName: record?.business_name || tenantRow.name || brandKit?.brand_name || '',
      tenantSlug: record?.tenant_slug || tenantRow.slug,
      record,
      brandKit,
      approverName: resolvedApproverName,
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

  const nextBusinessName = stringOrNull(input.businessName) || current.profile.businessName;
  const nextWebsiteUrl =
    input.websiteUrl === undefined
      ? current.profile.websiteUrl
      : normalizeMarketingWebsiteUrl(input.websiteUrl) || null;
  const nextBusinessType =
    input.businessType === undefined ? current.profile.businessType : stringOrNull(input.businessType);
  const nextPrimaryGoal =
    input.primaryGoal === undefined ? current.profile.primaryGoal : stringOrNull(input.primaryGoal);
  const nextApproverUserId =
    input.launchApproverUserId === undefined ? current.profile.launchApproverUserId : stringOrNull(input.launchApproverUserId);
  const nextApproverName =
    input.launchApproverName === undefined ? current.profile.launchApproverName : stringOrNull(input.launchApproverName);
  const nextOffer = input.offer === undefined ? current.profile.offer : stringOrNull(input.offer);
  const nextNotes = input.notes === undefined ? current.profile.notes : stringOrNull(input.notes);
  const nextCompetitorUrl =
    input.competitorUrl === undefined
      ? current.profile.competitorUrl
      : normalizeMarketingWebsiteUrl(input.competitorUrl) || stringOrNull(input.competitorUrl);
  const nextChannels = input.channels === undefined || input.channels === null
    ? current.profile.channels
    : stringArray(input.channels);

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
    notes: nextNotes,
    competitor_url: nextCompetitorUrl,
    channels: nextChannels,
    updated_at: nowIso(),
  });

  await persistBrandKitIfNeeded(input.tenantId, nextWebsiteUrl, current.profile.websiteUrl);
  return getBusinessProfileWithDiagnostics(client, input.tenantId);
}

export function getPublicBusinessProfile(websiteUrl?: string | null): ResolvedBusinessProfile {
  const tenantId =
    derivePublicMarketingTenantId(websiteUrl) ||
    findLatestMarketingTenantId() ||
    'public_campaign';
  const record = loadBusinessProfileRecord(tenantId);
  const { brandKit, source, latestJobId } = resolveBusinessProfileBrandKit(tenantId);
  const tenantSlug = record?.tenant_slug || publicTenantSlug(tenantId);
  const businessName = record?.business_name || brandKit?.brand_name || '';

  return {
    profile: buildBusinessProfileView({
      tenantId,
      businessName,
      tenantSlug,
      record,
      brandKit,
      approverName: record?.launch_approver_name ?? null,
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

  const current = getPublicBusinessProfile(normalizedWebsiteUrl);
  const nextBusinessName =
    stringOrNull(input.businessName) ||
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
    business_type:
      input.businessType === undefined ? current.profile.businessType : stringOrNull(input.businessType),
    primary_goal:
      input.primaryGoal === undefined ? current.profile.primaryGoal : stringOrNull(input.primaryGoal),
    launch_approver_user_id:
      input.launchApproverUserId === undefined ? current.profile.launchApproverUserId : stringOrNull(input.launchApproverUserId),
    launch_approver_name:
      input.launchApproverName === undefined ? current.profile.launchApproverName : stringOrNull(input.launchApproverName),
    offer:
      input.offer === undefined ? current.profile.offer : stringOrNull(input.offer),
    notes:
      input.notes === undefined ? current.profile.notes : stringOrNull(input.notes),
    competitor_url:
      input.competitorUrl === undefined
        ? current.profile.competitorUrl
        : normalizeMarketingWebsiteUrl(input.competitorUrl) || stringOrNull(input.competitorUrl),
    channels:
      input.channels === undefined || input.channels === null
        ? current.profile.channels
        : stringArray(input.channels),
    updated_at: nowIso(),
  });

  await persistBrandKitIfNeeded(tenantId, normalizedWebsiteUrl, current.profile.websiteUrl);
  return getPublicBusinessProfile(normalizedWebsiteUrl);
}

export function businessProfileWritePathForTenant(tenantId: string): string {
  return businessProfilePath(tenantId);
}

export function tenantBrandKitWritePathForTenant(tenantId: string): string {
  return tenantBrandKitPath(tenantId);
}

export function marketingPayloadDefaultsFromBusinessProfile(tenantId: string): PersistedMarketingProfileDefaults {
  const record = loadBusinessProfileRecord(tenantId);
  if (!record) {
    return {};
  }

  return {
    websiteUrl: record.website_url ?? undefined,
    businessName: record.business_name ?? undefined,
    businessType: record.business_type ?? undefined,
    primaryGoal: record.primary_goal ?? undefined,
    goal: record.primary_goal ?? undefined,
    launchApproverName: record.launch_approver_name ?? undefined,
    approverName: record.launch_approver_name ?? undefined,
    offer: record.offer ?? undefined,
    competitorUrl: record.competitor_url ?? undefined,
    channels: record.channels.length > 0 ? [...record.channels] : undefined,
  };
}
