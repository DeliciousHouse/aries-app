import React from 'react';
import { BrandLogo } from '@/components/redesign/brand/logo';

interface LoginFormProps {
  onGoogleSuccess: () => void;
  isLoading: boolean;
  authError?: string | null;
}

const LoginForm: React.FC<LoginFormProps> = ({ onGoogleSuccess, isLoading, authError }) => {
  return (
    <div className="auth-container animate-in fade-in duration-1000" style={{ fontFamily: "'Inter', sans-serif" }}>
      <div className="flex flex-col items-center mb-6 text-center">
        <div className="mb-6">
          <BrandLogo size={96} variant="mark" priority />
        </div>
        <h1
          className="text-[26px] font-medium text-white tracking-[0.25em] mb-[20px] uppercase leading-none pl-[0.25em]"
          style={{ marginBottom: '20px' }}
        >
          ARIES AI
        </h1>
        <p className="text-white italic text-[18px] tracking-wide font-normal mt-[20px] opacity-90">
          Sign in with Google to access the operator console
        </p>
      </div>

      <div className="auth-card animate-in fade-in zoom-in-95 duration-500 space-y-6">
        <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-center text-sm text-white/75">
          Email/password, signup, and recovery flows are temporarily unavailable while authentication is being hardened.
        </div>

        {authError && (
          <div
            className="rounded-xl border border-red-500/20 bg-gradient-to-r from-red-500/15 via-red-500/5 to-transparent backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.3)] flex items-center gap-3 animate-in fade-in slide-in-from-top-3 duration-500"
            style={{
              padding: '16px',
              borderLeft: '4px solid #EF4444',
            }}
          >
            <div
              className="shrink-0 rounded-full bg-red-500/20 flex items-center justify-center border border-red-500/30"
              style={{ width: '24px', height: '24px' }}
            >
              <svg className="text-red-400" style={{ width: '14px', height: '14px' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <span
              className="text-red-100/90 font-bold tracking-normal leading-snug"
              style={{
                fontSize: '10px',
                textTransform: 'capitalize',
                letterSpacing: '0.02em',
              }}
            >
              {authError}
            </span>
          </div>
        )}

        <button type="button" onClick={onGoogleSuccess} disabled={isLoading} className="auth-primary-button">
          {isLoading ? 'Redirecting...' : 'Continue with Google'}
        </button>
      </div>
    </div>
  );
};

export default LoginForm;



