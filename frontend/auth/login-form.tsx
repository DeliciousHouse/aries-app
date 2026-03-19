import React from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Chrome, Github, Lock, Mail, Sparkles, Twitter } from 'lucide-react';

import { AriesMark } from '@/frontend/donor/ui';

interface LoginFormProps {
  onGoogleSuccess: () => void;
  isLoading: boolean;
  authError?: string | null;
}

const LoginForm: React.FC<LoginFormProps> = ({ onGoogleSuccess, isLoading, authError }) => {
  return (
    <div className="max-w-md mx-auto">
      <Link href="/" className="inline-flex items-center gap-2 text-white/60 hover:text-white transition-colors mb-8 group">
        <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
        <span>Back to Home</span>
      </Link>

      <div className="glass p-8 md:p-10 rounded-2xl border border-white/10 relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-secondary to-primary" />

        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 mb-4">
            <Sparkles className="w-6 h-6 text-primary" />
          </div>
          <div className="inline-flex items-center gap-3 mb-3">
            <AriesMark sizeClassName="w-10 h-10" />
            <span className="text-2xl font-bold tracking-tight">Aries AI</span>
          </div>
          <h1 className="text-3xl font-bold mb-2">Welcome Back</h1>
          <p className="text-white/60">Sign in to your Aries AI account</p>
        </div>

        <form className="space-y-5" onSubmit={(event) => event.preventDefault()}>
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
                disabled
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-sm font-medium text-white/80">Password</label>
              <span className="text-sm text-primary/80">Google OAuth only</span>
            </div>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock className="h-5 w-5 text-white/40" />
              </div>
              <input
                type="password"
                className="block w-full pl-10 pr-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/30 focus:outline-none transition-all disabled:opacity-60"
                placeholder="••••••••"
                disabled
              />
            </div>
          </div>

          <button
            type="button"
            onClick={onGoogleSuccess}
            disabled={isLoading}
            className="w-full py-3 px-4 bg-gradient-to-r from-primary to-secondary hover:opacity-90 text-white font-medium rounded-xl transition-all shadow-[0_0_20px_rgba(124,58,237,0.3)] hover:shadow-[0_0_30px_rgba(124,58,237,0.5)] flex items-center justify-center gap-2 disabled:opacity-60"
          >
            <Chrome className="w-4 h-4" />
            {isLoading ? 'Redirecting...' : 'Continue with Google'}
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        <div className="mt-8">
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-white/10" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-background/80 backdrop-blur-sm text-white/40">Other providers are not enabled</span>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-3">
            <button type="button" disabled className="flex items-center justify-center gap-2 py-2.5 px-4 bg-white/5 border border-white/10 rounded-xl text-sm font-medium opacity-60 cursor-not-allowed">
              <Github className="w-4 h-4" />
              GitHub
            </button>
            <button type="button" disabled className="flex items-center justify-center gap-2 py-2.5 px-4 bg-white/5 border border-white/10 rounded-xl text-sm font-medium opacity-60 cursor-not-allowed">
              <Twitter className="w-4 h-4" />
              Twitter
            </button>
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4 text-center text-sm text-white/75">
          Email/password, signup, and recovery flows are intentionally disabled in this runtime while authentication is hardened.
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
          Need the full runtime contract?{' '}
          <Link href="/documentation" className="font-medium text-primary hover:text-primary/80 transition-colors">
            Review the docs
          </Link>
        </p>
      </div>
    </div>
  );
};

export default LoginForm;
