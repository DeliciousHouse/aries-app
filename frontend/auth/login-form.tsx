import React, { useState, useEffect } from 'react';
import { AuthView } from '../types';
import { recordLogin, verifyLogin } from '../services/supabase';


interface LoginFormProps {
  onNavigate: (view: AuthView) => void;
  onSubmit: (email: string) => void;
  onGoogleSuccess: () => void;
  onSlackClick: () => void;
  isLoading: boolean;
  successMessage: string | null;
  authError?: string | null;
}


const LoginForm: React.FC<LoginFormProps> = ({
  onNavigate,
  onSubmit,
  onGoogleSuccess,
  onSlackClick,
  isLoading,
  authError,
  successMessage,
}) => {
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
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
    if (!email || !password) return;


    setIsLoggingIn(true);
    try {
      await verifyLogin(email, password);
      await recordLogin(email);
      onSubmit(email);
    } catch (err: any) {
      setError(err.message || "Invalid email or password.");
      setIsLoggingIn(false);
    }
  };


  return (
    <div className="auth-container animate-in fade-in duration-1000" style={{ fontFamily: "'Inter', sans-serif" }}>
      {/* Header Section */}
      <div className="flex flex-col items-center mb-6 text-center">
        <div className="w-[100px] h-[100px] mb-6">
          <img
            src="/aries.webp"
            alt="Aries AI Logo"
            className="w-full h-full object-contain filter drop-shadow-[0_0_20px_rgba(255,255,255,0.2)]"
          />
        </div>
        <h1 className="text-[26px] font-medium text-white tracking-[0.25em] mb-[20px] uppercase leading-none pl-[0.25em]" style={{ marginBottom: '20px' }}>ARIES AI</h1>
        <p className="text-white italic text-[18px] tracking-wide font-normal mt-[20px] opacity-90">Welcome back to Aries</p>
      </div>


      {/* Glassmorphic Form Card */}
      <div className="auth-card animate-in fade-in zoom-in-95 duration-500">
        {successMessage && (
          <div className="mb-6 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400 text-sm font-medium text-center">
            {successMessage}
          </div>
        )}


        {(error || authError) && (
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
              {authError || error}
            </span>
          </div>
        )}


        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="auth-label">Email</label>
            <input
              type="email"
              required
              className="auth-input"
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="auth-label">Password</label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                required
                className="auth-input pr-12"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className={`absolute right-4 top-1/2 -translate-y-1/2 ${showPassword ? 'text-white' : 'text-white/40'} hover:text-white transition-colors`}
              >
                {showPassword ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.892 7.892L21 21m-2.228-2.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.644C3.399 8.049 7.21 5 12 5c4.79 0 8.601 3.049 9.964 6.678.114.303.114.626 0 .93C20.601 15.951 16.79 19 12 19c-4.479 0-8.268-2.943-9.543-7z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                )}
              </button>
            </div>
          </div>


          <div className="flex items-center justify-between text-[14px] text-white mt-[10px] pb-[4px]">
            <label className="flex items-center gap-3 cursor-pointer group">
              <input 
                type="checkbox" 
                className="w-4 h-4 rounded-[4px] border border-white/40 bg-black/40 flex-shrink-0 appearance-none outline-none checked:bg-white checked:border-white relative transition-all before:content-['✓'] before:absolute before:inset-0 before:flex before:items-center before:justify-center before:text-[#7A001E] before:text-[10px] before:font-bold before:opacity-0 checked:before:opacity-100" 
              />
              <span className="font-medium group-hover:text-white transition-all">Remember me</span>
            </label>
            <button
              type="button"
              onClick={() => onNavigate('forgot-password')}
              className="hover:underline decoration-white/70 transition-all font-medium py-1"
            >
              Forgot password?
            </button>
          </div>


          <button
            type="submit"
            disabled={isLoading || isLoggingIn}
            className="auth-primary-button"
          >
            {isLoggingIn ? 'Logging in...' : 'LOGIN'}
          </button>
        </form>


        <div className="auth-separator">
          <div className="auth-separator-line"></div>
          <span className="auth-separator-label">
            OR CONTINUE WITH
          </span>
        </div>


        <div className="auth-social-grid">
          <button
            type="button"
            onClick={onGoogleSuccess}
            className="auth-social-button"
          >
            <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            <span>Continue with Google</span>
          </button>


          <button
            type="button"
            onClick={onSlackClick}
            className="auth-social-button"
          >
            <svg className="w-[18px] h-[18px]" viewBox="0 0 122.8 122.8">
              <path fill="#e01e5a" d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.4 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"/><path fill="#36c5f0" d="M45.1 25.8c-7.1 0-12.9-5.8-12.9-12.9S38 0 45.1 0s12.9 5.8 12.9 12.9v12.9H45.1zm0 6.4c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58 0 52.2 0 45.1s5.8-12.9 12.9-12.9h32.2z"/><path fill="#2eb67d" d="M97 45.1c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.1zm-6.4 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C77.7 5.8 83.5 0 90.6 0s12.9 5.8 12.9 12.9v32.2z"/><path fill="#ecb22e" d="M77.7 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.4c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.7z"/>
            </svg>
            <span>Continue with Slack</span>
          </button>
        </div>
      </div>


      <div className="text-center font-medium text-[15px]" style={{ marginTop: '20px', color: '#FFFFFF' }}>
        <p>
          Don't have an account? <button onClick={() => onNavigate('signup')} className="underline underline-offset-4 decoration-white/40 hover:decoration-white hover:text-white transition-all ml-1 font-bold">Create account</button>
        </p>
      </div>


    </div>
  );
};


export default LoginForm;



