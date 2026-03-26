import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { PoolClient } from 'pg';

import { resolveDataPath } from '@/lib/runtime-paths';
import { extractAndSaveTenantBrandKit, loadTenantBrandKit, type TenantBrandKit } from '@/backend/marketing/brand-kit';

export type BusinessProfileRecord = {
  tenant_id: string;
  website_url: string | null;
  business_type: string | null;
  primary_goal: string | null;
  launch_approver_user_id: string | null;
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
  brandKit: TenantBrandKit | null;
  incomplete: boolean;
};

function nowIso(): string {
  return new Date().toISOString();
}

function businessProfilePath(tenantId: string): string {
  return resolveDataPath('generated', 'validated', tenantId, 'business-profile.json');
}

function loadBusinessProfileRecord(tenantId: string): BusinessProfileRecord | null {
  const filePath = businessProfilePath(tenantId);
  if (!existsSync(filePath)) {
    return null;
  }
  return JSON.parse(readFileSync(filePath, 'utf8')) as BusinessProfileRecord;
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

export async function getBusinessProfile(client: PoolClient, tenantId: string): Promise<BusinessProfileView> {
  const tenant = await client.query(
    "SELECT id, name, COALESCE(NULLIF(slug, ''), 'org-' || id::text) AS slug FROM organizations WHERE id = $1 LIMIT 1",
    [Number(tenantId)],
  );
  if ((tenant.rowCount ?? 0) === 0) {
    throw new Error('tenant_not_found');
  }

  const tenantRow = tenant.rows[0] as { id: number; name: string; slug: string };
  const record = loadBusinessProfileRecord(tenantId);
  const brandKit = loadTenantBrandKit(tenantId);
  const approverName = await launchApproverName(client, record?.launch_approver_user_id ?? null);

  const websiteUrl = record?.website_url ?? brandKit?.source_url ?? null;
  const incomplete = !websiteUrl || !record?.business_type || !record?.primary_goal;

  return {
    tenantId,
    businessName: tenantRow.name,
    tenantSlug: tenantRow.slug,
    websiteUrl,
    businessType: record?.business_type ?? null,
    primaryGoal: record?.primary_goal ?? null,
    launchApproverUserId: record?.launch_approver_user_id ?? null,
    launchApproverName: approverName,
    brandKit,
    incomplete,
  };
}

export async function updateBusinessProfile(
  client: PoolClient,
  input: {
    tenantId: string;
    businessName?: string | null;
    websiteUrl?: string | null;
    businessType?: string | null;
    primaryGoal?: string | null;
    launchApproverUserId?: string | null;
  },
): Promise<BusinessProfileView> {
  const current = await getBusinessProfile(client, input.tenantId);

  const nextBusinessName = (input.businessName ?? current.businessName).trim();
  const nextWebsiteUrl = input.websiteUrl === undefined ? current.websiteUrl : (input.websiteUrl?.trim() || null);
  const nextBusinessType = input.businessType === undefined ? current.businessType : (input.businessType?.trim() || null);
  const nextPrimaryGoal = input.primaryGoal === undefined ? current.primaryGoal : (input.primaryGoal?.trim() || null);
  const nextApproverUserId = input.launchApproverUserId === undefined ? current.launchApproverUserId : (input.launchApproverUserId?.trim() || null);

  if (!nextBusinessName) {
    throw new Error('missing_required_fields:businessName');
  }

  await client.query('UPDATE organizations SET name = $1 WHERE id = $2', [nextBusinessName, Number(input.tenantId)]);

  saveBusinessProfileRecord({
    tenant_id: input.tenantId,
    website_url: nextWebsiteUrl,
    business_type: nextBusinessType,
    primary_goal: nextPrimaryGoal,
    launch_approver_user_id: nextApproverUserId,
    updated_at: nowIso(),
  });

  if (nextWebsiteUrl && nextWebsiteUrl !== current.websiteUrl) {
    await extractAndSaveTenantBrandKit({
      tenantId: input.tenantId,
      brandUrl: nextWebsiteUrl,
    });
  }

  return getBusinessProfile(client, input.tenantId);
}
