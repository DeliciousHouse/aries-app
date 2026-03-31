import { NextResponse } from 'next/server';

import { listMarketingCampaignsForTenant, listPublicMarketingCampaigns } from '@/backend/marketing/runtime-views';
import { isMarketingPublicMode } from '@/lib/marketing-public-mode';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

export async function handleGetMarketingCampaigns(tenantContextLoader?: TenantContextLoader) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    if (isMarketingPublicMode()) {
      return NextResponse.json({ campaigns: await listPublicMarketingCampaigns() }, { status: 200 });
    }
    return tenantResult.response;
  }

  const campaigns = await listMarketingCampaignsForTenant(tenantResult.tenantContext.tenantId);
  return NextResponse.json({ campaigns }, { status: 200 });
}

export async function GET() {
  return handleGetMarketingCampaigns();
}
