"use client";

import React, { useState, useEffect } from 'react';
import { AuthView } from '../types';
import { registerUserAction } from '@/app/actions/auth';
import { getInvitationByToken } from '../services/supabase';
import { AriesMark } from '@/frontend/donor/ui';
import {
  getEmailFieldError,
  getRequiredFieldError,
  isValidEmailAddress,
  useDisabledUntilValid,
} from '@/lib/form-validation';

interface SignUpFormProps {
  onNavigate: (view: AuthView, email?: string) => void;
  onSubmit: (email: string, password: string) => Promise<{ success: boolean }> | { success: boolean };
  onGoogleSuccess: () => void;
  isLoading: boolean;
  authError?: string | null;
  savedStateMessage?: string | null;
  defaultEmail?: string;
}

const PASSWORD_POLICY_REGEX = /^(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).{8,}$/;
const PASSWORD_POLICY_MESSAGE =
  'Password must be at least 8 characters long and include an uppercase letter, a number, and a special character.';

type InvitationData = {
  email: string;
  organizations?: {
    name?: string;
  } | null;
};

const SignUpForm: React.FC<SignUpFormProps> = ({
  onNavigate,
  onSubmit,
  onGoogleSuccess,
  isLoading,
  authError,
  savedStateMessage,
  defaultEmail,
}) => {
  const [email, setEmail] = useState(defaultEmail || '');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [orgNameInput, setOrgNameInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorLocal, setErrorLocal] = useState<string | null>(null);
  const [invitationData, setInvitationData] = useState<InvitationData | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [fullNameTouched, setFullNameTouched] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);


  useEffect(() => {
    setEmail(defaultEmail || '');
  }, [defaultEmail]);


  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('invite');
    const emailParam = params.get('email');
    if (token) {
      getInvitationByToken(token).then(data => {
        const invitation = data as InvitationData | null;
        if (invitation) {
          setInvitationData(invitation);
          setOrgNameInput(invitation.organizations?.name || '');
          setEmail(invitation.email);


          const namePart = invitation.email.split('@')[0];
          const firstName = namePart.split(/[._+-]/)[0];
          setFullName(firstName.charAt(0).toUpperCase() + firstName.slice(1));
        }
      });
      return;
    }

    if (emailParam) {
      setEmail(emailParam);
    }
  }, []);


  useEffect(() => {
    if (errorLocal) {
      const timer = setTimeout(() => {
        setErrorLocal(null);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [errorLocal]);


  const passwordMeetsPolicy = PASSWORD_POLICY_REGEX.test(password);
  const emailIsValid = isValidEmailAddress(email);
  const fullNameIsValid = fullName.trim().length > 0;
  const fullNameError = fullNameTouched ? getRequiredFieldError(fullName, 'your full name') : null;
  const emailError = emailTouched ? getEmailFieldError(email) : null;
  const passwordError = !passwordTouched
    ? null
    : !password.trim()
      ? getRequiredFieldError(password, 'your password')
      : passwordMeetsPolicy
        ? null
        : PASSWORD_POLICY_MESSAGE;
  const canSubmit = fullNameIsValid && emailIsValid && passwordMeetsPolicy;
  const submitDisabled = useDisabledUntilValid(canSubmit, isLoading || isSubmitting);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading || isSubmitting) return;
    setFullNameTouched(true);
    setEmailTouched(true);
    setPasswordTouched(true);
    if (!fullNameIsValid || !emailIsValid || !password.trim()) return;

    // Password Validation
    if (!PASSWORD_POLICY_REGEX.test(password)) {
      setErrorLocal(null);
      return;
    }

    setIsSubmitting(true);
    setErrorLocal(null);
    try {
      const result = await registerUserAction({
        email,
        password,
        fullName,
        orgName: orgNameInput
      });

      if (!result.success) {
        setErrorLocal(result.error === 'User already exists' ? 'This email is already registered. Please sign in instead.' : result.error);
        setIsSubmitting(false);
        return;
      }

      const submitResult = await onSubmit(email, password);
      if (!submitResult.success) {
        setIsSubmitting(false);
      }
    } catch (error: unknown) {
      setErrorLocal(error instanceof Error ? error.message : "Signup failed.");
      setIsSubmitting(false);
    }
  };


  return (
    <div className="max-w-md mx-auto">
      {/* Header Section */}
      <div className="text-center mb-8">
        <div className="flex flex-col items-center mb-2">
          <AriesMark sizeClassName="w-28 h-28" />
          <span className="text-2xl font-bold tracking-tight text-white -mt-4">Aries AI</span>
        </div>
        <h1 className="text-3xl font-bold mb-2 text-white">
          {invitationData ? `Joining ${invitationData.organizations?.name || 'your organization'}` : "Create Account"}
        </h1>
        <p className="text-white/60">
          Plan, approve, and launch campaigns from one workspace.
        </p>
      </div>

      {savedStateMessage ? (
        <div className="mb-6 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-100">
          {savedStateMessage}
        </div>
      ) : null}

      <div className="glass p-8 md:p-10 rounded-2xl border border-white/10 relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-secondary to-primary" />
        
        {(authError || errorLocal) && (
          <div className="mb-6 rounded-xl border border-red-500/20 bg-gradient-to-r from-red-500/15 via-red-500/5 to-transparent backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.3)] flex items-center gap-3 p-4 border-l-4 border-l-red-500">
            <div className="shrink-0 rounded-full bg-red-500/20 flex items-center justify-center border border-red-500/30 w-6 h-6">
              <svg className="text-red-400 w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <span className="text-red-100/90 text-xs font-bold tracking-normal leading-snug">{authError || errorLocal}</span>
          </div>
        )}


        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="signup-full-name" className="block text-sm font-medium text-white/80 mb-1.5">Full Name</label>
            <input 
              id="signup-full-name"
              type="text" 
              required 
              className="block w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/30 focus:outline-none transition-all" 
              placeholder="John Doe" 
              value={fullName} 
              onChange={(e) => setFullName(e.target.value)}
              onBlur={() => setFullNameTouched(true)}
              aria-invalid={fullNameError ? true : undefined}
              aria-describedby={fullNameError ? 'signup-full-name-error' : undefined}
            />
            {fullNameError ? (
              <p id="signup-full-name-error" role="alert" className="mt-2 text-sm text-red-300">
                {fullNameError}
              </p>
            ) : null}
          </div>


          <div>
            <label className="block text-sm font-medium text-white/80 mb-1.5">Organization {!invitationData && "(Optional)"}</label>
            <input 
              type="text" 
              className="block w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/30 focus:outline-none transition-all disabled:opacity-60" 
              placeholder="e.g. Acme Corp" 
              value={orgNameInput} 
              onChange={(e) => setOrgNameInput(e.target.value)} 
              disabled={!!invitationData} 
            />
          </div>


          <div>
            <label htmlFor="signup-email" className="block text-sm font-medium text-white/80 mb-1.5">Email Address</label>
            <input 
              id="signup-email"
              type="email" 
              required 
              className="block w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/30 focus:outline-none transition-all disabled:opacity-60" 
              placeholder="name@company.com" 
              value={email} 
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setEmailTouched(true)}
              disabled={!!invitationData} 
              aria-invalid={emailError ? true : undefined}
              aria-describedby={emailError ? 'signup-email-error' : undefined}
            />
            {emailError ? (
              <p id="signup-email-error" role="alert" className="mt-2 text-sm text-red-300">
                {emailError}
              </p>
            ) : null}
          </div>


          <div>
            <label htmlFor="signup-password" className="block text-sm font-medium text-white/80 mb-1.5">Password</label>
            <div className="relative">
              <input 
                id="signup-password"
                type={showPassword ? 'text' : 'password'} 
                required 
                className="block w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/30 focus:outline-none transition-all" 
                placeholder="••••••••" 
                value={password} 
                onChange={(e) => setPassword(e.target.value)}
                onBlur={() => setPasswordTouched(true)}
                aria-invalid={passwordError ? true : undefined}
                aria-describedby={passwordError ? 'signup-password-error' : undefined}
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
            {passwordError ? (
              <p id="signup-password-error" role="alert" className="mt-2 text-sm text-red-300">
                {passwordError}
              </p>
            ) : null}
          </div>


          <button
            type="submit"
            disabled={submitDisabled}
            className="w-full py-3 px-4 bg-gradient-to-r from-primary to-secondary hover:opacity-90 text-white font-medium rounded-xl transition-all shadow-[0_0_20px_rgba(124,58,237,0.3)] hover:shadow-[0_0_30px_rgba(124,58,237,0.5)] flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {isSubmitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>


        {!invitationData && (
          <div className="mt-8">
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-white/10" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-[#0B0A14] text-white/40 uppercase tracking-wider">or sign up with</span>
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
                <span className="text-white/80 group-hover:text-white">Google</span>
              </button>
            </div>
          </div>
        )}
      </div>


      <div className="text-center mt-8">
        <p className="text-sm text-white/60">
          Already have an account?{' '}
          <button type="button" onClick={() => onNavigate('login', email)} className="font-bold text-white hover:text-primary transition-colors">Sign In</button>
        </p>
      </div>
    </div>
  );
};


export default SignUpForm;
