"use client";

import React, { useState } from 'react';
import AuthLayout from '../../frontend/auth/auth-layout';
import LoginForm from '../../frontend/auth/login-form';
import SignUpForm from '../../frontend/auth/sign-up-form';
import ForgotPasswordForm from '../../frontend/auth/ForgotPasswordForm';
import type { AuthView } from '../../frontend/types';

import { signIn } from "next-auth/react";

export default function LoginPage() {
  const [view, setView] = useState<AuthView>('login');
  const [email, setEmail] = useState('');

  const handleNavigate = (newView: AuthView, newEmail?: string) => {
    setView(newView);
    if (newEmail) setEmail(newEmail);
  };

  const onLoginSuccess = (email: string) => {
    console.log('Login successful for:', email);
    window.location.href = '/dashboard';
  };

  const onSignUpSuccess = (email: string, needsOnboarding: boolean) => {
    console.log('SignUp successful for:', email);
    // Usually redirect to onboarding or verification
    window.location.href = '/dashboard';
  };

  const onForgotPasswordSuccess = (email: string, code: string) => {
    console.log('Password reset code sent to:', email);
    // Usually navigate to a "reset password" view with the code
    setView('login'); 
    alert('Reset code sent to your email.');
  };

  const handleGoogleSuccess = () => {
    signIn("google", { callbackUrl: "/dashboard" });
  };

  const handleSlackClick = () => {
    alert("Slack authentication is being configured. Please use Google or Email for now.");
  };

  return (
    <AuthLayout>
      <div className="flex justify-center w-full">
        {view === 'login' && (
          <LoginForm 
            onNavigate={handleNavigate}
            onSubmit={onLoginSuccess}
            onGoogleSuccess={handleGoogleSuccess}
            onSlackClick={handleSlackClick}
            isLoading={false}
            successMessage={null}
            authError={null}
          />
        )}
        {view === 'signup' && (
          <SignUpForm 
            onNavigate={handleNavigate}
            onSubmit={onSignUpSuccess}
            onGoogleSuccess={handleGoogleSuccess}
            onSlackClick={handleSlackClick}
            isLoading={false}
            authError={null}
          />
        )}
        {view === 'forgot-password' && (
          <ForgotPasswordForm 
            onNavigate={handleNavigate}
            onSubmit={onForgotPasswordSuccess}
            isLoading={false}
          />
        )}
        {/* If the user reaches other views, we can show a placeholder or back link */}
        {['email-verification', 'reset-password'].includes(view) && (
          <div className="text-white text-center">
            <h2 className="text-2xl mb-4 uppercase tracking-widest">{view.replace('-', ' ')}</h2>
            <p className="mb-8 opacity-70">Feature coming soon for {email}</p>
            <button 
              onClick={() => setView('login')}
              className="px-6 py-2 border border-white/20 rounded-xl hover:bg-white/10 transition-all font-bold text-xs uppercase tracking-widest"
            >
              Back to Login
            </button>
          </div>
        )}
      </div>
    </AuthLayout>
  );
}
