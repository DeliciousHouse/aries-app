import { NextResponse } from 'next/server';

import { oauthRefresh } from '@/backend/integrations/refresh';
import { getTenantContext } from '@/lib/tenant-context';

// PRD §20 invariant 4: tenant IDs are derived server-side; clients and
// callbacks do not decide tenant access. Prior to this gate the route
// trusted `body.tenant_id` and would trigger an OAuth token refresh for
// any tenant id any caller supplied. The session-derived tenantId now
// overrides whatever the body claims; the body-level `tenant_id` field
// is dropped.

type RefreshBody = {
  token_expires_in_seconds?: number;
  refresh_expires_in_seconds?: number;
};

export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;

  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 403 });
  }

  let body: RefreshBody = {};
  try {
    body = (await req.json()) as RefreshBody;
  } catch {
    // empty body is allowed; only the override fields are read
  }

  const result = await oauthRefresh(provider, tenantContext.tenantId, {
    token_expires_in_seconds: body.token_expires_in_seconds,
    refresh_expires_in_seconds: body.refresh_expires_in_seconds,
  });
  const status = result.broker_status === 'ok' ? 200 : 400;
  return new Response(JSON.stringify(result), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
