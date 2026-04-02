'use client';

import Link from 'next/link';

import { CheckCircle, Clock3, Sparkles } from 'lucide-react';

import { useLatestMarketingJob } from '@/hooks/use-latest-marketing-job';

export default function PostsConsole(): JSX.Element {
  const latestJob = useLatestMarketingJob({ autoLoad: true });
  const campaign = latestJob.data;
  const events = campaign?.calendarEvents ?? [];
  const previewFallback = campaign?.assetPreviewCards ?? [];

  let postQueueBody: JSX.Element;
  if (latestJob.isLoading) {
    postQueueBody = <div className="text-white/60">Loading post queue…</div>;
  } else if (events.length === 0 && previewFallback.length === 0) {
    postQueueBody = (
      <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-6 text-white/60">
        No scheduled post events are available yet for this campaign.
      </div>
    );
  } else if (events.length === 0) {
    postQueueBody = (
      <div className="grid md:grid-cols-2 gap-4">
        {previewFallback.map((preview) => (
          <Link
            key={preview.id}
            href={preview.previewHref}
            className="rounded-[1.5rem] border border-white/10 bg-white/5 overflow-hidden hover:bg-white/10 transition-colors"
          >
            <div className="h-44 flex items-center justify-center bg-black/20 text-white/45">
              {preview.platformName}
            </div>
            <div className="p-4">
              <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-2">{preview.channelType}</p>
              <h3 className="font-semibold mb-1">{preview.title}</h3>
              <p className="text-sm text-white/60">{preview.summary}</p>
            </div>
          </Link>
        ))}
      </div>
    );
  } else {
    const assetPreviewCards = campaign?.assetPreviewCards ?? [];
    postQueueBody = (
      <div className="space-y-4">
        {events.map((event) => {
          const matchingPreview = assetPreviewCards.find((preview) => preview.id === event.assetPreviewId);
          return (
            <div key={event.id} className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 grid md:grid-cols-[1fr_auto] gap-4">
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <CheckCircle className="w-5 h-5 text-primary" />
                  <div>
                    <h3 className="font-semibold">{event.title}</h3>
                    <p className="text-sm text-white/50">{event.platform} · {event.status}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm text-white/60">
                  <Clock3 className="w-4 h-4" />
                  <span>{new Date(event.startsAt).toLocaleString()}</span>
                </div>
                {matchingPreview ? (
                  <Link href={matchingPreview.previewHref} className="inline-flex items-center gap-2 text-primary hover:text-primary/80 transition-colors">
                    Open linked preview <Sparkles className="w-4 h-4" />
                  </Link>
                ) : null}
              </div>
              <div className="text-sm text-white/60 rounded-[1.25rem] border border-white/10 bg-black/20 px-4 py-3 h-fit">
                Asset preview: {event.assetPreviewId || 'none'}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="glass rounded-[2.5rem] p-8">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-white/35 mb-3">Post queue</p>
            <h2 className="text-3xl font-bold mb-3">Planned and created content</h2>
            <p className="text-white/60 leading-relaxed max-w-2xl">
              Review every scheduled post in the current campaign, along with live status and direct links back to the exact preview bundle.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/70">
              Planned: <strong className="text-white">{campaign?.plannedPostCount ?? 0}</strong>
            </div>
            <div className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/70">
              Created: <strong className="text-white">{campaign?.createdPostCount ?? 0}</strong>
            </div>
          </div>
        </div>
      </div>

      {!campaign ? (
        <div className="glass rounded-[2.5rem] p-8 text-white/60">
          No campaign is available for this tenant yet. Launch a campaign to populate the queue.
        </div>
      ) : (
        <div className="grid xl:grid-cols-[1.15fr_0.85fr] gap-6">
          <div className="glass rounded-[2.5rem] p-8">
            {postQueueBody}
          </div>
          <div className="glass rounded-[2.5rem] p-8">
            <div className="space-y-4">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/35 mb-3">Campaign actions</p>
                <h3 className="text-2xl font-bold">Continue in the live workspace</h3>
              </div>
              <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 text-white/70">
                <p className="mb-3">This queue is sourced from the latest campaign runtime, not static guidance content.</p>
                <div className="flex flex-col gap-3">
                  <Link href={`/marketing/job-status?jobId=${encodeURIComponent(campaign.jobId)}`} className="px-5 py-3 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold text-center">
                    Open job status
                  </Link>
                  {campaign.approval?.actionHref ? (
                    <Link href={campaign.approval.actionHref} className="px-5 py-3 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all text-center">
                      Open approval
                    </Link>
                  ) : null}
                  <Link href="/dashboard/calendar" className="px-5 py-3 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all text-center">
                    Open campaign calendar
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
