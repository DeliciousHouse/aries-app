import { Suspense } from 'react';
import { redirect } from 'next/navigation';

import AuthLayout from '../../frontend/auth/auth-layout';
import LoginPageClient from './page-client';

export const metadata = {
  title: 'Sign in — Aries AI',
};

type SearchParamValue = string | string[] | undefined;

function firstParamValue(value: SearchParamValue): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, SearchParamValue>>;
}) {
  const resolvedParams = (await searchParams) ?? {};
  const draftSaved = firstParamValue(resolvedParams.draftSaved);
  const callbackUrl = firstParamValue(resolvedParams.callbackUrl);
  // `intent=login` is the escape hatch from the signup page's "Already have an
  // account? Sign In" link. Without it that link was a closed loop: signup sent
  // the user to /login carrying draftSaved=1, and /login bounced them straight
  // back to /signup. A returning customer who completed the intake anonymously
  // could never reach the sign-in form at all — and signing up again just told
  // them the email was taken and to "sign in instead".
  const wantsLoginForm = firstParamValue(resolvedParams.intent) === 'login';

  if (!wantsLoginForm && draftSaved === '1' && callbackUrl && callbackUrl.startsWith('/onboarding/resume')) {
    const forwarded = new URLSearchParams();
    for (const [key, raw] of Object.entries(resolvedParams)) {
      const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
      for (const value of values) {
        forwarded.append(key, value);
      }
    }
    const query = forwarded.toString();
    redirect(`/signup${query ? `?${query}` : ''}`);
  }

  return (
    <Suspense
      fallback={
        <AuthLayout>
          <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-center text-white/70">
            Loading sign-in…
          </div>
        </AuthLayout>
      }
    >
      <LoginPageClient />
    </Suspense>
  );
}
