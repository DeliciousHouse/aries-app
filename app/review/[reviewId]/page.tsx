import AppShellLayout from '@/frontend/app-shell/layout';
import AriesReviewItemScreen from '@/frontend/aries-v1/review-item';

export default async function ReviewItemPage({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}) {
  const { reviewId } = await params;

  return (
    <AppShellLayout currentRouteId="review">
      <AriesReviewItemScreen reviewId={reviewId} />
    </AppShellLayout>
  );
}
