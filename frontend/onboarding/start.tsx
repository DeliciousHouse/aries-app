"use client";

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type {
  OnboardingStartError,
  OnboardingStartRequest,
  OnboardingStartSuccess
} from '@/lib/api/onboarding';
import { useOnboardingStart } from '@/hooks/use-onboarding-start';
import { Button, ButtonLink } from '@/components/redesign/primitives/button';
import { Card } from '@/components/redesign/primitives/card';
import { TextInput } from '@/components/redesign/primitives/input';

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
    <div className="rd-workflow-grid rd-workflow-grid--2">
      <Card>
        <form onSubmit={onSubmit} style={{ display: 'grid', gap: '1rem' }}>
          <div>
            <p className="rd-section-label">Onboarding launch</p>
            <h1 style={{ margin: '0.8rem 0 0.5rem', fontFamily: 'var(--rd-font-display)', fontSize: '2rem' }}>
              Start tenant onboarding through the Aries API
            </h1>
            <p className="rd-section-description">
              Collect the tenant identity and onboarding metadata needed to begin the parity onboarding workflow without exposing any workflow internals to the browser.
            </p>
          </div>

          {fields.map((field) => (
            <label key={field.label} className="rd-field">
              <span className="rd-label">{field.label}</span>
              <TextInput
                value={field.value}
                placeholder={field.placeholder}
                onChange={(event) => field.setValue(event.currentTarget.value)}
              />
            </label>
          ))}

          <Button type="submit" disabled={loading || !resolvedTenantId || !resolvedSignupEventId}>
            {loading ? 'Starting onboarding…' : 'Start onboarding'}
          </Button>
        </form>
      </Card>

      <Card>
        <div style={{ display: 'grid', gap: '1rem' }}>
          <p className="rd-section-label">Status handoff</p>
          <h2 style={{ margin: '0.8rem 0 0.5rem', fontFamily: 'var(--rd-font-display)', fontSize: '1.6rem' }}>
            What happens after submission
          </h2>
          <div className="rd-summary-list">
            {[
              'Aries posts the onboarding request to its internal API route.',
              'The route delegates server-side through OpenClaw.',
              'You are redirected to the onboarding status screen with stable query parameters.',
            ].map((item) => (
              <div key={item} className="rd-glass" style={{ padding: '1rem', borderRadius: '1rem' }}>{item}</div>
            ))}
          </div>

          {loading ? <div className="rd-alert rd-alert--info">Submitting onboarding start request…</div> : null}
          {onboardingStart.error ? <div className="rd-alert rd-alert--danger">Client error: {onboardingStart.error.message}</div> : null}

          {result && 'status' in result && result.status === 'ok' ? (
            <div className="rd-alert rd-alert--success">
              <div>
                <strong style={{ display: 'block', marginBottom: '0.25rem' }}>Onboarding accepted</strong>
                <span>Continue to the status route if the automatic redirect does not occur.</span>
                <div style={{ marginTop: '0.75rem' }}>
                  <ButtonLink href={resolveOnboardingStatusHref(result, resolvedTenantId, resolvedSignupEventId)} variant="secondary">
                    Open onboarding status
                  </ButtonLink>
                </div>
              </div>
            </div>
          ) : null}

          {result?.onboarding_status === 'error' ? (
            <div className="rd-alert rd-alert--danger">
              <div>
                <strong style={{ display: 'block', marginBottom: '0.25rem' }}>Onboarding failed</strong>
                <span>{result.reason}</span>
                {result.message ? <p style={{ margin: '0.5rem 0 0' }}>{result.message}</p> : null}
              </div>
            </div>
          ) : null}

          <div className="rd-json-panel"><code>{statusHref}</code></div>
        </div>
      </Card>
    </div>
  );
}
