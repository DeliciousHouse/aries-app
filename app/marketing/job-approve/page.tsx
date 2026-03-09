import MarketingJobApproveScreen from '../../../frontend/marketing/job-approve';

export default function MarketingJobApprovePage({
  searchParams
}: {
  searchParams?: { jobId?: string; tenantId?: string };
}) {
  const jobId = searchParams?.jobId || '';
  const tenantId = searchParams?.tenantId || '';
  return <MarketingJobApproveScreen defaultJobId={jobId} defaultTenantId={tenantId} />;
}
