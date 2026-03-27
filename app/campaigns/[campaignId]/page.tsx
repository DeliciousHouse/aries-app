import { redirect } from 'next/navigation';

export default async function CampaignWorkspacePage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;
  redirect(`/dashboard/campaigns/${encodeURIComponent(campaignId)}`);
}
