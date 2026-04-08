export type FeedbackLabel = {
  name: string;
};

export type FeedbackIssue = {
  title: string;
  body?: string | null;
  labels?: FeedbackLabel[];
};

export type FeedbackClassification = {
  type: string;
  source?: string;
};

export function classifyIssue(issue: FeedbackIssue): FeedbackClassification;

export function buildDailySummary(input: {
  dryRun?: boolean;
  log: {
    version: number;
    repo: string;
    lastSyncAt: string | null;
    lastDailySummaryAt: string | null;
    items: Array<Record<string, unknown>>;
  };
}): {
  text: string;
};
