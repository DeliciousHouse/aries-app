import AppShellLayout from '@/frontend/app-shell/layout';
import AriesReviewQueueScreen from '@/frontend/aries-v1/review-queue';

export default function ReviewQueuePage() {
  return (
    <AppShellLayout currentRouteId="review" skipOnboardingGate>
      <AriesReviewQueueScreen />
    </AppShellLayout>
  );
}
