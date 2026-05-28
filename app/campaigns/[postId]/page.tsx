import { redirect } from 'next/navigation';

export default async function PostWorkspaceRedirectPage({
  params,
}: {
  params: Promise<{ postId: string }>;
}) {
  const { postId } = await params;
  redirect(`/dashboard/social-content/${encodeURIComponent(postId)}`);
}
