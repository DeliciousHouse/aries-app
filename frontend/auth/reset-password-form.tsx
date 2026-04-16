import React, { useState, useEffect } from 'react';
import { AuthView } from '../types';
import { BrandLogo } from '@/components/redesign/brand/logo';


interface ResetPasswordFormProps {
  email: string;
  otpCode?: string;
  onNavigate: (view: AuthView) => void;
  onSubmit: (email: string, code: string, password: string) => void | Promise<void>;
  isLoading: boolean;
}


const ResetPasswordForm: React.FC<ResetPasswordFormProps> = ({ email, otpCode, onNavigate, onSubmit, isLoading }) => {
  const [code, setCode] = useState(otpCode ?? '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);


  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => {
        setError(null);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [error]);



  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);


    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the 6-digit code from your email.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    const passwordRegex = /^(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).{8,}$/;
    if (!passwordRegex.test(password)) {
      setError("Password must be at least 8 characters long and include an uppercase letter, a number, and a special character.");
      return;
    }


    try {
      await onSubmit(email, code.trim(), password);
    } catch (err: any) {
      setError(err?.message || "Failed to update password. Try again.");
    }
  };


  return (
    <div className="auth-container animate-in fade-in duration-1000" style={{ fontFamily: "'Inter', sans-serif" }}>
      {/* Header Section */}
      <div className="flex flex-col items-center mb-6 text-center">
        <div className="mb-6">
          <BrandLogo size={96} variant="mark" />
        </div>
        <h1 className="text-[26px] font-medium text-white tracking-[0.25em] mb-[20px] uppercase leading-none pl-[0.25em]" style={{ marginBottom: '20px' }}>RESET PASSWORD</h1>
        <p className="text-white italic text-[18px] tracking-wide font-normal mt-[20px] opacity-90 px-4">Set your new high-performance credentials</p>
      </div>


      {/* Glassmorphic Form Card */}
      <div className="auth-card animate-in fade-in zoom-in-95 duration-500">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="auth-label">Recovery Code</label>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              className="auth-input tracking-[0.4em] text-center"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </div>
          <div className="space-y-2">
            <label className="auth-label">New Password</label>
            <input type="password" required className="auth-input" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="space-y-2">
            <label className="auth-label">Confirm Password</label>
            <input type="password" required className="auth-input" placeholder="••••••••" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
          </div>


          {error && (
            <div className="rounded-xl border border-red-500/20 bg-gradient-to-r from-red-500/15 via-red-500/5 to-transparent backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.3)] flex items-center gap-3 animate-in fade-in slide-in-from-top-3 duration-500"
                 style={{
                   padding: '16px',
                   marginBottom: '32px',
                   borderLeft: '4px solid #EF4444'
                 }}>
              <div className="shrink-0 rounded-full bg-red-500/20 flex items-center justify-center border border-red-500/30"
                   style={{ width: '24px', height: '24px' }}>
                <svg className="text-red-400" style={{ width: '14px', height: '14px' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <span className="text-red-100/90 font-bold tracking-normal leading-snug"
                    style={{
                      fontSize: '10px',
                      textTransform: 'capitalize',
                      letterSpacing: '0.02em'
                    }}>
                {error}
              </span>
            </div>
          )}


          <button
            type="submit"
            disabled={isLoading || !password || !code}
            className="auth-primary-button"
          >
            {isLoading ? 'Updating...' : 'UPDATE PASSWORD'}
          </button>
        </form>
      </div>


      <div className="text-center font-medium text-[15px]" style={{ marginTop: '20px', color: '#FFFFFF' }}>
        <p>
          Remember your password? <button type="button" onClick={() => onNavigate('login')} className="underline underline-offset-4 decoration-white/40 hover:decoration-white transition-all ml-1 font-bold">Sign In</button>
        </p>
      </div>
    </div>
  );
};


export default ResetPasswordForm;
