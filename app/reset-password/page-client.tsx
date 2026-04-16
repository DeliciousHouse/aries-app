"use client";

import React, { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import AuthLayout from '../../frontend/auth/auth-layout';
import ResetPasswordForm from '../../frontend/auth/reset-password-form';

export default function ResetPasswordPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get('email') || '';
  const [isLoading, setIsLoading] = useState(false);

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
        throw new Error(data.error || 'Failed to update password. Try again.');
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
