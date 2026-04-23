import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Lock, Mail } from 'lucide-react';

import { AriesMark } from '@/frontend/donor/ui';
import {
  getEmailFieldError,
  getRequiredFieldError,
  isValidEmailAddress,
  useDisabledUntilValid,
} from '@/lib/form-validation';

interface LoginFormProps {
  defaultEmail?: string;
  onCredentialsSubmit: (email: string, password: string) => void;
  onGoogleSuccess: () => void;
  isLoading: boolean;
  authError?: string | null;
  savedStateMessage?: string | null;
  signupHref?: string;
}

const LoginForm: React.FC<LoginFormProps> = ({
  defaultEmail,
  onCredentialsSubmit,
  onGoogleSuccess,
  isLoading,
  authError,
  savedStateMessage,
  signupHref,
}) => {
  const [email, setEmail] = useState(defaultEmail || '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);

  useEffect(() => {
    setEmail(defaultEmail || '');
  }, [defaultEmail]);

  const emailError = emailTouched ? getEmailFieldError(email) : null;
  const passwordError = passwordTouched ? getRequiredFieldError(password, 'your password') : null;
  const credentialsAreValid = isValidEmailAddress(email) && password.trim().length > 0;
  const submitDisabled = useDisabledUntilValid(credentialsAreValid, isLoading);

  return (
    <div className="max-w-md mx-auto">
      <Link href="/" className="inline-flex items-center gap-2 text-white/60 hover:text-white transition-colors mb-8 group">
        <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
        <span>Back to Home</span>
      </Link>

      <div className="glass p-8 md:p-10 rounded-2xl border border-white/10 relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-secondary to-primary" />

        <div className="text-center mb-8">
          <div className="flex flex-col items-center mb-2">
            <AriesMark sizeClassName="w-28 h-28" />
            <span className="text-2xl font-bold tracking-tight -mt-4">Aries AI</span>
          </div>
          <h1 className="text-3xl font-bold mb-2">Welcome Back</h1>
          <p className="text-white/60">Sign in to your Aries AI account</p>
        </div>

        {savedStateMessage ? (
          <div className="mb-6 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-100">
            {savedStateMessage}
          </div>
        ) : null}

        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            setEmailTouched(true);
            setPasswordTouched(true);
            if (submitDisabled) {
              return;
            }
            onCredentialsSubmit(email, password);
          }}
        >
          <div>
            <label htmlFor="login-email" className="block text-sm font-medium text-white/80 mb-1.5">Email Address</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Mail className="h-5 w-5 text-white/40" />
              </div>
              <input
                id="login-email"
                type="email"
                className="block w-full pl-10 pr-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/30 focus:outline-none transition-all disabled:opacity-60"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onBlur={() => setEmailTouched(true)}
                autoComplete="email"
                disabled={isLoading}
                aria-invalid={emailError ? true : undefined}
                aria-describedby={emailError ? 'login-email-error' : undefined}
              />
            </div>
            {emailError ? (
              <p id="login-email-error" role="alert" className="mt-2 text-sm text-red-300">
                {emailError}
              </p>
            ) : null}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="login-password" className="block text-sm font-medium text-white/80">Password</label>
              <Link href="/forgot-password" className="text-sm text-white/60 hover:text-white transition-colors">
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock className="h-5 w-5 text-white/40" />
              </div>
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                className="block w-full pl-10 pr-12 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/30 focus:outline-none transition-all disabled:opacity-60"
                placeholder="••••••••"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onBlur={() => setPasswordTouched(true)}
                autoComplete="current-password"
                disabled={isLoading}
                aria-invalid={passwordError ? true : undefined}
                aria-describedby={passwordError ? 'login-password-error' : undefined}
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                className="absolute inset-y-0 right-0 px-3 text-sm text-white/50 transition hover:text-white"
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
            {passwordError ? (
              <p id="login-password-error" role="alert" className="mt-2 text-sm text-red-300">
                {passwordError}
              </p>
            ) : null}
          </div>

          <button
            type="submit"
            disabled={submitDisabled}
            className="w-full py-3 px-4 bg-gradient-to-r from-primary to-secondary hover:opacity-90 text-white font-medium rounded-xl transition-all shadow-[0_0_20px_rgba(124,58,237,0.3)] hover:shadow-[0_0_30px_rgba(124,58,237,0.5)] flex items-center justify-center gap-2 disabled:opacity-60"
          >
            <Lock className="w-4 h-4" />
            {isLoading ? 'Signing in...' : 'Sign in'}
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        <div className="mt-8">
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-white/10" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-background/80 backdrop-blur-sm text-white/40 uppercase tracking-wider">or continue with</span>
            </div>
          </div>

          <div className="mt-6">
            <button
              type="button"
              onClick={onGoogleSuccess}
              disabled={isLoading}
              className="group w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-white/5 border border-white/10 rounded-xl text-sm font-medium hover:bg-white/10 transition-all"
            >
              <svg className="w-4 h-4 grayscale group-hover:grayscale-0 transition-all duration-300" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Google
            </button>
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4 text-center text-sm text-white/75">
          Sign in with your email and password, or use Google if that's how your account was created.
        </div>

        {authError ? (
          <div className="mt-4 rounded-xl border border-red-500/20 bg-gradient-to-r from-red-500/15 via-red-500/5 to-transparent backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.3)] flex items-center gap-3 p-4 border-l-4 border-l-red-500">
            <div className="shrink-0 rounded-full bg-red-500/20 flex items-center justify-center border border-red-500/30 w-6 h-6">
              <svg className="text-red-400 w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <span className="text-red-100/90 text-xs font-bold tracking-normal leading-snug">{authError}</span>
          </div>
        ) : null}

        <p className="mt-8 text-center text-sm text-white/60">
          Don't have an account?{' '}
          <Link href={signupHref || '/signup'} className="font-bold text-white hover:text-primary transition-colors">
            create one
          </Link>
        </p>
      </div>
    </div>
  );
};

export default LoginForm;
