import React from 'react';
import MarketingJobApproveScreen from '@/frontend/marketing/job-approve';

export const metadata = {
  title: 'Weekly Social Content Review · Aries AI',
};

export default async function SocialContentReviewPage({
  searchParams,
}: {
  searchParams?: Promise<{ jobId?: string }>;
}) {
  const resolved = await searchParams;
  const jobId = resolved?.jobId || '';
  return (
    <MarketingJobApproveScreen
      defaultJobId={jobId}
      jobApprovePath="/api/social-content/jobs"
      jobStatusPath="/api/social-content/jobs"
      copyVariant="social-content"
    />
  );
}
