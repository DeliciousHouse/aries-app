import { redirect } from 'next/navigation';

export const metadata = {
  title: 'Campaign Status · Aries AI',
};

export default async function MarketingJobStatusPage({
  searchParams,
}: {
  searchParams?: Promise<{ jobId?: string }>;
}) {
  const resolved = await searchParams;
  const jobId = resolved?.jobId || '';
  const query = jobId ? `?jobId=${encodeURIComponent(jobId)}` : '';
  redirect(`/social-content/status${query}`);
}
