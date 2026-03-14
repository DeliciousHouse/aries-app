import React from 'react';

export interface SettingsScreenProps {
  baseUrl?: string;
}

export const SETTINGS_RUNTIME_STATUS = {
  status: 'not_implemented',
  missingEndpoint: '/api/tenant-admin/settings'
} as const;

export default function SettingsScreen(_props: SettingsScreenProps): JSX.Element {
  return (
    <div className="app-page">
      <div className="app-page-header">
        <h1 className="app-page-title">Settings</h1>
        <p className="app-page-desc">Tenant settings are not editable in the current Aries runtime.</p>
      </div>

      <div className="glass-card" style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div className="alert alert-error">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
          This route is currently a read-only placeholder. The live tenant settings API is not implemented.
        </div>

        <div>
          <h2 className="section-title" style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-2)' }}>
            Current truth contract
          </h2>
          <p className="app-page-desc" style={{ marginBottom: 'var(--space-3)' }}>
            Aries does not currently expose <code>{SETTINGS_RUNTIME_STATUS.missingEndpoint}</code>, so this page no longer
            presents editable tenant profile or session-policy controls as if they were live.
          </p>
          <ul style={{ margin: 0, paddingLeft: '1.25rem', display: 'grid', gap: '0.5rem' }}>
            <li>Tenant profile editing is intentionally disabled.</li>
            <li>Session security values are not shown because the repo does not provide a live source of truth for them here.</li>
            <li>Documentation will be updated to reflect this placeholder state.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
