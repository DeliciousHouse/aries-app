"use client";

import React from 'react';
import AuthLayout from '../../frontend/auth/auth-layout';
import SignUpForm from '../../frontend/auth/sign-up-form';
import { signIn } from "next-auth/react";

export default function SignUpPage() {
  const handleGoogleSuccess = () => {
    signIn("google", { callbackUrl: "/dashboard" });
  };

  const handleNavigate = (view: string) => {
    if (view === 'login') {
      window.location.href = '/login';
    }
  };

  const handleSubmit = (email: string, needsOnboarding: boolean) => {
    console.log('Signup success:', email);
    window.location.href = '/onboarding';
  };

  return (
    <AuthLayout>
      <div className="flex justify-center w-full">
        <SignUpForm 
          onNavigate={handleNavigate} 
          onSubmit={handleSubmit} 
          onGoogleSuccess={handleGoogleSuccess} 
          onSlackClick={() => console.log('Slack signup clicked')}
          isLoading={false} 
          authError={null} 
        />
      </div>
    </AuthLayout>
  );
}
