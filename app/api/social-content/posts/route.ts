import { NextResponse } from 'next/server';

import {
  listDeletedSocialContentJobsForTenant,
  listSocialContentJobsForTenant,
} from '@/backend/marketing/runtime-views';
import { loadTenantBrandKit } from '@/backend/marketing/brand-kit';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

export async function handleGetSocialContentPosts(tenantContextLoader?: TenantContextLoader) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const tenantId = tenantResult.tenantContext.tenantId;
  const [campaignPage, deletedPosts, currentBrandKit] = await Promise.all([
    listSocialContentJobsForTenant(tenantId),
    listDeletedSocialContentJobsForTenant(tenantId),
    loadTenantBrandKit(tenantId),
  ]);
  const currentBrandKitExtractedAt = currentBrandKit?.extracted_at ?? null;
  return NextResponse.json(
    {
      posts: campaignPage.posts,
      hasMore: campaignPage.hasMore,
      deletedPosts,
      currentBrandKitExtractedAt,
    },
    { status: 200 },
  );
}

export async function GET() {
  return handleGetSocialContentPosts();
}
