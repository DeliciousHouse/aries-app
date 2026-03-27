import { NextResponse } from 'next/server';

import { listMarketingPostsForTenant } from '@/backend/marketing/runtime-views';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

export async function handleGetMarketingPosts(tenantContextLoader?: TenantContextLoader) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const content = await listMarketingPostsForTenant(tenantResult.tenantContext.tenantId);
  return NextResponse.json(content, { status: 200 });
}

export async function GET() {
  return handleGetMarketingPosts();
}
