import pool from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';
import { workspaceMismatchResponse } from '@/lib/tenant-context-http';
import {
  getBusinessProfileWithDiagnostics,
  updateBusinessProfileWithDiagnostics,
  INVALID_TIMEZONE_ERROR,
} from '@/backend/tenant/business-profile';
import { normalizeMarketingWebsiteUrl } from '@/lib/marketing-public-mode';
import {
  COMPETITOR_URL_INVALID_ERROR,
  COMPETITOR_URL_SOCIAL_ERROR,
} from '@/lib/marketing-competitor';
import { parseReelAudioMode } from '@/backend/marketing/reel-audio-mode';

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

// Maps a caught error message to a client-safe error code + HTTP status.
// Returns literal codes / imported constants only — never the raw message,
// which CodeQL flags as stack-trace exposure (js/stack-trace-exposure).
function classifyClientError(message: string): { error: string; status: number } {
  if (message === 'missing_required_fields:businessName') {
    return { error: 'missing_required_fields:businessName', status: 400 };
  }
  if (message === 'missing_required_fields:websiteUrl') {
    return { error: 'missing_required_fields:websiteUrl', status: 400 };
  }
  if (message.startsWith('missing_required_fields:')) {
    return { error: 'missing_required_fields', status: 400 };
  }
  if (message === 'invalid_website_url') {
    return { error: 'invalid_website_url', status: 400 };
  }
  if (message === 'invalid_launch_approver') {
    // The submitted launch approver is not a member of this workspace
    // (multi-workspace Phase 4). Frontend-safe: no id echoed back.
    return { error: 'invalid_launch_approver', status: 400 };
  }
  if (message === COMPETITOR_URL_SOCIAL_ERROR) {
    return { error: COMPETITOR_URL_SOCIAL_ERROR, status: 400 };
  }
  if (message === COMPETITOR_URL_INVALID_ERROR) {
    return { error: COMPETITOR_URL_INVALID_ERROR, status: 400 };
  }
  if (message.startsWith(`${INVALID_TIMEZONE_ERROR}:`)) {
    // Drop the dynamic suffix (the user-submitted bad value).
    return { error: INVALID_TIMEZONE_ERROR, status: 400 };
  }
  if (message.startsWith('brand_kit_insufficient_source_data')) {
    return { error: 'brand_kit_insufficient_source_data', status: 422 };
  }
  if (message.startsWith('brand_kit_fetch_failed')) {
    // Raw message carries an inner error after the colon — collapse it.
    return { error: 'brand_kit_fetch_failed', status: 422 };
  }
  if (message.startsWith('brand_kit_')) {
    return { error: 'brand_kit_error', status: 422 };
  }
  return { error: 'An unexpected error occurred', status: 500 };
}

export async function GET(req: Request) {
  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    return json({ error: 'Authentication required.' }, 403);
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
    if (message === 'tenant_not_found') {
      return json({ error: 'tenant_not_found' }, 404);
    }
    console.error('[business-profile]', {
      event: 'read-failed',
      tenantId: tenantContext.tenantId,
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return json({ error: 'An unexpected error occurred' }, 500);
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
    brandVoice?: string | null;
    styleVibe?: string | null;
    notes?: string | null;
    competitorUrl?: string | null;
    channels?: string[] | null;
    timezone?: string | null;
    reelAudioMode?: string | null;
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
    const mismatch = workspaceMismatchResponse(error);
    if (mismatch) return mismatch;
    return json({ error: 'Authentication required.' }, 403);
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
      brandVoice: payload.brandVoice === undefined ? undefined : stringOrNull(payload.brandVoice),
      styleVibe: stringOrNull(payload.styleVibe),
      notes: payload.notes === undefined ? undefined : stringOrNull(payload.notes),
      competitorUrl: stringOrNull(payload.competitorUrl),
      channels: payload.channels === undefined ? undefined : stringArray(payload.channels),
      timezone: payload.timezone === undefined ? undefined : stringOrNull(payload.timezone),
      // undefined = no change; a recognized value sets the default; an
      // unrecognized value resolves to null in the merge (keeps current).
      reelAudioMode:
        payload.reelAudioMode === undefined
          ? undefined
          : parseReelAudioMode(payload.reelAudioMode),
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
    console.error('[business-profile]', {
      event: 'write-failed',
      mode: 'authenticated_db_plus_file',
      tenantId: tenantContext.tenantId,
      normalizedWebsiteUrl,
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    const { error: clientError, status } = classifyClientError(message);
    return json({ error: clientError }, status);
  } finally {
    client.release();
  }
}
