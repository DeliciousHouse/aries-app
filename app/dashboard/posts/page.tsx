import AppShellLayout from '@/frontend/app-shell/layout';
import AriesPostsScreen from '@/frontend/aries-v1/posts-screen';

export const metadata = {
  title: 'Posts — Aries AI',
};

export default function DashboardPostsPage() {
  return (
    <AppShellLayout currentRouteId="posts">
      <AriesPostsScreen />
    </AppShellLayout>
  );
}
