import AppShellLayout from '@/frontend/app-shell/layout';
import AriesReviewItemScreen from '@/frontend/aries-v1/review-item';
import { handleGetMarketingReviewItem } from '@/app/api/marketing/reviews/[reviewId]/route';
import type { ReviewItemResponse } from '@/lib/api/aries-v1';

type ReviewItemPageLoader = (reviewId: string) => Promise<Response>;

function decodeReviewIdParam(reviewId: string): string {
  try {
    return decodeURIComponent(reviewId);
  } catch {
    return reviewId;
  }
}

function isReviewItemResponse(value: unknown): value is ReviewItemResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'review' in value &&
    typeof (value as { review?: { id?: unknown } }).review?.id === 'string'
  );
}

export async function loadReviewItemPageData(
  reviewId: string,
  reviewItemLoader: ReviewItemPageLoader = handleGetMarketingReviewItem,
): Promise<ReviewItemResponse | null> {
  try {
    const response = await reviewItemLoader(reviewId);
    if (!response.ok) {
      return null;
    }

    const body = await response.json() as unknown;
    return isReviewItemResponse(body) ? body : null;
  } catch {
    return null;
  }
}

export default async function ReviewItemPage({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}) {
  const { reviewId } = await params;
  const encodedReviewPath = `/review/${reviewId}`;
  const initialData = await loadReviewItemPageData(reviewId);

  return (
    <AppShellLayout
      currentRouteId="review"
      skipOnboardingGate
      loginRedirectPath={encodedReviewPath}
    >
      <AriesReviewItemScreen reviewId={decodeReviewIdParam(reviewId)} initialData={initialData} />
    </AppShellLayout>
  );
}
