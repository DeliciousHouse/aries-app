import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Chrome, Lock, Mail } from 'lucide-react';

import { AriesMark } from '@/frontend/donor/ui';

interface LoginFormProps {
  defaultEmail?: string;
  onCredentialsSubmit: (email: string, password: string) => void;
  onGoogleSuccess: () => void;
  onSlackClick?: () => void;
  isLoading: boolean;
  authError?: string | null;
}

const LoginForm: React.FC<LoginFormProps> = ({
  defaultEmail,
  onCredentialsSubmit,
  onGoogleSuccess,
  onSlackClick,
  isLoading,
  authError,
}) => {
  const [email, setEmail] = useState(defaultEmail || '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    setEmail(defaultEmail || '');
  }, [defaultEmail]);

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

        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            onCredentialsSubmit(email, password);
          }}
        >
          <div>
            <label className="block text-sm font-medium text-white/80 mb-1.5">Email Address</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Mail className="h-5 w-5 text-white/40" />
              </div>
              <input
                type="email"
                className="block w-full pl-10 pr-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/30 focus:outline-none transition-all disabled:opacity-60"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                disabled={isLoading}
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-sm font-medium text-white/80">Password</label>
              <span className="text-sm text-white/40">Password reset is not self-serve yet</span>
            </div>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock className="h-5 w-5 text-white/40" />
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                className="block w-full pl-10 pr-12 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/30 focus:outline-none transition-all disabled:opacity-60"
                placeholder="••••••••"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                disabled={isLoading}
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                className="absolute inset-y-0 right-0 px-3 text-sm text-white/50 transition hover:text-white"
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading || !email || !password}
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
              <span className="px-2 bg-background/80 backdrop-blur-sm text-white/40 uppercase tracking-wider">or continue with Google</span>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={onGoogleSuccess}
              disabled={isLoading}
              className="group flex items-center justify-center gap-2 py-2.5 px-4 bg-white/5 border border-white/10 rounded-xl text-sm font-medium hover:bg-white/10 transition-all"
            >
              <svg className="w-4 h-4 grayscale group-hover:grayscale-0 transition-all duration-300" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Google
            </button>
            <button
              type="button"
              onClick={onSlackClick}
              className="group flex items-center justify-center gap-2 py-2.5 px-4 bg-white/5 border border-white/10 rounded-xl text-sm font-medium hover:bg-white/10 transition-all"
            >
              <svg className="w-4 h-4 grayscale group-hover:grayscale-0 transition-all duration-300" viewBox="0 0 122.8 122.8">
                <path fill="#E01E5A" d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.4 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"/>
                <path fill="#36C5F0" d="M45.1 25.8c-7.1 0-12.9-5.8-12.9-12.9S38 0 45.1 0s12.9 5.8 12.9 12.9v12.9H45.1zm0 6.4c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58 0 52.2 0 45.1s5.8-12.9 12.9-12.9h32.2z"/>
                <path fill="#2EB67D" d="M97 45.1c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.1zm-6.4 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C77.7 5.8 83.5 0 90.6 0s12.9 5.8 12.9 12.9v32.2z"/>
                <path fill="#ECB22E" d="M77.7 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.4c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.7z"/>
              </svg>
              Slack
            </button>
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4 text-center text-sm text-white/75">
          Use your Postgres-backed email and password, or continue with Google if your account is managed there.
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
          <Link href="/signup" className="font-bold text-white hover:text-primary transition-colors">
            create one
          </Link>
        </p>
      </div>
    </div>
  );
};

export default LoginForm;
