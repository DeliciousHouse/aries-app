"use client";

import React, { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import AuthLayout from '@/frontend/auth/auth-layout';
import InviteAcceptForm from '@/frontend/auth/invite-accept-form';

type AbsorbViewer = { signedIn: boolean; email: string | null; matchesInvite: boolean };

type ValidationState =
  | { phase: 'checking' }
  | { phase: 'valid'; email: string }
  | {
      phase: 'absorb';
      email: string;
      workspaceName: string | null;
      inviterName: string | null;
      roleLabel: string;
      viewer: AbsorbViewer;
    }
  // Multi-workspace Phase 2: an existing ACTIVE account joining an additional
  // workspace — activation only, no password step, no absorb.
  | {
      phase: 'join';
      email: string;
      workspaceName: string | null;
      inviterName: string | null;
      roleLabel: string;
      viewer: AbsorbViewer;
    }
  // Idempotent already-a-member state (disclosed only to the invited account).
  | { phase: 'already_member' }
  | { phase: 'invalid' };

type AbsorbFlowState =
  | { step: 'consent'; busy: 'accept' | 'decline' | null; error: string | null }
  | { step: 'declined' }
  | { step: 'workspace_in_use' };

type JoinFlowState =
  | { step: 'consent'; busy: 'accept' | 'decline' | null; error: string | null }
  | { step: 'declined' }
  // Decision 13 upgrade-required variant: the accept was refused because the
  // free plan includes one workspace — the invitation stays valid.
  | { step: 'requires_pro' };

export default function InviteAcceptPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = (searchParams.get('token') || '').trim();
  const [validation, setValidation] = useState<ValidationState>({ phase: 'checking' });
  const [isLoading, setIsLoading] = useState(false);
  const [absorb, setAbsorb] = useState<AbsorbFlowState>({ step: 'consent', busy: null, error: null });
  const [join, setJoin] = useState<JoinFlowState>({ step: 'consent', busy: null, error: null });

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setValidation({ phase: 'invalid' });
      return;
    }
    (async () => {
      try {
        const response = await fetch(`/api/auth/invite/validate?token=${encodeURIComponent(token)}`);
        const data = (await response.json().catch(() => null)) as {
          valid?: boolean;
          alreadyAccepted?: boolean;
          email?: string;
          mode?: string;
          workspaceName?: string | null;
          inviterName?: string | null;
          roleLabel?: string;
          viewer?: AbsorbViewer;
        } | null;
        if (cancelled) return;
        if (response.ok && data?.valid) {
          const email = typeof data.email === 'string' ? data.email : '';
          if (data.mode === 'absorb' || data.mode === 'join') {
            setValidation({
              phase: data.mode,
              email,
              workspaceName: typeof data.workspaceName === 'string' ? data.workspaceName : null,
              inviterName: typeof data.inviterName === 'string' ? data.inviterName : null,
              roleLabel: typeof data.roleLabel === 'string' ? data.roleLabel : 'Editor',
              viewer: data.viewer ?? { signedIn: false, email: null, matchesInvite: false },
            });
          } else {
            setValidation({ phase: 'valid', email });
          }
        } else if (response.ok && data?.alreadyAccepted) {
          setValidation({ phase: 'already_member' });
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

  const handleAbsorbAction = async (intent: 'accept' | 'decline'): Promise<void> => {
    setAbsorb({ step: 'consent', busy: intent, error: null });
    try {
      const response = await fetch('/api/auth/invite/absorb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, intent }),
      });
      const data = (await response.json().catch(() => null)) as
        | { success?: boolean; error?: string; message?: string }
        | null;

      if (response.ok && data?.success) {
        if (intent === 'decline') {
          setAbsorb({ step: 'declined' });
          return;
        }
        // Hard navigation: the session's tenant claims re-hydrate from the DB,
        // so a full load lands the account in its new workspace.
        window.location.assign('/dashboard');
        return;
      }

      if (data?.error === 'workspace_in_use') {
        setAbsorb({ step: 'workspace_in_use' });
        return;
      }
      setAbsorb({
        step: 'consent',
        busy: null,
        error: (typeof data?.message === 'string' && data.message) || 'Something went wrong. Try again.',
      });
    } catch {
      setAbsorb({ step: 'consent', busy: null, error: 'Something went wrong. Try again.' });
    }
  };

  const handleJoinAction = async (intent: 'accept' | 'decline'): Promise<void> => {
    setJoin({ step: 'consent', busy: intent, error: null });
    try {
      const response = await fetch('/api/auth/invite/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, intent }),
      });
      const data = (await response.json().catch(() => null)) as
        | { success?: boolean; error?: string; message?: string }
        | null;

      if (response.ok && data?.success) {
        if (intent === 'decline') {
          setJoin({ step: 'declined' });
          return;
        }
        // Hard navigation ("you're in"): the session's tenant claims re-hydrate
        // from the DB, so a full load lands the account in the new workspace.
        window.location.assign('/dashboard');
        return;
      }

      if (response.status === 402 || data?.error === 'multi_workspace_requires_pro') {
        setJoin({ step: 'requires_pro' });
        return;
      }
      setJoin({
        step: 'consent',
        busy: null,
        error: (typeof data?.message === 'string' && data.message) || 'Something went wrong. Try again.',
      });
    } catch {
      setJoin({ step: 'consent', busy: null, error: 'Something went wrong. Try again.' });
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

  if (validation.phase === 'already_member') {
    return (
      <AuthLayout>
        <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-left text-white/80 space-y-4">
          <p className="text-lg font-semibold text-white">You&rsquo;re already a member.</p>
          <p className="text-sm text-white/60">
            This invitation was already accepted — the workspace is on your account.
          </p>
          <button
            type="button"
            onClick={() => window.location.assign('/dashboard')}
            className="rounded-xl border border-white/20 bg-white/10 px-5 py-3 text-sm font-semibold text-white hover:bg-white/20 transition-colors"
          >
            Open your dashboard
          </button>
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

  if (validation.phase === 'absorb') {
    return (
      <AuthLayout>
        <AbsorbConsentPanel
          email={validation.email}
          workspaceName={validation.workspaceName}
          inviterName={validation.inviterName}
          roleLabel={validation.roleLabel}
          viewer={validation.viewer}
          flow={absorb}
          signInHref={`/login?callbackUrl=${encodeURIComponent(`/invite/accept?token=${token}`)}`}
          onAccept={() => void handleAbsorbAction('accept')}
          onDecline={() => void handleAbsorbAction('decline')}
        />
      </AuthLayout>
    );
  }

  if (validation.phase === 'join') {
    return (
      <AuthLayout>
        <JoinConsentPanel
          email={validation.email}
          workspaceName={validation.workspaceName}
          inviterName={validation.inviterName}
          roleLabel={validation.roleLabel}
          viewer={validation.viewer}
          flow={join}
          signInHref={`/login?callbackUrl=${encodeURIComponent(`/invite/accept?token=${token}`)}`}
          onAccept={() => void handleJoinAction('accept')}
          onDecline={() => void handleJoinAction('decline')}
        />
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

/**
 * Absorb-orphan consent variant (multi-workspace plan Phase 0.5). The invited
 * email already backs an Aries account whose workspace is unused; accepting
 * folds that account into the inviting workspace. Consent requires being
 * signed in AS the invited account — the server re-verifies on the POST, this
 * panel just renders the matching auth state.
 */
function AbsorbConsentPanel(props: {
  email: string;
  workspaceName: string | null;
  inviterName: string | null;
  roleLabel: string;
  viewer: AbsorbViewer;
  flow: AbsorbFlowState;
  signInHref: string;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const workspace = props.workspaceName || 'the workspace';
  const invitedBy = props.inviterName ? `${props.inviterName} invited you` : 'You were invited';

  if (props.flow.step === 'declined') {
    return (
      <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-left text-white/80 space-y-3">
        <p className="text-lg font-semibold text-white">Invitation declined.</p>
        <p className="text-sm text-white/60">
          Nothing changed — your account and workspace stay exactly as they are. The invite link is
          no longer valid.
        </p>
      </div>
    );
  }

  if (props.flow.step === 'workspace_in_use') {
    return (
      <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-left text-white/80 space-y-3">
        <p className="text-lg font-semibold text-white">Your workspace is now in use.</p>
        <p className="text-sm text-white/60">
          Your current workspace has members or activity, so it can no longer be folded into{' '}
          {workspace}. This invitation is no longer valid — ask the admin who invited you to reach
          out to support if you still want to join.
        </p>
      </div>
    );
  }

  if (!props.viewer.signedIn) {
    return (
      <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-left text-white/80 space-y-4">
        <p className="text-lg font-semibold text-white">
          {invitedBy} to join {workspace}.
        </p>
        <p className="text-sm text-white/60">
          This invitation is for <span className="font-semibold text-white">{props.email}</span>,
          which already has an Aries AI account. Sign in with that account to review the invitation.
        </p>
        <a
          href={props.signInHref}
          className="inline-block rounded-xl border border-white/20 bg-white/10 px-5 py-3 text-sm font-semibold text-white hover:bg-white/20 transition-colors"
        >
          Sign in to continue
        </a>
      </div>
    );
  }

  if (!props.viewer.matchesInvite) {
    return (
      <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-left text-white/80 space-y-4">
        <p className="text-lg font-semibold text-white">
          This invitation is for {props.email}.
        </p>
        <p className="text-sm text-white/60">
          {props.viewer.email
            ? `You're signed in as ${props.viewer.email}. `
            : "You're signed in as a different account. "}
          Sign in with the invited account to review this invitation.
        </p>
        <a
          href={props.signInHref}
          className="inline-block rounded-xl border border-white/20 bg-white/10 px-5 py-3 text-sm font-semibold text-white hover:bg-white/20 transition-colors"
        >
          Switch accounts
        </a>
      </div>
    );
  }

  const busy = props.flow.busy;
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-left text-white/80 space-y-4">
      <p className="text-lg font-semibold text-white">
        Fold your unused workspace into {workspace}?
      </p>
      <div className="space-y-2 text-sm text-white/70">
        <p>
          {invitedBy} to join <span className="font-semibold text-white">{workspace}</span> as{' '}
          {/^[aeiou]/i.test(props.roleLabel) ? 'an' : 'a'}{' '}
          <span className="font-semibold text-white">{props.roleLabel}</span>. You're accepting as{' '}
          <span className="font-semibold text-white">{props.email}</span>.
        </p>
        <p>
          Your current workspace is empty and will be left behind — your account moves into{' '}
          {workspace}, keeping your existing sign-in.
        </p>
        <p>Admins of {workspace} will see your name and email.</p>
      </div>

      {props.flow.error ? (
        <p role="alert" className="text-sm text-red-300">
          {props.flow.error}
        </p>
      ) : null}

      <div className="flex items-center gap-4 pt-2">
        <button
          type="button"
          onClick={props.onAccept}
          disabled={busy !== null}
          className="rounded-xl border border-white/20 bg-white/10 px-5 py-3 text-sm font-semibold text-white hover:bg-white/20 transition-colors disabled:opacity-50"
        >
          {busy === 'accept' ? 'Joining…' : `Join ${workspace}`}
        </button>
        <button
          type="button"
          onClick={props.onDecline}
          disabled={busy !== null}
          className="text-sm font-semibold text-white/70 underline underline-offset-4 decoration-white/40 hover:decoration-white hover:text-white transition-all disabled:opacity-50"
        >
          {busy === 'decline' ? 'Declining…' : 'Decline'}
        </button>
      </div>
    </div>
  );
}

/**
 * Join-as-existing-account consent variant (multi-workspace plan Phase 2).
 * The invited email backs an active Aries account; accepting ADDS this
 * workspace to that account — no password step, no absorb, other workspaces
 * untouched. Consent requires being signed in AS the invited account — the
 * server re-verifies on the POST, this panel just renders the matching auth
 * state. Disclosure order per the design review: workspace + inviter → role
 * in plain words → "as <email>" → what joining means.
 */
function JoinConsentPanel(props: {
  email: string;
  workspaceName: string | null;
  inviterName: string | null;
  roleLabel: string;
  viewer: AbsorbViewer;
  flow: JoinFlowState;
  signInHref: string;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const workspace = props.workspaceName || 'the workspace';
  const invitedBy = props.inviterName ? `${props.inviterName} invited you` : 'You were invited';
  const roleArticle = /^[aeiou]/i.test(props.roleLabel) ? 'an' : 'a';

  if (props.flow.step === 'declined') {
    return (
      <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-left text-white/80 space-y-3">
        <p className="text-lg font-semibold text-white">Invitation declined.</p>
        <p className="text-sm text-white/60">
          Nothing changed — your account and workspaces stay exactly as they are. The invite link
          is no longer valid; the admin can send a new one if you change your mind.
        </p>
      </div>
    );
  }

  if (props.flow.step === 'requires_pro') {
    // Upgrade-required variant (Decision 13). Workspace context stays visible;
    // the paywall is framed as the account's state, not an error — and the
    // invitation explicitly survives.
    return (
      <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-left text-white/80 space-y-4">
        <p className="text-lg font-semibold text-white">Joining {workspace} needs Aries Pro.</p>
        <div className="space-y-2 text-sm text-white/70">
          <p>
            {invitedBy} to join <span className="font-semibold text-white">{workspace}</span> as{' '}
            {roleArticle} <span className="font-semibold text-white">{props.roleLabel}</span>, accepting
            as <span className="font-semibold text-white">{props.email}</span>.
          </p>
          <p>
            Your account is on the free plan, which includes one workspace. Joining {workspace} as a
            second workspace needs Aries Pro.
          </p>
          <p>
            Contact {props.inviterName ? <span className="font-semibold text-white">{props.inviterName}</span> : 'the workspace owner'}{' '}
            about upgrading your account, then open this invite link again.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.location.assign('/dashboard')}
          className="text-sm font-semibold text-white/70 underline underline-offset-4 decoration-white/40 hover:decoration-white hover:text-white transition-all"
        >
          Not now — your invitation stays valid
        </button>
      </div>
    );
  }

  if (!props.viewer.signedIn) {
    return (
      <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-left text-white/80 space-y-4">
        <p className="text-lg font-semibold text-white">
          {invitedBy} to join {workspace}.
        </p>
        <p className="text-sm text-white/60">
          This invitation is for <span className="font-semibold text-white">{props.email}</span>,
          which already has an Aries AI account. Sign in with that account to review the invitation
          — there is no password step.
        </p>
        <a
          href={props.signInHref}
          className="inline-block rounded-xl border border-white/20 bg-white/10 px-5 py-3 text-sm font-semibold text-white hover:bg-white/20 transition-colors"
        >
          Sign in to continue
        </a>
      </div>
    );
  }

  if (!props.viewer.matchesInvite) {
    return (
      <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-left text-white/80 space-y-4">
        <p className="text-lg font-semibold text-white">This invitation is for {props.email}.</p>
        <p className="text-sm text-white/60">
          {props.viewer.email
            ? `You're signed in as ${props.viewer.email}. `
            : "You're signed in as a different account. "}
          Sign in with the invited account to review this invitation.
        </p>
        <a
          href={props.signInHref}
          className="inline-block rounded-xl border border-white/20 bg-white/10 px-5 py-3 text-sm font-semibold text-white hover:bg-white/20 transition-colors"
        >
          Switch accounts
        </a>
      </div>
    );
  }

  const busy = props.flow.busy;
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-left text-white/80 space-y-4">
      <p className="text-lg font-semibold text-white">
        {invitedBy} to join {workspace}.
      </p>
      <div className="space-y-2 text-sm text-white/70">
        <p>
          You&rsquo;ll join <span className="font-semibold text-white">{workspace}</span> as{' '}
          {roleArticle} <span className="font-semibold text-white">{props.roleLabel}</span>.
          You&rsquo;re accepting as <span className="font-semibold text-white">{props.email}</span>.
        </p>
        <p>
          This adds {workspace} to your existing account — your sign-in, password, and other
          workspaces stay exactly as they are.
        </p>
        <p>Admins of {workspace} will see your name and email.</p>
      </div>

      {props.flow.error ? (
        <p role="alert" className="text-sm text-red-300">
          {props.flow.error}
        </p>
      ) : null}

      <div className="flex items-center gap-4 pt-2">
        <button
          type="button"
          onClick={props.onAccept}
          disabled={busy !== null}
          className="rounded-xl border border-white/20 bg-white/10 px-5 py-3 text-sm font-semibold text-white hover:bg-white/20 transition-colors disabled:opacity-50"
        >
          {busy === 'accept' ? 'Joining…' : `Join ${workspace}`}
        </button>
        <button
          type="button"
          onClick={props.onDecline}
          disabled={busy !== null}
          className="text-sm font-semibold text-white/70 underline underline-offset-4 decoration-white/40 hover:decoration-white hover:text-white transition-all disabled:opacity-50"
        >
          {busy === 'decline' ? 'Declining…' : 'Decline'}
        </button>
      </div>
    </div>
  );
}
