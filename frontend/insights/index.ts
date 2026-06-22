// ─────────────────────────────────────────────────────────────────────────────
// index.ts — Barrel export for the insights component library
// ─────────────────────────────────────────────────────────────────────────────

// Sections
export { HeroSection }          from "@/frontend/insights/HeroSection";
export { GoalSection }          from "@/frontend/insights/GoalSection";
export { AttentionSection }     from "@/frontend/insights/AttentionSection";
export { ActivitySection }      from "@/frontend/insights/ActivitySection";
export { TrendsSection }        from "@/frontend/insights/TrendsSection";
export { TopPostsSection }      from "@/frontend/insights/TopPostsSection";
export { ConversationsSection } from "@/frontend/insights/ConversationsSection";
export { AriesSection }         from "@/frontend/insights/AriesSection";
export { AudienceSection }      from "@/frontend/insights/AudienceSection";

// Layout chrome
export { Sidebar }              from "@/frontend/insights/Sidebar";
export { Header }               from "@/frontend/insights/Header";
export { InsightsFilters }      from "@/frontend/insights/InsightsFilters";

// Primitives
export {
  Skeleton,
  SectionCard,
  DeltaBadge,
  MetricTile,
  PlatformDot,
  StatusBadge,
  EmptyState,
  ErrorState,
  LoadingRows,
  Divider,
} from "@/frontend/insights/ui";

// Data layer
export { useInsight }           from "@/frontend/insights/useInsight";

// Types
export type {
  Period,
  Platform,
  SortKey,
  ApiBase,
  NarrativeData,
  GoalData,
  AttentionData,
  AttentionCard,
  ActivityData,
  ContentMixSlice,
  TrendsData,
  MetricDisplay,
  KeyMovement,
  TrendMetricKey,
  TopData,
  TopPost,
  ConversationsData,
  ConversationItem,
  AriesData,
  AudienceData,
  AudienceScheduleItem,
} from "@/frontend/insights/types";

// Tokens
export { C, platformColor, platformLabel } from "@/frontend/insights/tokens";
