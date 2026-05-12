import { permanentRedirect } from 'next/navigation';

export const metadata = {
  title: 'Weekly Social Content Status · Aries AI',
};

// QA ISSUE-008 (2026-05-12): 308 so caches/crawlers update the canonical URL.
export default async function MarketingJobStatusPage({
  searchParams,
}: {
  searchParams?: Promise<{ jobId?: string }>;
}) {
  const resolved = await searchParams;
  const jobId = resolved?.jobId || '';
  const query = jobId ? `?jobId=${encodeURIComponent(jobId)}` : '';
  permanentRedirect(`/social-content/status${query}`);
}
