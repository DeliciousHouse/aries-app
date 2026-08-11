/**
 * Weekly cross-post fan-out — the PRODUCER side.
 *
 * CONTRACT — why this exists:
 * A weekly-content run synthesizes one `posts` row per (content_package entry x
 * facebook/instagram) feed image. The publish back-half already supports x,
 * linkedin and reddit as Composio-only publish targets (see
 * `composio-publisher-provider.ts` + the scheduled-dispatch admit gate), but
 * nothing ever CREATES those `posts` rows — so a tenant that has connected X /
 * LinkedIn / Reddit still only ever publishes to Meta.
 *
 * This module closes that gap on the synthesis side: for each feed image post
 * built for FB/IG, and for each of `['x','linkedin','reddit']` where (a) the
 * platform's rollout flag is ON and (b) the tenant has an active connected
 * account, an ADDITIONAL `posts` row is synthesized with a platform-adapted
 * caption and the SAME image/asset linkage. Feed surface ONLY — a story/reel is
 * never fanned out (those surfaces are Meta-specific here).
 *
 * Safety: the whole fan-out is gated by `ARIES_WEEKLY_CROSSPOST_ENABLED`
 * (default OFF) and must NEVER break FB/IG synthesis — a crosspost-eligibility
 * lookup failure fails open to `[]`, and the synthesis call-site wraps the
 * fan-out so any error degrades to no-crosspost.
 *
 * Flag-truthiness follows the repo's canonical 4-token idiom
 * (`1` | `true` | `yes` | `on`); see CLAUDE.md "Optional safety flags".
 */

import pool from '@/lib/db';
import {
  CROSSPOST_PLATFORMS,
  eligibleCrosspostPlatforms,
  isCrosspostPlatformConfigured,
  isCrosspostPlatformFlagEnabled,
  type CrosspostPlatform,
} from '../integrations/providers/integration-config';

// The platform list and its flag/config predicates live in integration-config —
// the ONE place that answers "which platforms can we publish to right now"
// (AA-217). Re-exported here so this module's long-standing import surface is
// unchanged for its consumers and tests.
export {
  CROSSPOST_PLATFORMS,
  eligibleCrosspostPlatforms,
  isCrosspostPlatformConfigured,
  isCrosspostPlatformFlagEnabled,
  type CrosspostPlatform,
};

/** Minimal query surface — injectable so tests run with no live database. */
export interface CrosspostQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

type Env = Partial<Record<string, string | undefined>>;

/**
 * Master rollout gate for the weekly cross-post fan-out. Treat 1/true/yes/on as
 * enabled, matching the ARIES_SYNTHESIZE_ON_PUBLISH_SKIP_ENABLED convention.
 *
 * An UNSET env still reads as OFF here (fail-safe for any process that does not
 * go through compose), and when off the synthesis output is byte-identical to
 * today (FB/IG only). Note the deployed default differs: docker-compose.yml now
 * supplies `ARIES_WEEKLY_CROSSPOST_ENABLED=1`, because the fan-out is inert
 * unless a per-platform ARIES_<P>_ENABLED flag is ALSO on and the tenant has
 * connected that account — so the real distribution decision lives in the
 * per-platform flags (all default false), not in this master switch.
 */
export function isWeeklyCrosspostEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_WEEKLY_CROSSPOST_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// Single query: the crosspost platforms whose per-platform flag is ON AND that
// have an active connected account for this tenant. Every row returns its
// Composio credential pointer; LinkedIn also returns its author URN. The
// publisher refuses before dispatch when either required id is absent. No
// Promise.all fan-out (guardrail #1) — one round-trip returns every eligible
// platform.
const SELECT_CONNECTED_CROSSPOST_PLATFORMS_SQL = `
  SELECT platform, connected_account_id, external_account_id
    FROM connected_accounts
   WHERE tenant_id = $1
     AND status = 'connected'
     AND platform = ANY($2)
`;

/**
 * Resolve the subset of CROSSPOST_PLATFORMS a weekly feed image should be fanned
 * out to for this tenant: the platform's rollout flag is ON, the platform's
 * required config is present (`isCrosspostPlatformConfigured` — reddit needs a
 * target subreddit), AND the tenant has an active (`status='connected'`)
 * `connected_accounts` row for it.
 *
 * Fail-open to `[]` on ANY DB error — a crosspost-eligibility failure must never
 * break FB/IG synthesis. The query is scoped to the surviving platforms so a
 * connected-but-flag-OFF (or unconfigured) platform is never returned.
 */
export async function resolveCrosspostPlatforms(
  tenantId: number,
  db: CrosspostQueryable = pool,
  env: Env = process.env,
): Promise<CrosspostPlatform[]> {
  const flagEnabled = eligibleCrosspostPlatforms(env as NodeJS.ProcessEnv);
  // Breadcrumb for the "I turned the flag on and nothing happened" case: a
  // platform whose rollout flag is ON but whose required config is missing is
  // dropped silently otherwise. Missing config is the reddit target subreddit,
  // X's media-upload slug, or a COMPOSIO_<P>_PUBLISH_POST_ACTION slug — all
  // would make every synthesized row fail terminally at dispatch (AA-217).
  for (const platform of CROSSPOST_PLATFORMS) {
    if (
      isCrosspostPlatformFlagEnabled(platform, env as NodeJS.ProcessEnv) &&
      !isCrosspostPlatformConfigured(platform, env as NodeJS.ProcessEnv)
    ) {
      console.info(
        `[weekly-crosspost] ${platform} skipped — missing publish config ` +
          `(COMPOSIO_${platform.toUpperCase()}_PUBLISH_POST_ACTION` +
          `${platform === 'x' ? ' / COMPOSIO_X_UPLOAD_MEDIA_ACTION' : ''}` +
          `${platform === 'reddit' ? ' / COMPOSIO_REDDIT_TARGET_SUBREDDIT' : ''})`,
        { tenantId },
      );
    }
  }
  if (flagEnabled.length === 0) return [];
  try {
    const result = await db.query(SELECT_CONNECTED_CROSSPOST_PLATFORMS_SQL, [tenantId, flagEnabled]);
    const rows = (result.rows ?? []) as Array<Record<string, unknown>>;
    const connected = new Set(
      rows
        .filter((row) => {
          const platform =
            typeof row.platform === 'string' ? row.platform.trim().toLowerCase() : '';
          const connectedAccountId =
            typeof row.connected_account_id === 'string' ? row.connected_account_id.trim() : '';
          return (
            platform.length > 0 &&
            connectedAccountId.length > 0 &&
            (platform !== 'linkedin' ||
              (typeof row.external_account_id === 'string' &&
                row.external_account_id.trim().length > 0))
          );
        })
        .map((row) => (row.platform as string).trim().toLowerCase()),
    );
    // Preserve CROSSPOST_PLATFORMS order and dedupe implicitly via the flag list.
    return flagEnabled.filter((p) => connected.has(p));
  } catch (err) {
    console.warn('[weekly-crosspost] connected-account lookup failed — no crosspost fan-out', {
      tenantId,
      error: (err as Error)?.message ?? String(err),
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Caption adapters — pure, exported, heavily unit-tested. Each maps the single
// `posts.caption` text field to the platform's own copy constraints. The publish
// back-half then splits/truncates from `input.content` (the row caption) itself
// (e.g. the reddit branch takes the first line as the title), so these adapters
// produce content shaped exactly the way that back-half expects to consume it.
// ---------------------------------------------------------------------------

const X_MAX_WEIGHTED = 270; // buffer under X's 280 hard cap
const LINKEDIN_MAX = 2900; // buffer under LinkedIn's 3000 commentary cap
const REDDIT_TITLE_MAX = 280; // buffer under Reddit's 300 title cap
const URL_WEIGHT = 23; // X counts every URL as 23 weighted chars (t.co)
const URL_RE = /https?:\/\/[^\s]+/gi;

/**
 * X's weighted character counter (conservative). X counts most code points as 1,
 * CJK / many emoji / other high code points as 2, and every URL as a fixed 23
 * regardless of length. We approximate: any code point >= U+1100 counts 2, each
 * http(s) URL counts 23, everything else counts 1. Deliberately conservative so
 * the real X limit is never exceeded.
 */
export function weightedXLength(text: string): number {
  let weight = 0;
  // Replace URLs with a placeholder that contributes the fixed URL weight, so
  // their raw characters are not double-counted by the per-code-point pass.
  const urls = text.match(URL_RE) ?? [];
  const withoutUrls = text.replace(URL_RE, '');
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0) ?? 0;
    weight += cp >= 0x1100 ? 2 : 1;
  }
  weight += urls.length * URL_WEIGHT;
  return weight;
}

/**
 * Truncate `text` to at most `maxWeighted` weighted chars (per weightedXLength),
 * breaking on a word boundary and appending a single '…' when truncation
 * happens. The ellipsis itself is counted within the budget.
 */
function truncateWeighted(text: string, maxWeighted: number): string {
  if (weightedXLength(text) <= maxWeighted) return text;
  // weightedXLength itself is the truncation oracle: find the longest
  // code-point prefix whose weighted length INCLUDING the trailing ellipsis
  // fits the budget. Using the same counter for truncation and for the cap
  // check makes the cap hold by construction — even when the cut lands inside
  // a URL (which X charges at 23 regardless of visible length) and with the
  // ellipsis's own weight (U+2026 ≥ U+1100 → 2). Weighted length is
  // non-decreasing in prefix length, so binary search is valid; the trailing
  // while-loop guarantees the invariant regardless.
  const cps = Array.from(text);
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (weightedXLength(`${cps.slice(0, mid).join('')}…`) <= maxWeighted) lo = mid;
    else hi = mid - 1;
  }
  let acc = cps.slice(0, lo).join('');
  while (acc.length > 0 && weightedXLength(`${acc}…`) > maxWeighted) {
    acc = acc.slice(0, -1);
  }
  // Prefer a word boundary: trim back to the last whitespace if there is one and
  // it does not eat the whole string.
  const lastSpace = acc.replace(/\s+$/, '').lastIndexOf(' ');
  const trimmed = lastSpace > 0 ? acc.slice(0, lastSpace) : acc.replace(/\s+$/, '');
  let result = `${(trimmed || acc).replace(/\s+$/, '')}…`;
  // Final oracle guard: trimming can re-tokenize around the ellipsis (a '…'
  // that was absorbed into a URL now stands alone at weight 2), so re-verify
  // the finished string and shave further if needed. Never returns over-cap.
  while (result.length > 1 && weightedXLength(result) > maxWeighted) {
    result = `${result.slice(0, -2).replace(/\s+$/, '')}…`;
  }
  return result;
}

/** First sentence / hook line of a caption (before the first newline or sentence end). */
function firstSentence(caption: string): string {
  const firstLine =
    caption
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  // Cut at the first sentence terminator if there is one mid-line.
  const m = /^(.*?[.!?])(\s|$)/.exec(firstLine);
  return (m ? m[1] : firstLine).trim();
}

/** Strip hashtag tokens (#word) from a line — used for a clean title/hook. */
function stripHashtags(text: string): string {
  return text
    .replace(/(^|\s)#[^\s#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * X (Twitter) caption: the caption's first sentence/hook + up to 2 hashtags,
 * hard-capped at 270 weighted chars. Never returns empty — falls back to a
 * weighted-truncated raw caption when there is no usable hook.
 */
export function buildXCaption(caption: string, hashtags: string[] = []): string {
  const hook = firstSentence(caption) || caption.trim();
  const tags = hashtags
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 2);
  const composed = tags.length > 0 ? `${hook} ${tags.join(' ')}`.trim() : hook.trim();
  const candidate = composed || caption.trim();
  const capped = truncateWeighted(candidate, X_MAX_WEIGHTED);
  // Never empty: if everything truncated away, fall back to the truncated raw
  // caption (or, in the pathological all-empty case, the raw hook).
  if (capped && capped !== '…') return capped;
  const rawFallback = truncateWeighted(caption.trim() || hook, X_MAX_WEIGHTED);
  return rawFallback && rawFallback !== '…' ? rawFallback : (caption.trim() || hook || '').slice(0, X_MAX_WEIGHTED);
}

/** LinkedIn caption: the full caption, clamped to 2900 chars (buffer under 3000). */
export function buildLinkedInCaption(caption: string): string {
  const text = caption ?? '';
  if (text.length <= LINKEDIN_MAX) return text;
  return `${text.slice(0, LINKEDIN_MAX - 1)}…`;
}

/**
 * Reddit content: a title (first sentence/line, hashtags stripped, clamped to
 * 280 chars) and a body (the full caption). The reddit publisher derives the
 * title from the FIRST non-empty line of `input.content` itself, so
 * `adaptCaptionForPlatform('reddit', …)` serializes this as
 * `<title>\n\n<body>` — the publisher's redditTitleFromContent takes line 1 as
 * the title and posts the body. Title never empty (falls back to a stable label).
 */
export function buildRedditContent(caption: string): { title: string; body: string } {
  const rawTitle = stripHashtags(firstSentence(caption));
  const clampedTitle =
    rawTitle.length <= REDDIT_TITLE_MAX ? rawTitle : `${rawTitle.slice(0, REDDIT_TITLE_MAX - 1)}…`;
  const title = clampedTitle || 'New post';
  return { title, body: caption ?? '' };
}

/**
 * Adapt the FB/IG feed caption to the target platform's `posts.caption` value.
 *
 * For reddit the publisher splits its own title/body from `input.content` (first
 * line = title), so we serialize the reddit shape as `title` + blank line +
 * body. When the title already equals the caption's first line (the common
 * case), this is effectively the original caption with a guaranteed-clean,
 * hashtag-stripped first line.
 */
export function adaptCaptionForPlatform(
  platform: CrosspostPlatform,
  caption: string,
  hashtags: string[] = [],
): string {
  switch (platform) {
    case 'x':
      return buildXCaption(caption, hashtags);
    case 'linkedin':
      return buildLinkedInCaption(caption);
    case 'reddit': {
      const { title, body } = buildRedditContent(caption);
      // Serialize title-then-body: the reddit publisher reads line 1 as the
      // title (redditTitleFromContent) and posts the whole content as the body.
      return body ? `${title}\n\n${body}` : title;
    }
  }
}
