import pool from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';
import {
  getBusinessProfileWithDiagnostics,
  getPublicBusinessProfile,
  updateBusinessProfileWithDiagnostics,
  updatePublicBusinessProfile,
} from '@/backend/tenant/business-profile';
import {
  derivePublicMarketingTenantId,
  isMarketingPublicMode,
  normalizeMarketingWebsiteUrl,
} from '@/lib/marketing-public-mode';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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

function errorStatus(message: string): number {
  if (message.startsWith('missing_required_fields:') || message === 'invalid_website_url') {
    return 400;
  }
  if (message.startsWith('brand_kit_')) {
    return 422;
  }
  return 500;
}

export async function GET(req: Request) {
  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    if (isMarketingPublicMode()) {
      const websiteUrl = normalizeMarketingWebsiteUrl(new URL(req.url).searchParams.get('websiteUrl'));
      const resolved = getPublicBusinessProfile(websiteUrl);
      console.info('[business-profile]', {
        event: 'read',
        mode: 'public',
        tenantId: resolved.profile.tenantId,
        websiteUrl,
        brandKitSource: resolved.brandKitSource,
        latestJobId: resolved.latestJobId,
      });
      return json({ profile: resolved.profile });
    }
    return json({ error: error instanceof Error ? error.message : 'Authentication required.' }, 403);
  }

  const client = await pool.connect();
  try {
    const resolved = await getBusinessProfileWithDiagnostics(client, tenantContext.tenantId);
    console.info('[business-profile]', {
      event: 'read',
      mode: 'authenticated',
      tenantId: tenantContext.tenantId,
      brandKitSource: resolved.brandKitSource,
      latestJobId: resolved.latestJobId,
    });
    return json({ profile: resolved.profile });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, message === 'tenant_not_found' ? 404 : 500);
  } finally {
    client.release();
  }
}

export async function PATCH(req: Request) {
  let payload: {
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
  } = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const normalizedWebsiteUrl = payload.websiteUrl === undefined
    ? undefined
    : normalizeMarketingWebsiteUrl(payload.websiteUrl) || null;

  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    if (!isMarketingPublicMode()) {
      return json({ error: error instanceof Error ? error.message : 'Authentication required.' }, 403);
    }

    const publicTenantId = derivePublicMarketingTenantId(normalizedWebsiteUrl || payload.websiteUrl || null);
    console.info('[business-profile]', {
      event: 'write',
      mode: 'public_file_only',
      normalizedWebsiteUrl,
      derivedTenantId: publicTenantId,
    });

    try {
      const resolved = await updatePublicBusinessProfile({
        businessName: stringOrNull(payload.businessName),
        websiteUrl: normalizedWebsiteUrl || payload.websiteUrl || null,
        businessType: stringOrNull(payload.businessType),
        primaryGoal: stringOrNull(payload.primaryGoal),
        launchApproverUserId: stringOrNull(payload.launchApproverUserId),
        launchApproverName: stringOrNull(payload.launchApproverName),
        offer: stringOrNull(payload.offer),
        notes: stringOrNull(payload.notes),
        competitorUrl: stringOrNull(payload.competitorUrl),
        channels: payload.channels === undefined ? undefined : stringArray(payload.channels),
      });
      console.info('[business-profile]', {
        event: 'write-complete',
        mode: 'public_file_only',
        normalizedWebsiteUrl: resolved.profile.websiteUrl,
        derivedTenantId: resolved.profile.tenantId,
        brandKitSource: resolved.brandKitSource,
        latestJobId: resolved.latestJobId,
      });
      return json({ profile: resolved.profile });
    } catch (updateError) {
      const message = updateError instanceof Error ? updateError.message : String(updateError);
      return json({ error: message }, errorStatus(message));
    }
  }

  if (tenantContext.role !== 'tenant_admin') {
    return json({ error: 'forbidden' }, 403);
  }

  const client = await pool.connect();
  try {
    console.info('[business-profile]', {
      event: 'write',
      mode: 'authenticated_db_plus_file',
      tenantId: tenantContext.tenantId,
      normalizedWebsiteUrl,
      derivedTenantId: null,
    });
    const resolved = await updateBusinessProfileWithDiagnostics(client, {
      tenantId: tenantContext.tenantId,
      businessName: stringOrNull(payload.businessName),
      websiteUrl: normalizedWebsiteUrl,
      businessType: stringOrNull(payload.businessType),
      primaryGoal: stringOrNull(payload.primaryGoal),
      launchApproverUserId: stringOrNull(payload.launchApproverUserId),
      launchApproverName: stringOrNull(payload.launchApproverName),
      offer: stringOrNull(payload.offer),
      notes: stringOrNull(payload.notes),
      competitorUrl: stringOrNull(payload.competitorUrl),
      channels: payload.channels === undefined ? undefined : stringArray(payload.channels),
    });
    console.info('[business-profile]', {
      event: 'write-complete',
      mode: 'authenticated_db_plus_file',
      tenantId: tenantContext.tenantId,
      normalizedWebsiteUrl: resolved.profile.websiteUrl,
      brandKitSource: resolved.brandKitSource,
      latestJobId: resolved.latestJobId,
    });
    return json({ profile: resolved.profile });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, errorStatus(message));
  } finally {
    client.release();
  }
}
