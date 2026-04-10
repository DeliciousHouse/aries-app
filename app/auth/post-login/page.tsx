import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import pool from '@/lib/db';
import { DATABASE_UNAVAILABLE_ERROR } from '@/lib/auth-error-message';
import { resolvePostLoginDestinationForUser } from '@/lib/auth-user-journey';

export default async function PostLoginPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect('/login');
  }

  const client = await pool.connect();
  let destination: string = '/onboarding/start';

  try {
    destination = await resolvePostLoginDestinationForUser(client, session.user.id);
  } catch (error) {
    console.error('Unable to resolve post-login destination:', error);
    destination = `/login?error=${encodeURIComponent(DATABASE_UNAVAILABLE_ERROR)}`;
  } finally {
    client.release();
  }

  redirect(destination);
}
