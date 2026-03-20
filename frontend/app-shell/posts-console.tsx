'use client';

import { useState, type FormEvent } from 'react';
import { Repeat2, Send, Sparkles } from 'lucide-react';

import { usePublishDispatch } from '@/hooks/use-publish-dispatch';
import { usePublishRetry } from '@/hooks/use-publish-retry';

export default function PostsConsole(): JSX.Element {
  return (
    <div className="grid xl:grid-cols-2 gap-6">
      <div className="glass rounded-[2.5rem] p-8">
        <div className="space-y-6">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <Sparkles className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/35">Campaign publishing</p>
                <h2 className="text-2xl font-bold">Publishing now lives inside the marketing job flow</h2>
              </div>
            </div>
            <p className="text-white/60 leading-relaxed">
              Aries no longer treats standalone publish dispatch and retry controls as the canonical workflow. Real publishing happens after research, strategy, production, and explicit approvals inside a marketing job.
            </p>
          </div>

          <div className="space-y-3">
            {[
              'Create a marketing job from the campaign launcher.',
              'Review real stage outputs from the job status workspace.',
              'Approve the publish checkpoint with platform-specific publish/render selections.',
            ].map((item) => (
              <div key={item} className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 text-white/75 flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 text-primary" />
                <span>{item}</span>
              </div>
            ))}
          </div>

          <div className="flex flex-col sm:flex-row gap-4">
            <Link href="/marketing/new-job" className="px-6 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20 text-center">
              Launch a campaign
            </Link>
            <Link href="/marketing/job-status" className="px-6 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all text-center">
              Open job status
            </Link>
          </div>
        </div>
      </div>

      <div className="glass rounded-[2.5rem] p-8">
        <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 h-full">
          <div className="flex items-center gap-3 mb-3">
            <Sparkles className="w-5 h-5 text-primary" />
            <h3 className="font-semibold">Operator guidance</h3>
          </div>
          <p className="text-white/60 mb-4">
            Calendar sync remains available from the calendar route, but campaign publishing itself should be driven from the marketing job status and approval surfaces.
          </p>
          <a href="/calendar" className="inline-flex items-center gap-2 text-primary hover:text-primary/80 transition-colors">
            Open calendar sync <Sparkles className="w-4 h-4" />
          </a>
        </div>
      </div>
    </div>
  );
}
