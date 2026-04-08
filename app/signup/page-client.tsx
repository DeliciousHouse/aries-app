'use client';

import React, { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';

import AuthLayout from '../../frontend/auth/auth-layout';
import SignUpForm from '../../frontend/auth/sign-up-form';

function savedDraftMessage(draftSaved: string | null, businessName: string | null): string | null {
  if (draftSaved !== '1') {
    return null;
  }

  const trimmedBusinessName = businessName?.trim();
  if (trimmedBusinessName) {
    return `Your setup for ${trimmedBusinessName} is saved. Create your account to continue in the same workspace.`;
  }

  return 'Your setup is saved. Create your account to continue in the same workspace.';
}

export default function SignUpPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const callbackUrl = searchParams.get('callbackUrl') || '/dashboard';
  const defaultEmail = searchParams.get('email') || '';
  const savedMessage = useMemo(
    () => savedDraftMessage(searchParams.get('draftSaved'), searchParams.get('businessName')),
    [searchParams],
  );
  const loginHref = useMemo(() => {
    const params = new URLSearchParams();
    if (callbackUrl) {
      params.set('callbackUrl', callbackUrl);
    }
    if (searchParams.get('draftSaved') === '1') {
      params.set('draftSaved', '1');
    }
    const businessName = searchParams.get('businessName');
    if (businessName) {
      params.set('businessName', businessName);
    }
    if (defaultEmail) {
      params.set('email', defaultEmail);
    }
    const suffix = params.toString();
    return suffix ? `/login?${suffix}` : '/login';
  }, [callbackUrl, defaultEmail, searchParams]);

  const handleGoogleSuccess = () => {
    setIsLoading(true);
    setAuthError(null);
    void signIn('google', { callbackUrl }).catch(() => {
      setAuthError('Unable to start Google sign-in right now.');
      setIsLoading(false);
    });
  };

  const handleNavigate = (view: string, email?: string) => {
    if (view === 'login') {
      const target = new URL(loginHref, window.location.origin);
      if (email?.trim()) {
        target.searchParams.set('email', email.trim());
      }
      window.location.href = `${target.pathname}${target.search}`;
    }
  };

  const handleSubmit = async (email: string, password: string) => {
    setIsLoading(true);
    setAuthError(null);

    try {
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
        callbackUrl,
      });

      if (!result || result.error) {
        const target = new URL(loginHref, window.location.origin);
        target.searchParams.set('email', email);
        window.location.href = `${target.pathname}${target.search}`;
        return;
      }

      router.push(result.url || callbackUrl);
      router.refresh();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Unable to create your account right now.');
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout>
      <div className="flex justify-center w-full">
        <SignUpForm
          onNavigate={handleNavigate}
          onSubmit={handleSubmit}
          onGoogleSuccess={handleGoogleSuccess}
          onSlackClick={() => {}}
          isLoading={isLoading}
          authError={authError}
          savedStateMessage={savedMessage}
          defaultEmail={defaultEmail}
        />
      </div>
    </AuthLayout>
  );
}
