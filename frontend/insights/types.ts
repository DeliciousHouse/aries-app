// ─────────────────────────────────────────────────────────────────────────────
// types.ts — Shared types for all Insights components
//
// These mirror the EXACT response contracts of the backend handlers in
// backend/insights/*/handler.ts. Note: there is NO top-level `hasData` flag —
// each section reports emptiness differently (snapshot.hasData, meta.hasData,
// allCaughtUp, or an empty array). Check the per-section field, never a shared one.
// ─────────────────────────────────────────────────────────────────────────────

export type Period   = "week" | "30day" | "90day";
export type Platform = "all" | "instagram" | "facebook" | "youtube" | "tiktok";
export type SortKey  = "reach" | "engagement" | "saves" | "shares" | "comments";

/** Fields every successful insights response carries at the top level. */
export interface ApiBase {
  status:        "ok" | string;
  period:        Period;
  platform?:     Platform;
  cached?:       boolean;
  generated_at?: string;
}

// § Narrative (Hero) — backend/insights/narrative/handler.ts
export interface NarrativeTopPost {
  title:       string;
  platform:    string;
  metric:      number;
  metricLabel: string;
}
export interface NarrativeData extends ApiBase {
  // status may also be "not_connected" (with connect_url) for an unconnected platform
  connect_url?: string;
  narrative:    string;
  score:        number;       // Aries Score, 0–100
  scoreDelta:   number;       // % change vs prior period
  judgment:     string;
  periodMeta: {
    posts:      number;
    postsLabel: string;
    comments:   number;
    hoursSaved: number;
  };
  snapshot: {
    posts:            number;
    postsLabel:       string;
    reach:            number;
    reachDelta:       number;
    reachLabel:       string;
    engagementRate:   number;
    topPost:          NarrativeTopPost | null;
    unreplied:        number;
    watchTimeMinutes: number | null;
    hasData:          boolean;   // ← emptiness flag lives HERE
  };
}

// § Goal — backend/insights/goal/handler.ts
export interface GoalData extends ApiBase {
  // status may be "no_goal" (no further fields) when no primary_goal is set
  goal:           string | null;
  goalLabel:      string | null;
  ariesLine:      string;
  metricValue:    number;
  metricLabel:    string;
  metricDelta:    number;
  secondaryValue: number | null;
  secondaryLabel: string | null;
  contributors: Array<{
    title:       string;
    platform:    string;
    metricValue: number;
    metricLabel: string;
  }>;
  hasData: boolean;   // ← top-level for this section
}

// § Attention — backend/insights/attention/handler.ts
export interface AttentionCta {
  label: string;
  href?: string;
  toast?: string;
}
export interface AttentionCard {
  type:         "unreplied" | "opportunity" | "pattern" | "milestone" | "calibrating";
  tone:         "urgent" | "positive" | "celebrate" | "neutral";
  badge:        string;
  icon:         string;
  title:        string;   // may contain <em> tags → render as HTML
  body:         string;
  ctaPrimary:   AttentionCta | null;
  ctaSecondary: AttentionCta | null;
}
export interface AttentionData extends ApiBase {
  cards:       AttentionCard[];
  allCaughtUp: boolean;
  meta: {
    unreplied:     number;
    highPerformer: boolean;
    hasPattern:    boolean;
    hasMilestone:  boolean;
    postCount:     number;
  };
}

// § Activity — backend/insights/activity/handler.ts
export interface ContentMixSlice {
  contentType: string;
  count:       number;
  pct:         number;
}
export interface ActivityData extends ApiBase {
  strip: {
    postsPublished:   number;
    commentsReceived: number;
    highPerformers:   number;
    hoursSaved:       number;
  };
  footerLine: string;
  contentMix: ContentMixSlice[];
  meta: {
    platformCount:         number;
    pendingClassification: number;
    hasData:               boolean;   // ← emptiness flag lives HERE
  };
}

// § Trends — backend/insights/trends/handler.ts
export interface MetricDisplay {
  label:          string;
  icon:           string;
  headline:       string;
  headlineSuffix: string;
  delta:          number | null;
  deltaLabel:     string | null;
  supporting:     string;   // HTML-safe
  interpretation: string;
}
export interface TrendsSeries {
  current: number[];
  prior:   number[];
  labels:  string[];
}
export interface PlatformSlice {
  platform: string;
  value:    number;
  pct:      number;
}
export interface KeyMovement {
  direction: "up" | "down" | "flat" | "flag";
  label:     string;
  value:     string;
  note:      string;
}
export type TrendMetricKey = "reach" | "engagement" | "followers" | "comments" | "visits";
export interface TrendsData extends ApiBase {
  metrics: Partial<Record<TrendMetricKey, MetricDisplay>>;
  series:  Record<TrendMetricKey, TrendsSeries | null>;
  keyMovements: KeyMovement[];
  platformBreakdown: Record<TrendMetricKey, PlatformSlice[] | null>;
  visitsAvailable: boolean;
  meta: {
    postCount: number;
    unreplied: number;
    hasData:   boolean;   // ← emptiness flag lives HERE
  };
}

// § Top Posts — backend/insights/top/handler.ts
export interface PostSentiment {
  positive: number;
  neutral:  number;
  negative: number;
}
export interface TopPost {
  id:            number;
  platform:      string;
  title:         string | null;
  caption:       string | null;
  permalink:     string | null;
  publishedAt:   string;
  dateLabel:     string;
  contentType:   string | null;
  mediaType:     string;
  reach:         number;
  engagement:    number;   // %
  saves:         number;
  shares:        number;
  comments:      number;
  saveRate:      number;
  multiplier:    number;
  bestDow:       string | null;
  sentiment:     PostSentiment | null;
  followerSplit: string | null;
  whyItWorked:   string;
}
export interface PatternBreakdownSlice {
  contentType: string;
  label:       string;
  count:       number;
}
export interface TopData extends ApiBase {
  posts:  TopPost[];
  pattern: {
    title:     string;
    takeaway:  string;   // HTML-safe
    note:      string;
    breakdown: PatternBreakdownSlice[];
  };
  sortBy: SortKey;
  meta: {
    postCount: number;
    avgReach:  number;
    hasData:   boolean;   // ← emptiness flag lives HERE
  };
}

// § Conversations — backend/insights/conversations/handler.ts (uncached)
export interface ConversationItem {
  id:         number;
  author:     string;
  avatar:     string;
  text:       string;
  postRef:    string;
  platform:   string;
  receivedAt: string;
  timeAgo:    string;
  tag:        string | null;
  tagLabel:   string | null;
  handled:    boolean;
}
export interface LeadQualityItem {
  tag:   string;
  label: string;
  note:  string;
  count: number;
  tone:  string;
}
export interface ConversationsData extends ApiBase {
  meta: {
    total:           number;
    positivePercent: number;
    needsReply:      number;
    viewAllLabel:    string;
  };
  conversations: ConversationItem[];
  leadQuality:   LeadQualityItem[];
}

// § Aries AI Adoption — backend/insights/aries/handler.ts (uncached)
export interface AriesData extends ApiBase {
  approvalFlow: {
    drafts:                  number;
    firstTry:                number;
    edited:                  number;
    rebuilt:                 number;
    firstTryRate:            number;
    firstTryRatePriorPeriod: number;
    weeksOnAries:            number;
  };
  learnings: Array<{ icon: string; title: string; body: string }>;
  learningCurve: {
    labels: string[];
    values: number[];
  };
}

// § Audience — backend/insights/audience/handler.ts (uncached)
export interface AudienceScheduleItem {
  id:           number;
  scheduledFor: string;
  platform:     string;
  title:        string;
  surface:      string;
  reason:       string | null;
  confidence:   string | null;
}
export interface AudienceData extends ApiBase {
  schedule: AudienceScheduleItem[];
  demographics: {
    hasData:   boolean;
    ages:      [string, number][];
    locations: [string, number][];
  };
  activeTimes: {
    hasData:    boolean;
    grid:       number[][] | null;
    peakWindow: { day: string; hour: string; score: number } | null;
  };
}
