"use client";

import React from 'react';
import AuthLayout from '../../frontend/auth/auth-layout';
import LoginForm from '../../frontend/auth/login-form';
import { signIn } from "next-auth/react";

export default function LoginPage() {
  const handleGoogleSuccess = () => {
    signIn("google", { callbackUrl: "/dashboard" });
  };

  return (
    <AuthLayout>
      <div className="flex justify-center w-full">
        <LoginForm onGoogleSuccess={handleGoogleSuccess} isLoading={false} authError={null} />
      </div>
    </AuthLayout>
  );
}
