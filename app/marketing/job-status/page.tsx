import React from 'react';
import MarketingJobStatusScreen from '../../../frontend/marketing/job-status';

export const metadata = {
  title: 'Campaign Status · Aries AI',
};

export default async function MarketingJobStatusPage({
  searchParams
}: {
  searchParams?: Promise<{ jobId?: string }>;
}) {
  const resolved = await searchParams;
  const jobId = resolved?.jobId || '';
  return <MarketingJobStatusScreen defaultJobId={jobId} />;
}
