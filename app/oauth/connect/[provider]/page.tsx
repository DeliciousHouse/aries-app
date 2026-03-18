import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import OAuthConnectScreen from '@/frontend/auth/oauth-connect-screen';

export default async function OAuthConnectPage({
  params,
  searchParams,
}: {
  params: Promise<{ provider: string }>;
  searchParams?: Promise<{
    mode?: 'connect' | 'reconnect';
    connection_id?: string;
    result?: 'connected' | 'error' | 'pending';
    reason?: string;
    message?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  const { provider } = await params;
  const resolved = await searchParams;

  return (
    <OAuthConnectScreen
      provider={provider}
      mode={resolved?.mode}
      connectionId={resolved?.connection_id}
      result={resolved?.result}
      reason={resolved?.reason}
      message={resolved?.message}
    />
  );
}
