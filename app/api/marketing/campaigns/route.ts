import { NextResponse } from 'next/server';

import {
  listDeletedMarketingCampaignsForTenant,
  listMarketingCampaignsForTenant,
} from '@/backend/marketing/runtime-views';
import { loadTenantBrandKit } from '@/backend/marketing/brand-kit';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

export async function handleGetMarketingCampaigns(tenantContextLoader?: TenantContextLoader) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const tenantId = tenantResult.tenantContext.tenantId;
  const [campaignPage, deletedCampaigns, currentBrandKit] = await Promise.all([
    listMarketingCampaignsForTenant(tenantId),
    listDeletedMarketingCampaignsForTenant(tenantId),
    loadTenantBrandKit(tenantId),
  ]);
  const currentBrandKitExtractedAt = currentBrandKit?.extracted_at ?? null;
  return NextResponse.json(
    {
      campaigns: campaignPage.campaigns,
      hasMore: campaignPage.hasMore,
      deletedCampaigns,
      currentBrandKitExtractedAt,
    },
    { status: 200 },
  );
}

export async function GET() {
  return handleGetMarketingCampaigns();
}
