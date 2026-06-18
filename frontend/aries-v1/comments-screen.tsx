'use client';

import { useMemo, useState } from 'react';

import type { InsightsCommentItem } from '@/lib/api/aries-v1';
import { useInsightsComments, type CommentReplyOutcome } from '@/hooks/use-insights-comments';
import type { Platform } from '@/backend/insights/platforms/registry';
import { PLATFORM_LABELS } from '@/backend/insights/platforms/registry';

import { customerSafeUiErrorMessage } from './customer-safe-copy';
import { EmptyStatePanel, LoadingStateGrid, ShellPanel } from './components';
import { PlatformSelector } from './platform-selector';

function formatDay(value: string): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, 10);
}

type PostGroup = {
  postId: number;
  postTitle: string | null;
  postPermalink: string | null;
  comments: InsightsCommentItem[];
};

function groupByPost(comments: InsightsCommentItem[]): PostGroup[] {
  const order: number[] = [];
  const groups = new Map<number, PostGroup>();
  for (const comment of comments) {
    let group = groups.get(comment.postId);
    if (!group) {
      group = {
        postId: comment.postId,
        postTitle: comment.postTitle,
        postPermalink: comment.postPermalink,
        comments: [],
      };
      groups.set(comment.postId, group);
      order.push(comment.postId);
    }
    group.comments.push(comment);
  }
  return order.map((id) => groups.get(id)!);
}

export default function AriesCommentsScreen({
  enabledPlatforms = ['facebook'],
}: {
  enabledPlatforms?: Platform[];
}) {
  const [platform, setPlatform] = useState<Platform>('facebook');

  // LinkedIn has no Composio list-comments action (#648); skip the fetch and
  // show an honest unavailable panel instead of an error or empty-state.
  const inbox = useInsightsComments({
    autoLoad: platform !== 'linkedin',
    platform,
  });
  const comments = inbox.data?.comments ?? [];
  const groups = useMemo(() => groupByPost(comments), [comments]);

  // Per-comment client state, keyed by comment id.
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [submittingId, setSubmittingId] = useState<number | null>(null);
  const [outcomes, setOutcomes] = useState<Record<number, CommentReplyOutcome>>({});
  const [repliedNow, setRepliedNow] = useState<Record<number, boolean>>({});

  async function handleReply(commentId: number) {
    const text = (drafts[commentId] ?? '').trim();
    if (!text || submittingId !== null) return;
    setSubmittingId(commentId);
    const outcome = await inbox.reply(commentId, text);
    setOutcomes((prev) => ({ ...prev, [commentId]: outcome }));
    if (outcome.kind === 'replied') {
      setRepliedNow((prev) => ({ ...prev, [commentId]: true }));
      setDrafts((prev) => ({ ...prev, [commentId]: '' }));
    }
    setSubmittingId(null);
  }

  const label = PLATFORM_LABELS[platform];

  return (
    <div className="space-y-5">
      <ShellPanel
        eyebrow="Comments"
        title={`${label} comment inbox`}
        action={
          enabledPlatforms.length > 1 ? (
            <PlatformSelector
              platforms={enabledPlatforms}
              value={platform}
              onChange={setPlatform}
            />
          ) : null
        }
      >
        {platform === 'facebook' ? (
          <p className="max-w-3xl text-sm leading-7 text-white/65">
            Comments on your Facebook posts, grouped by the post they belong to. Reply directly from
            Aries when native reply is enabled for your account.
          </p>
        ) : platform === 'linkedin' ? (
          <p className="max-w-3xl text-sm leading-7 text-white/65">
            LinkedIn comment retrieval isn&apos;t supported by the integration used here. Visit
            LinkedIn directly to read and respond to comments.
          </p>
        ) : (
          <p className="max-w-3xl text-sm leading-7 text-white/65">
            Comments on your {label} posts, grouped by the post they belong to. Reply directly from
            Aries when native reply is enabled for your account.
          </p>
        )}
      </ShellPanel>

      {/* LinkedIn short-circuit: no Composio list-comments action for LinkedIn. */}
      {platform === 'linkedin' ? (
        <EmptyStatePanel
          title="Comments aren't available for LinkedIn."
          description="LinkedIn doesn't support listing post comments via the integration used here. Visit LinkedIn directly to read and respond to comments."
        />
      ) : inbox.isLoading ? (
        <LoadingStateGrid />
      ) : inbox.error ? (
        <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
          <p>{customerSafeUiErrorMessage(inbox.error.message, 'Comments are not available right now.')}</p>
          <button
            type="button"
            onClick={() => void inbox.load()}
            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-50 transition hover:bg-red-500/20"
          >
            Try again
          </button>
        </div>
      ) : groups.length === 0 ? (
        <EmptyStatePanel
          title="No comments yet"
          description={
            platform === 'facebook'
              ? 'When people comment on your live Facebook posts, their messages will appear here so you can read and reply.'
              : `When people comment on your live ${label} posts, their messages will appear here so you can read and reply.`
          }
        />
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <ShellPanel
              key={group.postId}
              eyebrow="Post"
              title={group.postTitle?.trim() || `Post #${group.postId}`}
            >
              <div className="space-y-4">
                {group.comments.map((comment) => {
                  const outcome = outcomes[comment.id];
                  const isReplied = comment.isReplied || Boolean(repliedNow[comment.id]);
                  const isSubmitting = submittingId === comment.id;
                  return (
                    <div
                      key={comment.id}
                      className="rounded-[1.25rem] border border-white/8 bg-black/20 px-4 py-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium text-white">
                          {comment.authorHandle?.trim() ||
                            (platform === 'facebook' ? 'Facebook user' : `${label} user`)}
                        </p>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-white/45">{formatDay(comment.receivedAt)}</span>
                          {isReplied ? (
                            <span className="inline-flex items-center rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1 text-xs font-medium text-emerald-100">
                              Replied
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-white/75">{comment.bodyText}</p>

                      {isReplied ? null : outcome?.kind === 'not_enabled' ? (
                        <p className="mt-3 text-xs text-white/45">
                          {platform === 'facebook' ? (
                            <>Native reply isn’t enabled for your account yet. You can still reply from
                            Facebook directly.</>
                          ) : (
                            <>Native reply isn&apos;t enabled for your account yet. You can still reply from{' '}
                            {label} directly.</>
                          )}
                        </p>
                      ) : (
                        <div className="mt-3 space-y-2">
                          <textarea
                            value={drafts[comment.id] ?? ''}
                            onChange={(event) =>
                              setDrafts((prev) => ({ ...prev, [comment.id]: event.target.value }))
                            }
                            placeholder="Write a reply…"
                            rows={2}
                            className="w-full rounded-[0.9rem] border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/28 focus:border-white/20 focus:outline-none"
                          />
                          <div className="flex items-center justify-between gap-3">
                            {outcome?.kind === 'error' ? (
                              <p className="text-xs text-red-200">{outcome.message}</p>
                            ) : (
                              <span />
                            )}
                            <button
                              type="button"
                              onClick={() => void handleReply(comment.id)}
                              disabled={isSubmitting || !(drafts[comment.id] ?? '').trim()}
                              className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-[#11161c] transition enabled:hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {isSubmitting ? 'Sending…' : 'Reply'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </ShellPanel>
          ))}
        </div>
      )}
    </div>
  );
}
