

import React, { useState } from 'react';
import { AuthView } from '../types';
import { AriesMark } from '@/frontend/donor/ui';
import {
  getEmailFieldError,
  isValidEmailAddress,
  useDisabledUntilValid,
} from '@/lib/form-validation';


interface ForgotPasswordFormProps {
  onNavigate: (view: AuthView) => void;
  onSubmit: (email: string) => void;
  isLoading: boolean;
}


const ForgotPasswordForm: React.FC<ForgotPasswordFormProps> = ({ onNavigate, onSubmit, isLoading: parentLoading }) => {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailTouched, setEmailTouched] = useState(false);

  const emailError = emailTouched ? getEmailFieldError(email, 'your account email') : null;
  const submitDisabled = useDisabledUntilValid(
    isValidEmailAddress(email),
    isLoading || parentLoading,
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailTouched(true);
    if (submitDisabled) return;


    setIsLoading(true);
    setError(null);


    try {
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      // The API always returns success to prevent email enumeration.
      // Surface transport failures as a generic error, otherwise proceed.
      if (!response.ok) {
        setError('Unable to send recovery code right now. Please try again.');
        return;
      }

      onSubmit(email);
    } catch {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };


  return (
    <div className="max-w-md mx-auto">
      <button
        onClick={() => onNavigate('login')}
        className="self-start flex items-center gap-2 text-white/40 hover:text-white mb-8 transition-colors group"
      >
        <svg className="w-4 h-4 group-hover:-translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M15 19l-7-7 7-7" />
        </svg>
        <span>Back to Login</span>
      </button>


      <div className="text-center mb-8">
        <div className="flex flex-col items-center mb-2">
          <AriesMark sizeClassName="w-28 h-28" />
          <span className="text-2xl font-bold tracking-tight text-white -mt-4">Aries AI</span>
        </div>
        <h1 className="text-3xl font-bold mb-2 text-white">Recovery</h1>
        <p className="text-white/60">Reset your access to Aries AI</p>
      </div>


      {/* Glassmorphic Form Card */}
      <div className="glass p-8 md:p-10 rounded-2xl border border-white/10 relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-secondary to-primary" />

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="forgot-password-email" className="block text-sm font-medium text-white/80 mb-1.5">Account Email</label>
            <input
              id="forgot-password-email"
              type="email"
              required
              className="block w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/30 focus:outline-none transition-all"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setEmailTouched(true)}
              aria-invalid={emailError ? true : undefined}
              aria-describedby={emailError ? 'forgot-password-email-error' : undefined}
            />
            {emailError ? (
              <p id="forgot-password-email-error" role="alert" className="mt-2 text-sm text-red-300">
                {emailError}
              </p>
            ) : null}
          </div>


          {error && (
            <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-xs font-bold transition-all text-center">
              {error}
            </div>
          )}


          <button
            type="submit"
            disabled={submitDisabled}
            className="w-full py-3 px-4 bg-gradient-to-r from-primary to-secondary hover:opacity-90 text-white font-medium rounded-xl transition-all shadow-[0_0_20px_rgba(124,58,237,0.3)] hover:shadow-[0_0_30px_rgba(124,58,237,0.5)] flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {isLoading || parentLoading ? 'Sending Code...' : 'Send Recovery Code'}
          </button>
        </form>
      </div>
    </div>
  );
};


export default ForgotPasswordForm;


