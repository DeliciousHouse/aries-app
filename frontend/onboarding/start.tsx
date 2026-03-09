"use client";

import { useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createOnboardingClient } from '../api/client/onboarding';
import type {
  OnboardingStartError,
  OnboardingStartRequest,
  OnboardingStartSuccess
} from '../api/contracts/onboarding';

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

export default function OnboardingStartScreen(): JSX.Element {
  const client = useMemo(() => createOnboardingClient(), []);
  const router = useRouter();

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
  const [clientError, setClientError] = useState<string | null>(null);

  function compactMetadata(values: MetadataDraft): MetadataDraft | undefined {
    const metadata = Object.fromEntries(
      Object.entries(values).filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
    ) as MetadataDraft;

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  const resolvedTenantId = tenantId.trim() || proposedSlug.trim();
  const resolvedSignupEventId = signupEventId.trim();
  const statusHref = `/onboarding/status?tenant_id=${encodeURIComponent(resolvedTenantId)}&signup_event_id=${encodeURIComponent(
    resolvedSignupEventId
  )}`;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setClientError(null);
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

      const startResult = await client.start(body);
      setResult(startResult);

      if ('status' in startResult && startResult.status === 'ok') {
        router.push(statusHref);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown client error';
      setClientError(message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section>
      <h1>Start Onboarding</h1>
      <p>Collect required onboarding start fields and submit to POST /api/onboarding/start.</p>

      <form onSubmit={onSubmit}>
        <label>
          Tenant ID (or leave blank and provide proposed slug)
          <input name="tenant_id" value={tenantId} onChange={(e) => setTenantId(e.currentTarget.value)} />
        </label>

        <label>
          Proposed Slug (used as tenant_id if tenant_id is blank)
          <input
            name="proposed_slug"
            value={proposedSlug}
            onChange={(e) => setProposedSlug(e.currentTarget.value)}
          />
        </label>

        <label>
          Tenant Type
          <input
            name="tenant_type"
            value={tenantType}
            onChange={(e) => setTenantType(e.currentTarget.value)}
            required
          />
        </label>

        <label>
          Signup Event ID
          <input
            name="signup_event_id"
            value={signupEventId}
            onChange={(e) => setSignupEventId(e.currentTarget.value)}
            required
          />
        </label>

        <label>
          Business Name
          <input
            name="business_name"
            value={businessName}
            onChange={(e) => setBusinessName(e.currentTarget.value)}
          />
        </label>

        <label>
          Contact Name
          <input
            name="contact_name"
            value={contactName}
            onChange={(e) => setContactName(e.currentTarget.value)}
          />
        </label>

        <label>
          Assistant Name Preference
          <input
            name="assistant_name_preference"
            value={assistantNamePreference}
            onChange={(e) => setAssistantNamePreference(e.currentTarget.value)}
          />
        </label>

        <label>
          User Name Preference
          <input
            name="user_name_preference"
            value={userNamePreference}
            onChange={(e) => setUserNamePreference(e.currentTarget.value)}
          />
        </label>

        <label>
          Preferred Channel
          <input
            name="preferred_channel"
            value={preferredChannel}
            onChange={(e) => setPreferredChannel(e.currentTarget.value)}
          />
        </label>

        <label>
          Backup Channel
          <input
            name="backup_channel"
            value={backupChannel}
            onChange={(e) => setBackupChannel(e.currentTarget.value)}
          />
        </label>

        <label>
          Owner User ID
          <input
            name="owner_user_id"
            value={ownerUserId}
            onChange={(e) => setOwnerUserId(e.currentTarget.value)}
          />
        </label>

        <button type="submit" disabled={loading || !resolvedTenantId || !resolvedSignupEventId}>
          {loading ? 'Starting onboarding…' : 'Start Onboarding'}
        </button>
      </form>

      {loading ? <p>Submitting onboarding start request…</p> : null}

      {clientError ? <p role="alert">Client error: {clientError}</p> : null}

      {result && 'status' in result && result.status === 'ok' ? (
        <div>
          <p>Onboarding start accepted. Redirecting to status…</p>
          <p>
            If you are not redirected, continue to <a href={statusHref}>/onboarding/status</a>.
          </p>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </div>
      ) : null}

      {result?.onboarding_status === 'error' ? (
        <div>
          <p role="alert">Onboarding start failed: {result.reason}</p>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </div>
      ) : null}
    </section>
  );
}
