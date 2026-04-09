'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';

import AuthLayout from '../../frontend/auth/auth-layout';
import LoginForm from '../../frontend/auth/login-form';
import { EMAIL_DOES_NOT_EXIST_ERROR } from '@/lib/auth-error-message';
import {
  getLoginAuthErrorMessage,
  resolveLoginErrorCode,
  shouldRedirectLoginToSignup,
} from '@/lib/login-auth-error';

function savedDraftMessage(draftSaved: string | null, businessName: string | null): string | null {
  if (draftSaved !== '1') {
    return null;
  }

  const trimmedBusinessName = businessName?.trim();
  if (trimmedBusinessName) {
    return `Your setup for ${trimmedBusinessName} is saved. Sign in to continue in the same workspace.`;
  }

  return 'Your setup is saved. Sign in to continue in the same workspace.';
}

export default function LoginPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const callbackUrl = '/auth/post-login';
  const defaultEmail = searchParams.get('email') || '';
  const queryErrorCode = useMemo(
    () => resolveLoginErrorCode(searchParams.get('error'), searchParams.get('code')),
    [searchParams],
  );
  const queryError = useMemo(
    () =>
      getLoginAuthErrorMessage(
        searchParams.get('error'),
        searchParams.get('code'),
        searchParams.get('missing'),
      ),
    [searchParams],
  );

  const savedMessage = useMemo(
    () => savedDraftMessage(searchParams.get('draft_saved'), searchParams.get('business_name')),
    [searchParams],
  );
  const signupHref = '/signup';

  useEffect(() => {
    if (queryErrorCode !== EMAIL_DOES_NOT_EXIST_ERROR) {
      return;
    }

    const email = searchParams.get('email') || '';
    if (typeof window !== 'undefined') {
      window.alert("Email doesn't exist. Please sign up.");
    }
    router.replace(`/signup?email=${encodeURIComponent(email)}&notice=${EMAIL_DOES_NOT_EXIST_ERROR}`);
  }, [queryErrorCode, router, searchParams]);

  const handleGoogleSuccess = () => {
    setIsLoading(true);
    setAuthError(null);
    void signIn('google', { callbackUrl }).catch(() => {
      setAuthError('Unable to start Google sign-in right now.');
      setIsLoading(false);
    });
  };

  const handleCredentialsSubmit = async (email: string, password: string) => {
    setIsLoading(true);
    setAuthError(null);

    try {
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
        callbackUrl,
      });

      if (!result) {
        setAuthError('Unable to sign in right now.');
        setIsLoading(false);
        return;
      }

      if (result.error) {
        if (shouldRedirectLoginToSignup(result.error, result.code)) {
          if (typeof window !== 'undefined') {
            window.alert("Email doesn't exist. Please sign up.");
          }
          router.push(`/signup?email=${encodeURIComponent(email)}&notice=${EMAIL_DOES_NOT_EXIST_ERROR}`);
          router.refresh();
          return;
        }

        setAuthError(
          getLoginAuthErrorMessage(
            result.error,
            result.code,
            searchParams.get('missing'),
          ) || 'Invalid email or password.',
        );
        setIsLoading(false);
        return;
      }

      router.push(result.url || callbackUrl);
      router.refresh();
    } catch (_error) {
      setAuthError('Unable to sign in right now.');
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout>
      <div className="flex justify-center w-full">
        <LoginForm
          defaultEmail={defaultEmail}
          onCredentialsSubmit={handleCredentialsSubmit}
          onGoogleSuccess={handleGoogleSuccess}
          isLoading={isLoading}
          authError={authError || queryError}
          savedStateMessage={savedMessage}
          signupHref={signupHref}
        />
      </div>
    </AuthLayout>
  );
}
