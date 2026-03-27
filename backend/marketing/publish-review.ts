import type { MarketingJobRuntimeDocument } from './runtime-state';

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function extractPublishReviewPayload(runtimeDoc: MarketingJobRuntimeDocument): Record<string, unknown> | null {
  const publishStage = runtimeDoc.stages.publish;
  const reviewOutput = recordValue(publishStage.outputs.review);
  if (reviewOutput) {
    return reviewOutput;
  }

  const primaryOutput = recordValue(publishStage.primary_output);
  const launchReview = recordValue(primaryOutput?.launch_review);
  if (launchReview) {
    return launchReview;
  }

  return primaryOutput;
}

export function extractPublishReviewBundle(runtimeDoc: MarketingJobRuntimeDocument): Record<string, unknown> | null {
  return recordValue(extractPublishReviewPayload(runtimeDoc)?.review_bundle);
}
