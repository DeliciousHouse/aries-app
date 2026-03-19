import React from 'react';
import MarketingJobApproveScreen from '../../../frontend/marketing/job-approve';

export default async function MarketingJobApprovePage({
  searchParams
}: {
  searchParams?: Promise<{ jobId?: string }>;
}) {
  const resolved = await searchParams;
  const jobId = resolved?.jobId || '';
  return <MarketingJobApproveScreen defaultJobId={jobId} />;
}
