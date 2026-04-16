"use client";

import React, { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

import AuthLayout from '../../frontend/auth/auth-layout';
import ResetPasswordForm from '../../frontend/auth/reset-password-form';

function ResetPasswordInner() {
  const searchParams = useSearchParams();
  const email = (searchParams.get('email') || '').trim();
  const otpCode = (searchParams.get('code') || searchParams.get('otp') || '').trim();

  const handleNavigate = (view: string) => {
    if (view === 'login') {
      window.location.href = '/login';
    }
  };

  const handleSubmit = () => {
    window.location.href = '/login?reset=success';
  };

  return (
    <AuthLayout>
      <div className="flex justify-center w-full">
        <ResetPasswordForm
          email={email}
          otpCode={otpCode}
          onNavigate={handleNavigate}
          onSubmit={handleSubmit}
          isLoading={false}
        />
      </div>
    </AuthLayout>
  );
}

export default function ResetPasswordPageClient() {
  return (
    <Suspense
      fallback={
        <AuthLayout>
          <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-center text-white/70">
            Loading password reset…
          </div>
        </AuthLayout>
      }
    >
      <ResetPasswordInner />
    </Suspense>
  );
}
