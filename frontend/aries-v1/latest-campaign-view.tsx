'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { useRuntimeCampaigns } from '@/hooks/use-runtime-campaigns';

import { EmptyStatePanel } from './components';

export default function AriesLatestCampaignView(props: {
  view: 'brand' | 'strategy' | 'creative' | 'publish';
  title: string;
  description: string;
}) {
  const router = useRouter();
  const campaigns = useRuntimeCampaigns({ autoLoad: true });
  const latestCampaign = campaigns.data?.campaigns?.[0] ?? null;

  useEffect(() => {
    if (!latestCampaign) {
      return;
    }
    router.replace(`/dashboard/campaigns/${encodeURIComponent(latestCampaign.id)}?view=${props.view}`);
  }, [latestCampaign, props.view, router]);

  if (campaigns.isLoading) {
    return <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-8 text-white/60">Loading campaign workspace...</div>;
  }

  if (campaigns.error) {
    return <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">{campaigns.error.message}</div>;
  }

  if (!latestCampaign) {
    return (
      <EmptyStatePanel
        title={props.title}
        description={props.description}
        action={
          <Link
            href="/dashboard/campaigns/new"
            className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold !text-[#11161c] transition-colors hover:!text-[#11161c]"
          >
            New Campaign
          </Link>
        }
      />
    );
  }

  return <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-8 text-white/60">Opening the latest campaign...</div>;
}
