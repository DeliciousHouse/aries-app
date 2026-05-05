import { redirect } from 'next/navigation';

export const metadata = {
  title: 'Campaign Approval · Aries AI',
};

export default async function MarketingJobApprovePage({
  searchParams,
}: {
  searchParams?: Promise<{ jobId?: string }>;
}) {
  const resolved = await searchParams;
  const jobId = resolved?.jobId || '';
  const query = jobId ? "?jobId=" + encodeURIComponent(jobId) : '';
  redirect("/social-content/review" + query);
}
