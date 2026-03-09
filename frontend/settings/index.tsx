"use client";

import { useState, type FormEvent } from 'react';

type SettingsPageState = 'idle' | 'loading' | 'ready' | 'saving' | 'error';
type SettingsSection = 'tenant_profile' | 'session_security';
type SettingsErrorCode = 'forbidden' | 'validation_failed' | 'conflict' | 'service_unavailable' | 'unknown';
type TenantRole = 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer';

type TenantProfile = {
  tenant_id: string;
  display_name: string;
  support_email: string;
  time_zone: string;
};

type SecuritySummary = {
  idle_timeout_seconds: number;
  absolute_timeout_seconds: number;
  access_token_max_ttl_seconds: number;
  csrf_required: true;
  cookie_secure: true;
  cookie_http_only: true;
  refresh_rotation_single_use: true;
};

type SettingsCapabilities = {
  can_edit_tenant_profile: boolean;
  can_view_security_policy: boolean;
  actor_role: TenantRole;
};

type SettingsLoadSuccess = {
  status: 'ok';
  page_state: 'ready';
  active_section: SettingsSection;
  tenant: TenantProfile;
  security_summary: SecuritySummary;
  capabilities: SettingsCapabilities;
};

type SettingsUpdateRequest = {
  display_name: string;
  support_email: string;
  time_zone: string;
};

type SettingsUpdateSuccess = {
  status: 'ok';
  tenant: TenantProfile;
};

type SettingsError = {
  status: 'error';
  page_state: 'error';
  error: {
    code: SettingsErrorCode;
    message: string;
    field_errors?: Array<{
      field: string;
      reason: string;
    }>;
  };
};

const contractSeed: SettingsLoadSuccess = {
  status: 'ok',
  page_state: 'ready',
  active_section: 'tenant_profile',
  tenant: {
    tenant_id: 'tenant_demo_001',
    display_name: 'Aries Demo Tenant',
    support_email: 'support@example.com',
    time_zone: 'America/Chicago'
  },
  security_summary: {
    idle_timeout_seconds: 900,
    absolute_timeout_seconds: 28800,
    access_token_max_ttl_seconds: 900,
    csrf_required: true,
    cookie_secure: true,
    cookie_http_only: true,
    refresh_rotation_single_use: true
  },
  capabilities: {
    can_edit_tenant_profile: true,
    can_view_security_policy: true,
    actor_role: 'tenant_admin'
  }
};

function isSettingsError(value: unknown): value is SettingsError {
  return typeof value === 'object' && value !== null && (value as { status?: string }).status === 'error';
}

export interface SettingsScreenProps {
  baseUrl?: string;
}

export default function SettingsScreen({ baseUrl = '' }: SettingsScreenProps): JSX.Element {
  const [pageState, setPageState] = useState<SettingsPageState>('idle');
  const [activeSection, setActiveSection] = useState<SettingsSection>('tenant_profile');

  const [tenant, setTenant] = useState<TenantProfile>(contractSeed.tenant);
  const [securitySummary] = useState<SecuritySummary>(contractSeed.security_summary);
  const [capabilities] = useState<SettingsCapabilities>(contractSeed.capabilities);

  const [displayNameDraft, setDisplayNameDraft] = useState(contractSeed.tenant.display_name);
  const [supportEmailDraft, setSupportEmailDraft] = useState(contractSeed.tenant.support_email);
  const [timeZoneDraft, setTimeZoneDraft] = useState(contractSeed.tenant.time_zone);

  const [lastUpdate, setLastUpdate] = useState<SettingsUpdateSuccess | null>(null);
  const [lastError, setLastError] = useState<SettingsError | null>(null);

  function loadContractSeed(): void {
    setPageState('loading');
    setLastError(null);
    setLastUpdate(null);

    setTenant(contractSeed.tenant);
    setDisplayNameDraft(contractSeed.tenant.display_name);
    setSupportEmailDraft(contractSeed.tenant.support_email);
    setTimeZoneDraft(contractSeed.tenant.time_zone);
    setActiveSection(contractSeed.active_section);

    setPageState('ready');
  }

  async function submitTenantProfile(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!capabilities.can_edit_tenant_profile) {
      setLastError({
        status: 'error',
        page_state: 'error',
        error: { code: 'forbidden', message: 'Actor role cannot edit tenant profile.' }
      });
      setPageState('error');
      return;
    }

    setPageState('saving');
    setLastError(null);
    setLastUpdate(null);

    const payload: SettingsUpdateRequest = {
      display_name: displayNameDraft.trim(),
      support_email: supportEmailDraft.trim(),
      time_zone: timeZoneDraft.trim()
    };

    try {
      const response = await fetch(`${baseUrl}/api/tenant-admin/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const body = (await response.json()) as SettingsUpdateSuccess | SettingsError;

      if (!response.ok || isSettingsError(body)) {
        setLastError(
          isSettingsError(body)
            ? body
            : {
                status: 'error',
                page_state: 'error',
                error: { code: 'unknown', message: 'Tenant settings update failed.' }
              }
        );
        setPageState('error');
        return;
      }

      setTenant(body.tenant);
      setDisplayNameDraft(body.tenant.display_name);
      setSupportEmailDraft(body.tenant.support_email);
      setTimeZoneDraft(body.tenant.time_zone);
      setLastUpdate(body);
      setPageState('ready');
    } catch {
      setLastError({
        status: 'error',
        page_state: 'error',
        error: { code: 'service_unavailable', message: 'Unable to reach tenant settings endpoint.' }
      });
      setPageState('error');
    }
  }

  return (
    <section>
      <h1>Tenant Admin Settings</h1>
      <p>Route: /tenant-admin/settings</p>

      <div>
        <button type="button" onClick={loadContractSeed} disabled={pageState === 'loading' || pageState === 'saving'}>
          {pageState === 'loading' ? 'Loading…' : 'Load contract seed'}
        </button>
      </div>

      <h2>Page state</h2>
      <p>{pageState}</p>

      <h2>Sections</h2>
      <div>
        <button type="button" onClick={() => setActiveSection('tenant_profile')}>
          tenant_profile
        </button>
        <button
          type="button"
          onClick={() => setActiveSection('session_security')}
          disabled={!capabilities.can_view_security_policy}
        >
          session_security
        </button>
      </div>
      <p>active_section: {activeSection}</p>

      <h2>Capabilities</h2>
      <pre>{JSON.stringify(capabilities, null, 2)}</pre>

      {activeSection === 'tenant_profile' ? (
        <div>
          <h2>Tenant profile</h2>
          <form onSubmit={submitTenantProfile}>
            <label htmlFor="display_name">display_name</label>
            <input
              id="display_name"
              name="display_name"
              value={displayNameDraft}
              maxLength={120}
              onChange={(event) => setDisplayNameDraft(event.target.value)}
              required
            />

            <label htmlFor="support_email">support_email</label>
            <input
              id="support_email"
              name="support_email"
              type="email"
              value={supportEmailDraft}
              onChange={(event) => setSupportEmailDraft(event.target.value)}
              required
            />

            <label htmlFor="time_zone">time_zone</label>
            <input
              id="time_zone"
              name="time_zone"
              value={timeZoneDraft}
              onChange={(event) => setTimeZoneDraft(event.target.value)}
              required
            />

            <button type="submit" disabled={pageState === 'saving' || !capabilities.can_edit_tenant_profile}>
              {pageState === 'saving' ? 'Saving…' : 'Save tenant profile'}
            </button>
          </form>

          <h3>Current tenant snapshot</h3>
          <pre>{JSON.stringify(tenant, null, 2)}</pre>
        </div>
      ) : null}

      {activeSection === 'session_security' && capabilities.can_view_security_policy ? (
        <div>
          <h2>Session security summary</h2>
          <pre>{JSON.stringify(securitySummary, null, 2)}</pre>
        </div>
      ) : null}

      {lastUpdate ? (
        <div>
          <h2>Update response</h2>
          <pre>{JSON.stringify(lastUpdate, null, 2)}</pre>
        </div>
      ) : null}

      {lastError ? (
        <div>
          <h2>Error</h2>
          <pre>{JSON.stringify(lastError, null, 2)}</pre>
        </div>
      ) : null}
    </section>
  );
}
