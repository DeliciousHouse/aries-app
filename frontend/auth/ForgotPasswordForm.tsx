

import React, { useState } from 'react';
import { AuthView } from '../types';
import { recordPasswordResetRequest } from '../services/supabase';
import { sendOTPEmail } from '../services/emailService';


interface ForgotPasswordFormProps {
  onNavigate: (view: AuthView) => void;
  onSubmit: (email: string, code: string) => void;
  isLoading: boolean;
}


const ForgotPasswordForm: React.FC<ForgotPasswordFormProps> = ({ onNavigate, onSubmit, isLoading: parentLoading }) => {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;


    setIsLoading(true);
    setError(null);


    try {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      await recordPasswordResetRequest(email, code);
      const result = await sendOTPEmail(email, code, 'reset');


      if (result.success) {
        onSubmit(email, code);
      } else {
        setError(result.error || "Delivery failed. Please ensure the email is correct.");
      }


    } catch (err: any) {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };


  const inputStyle = "w-full px-[16px] py-[10px] rounded-xl border border-white/20 bg-black/10 text-white placeholder-[#851028] placeholder:font-medium placeholder:text-[15px] focus:outline-none focus:border-white/40 transition-all text-[15px]";
  const labelStyle = "block text-sm font-semibold text-white/90 mb-2";


  return (
    <div className="auth-container animate-in fade-in duration-1000" style={{ fontFamily: "'Inter', sans-serif" }}>
      <div className="w-full max-w-[460px] flex flex-col">
        <button
          onClick={() => onNavigate('login')}
          className="self-start flex items-center gap-2 text-white/40 hover:text-white mb-8 transition-colors group font-bold text-xs uppercase tracking-widest"
        >
          <svg className="w-4 h-4 group-hover:-translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Login
        </button>


        <div className="flex flex-col items-center mb-6 text-center">
          <div className="w-[100px] h-[100px] mb-6">
            <img src="/aries.webp" alt="Aries AI Logo" className="w-full h-full object-contain filter drop-shadow-[0_0_20px_rgba(255,255,255,0.2)]" />
          </div>
          <h1 className="text-[26px] font-medium text-white tracking-[0.25em] mb-[20px] uppercase leading-none pl-[0.25em]" style={{ marginBottom: '20px' }}>RECOVERY</h1>
          <p className="text-white italic text-[18px] tracking-wide font-normal mt-[20px] opacity-90">Reset your access to Aries AI</p>
        </div>


        <div className="auth-card animate-in fade-in zoom-in-95 duration-500">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <label className="auth-label">Account Email</label>
            <input
              type="email"
              required
              className="auth-input"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>


          {error && (
            <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-xs font-bold transition-all text-center">
              {error}
            </div>
          )}


          <button
            type="submit"
            disabled={isLoading || parentLoading || !email}
            className="auth-primary-button"
          >
            {isLoading || parentLoading ? 'Locating Account...' : 'Send Recovery Code'}
          </button>
        </form>
      </div>
    </div>
    </div>
  );
};


export default ForgotPasswordForm;



