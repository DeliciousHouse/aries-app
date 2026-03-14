import React from 'react';
import MarketingJobApproveScreen from '../../../frontend/marketing/job-approve';

export default async function MarketingJobApprovePage({
  searchParams
}: {
  searchParams?: Promise<{ jobId?: string; tenantId?: string }>;
}) {
  const resolved = await searchParams;
  const jobId = resolved?.jobId || '';
  const tenantId = resolved?.tenantId || '';
  return <MarketingJobApproveScreen defaultJobId={jobId} defaultTenantId={tenantId} />;
}
