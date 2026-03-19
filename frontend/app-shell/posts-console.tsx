'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Repeat2, Send, Sparkles } from 'lucide-react';

import { usePublishDispatch } from '@/hooks/use-publish-dispatch';
import { usePublishRetry } from '@/hooks/use-publish-retry';

export default function PostsConsole(): JSX.Element {
  const publishDispatch = usePublishDispatch();
  const publishRetry = usePublishRetry();

  const [provider, setProvider] = useState('facebook');
  const [content, setContent] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [retryAttempts, setRetryAttempts] = useState('3');

  async function handleDispatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await publishDispatch.dispatch({
      provider,
      content: content.trim(),
      scheduled_for: scheduledFor.trim() || undefined,
    });
  }

  async function handleRetry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await publishRetry.retry({
      max_attempts: Number(retryAttempts) || 3,
    });
  }

  return (
    <div className="grid xl:grid-cols-2 gap-6">
      <div className="glass rounded-[2.5rem] p-8">
        <form onSubmit={handleDispatch} className="space-y-6">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <Send className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/35">Aries publish flow</p>
                <h2 className="text-2xl font-bold">Send a publish request through Aries</h2>
              </div>
            </div>
            <p className="text-white/60 leading-relaxed">
              This route stays browser-safe by posting only to Aries internal APIs. Gateway and Lobster details remain server-side.
            </p>
          </div>

          <label className="block space-y-2">
            <span className="text-xs uppercase tracking-[0.22em] text-white/35">Provider</span>
            <select
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white focus:outline-none focus:border-primary/50"
            >
              {['facebook', 'instagram', 'linkedin', 'x', 'youtube', 'reddit', 'tiktok'].map((value) => (
                <option key={value} value={value} className="bg-black text-white">
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-2">
            <span className="text-xs uppercase tracking-[0.22em] text-white/35">Content</span>
            <input
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="Ship a platform-safe post from Aries."
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
            />
          </label>

          <label className="block space-y-2">
            <span className="text-xs uppercase tracking-[0.22em] text-white/35">Schedule (optional)</span>
            <input
              value={scheduledFor}
              onChange={(event) => setScheduledFor(event.target.value)}
              placeholder="2026-03-21T16:00:00Z"
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
            />
          </label>

          <button
            type="submit"
            disabled={publishDispatch.isLoading || !content.trim()}
            className="w-full px-6 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20 disabled:opacity-60"
          >
            {publishDispatch.isLoading ? 'Dispatching…' : 'Dispatch publish event'}
          </button>

          {publishDispatch.error ? (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100">
              {publishDispatch.error.message}
            </div>
          ) : null}
          {publishDispatch.data ? (
            <div className="rounded-[1.5rem] border border-white/10 bg-black/30 p-5 overflow-x-auto font-mono text-sm text-white/75">
              {JSON.stringify(publishDispatch.data, null, 2)}
            </div>
          ) : null}
        </form>
      </div>

      <div className="glass rounded-[2.5rem] p-8">
        <form onSubmit={handleRetry} className="space-y-6">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-2xl bg-secondary/10 border border-secondary/20 flex items-center justify-center">
                <Repeat2 className="w-6 h-6 text-secondary" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/35">Aries repair loop</p>
                <h2 className="text-2xl font-bold">Request publish retry handling</h2>
              </div>
            </div>
            <p className="text-white/60 leading-relaxed">
              Use bounded retry attempts through the internal route rather than exposing any workflow runner details to the browser.
            </p>
          </div>

          <label className="block space-y-2">
            <span className="text-xs uppercase tracking-[0.22em] text-white/35">Max attempts</span>
            <input
              value={retryAttempts}
              onChange={(event) => setRetryAttempts(event.target.value)}
              inputMode="numeric"
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
            />
          </label>

          <button
            type="submit"
            disabled={publishRetry.isLoading}
            className="w-full px-6 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all disabled:opacity-60"
          >
            {publishRetry.isLoading ? 'Submitting…' : 'Request publish retry'}
          </button>

          {publishRetry.error ? (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100">
              {publishRetry.error.message}
            </div>
          ) : null}
          {publishRetry.data ? (
            <div className="rounded-[1.5rem] border border-white/10 bg-black/30 p-5 overflow-x-auto font-mono text-sm text-white/75">
              {JSON.stringify(publishRetry.data, null, 2)}
            </div>
          ) : null}
        </form>

        <div className="mt-6 rounded-[1.5rem] border border-white/10 bg-white/5 p-5">
          <div className="flex items-center gap-3 mb-3">
            <Sparkles className="w-5 h-5 text-primary" />
            <h3 className="font-semibold">Next control surface</h3>
          </div>
          <p className="text-white/60 mb-4">
            Schedule windows and sync actions live in the donor-styled calendar route.
          </p>
          <Link href="/calendar" className="inline-flex items-center gap-2 text-primary hover:text-primary/80 transition-colors">
            Open calendar sync <Sparkles className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}
