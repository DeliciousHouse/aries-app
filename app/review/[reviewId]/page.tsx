import AppShellLayout from '@/frontend/app-shell/layout';
import AriesReviewItemScreen from '@/frontend/aries-v1/review-item';

function decodeReviewIdParam(reviewId: string): string {
  try {
    return decodeURIComponent(reviewId);
  } catch {
    return reviewId;
  }
}

export default async function ReviewItemPage({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}) {
  const { reviewId } = await params;

  return (
    <AppShellLayout currentRouteId="review">
      <AriesReviewItemScreen reviewId={decodeReviewIdParam(reviewId)} />
    </AppShellLayout>
  );
}
