import React from "react";
import MarketingJobStatusScreen from "@/frontend/marketing/job-status";

export const metadata = {
  title: "Weekly Social Content Status · Aries AI",
};

export default async function SocialContentStatusPage({
  searchParams,
}: {
  searchParams?: Promise<{ jobId?: string }>;
}) {
  const resolved = await searchParams;
  const jobId = resolved?.jobId || "";
  return (
    <MarketingJobStatusScreen
      defaultJobId={jobId}
      jobStatusPath="/api/social-content/jobs"
      copyVariant="social-content"
    />
  );
}
