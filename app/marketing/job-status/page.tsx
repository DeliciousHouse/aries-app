import MarketingJobStatusScreen from '../../../frontend/marketing/job-status';

export default function MarketingJobStatusPage({
  searchParams
}: {
  searchParams?: { jobId?: string };
}) {
  const jobId = searchParams?.jobId || '';
  return <MarketingJobStatusScreen defaultJobId={jobId} />;
}
