import { Suspense } from 'react';

import React, { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import AuthLayout from '../../frontend/auth/auth-layout';
import SignUpForm from '../../frontend/auth/sign-up-form';
import { signIn } from "next-auth/react";
import { EMAIL_DOES_NOT_EXIST_ERROR, getAuthErrorMessage } from '@/lib/auth-error-message';

export default function SignUpPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const redirectedFromMissingEmail = searchParams.get('notice');
  const defaultAuthError = useMemo(() => {
    if (!redirectedFromMissingEmail) {
      return null;
    }

    return getAuthErrorMessage(redirectedFromMissingEmail);
  }, [redirectedFromMissingEmail]);

  const handleGoogleSuccess = () => {
    setIsLoading(true);
    setAuthError(null);
    void signIn("google", { callbackUrl: "/auth/post-login" }).catch(() => {
      setAuthError('Unable to start Google sign-up right now.');
      setIsLoading(false);
    });
  };

  const handleNavigate = (view: string) => {
    if (view === 'login') {
      router.push('/login');
    }
  };

  const handleSubmit = async (email: string, password: string): Promise<{ success: boolean }> => {
    setIsLoading(true);
    setAuthError(null);

    try {
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
        callbackUrl: '/auth/post-login',
      });

      if (!result || result.error) {
        setAuthError('Account created, but automatic sign-in failed. Please sign in to continue.');
        setIsLoading(false);
        return { success: false };
      }

      router.push(result.url || '/auth/post-login');
      router.refresh();
      return { success: true };
    } catch (_error) {
      setAuthError('Account created, but automatic sign-in failed. Please sign in to continue.');
      setIsLoading(false);
      return { success: false };
    }
  };

  return (
    <AuthLayout>
      <div className="flex justify-center w-full">
        <SignUpForm 
          onNavigate={handleNavigate} 
          onSubmit={handleSubmit} 
          onGoogleSuccess={handleGoogleSuccess} 
          onSlackClick={() => console.log('Slack signup clicked')}
          isLoading={isLoading} 
          authError={authError || defaultAuthError} 
        />
      </div>
    </AuthLayout>
  );
}
