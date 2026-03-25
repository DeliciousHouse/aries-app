"use client";

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, Rocket, Sparkles } from 'lucide-react';
import type {
  OnboardingStartError,
  OnboardingStartRequest,
  OnboardingStartSuccess
} from '@/lib/api/onboarding';
import { useOnboardingStart } from '@/hooks/use-onboarding-start';

type StartResult = OnboardingStartSuccess | OnboardingStartError | null;

type MetadataDraft = {
  business_name?: string;
  contact_name?: string;
  assistant_name_preference?: string;
  user_name_preference?: string;
  preferred_channel?: string;
  backup_channel?: string;
  owner_user_id?: string;
  proposed_slug?: string;
};

export function buildOnboardingStatusHref(tenantId: string, signupEventId: string): string {
  return `/onboarding/status?tenant_id=${encodeURIComponent(tenantId)}&signup_event_id=${encodeURIComponent(signupEventId)}`;
}

export function resolveOnboardingStatusHref(
  result: Pick<OnboardingStartSuccess, 'tenant_id' | 'signup_event_id'> | null,
  fallbackTenantId: string,
  fallbackSignupEventId: string
): string {
  const tenantId = result?.tenant_id?.trim() || fallbackTenantId.trim();
  const signupEventId = result?.signup_event_id?.trim() || fallbackSignupEventId.trim();
  return buildOnboardingStatusHref(tenantId, signupEventId);
}

export default function OnboardingStartScreen(): JSX.Element {
  const router = useRouter();
  const onboardingStart = useOnboardingStart();

  const [tenantId, setTenantId] = useState('');
  const [proposedSlug, setProposedSlug] = useState('');
  const [tenantType, setTenantType] = useState('single_user');
  const [signupEventId, setSignupEventId] = useState('');

  const [businessName, setBusinessName] = useState('');
  const [contactName, setContactName] = useState('');
  const [assistantNamePreference, setAssistantNamePreference] = useState('');
  const [userNamePreference, setUserNamePreference] = useState('');
  const [preferredChannel, setPreferredChannel] = useState('');
  const [backupChannel, setBackupChannel] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<StartResult>(null);

  function compactMetadata(values: MetadataDraft): MetadataDraft | undefined {
    const metadata = Object.fromEntries(
      Object.entries(values).filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
    ) as MetadataDraft;

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  const resolvedTenantId = tenantId.trim() || proposedSlug.trim();
  const resolvedSignupEventId = signupEventId.trim();
  const statusHref = resolveOnboardingStatusHref(null, resolvedTenantId, resolvedSignupEventId);
  const fields: Array<{
    label: string;
    value: string;
    setValue: (next: string) => void;
    placeholder: string;
  }> = [
    { label: 'Tenant ID', value: tenantId, setValue: setTenantId, placeholder: 'tenant_alpha' },
    { label: 'Proposed Slug', value: proposedSlug, setValue: setProposedSlug, placeholder: 'tenant-alpha' },
    { label: 'Tenant Type', value: tenantType, setValue: setTenantType, placeholder: 'single_user' },
    { label: 'Signup Event ID', value: signupEventId, setValue: setSignupEventId, placeholder: 'signup_evt_123' },
    { label: 'Business Name', value: businessName, setValue: setBusinessName, placeholder: 'Acme Studio' },
    { label: 'Contact Name', value: contactName, setValue: setContactName, placeholder: 'Avery' },
    { label: 'Assistant Name Preference', value: assistantNamePreference, setValue: setAssistantNamePreference, placeholder: 'Aries' },
    { label: 'User Name Preference', value: userNamePreference, setValue: setUserNamePreference, placeholder: 'Avery' },
    { label: 'Preferred Channel', value: preferredChannel, setValue: setPreferredChannel, placeholder: 'instagram' },
    { label: 'Backup Channel', value: backupChannel, setValue: setBackupChannel, placeholder: 'linkedin' },
    { label: 'Owner User ID', value: ownerUserId, setValue: setOwnerUserId, placeholder: 'user_123' },
  ];

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setResult(null);
    setLoading(true);

    try {
      const body: OnboardingStartRequest = {
        tenant_id: resolvedTenantId,
        tenant_type: tenantType.trim(),
        signup_event_id: resolvedSignupEventId,
        metadata: compactMetadata({
          business_name: businessName,
          contact_name: contactName,
          assistant_name_preference: assistantNamePreference,
          user_name_preference: userNamePreference,
          preferred_channel: preferredChannel,
          backup_channel: backupChannel,
          owner_user_id: ownerUserId,
          proposed_slug: proposedSlug
        })
      };

      if (!body.metadata) {
        delete body.metadata;
      }

      const startResult = await onboardingStart.start(body);
      if (!startResult) {
        setResult(null);
        return;
      }
      setResult(startResult);

      if ('status' in startResult && startResult.status === 'ok') {
        router.push(resolveOnboardingStatusHref(startResult, resolvedTenantId, resolvedSignupEventId));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background px-6 py-10 md:px-8 lg:px-10">
      <div className="max-w-7xl mx-auto grid gap-6">
        <div className="glass rounded-[2.5rem] p-8 md:p-10">
          <p className="text-xs uppercase tracking-[0.3em] text-primary mb-3">Aries workflow</p>
          <h1 className="text-4xl font-bold mb-3">Tenant onboarding</h1>
          <p className="text-white/60">Transplanted donor-style workflow chrome connected to the real Aries onboarding routes.</p>
        </div>

        <div className="grid xl:grid-cols-2 gap-6">
      <div className="glass rounded-[2.5rem] p-8">
        <form onSubmit={onSubmit} className="space-y-5">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <Rocket className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/35">Onboarding launch</p>
                <h1 className="text-3xl font-bold">Start tenant onboarding through the Aries API</h1>
              </div>
            </div>
            <p className="text-white/60 leading-relaxed">
              Collect the tenant identity and onboarding metadata needed to begin the parity onboarding workflow without exposing any workflow internals to the browser.
            </p>
          </div>

          {fields.map((field) => (
            <label key={field.label} className="block space-y-2">
              <span className="text-xs uppercase tracking-[0.22em] text-white/35">{field.label}</span>
              <input
                value={field.value}
                placeholder={field.placeholder}
                onChange={(event) => field.setValue(event.currentTarget.value)}
                className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
              />
            </label>
          ))}

          <button
            type="submit"
            disabled={loading || !resolvedTenantId || !resolvedSignupEventId}
            className="w-full px-6 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20 disabled:opacity-60"
          >
            {loading ? 'Starting onboarding…' : 'Start onboarding'}
          </button>
        </form>
      </div>

      <div className="glass rounded-[2.5rem] p-8 space-y-5">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-2xl bg-secondary/10 border border-secondary/20 flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-secondary" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-white/35">Status handoff</p>
              <h2 className="text-3xl font-bold">What happens after submission</h2>
            </div>
          </div>
          <div className="space-y-3">
            {[
              'Aries posts the onboarding request to its internal API route.',
              'The route delegates server-side through OpenClaw.',
              'You are redirected to the onboarding status screen with stable query parameters.',
            ].map((item) => (
              <div key={item} className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 text-white/70">
                {item}
              </div>
            ))}
          </div>
        </div>

        {loading ? <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-4 text-cyan-100">Submitting onboarding start request…</div> : null}
        {onboardingStart.error ? <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100">Client error: {onboardingStart.error.message}</div> : null}

        {result && 'status' in result && result.status === 'ok' ? (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-5 text-emerald-100">
            <strong className="block mb-2">Onboarding accepted</strong>
            <span>Continue to the status route if the automatic redirect does not occur.</span>
            <div className="mt-4">
              <Link
                href={resolveOnboardingStatusHref(result, resolvedTenantId, resolvedSignupEventId)}
                className="inline-flex items-center gap-2 text-white bg-white/10 border border-white/10 px-5 py-3 rounded-full"
              >
                Open onboarding status
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        ) : null}

        {result?.onboarding_status === 'error' ? (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-5 text-red-100">
            <strong className="block mb-2">Onboarding failed</strong>
            <span>{result.reason}</span>
          </div>
        ) : null}

        <div className="rounded-[1.5rem] border border-white/10 bg-black/30 p-5 font-mono text-sm text-white/75 break-all">
          {statusHref}
        </div>
      </div>
        </div>
      </div>
    </div>
  );
}
