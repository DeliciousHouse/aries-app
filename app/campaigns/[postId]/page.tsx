import { permanentRedirect } from 'next/navigation';

export default async function PostWorkspaceRedirectPage({
  params,
}: {
  params: Promise<{ postId: string }>;
}) {
  const { postId } = await params;
  permanentRedirect(`/dashboard/social-content/${encodeURIComponent(postId)}`);
}
