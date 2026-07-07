/**
 * backend/insights/conversations/conversations-builder.ts
 *
 * Fetches the raw data for the Conversations section of the Insights dashboard.
 *
 * Returns:
 *   - Up to 6 recent comments (unhandled first, then newest) for the feed
 *   - Aggregate meta: total, needsReply, positivePercent
 *   - Lead-quality breakdown by classification tag
 *
 * Queries run sequentially (DB_POOL_MAX guardrail — no Promise.all on DB calls).
 * Comments are real-time data so this builder is never cached.
 */

import pool from '@/lib/db';
import type { NarrativePeriod } from '../narrative/snapshot-builder';

// ── Public shapes ─────────────────────────────────────────────────────────────

export interface ConversationItem {
  id:          number;
  author:      string;
  avatar:      string;
  text:        string;
  postRef:     string;
  platform:    string;
  receivedAt:  string;   // ISO string
  timeAgo:     string;   // "2h ago", "1d ago", etc.
  tag:         string | null;
  tagLabel:    string | null;
  handled:     boolean;
}

export interface LeadQualityItem {
  tag:   string;
  label: string;
  note:  string;
  count: number;
  tone:  string;
}

export interface ConversationsMeta {
  total:           number;
  positivePercent: number;
  needsReply:      number;
  viewAllLabel:    string;
}

export interface ConversationsSnapshot {
  meta:          ConversationsMeta;
  conversations: ConversationItem[];
  leadQuality:   LeadQualityItem[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function periodDays(period: NarrativePeriod): number {
  if (period === 'week')  return 7;
  if (period === '30day') return 30;
  return 90;
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

/** Derive a 2-character avatar from an @handle or plain username. */
function avatarInitials(handle: string | null): string {
  if (!handle) return '??';
  const clean = handle.replace(/^@/, '');
  // Split on underscore / dot / hyphen
  const parts = clean.split(/[._\-]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  // CamelCase split
  const camel = clean.match(/[A-Z][a-z]+|[a-z]+/g);
  if (camel && camel.length >= 2) return (camel[0][0] + camel[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

/** Human-readable relative time. Uses a fixed reference so tests can rely on it. */
function timeAgo(date: Date, now: Date): string {
  const diffMs  = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin <  1)  return 'just now';
  if (diffMin < 60)  return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr  < 24)  return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay <  7)  return `${diffDay}d ago`;
  const diffWk  = Math.floor(diffDay / 7);
  return `${diffWk}w ago`;
}

/**
 * Maps classification columns to a design tag.
 * Priority: lead > question > positive.
 * Returns null when no classification exists or category is spam/complaint/other.
 */
function deriveTag(
  isLead:    boolean | null,
  category:  string  | null,
  sentiment: string  | null,
): { tag: string; tagLabel: string } | null {
  if (isLead)                                                      return { tag: 'lead',     tagLabel: 'Likely lead'       };
  if (category === 'question')                                     return { tag: 'question', tagLabel: 'Product question'  };
  if (sentiment === 'positive' || category === 'compliment')       return { tag: 'positive', tagLabel: 'Positive'          };
  return null;
}

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildConversationsSnapshot(
  tenantId: number,
  period:   NarrativePeriod,
  platform: string,
): Promise<ConversationsSnapshot> {
  const fromDate       = daysAgo(periodDays(period));
  const platformFilter = platform === 'all' ? null : platform;
  const now            = new Date();

  const client = await pool.connect();
  try {

    // ── Aggregate: totals for meta + lead-quality counts ─────────────────────
    const aggRes = await client.query<{
      total:              string;
      needs_reply:        string;
      positive_count:     string;
      lead_count:         string;
      question_count:     string;
    }>(
      `SELECT
         COUNT(*)                                                                       AS total,
         COUNT(*) FILTER (WHERE c.is_replied = false)                                  AS needs_reply,
         COUNT(*) FILTER (
           WHERE cl.sentiment = 'positive' OR cl.category = 'compliment'
         )                                                                              AS positive_count,
         COUNT(*) FILTER (WHERE cl.is_lead = true)                                     AS lead_count,
         COUNT(*) FILTER (
           WHERE cl.category = 'question'
             AND (cl.is_lead IS NULL OR cl.is_lead = false)
         )                                                                              AS question_count
       FROM insights_comments c
       LEFT JOIN insights_comment_classifications cl ON cl.comment_id = c.id
       WHERE c.tenant_id   = $1
         AND c.received_at >= $2
         AND ($3::text IS NULL OR c.platform = $3)`,
      [tenantId, fromDate, platformFilter],
    );

    const total         = Number(aggRes.rows[0].total);
    const needsReply    = Number(aggRes.rows[0].needs_reply);
    const positiveCount = Number(aggRes.rows[0].positive_count);
    const leadCount     = Number(aggRes.rows[0].lead_count);
    const questionCount = Number(aggRes.rows[0].question_count);

    // ── Feed: up to 6 comments, unhandled first then newest ──────────────────
    const feedRes = await client.query<{
      id:            number;
      author_handle: string | null;
      body_text:     string;
      platform:      string;
      received_at:   Date;
      is_replied:    boolean;
      post_title:    string | null;
      is_lead:       boolean | null;
      category:      string | null;
      sentiment:     string | null;
    }>(
      `SELECT
         c.id,
         c.author_handle,
         c.body_text,
         c.platform,
         c.received_at,
         c.is_replied,
         p.title                                    AS post_title,
         cl.is_lead,
         cl.category,
         cl.sentiment
       FROM insights_comments c
       LEFT JOIN insights_posts p
              ON p.id = c.post_id AND p.tenant_id = c.tenant_id
       LEFT JOIN insights_comment_classifications cl ON cl.comment_id = c.id
       WHERE c.tenant_id   = $1
         AND c.received_at >= $2
         AND ($3::text IS NULL OR c.platform = $3)
       ORDER BY c.is_replied ASC, c.received_at DESC
       LIMIT 6`,
      [tenantId, fromDate, platformFilter],
    );

    const conversations: ConversationItem[] = feedRes.rows.map((row) => {
      const tagResult = deriveTag(row.is_lead, row.category, row.sentiment);
      // Facebook's Graph API withholds the commenter identity (`from`) on public
      // Page comments unless advanced permissions are held, so author_handle is
      // often null. Show a platform-appropriate label instead of "@unknown".
      const rawHandle  = row.author_handle?.trim() || null;
      const platformName = row.platform.charAt(0).toUpperCase() + row.platform.slice(1);
      const author     = rawHandle
        ? (rawHandle.startsWith('@') ? rawHandle : `@${rawHandle}`)
        : `${platformName} user`;
      return {
        id:         row.id,
        author,
        avatar:     avatarInitials(rawHandle || row.platform),
        text:       row.body_text,
        postRef:    row.post_title || 'a post',
        platform:   row.platform,
        receivedAt: row.received_at.toISOString(),
        timeAgo:    timeAgo(row.received_at, now),
        tag:        tagResult?.tag      ?? null,
        tagLabel:   tagResult?.tagLabel ?? null,
        handled:    row.is_replied,
      };
    });

    // ── Meta ──────────────────────────────────────────────────────────────────
    const positivePercent = total > 0 ? Math.round((positiveCount / total) * 100) : 0;
    const viewAllLabel    = needsReply > 0
      ? `View all ${needsReply} replies needed`
      : `View all conversations`;

    const meta: ConversationsMeta = {
      total,
      positivePercent,
      needsReply,
      viewAllLabel,
    };

    // ── Lead quality breakdown ────────────────────────────────────────────────
    const leadQuality: LeadQualityItem[] = [
      { tag: 'lead',     label: 'Likely leads',      note: 'asking about your services', count: leadCount,     tone: 'lead'     },
      { tag: 'question', label: 'Product questions',  note: 'where-to-buy / details',     count: questionCount, tone: 'question' },
      { tag: 'positive', label: 'Positive reactions', note: 'compliments and emoji',       count: positiveCount, tone: 'positive' },
    ].filter((x) => x.count > 0);

    return { meta, conversations, leadQuality };

  } finally {
    client.release();
  }
}
