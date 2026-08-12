import type { Pool } from 'pg';

import pool from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { isAutoPublishGateEnabled } from '@/backend/marketing/auto-publish-env';
import {
  getAutoPublishSettingForTenant,
  setAutoPublishEnabledForTenant,
} from '@/backend/marketing/auto-publish-store';

/**
 * GET/PATCH /api/marketing/auto-publish
 *
 * The workspace's auto-publish opt-in. Auto-schedule is unaffected and stays on
 * for every tenant; this toggle decides only whether scheduled-posts-worker may
 * DISPATCH a due row to the provider, or whether it is held for a human to
 * publish. Reads/writes go through the single-writer helpers in
 * backend/marketing/auto-publish-store.ts.
 *
 * PATCH is tenant_admin only — the same role guard
 * app/api/marketing/schedule and app/api/business/profile use. GET is open to
 * every tenant role: an analyst seeing "auto-publish is off, posts wait for an
 * admin" is exactly the context that stops them filing a "nothing published"
 * bug, and the value is not sensitive.
 *
 * Tenant id is resolved ONLY from tenantContext, never from the request body or
 * query string.
 */

type AutoPublishDeps = {
  tenantContextLoader?: TenantContextLoader;
  db?: Pool;
  env?: Partial<Record<string, string | undefined>>;
};

type AutoPublishPatchBody = {
  enabled?: unknown;
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function readPatchBody(req: Request): Promise<AutoPublishPatchBody> {
  try {
    return (await req.json()) as AutoPublishPatchBody;
  } catch {
    return {};
  }
}

/**
 * `enabled` is REQUIRED and must be a real boolean — unlike the cadence PATCH,
 * where every field is optional. A partial-update idiom is wrong for a
 * single-field safety toggle: `{}` would silently mean "leave it alone" while
 * reading as success to whoever called it.
 */
function parseEnabled(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(t)) return true;
    if (['0', 'false', 'no', 'off'].includes(t)) return false;
  }
  return null;
}

export async function handleGetAutoPublish(
  _req: Request,
  deps: AutoPublishDeps = {},
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(deps.tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const { tenantContext } = tenantResult;
  const tenantId = Number(tenantContext.tenantId);

  const db = deps.db ?? pool;
  const setting = await getAutoPublishSettingForTenant(db, tenantId);

  return json(
    {
      autoPublish: {
        enabled: setting.enabled,
        updatedByUserId: setting.updatedByUserId,
        updatedAt: setting.updatedAt,
        // Whether the toggle currently has any effect. With the fleet-wide gate
        // OFF every tenant publishes regardless of `enabled`, and a UI that
        // showed the switch as authoritative would be lying about what happens
        // to the next scheduled post.
        gateActive: isAutoPublishGateEnabled(deps.env),
        canEdit: tenantContext.role === 'tenant_admin',
      },
    },
    200,
  );
}

export async function handlePatchAutoPublish(
  req: Request,
  deps: AutoPublishDeps = {},
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(deps.tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const { tenantContext } = tenantResult;

  if (tenantContext.role !== 'tenant_admin') {
    return json({ error: 'forbidden' }, 403);
  }

  const body = await readPatchBody(req);
  const enabled = parseEnabled(body.enabled);
  if (enabled === null) {
    return json({ error: 'invalid_enabled' }, 400);
  }

  // Tenant id ONLY from tenantContext — never from the body.
  const tenantId = Number(tenantContext.tenantId);
  const userId = Number(tenantContext.userId);

  const db = deps.db ?? pool;
  const setting = await setAutoPublishEnabledForTenant(db, {
    tenantId,
    enabled,
    updatedByUserId: Number.isFinite(userId) ? userId : null,
  });

  return json(
    {
      autoPublish: {
        enabled: setting.enabled,
        updatedByUserId: setting.updatedByUserId,
        updatedAt: setting.updatedAt,
        gateActive: isAutoPublishGateEnabled(deps.env),
        canEdit: true,
      },
    },
    200,
  );
}
