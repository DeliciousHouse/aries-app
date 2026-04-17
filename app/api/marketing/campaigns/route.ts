import { NextResponse } from 'next/server';

import {
  listDeletedMarketingCampaignsForTenant,
  listMarketingCampaignsForTenant,
} from '@/backend/marketing/runtime-views';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

export async function handleGetMarketingCampaigns(tenantContextLoader?: TenantContextLoader) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const [campaigns, deletedCampaigns] = await Promise.all([
    listMarketingCampaignsForTenant(tenantResult.tenantContext.tenantId),
    listDeletedMarketingCampaignsForTenant(tenantResult.tenantContext.tenantId),
  ]);
  return NextResponse.json({ campaigns, deletedCampaigns }, { status: 200 });
}

export async function GET() {
  return handleGetMarketingCampaigns();
}
