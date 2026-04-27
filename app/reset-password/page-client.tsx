"use client";

import React, { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import AuthLayout from '../../frontend/auth/auth-layout';
import ResetPasswordForm from '../../frontend/auth/reset-password-form';

export default function ResetPasswordPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = (searchParams.get('email') || '').trim();
  const [isLoading, setIsLoading] = useState(false);

  // Without an email we have nothing to submit against /api/auth/reset-password
  // (the server requires email + code + password). Send the user back to
  // /forgot-password to start from the top instead of rendering a form that
  // can only fail.
  useEffect(() => {
    if (!email) {
      router.replace('/forgot-password');
    }
  }, [email, router]);

  if (!email) {
    return (
      <AuthLayout>
        <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-center text-white/70">
          Redirecting to password reset request…
        </div>
      </AuthLayout>
    );
  }

  const handleNavigate = (view: string) => {
    if (view === 'login') {
      router.push('/login');
    }
  };

  const handleSubmit = async (
    submittedEmail: string,
    code: string,
    password: string,
  ): Promise<void> => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: submittedEmail, code, password }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        const fallbackMessage = response.status === 400
          ? 'Your recovery code is invalid or expired. Request a new code and try again.'
          : 'Failed to update password. Try again.';
        throw new Error(data.error?.trim() || fallbackMessage);
      }

      router.push('/login?reset=success');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout>
      <div className="flex justify-center w-full">
        <ResetPasswordForm
          email={email}
          onNavigate={handleNavigate}
          onSubmit={handleSubmit}
          isLoading={isLoading}
        />
      </div>
    </AuthLayout>
  );
}
