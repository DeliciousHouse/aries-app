"use client";

import React, { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import AuthLayout from '@/frontend/auth/auth-layout';
import InviteAcceptForm from '@/frontend/auth/invite-accept-form';

type ValidationState =
  | { phase: 'checking' }
  | { phase: 'valid'; email: string }
  | { phase: 'invalid' };

export default function InviteAcceptPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = (searchParams.get('token') || '').trim();
  const [validation, setValidation] = useState<ValidationState>({ phase: 'checking' });
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setValidation({ phase: 'invalid' });
      return;
    }
    (async () => {
      try {
        const response = await fetch(`/api/auth/invite/validate?token=${encodeURIComponent(token)}`);
        const data = (await response.json().catch(() => null)) as { valid?: boolean; email?: string } | null;
        if (cancelled) return;
        if (response.ok && data?.valid) {
          setValidation({ phase: 'valid', email: typeof data.email === 'string' ? data.email : '' });
        } else {
          setValidation({ phase: 'invalid' });
        }
      } catch {
        if (!cancelled) setValidation({ phase: 'invalid' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSubmit = async (password: string): Promise<void> => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/auth/invite/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
        const responseMessage = typeof data?.error === 'string' ? data.error.trim() : '';
        throw new Error(responseMessage || 'Failed to set your password. Try again.');
      }

      router.push('/login?invited=success');
    } finally {
      setIsLoading(false);
    }
  };

  if (validation.phase === 'checking') {
    return (
      <AuthLayout>
        <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-center text-white/70">
          Checking your invite…
        </div>
      </AuthLayout>
    );
  }

  if (validation.phase === 'invalid') {
    return (
      <AuthLayout>
        <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-center text-white/80 space-y-4">
          <p className="text-lg font-semibold text-white">This invite link is invalid or has expired.</p>
          <p className="text-sm text-white/60">
            Ask a workspace admin to resend your invite, then open the new link.
          </p>
          <button
            type="button"
            onClick={() => router.push('/login')}
            className="underline underline-offset-4 decoration-white/40 hover:decoration-white transition-all font-semibold"
          >
            Back to sign in
          </button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="flex justify-center w-full">
        <InviteAcceptForm
          email={validation.email}
          onSignIn={() => router.push('/login')}
          onSubmit={handleSubmit}
          isLoading={isLoading}
        />
      </div>
    </AuthLayout>
  );
}
