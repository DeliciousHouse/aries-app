import { NextResponse } from 'next/server';

import { listMarketingCampaignsForTenant } from '@/backend/marketing/runtime-views';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

export async function handleGetMarketingCampaigns(tenantContextLoader?: TenantContextLoader) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const campaigns = await listMarketingCampaignsForTenant(tenantResult.tenantContext.tenantId);
  return NextResponse.json({ campaigns }, { status: 200 });
}

export async function GET() {
  return handleGetMarketingCampaigns();
}
