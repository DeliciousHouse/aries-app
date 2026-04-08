'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';

import AuthLayout from '../../frontend/auth/auth-layout';
import LoginForm from '../../frontend/auth/login-form';

function authErrorMessage(errorCode: string | null, missingClaims: string | null): string | null {
  if (!errorCode) {
    return null;
  }

  switch (errorCode) {
    case 'CredentialsSignin':
      return 'Invalid email or password.';
    case 'AccessDenied':
      return 'Access was denied. Try a different sign-in method.';
    case 'DatabaseUnavailable':
      return 'Authentication cannot reach the Postgres database. Start Postgres or update the DB connection settings.';
    case 'TenantClaimsIncomplete':
      return missingClaims
        ? `Your account is authenticated but missing required tenant claims: ${missingClaims
            .split(',')
            .filter(Boolean)
            .join(', ')}.`
        : 'Your account is authenticated but missing required tenant claims.';
    case 'OAuthAccountNotLinked':
      return 'This email is already linked to a different sign-in method.';
    case 'CallbackRouteError':
      return 'Unable to complete sign-in right now.';
    default:
      return 'Unable to sign in right now.';
  }
}

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
  const callbackUrl = searchParams.get('callbackUrl') || '/dashboard';
  const defaultEmail = searchParams.get('email') || '';
  const savedMessage = useMemo(
    () => savedDraftMessage(searchParams.get('draftSaved'), searchParams.get('businessName')),
    [searchParams],
  );
  const signupHref = useMemo(() => {
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
    return suffix ? `/signup?${suffix}` : '/signup';
  }, [callbackUrl, defaultEmail, searchParams]);
  const queryError = useMemo(
    () => authErrorMessage(searchParams.get('error'), searchParams.get('missing')),
    [searchParams],
  );

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
        setAuthError(
          authErrorMessage(result.error, searchParams.get('missing')) || 'Invalid email or password.',
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
