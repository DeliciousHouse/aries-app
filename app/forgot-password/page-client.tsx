"use client";

import React from 'react';
import AuthLayout from '../../frontend/auth/auth-layout';
import ForgotPasswordForm from '../../frontend/auth/ForgotPasswordForm';

export default function ForgotPasswordPageClient() {
  const handleNavigate = (view: string) => {
    if (view === 'login') {
      window.location.href = '/login';
    }
  };

  const handleSubmit = (email: string, _code: string) => {
    window.location.href = `/reset-password?email=${encodeURIComponent(email)}`;
  };

  return (
    <AuthLayout>
      <div className="flex justify-center w-full">
        <ForgotPasswordForm
          onNavigate={handleNavigate}
          onSubmit={handleSubmit}
          isLoading={false}
        />
      </div>
    </AuthLayout>
  );
}
