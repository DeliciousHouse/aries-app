import AppShellLayout from '../../frontend/app-shell/layout';
import PostsConsole from '../../frontend/app-shell/posts-console';

export default function PostsPage() {
  return (
    <AppShellLayout currentRouteId="posts">
      <PostsConsole />
    </AppShellLayout>
  );
}
