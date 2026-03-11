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
    <div className="app-page">
      <div className="app-page-header">
        <h1 className="app-page-title">Settings</h1>
        <p className="app-page-desc">Manage tenant configurations and security policies.</p>
      </div>

      <div className="settings-container" style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 'var(--space-8)' }}>
        {/* Settings Sidebar */}
        <aside className="settings-sidebar">
          <nav className="doc-nav">
            <button
              type="button"
              className={`doc-nav-link ${activeSection === 'tenant_profile' ? 'active' : ''}`}
              onClick={() => setActiveSection('tenant_profile')}
              style={{
                width: '100%',
                textAlign: 'left',
                background: activeSection === 'tenant_profile' ? 'var(--aries-glass)' : 'transparent',
                borderLeftColor: activeSection === 'tenant_profile' ? 'var(--aries-crimson)' : 'transparent',
                color: activeSection === 'tenant_profile' ? 'var(--aries-text-primary)' : 'var(--aries-text-secondary)',
                cursor: 'pointer'
              }}
            >
              Tenant Profile
            </button>
            <button
              type="button"
              className={`doc-nav-link ${activeSection === 'session_security' ? 'active' : ''}`}
              onClick={() => setActiveSection('session_security')}
              disabled={!capabilities.can_view_security_policy}
              style={{
                width: '100%',
                textAlign: 'left',
                background: activeSection === 'session_security' ? 'var(--aries-glass)' : 'transparent',
                borderLeftColor: activeSection === 'session_security' ? 'var(--aries-crimson)' : 'transparent',
                color: activeSection === 'session_security' ? 'var(--aries-text-primary)' : 'var(--aries-text-secondary)',
                cursor: capabilities.can_view_security_policy ? 'pointer' : 'not-allowed',
                opacity: capabilities.can_view_security_policy ? 1 : 0.5
              }}
            >
              Session Security
            </button>
          </nav>
          
          <div className="glass-card" style={{ marginTop: 'var(--space-6)', padding: 'var(--space-4)' }}>
            <h3 className="stat-label" style={{ marginBottom: 'var(--space-2)' }}>Your Role</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--aries-success)' }}></div>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--aries-text-primary)', textTransform: 'capitalize' }}>
                {capabilities.actor_role.replace('_', ' ')}
              </span>
            </div>
          </div>
        </aside>

        {/* Settings Content */}
        <main className="settings-content">
          {pageState === 'loading' && (
            <div className="glass-card" style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-12)' }}>
              <div className="spinner"></div>
            </div>
          )}

          {pageState !== 'loading' && activeSection === 'tenant_profile' && (
            <div className="glass-card" style={{ animation: 'heroFadeIn 0.3s var(--ease-out) both' }}>
              <h2 className="section-title" style={{ fontSize: 'var(--text-2xl)', marginBottom: 'var(--space-6)' }}>Tenant Profile</h2>
              
              {lastUpdate && (
                <div className="alert alert-success" style={{ marginBottom: 'var(--space-6)' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                  Profile updated successfully.
                </div>
              )}

              {lastError && (
                <div className="alert alert-error" style={{ marginBottom: 'var(--space-6)' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                  {lastError.error.message}
                </div>
              )}

              <form onSubmit={submitTenantProfile} className="form-group" style={{ gap: 'var(--space-6)' }}>
                <div className="form-group">
                  <label htmlFor="display_name" className="form-label">Display Name</label>
                  <input
                    id="display_name"
                    name="display_name"
                    className="form-input"
                    value={displayNameDraft}
                    maxLength={120}
                    onChange={(event) => setDisplayNameDraft(event.target.value)}
                    required
                    disabled={!capabilities.can_edit_tenant_profile || pageState === 'saving'}
                  />
                  <p style={{ fontSize: 'var(--text-xs)', color: 'var(--aries-text-muted)', marginTop: 'var(--space-1)' }}>
                    The public-facing name for your organization.
                  </p>
                </div>

                <div className="form-group">
                  <label htmlFor="support_email" className="form-label">Support Email</label>
                  <input
                    id="support_email"
                    name="support_email"
                    type="email"
                    className="form-input"
                    value={supportEmailDraft}
                    onChange={(event) => setSupportEmailDraft(event.target.value)}
                    required
                    disabled={!capabilities.can_edit_tenant_profile || pageState === 'saving'}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="time_zone" className="form-label">Time Zone</label>
                  <select
                    id="time_zone"
                    name="time_zone"
                    className="form-select"
                    value={timeZoneDraft}
                    onChange={(event) => setTimeZoneDraft(event.target.value)}
                    required
                    disabled={!capabilities.can_edit_tenant_profile || pageState === 'saving'}
                  >
                    <option value="America/Chicago">Central Time (US & Canada)</option>
                    <option value="America/New_York">Eastern Time (US & Canada)</option>
                    <option value="America/Los_Angeles">Pacific Time (US & Canada)</option>
                    <option value="UTC">UTC</option>
                  </select>
                </div>

                <div style={{ marginTop: 'var(--space-2)', paddingTop: 'var(--space-6)', borderTop: '1px solid var(--aries-glass-border)', display: 'flex', justifyContent: 'flex-end' }}>
                  <button 
                    type="submit" 
                    className="btn btn-primary"
                    disabled={pageState === 'saving' || !capabilities.can_edit_tenant_profile}
                  >
                    {pageState === 'saving' ? (
                      <>
                        <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2, borderTopColor: 'var(--aries-white)' }}></div>
                        Saving...
                      </>
                    ) : 'Save Changes'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {pageState !== 'loading' && activeSection === 'session_security' && Object.keys(securitySummary).length > 0 && (
            <div className="glass-card" style={{ animation: 'heroFadeIn 0.3s var(--ease-out) both' }}>
              <h2 className="section-title" style={{ fontSize: 'var(--text-2xl)', marginBottom: 'var(--space-2)' }}>Session Security</h2>
              <p className="app-page-desc" style={{ marginBottom: 'var(--space-8)' }}>
                These are read-only security policies enforced globally for your tenant.
              </p>
              
              <div className="grid-2" style={{ gap: 'var(--space-6)' }}>
                <div>
                  <h3 className="stat-label">Idle Timeout</h3>
                  <div className="stat-value" style={{ fontSize: 'var(--text-xl)' }}>{securitySummary.idle_timeout_seconds / 60} min</div>
                  <p className="stat-meta">Sessions expire after inactivity.</p>
                </div>
                <div>
                  <h3 className="stat-label">Absolute Timeout</h3>
                  <div className="stat-value" style={{ fontSize: 'var(--text-xl)' }}>{securitySummary.absolute_timeout_seconds / 3600} hours</div>
                  <p className="stat-meta">Maximum session lifetime.</p>
                </div>
                <div>
                  <h3 className="stat-label">Access Token TTL</h3>
                  <div className="stat-value" style={{ fontSize: 'var(--text-xl)' }}>{securitySummary.access_token_max_ttl_seconds / 60} min</div>
                  <p className="stat-meta">Short-lived credential rotation.</p>
                </div>
                <div>
                  <h3 className="stat-label">Protection Flags</h3>
                  <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)', flexWrap: 'wrap' }}>
                    {securitySummary.csrf_required && <span className="section-label" style={{ margin: 0 }}>CSRF</span>}
                    {securitySummary.cookie_secure && <span className="section-label" style={{ margin: 0 }}>Secure</span>}
                    {securitySummary.cookie_http_only && <span className="section-label" style={{ margin: 0 }}>HttpOnly</span>}
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
