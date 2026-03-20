"use client";

import React from 'react';
import AuthLayout from '../../frontend/auth/auth-layout';
import ForgotPasswordForm from '../../frontend/auth/ForgotPasswordForm';

export default function ForgotPasswordPage() {
  const handleNavigate = (view: string) => {
    if (view === 'login') {
      window.location.href = '/login';
    }
  };

  const handleSubmit = (email: string, code: string) => {
    // Navigate to reset password or show success
    console.log('Recovery code sent to:', email);
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
