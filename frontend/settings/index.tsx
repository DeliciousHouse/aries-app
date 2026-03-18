import React from 'react';
import { Card } from '@/components/redesign/primitives/card';
import { ButtonLink } from '@/components/redesign/primitives/button';

export interface SettingsScreenProps {
  baseUrl?: string;
}

export const SETTINGS_RUNTIME_STATUS = {
  status: 'not_implemented',
  missingEndpoint: '/api/tenant-admin/settings'
} as const;

export default function SettingsScreen(_props: SettingsScreenProps): JSX.Element {
  return (
    <div className="rd-workflow-grid rd-workflow-grid--2">
      <Card>
        <div style={{ display: 'grid', gap: '1rem' }}>
          <p className="rd-section-label">Runtime truth</p>
          <h2 style={{ margin: 0, fontFamily: 'var(--rd-font-display)', fontSize: '1.5rem' }}>Settings are intentionally read-only</h2>
          <div className="rd-alert rd-alert--danger">
            <div>
              <strong style={{ display: 'block', marginBottom: '0.25rem' }}>No live tenant settings endpoint</strong>
              <span>The current runtime does not expose <code>{SETTINGS_RUNTIME_STATUS.missingEndpoint}</code>.</span>
            </div>
          </div>
          <p className="rd-section-description">
            This route stays in the shell to preserve navigation, but avoids presenting editable controls until the backend exposes a real source of truth.
          </p>
        </div>
      </Card>

      <Card>
        <div style={{ display: 'grid', gap: '1rem' }}>
          <p className="rd-section-label">Next best actions</p>
          <div className="rd-summary-list">
            <div className="rd-glass" style={{ padding: '1rem', borderRadius: '1rem' }}>
              Review platform credentials and token health in <strong>Platforms</strong>.
            </div>
            <div className="rd-glass" style={{ padding: '1rem', borderRadius: '1rem' }}>
              Use the <strong>Posts</strong> route for publish dispatch and retry controls.
            </div>
            <div className="rd-glass" style={{ padding: '1rem', borderRadius: '1rem' }}>
              Track workflow status and approvals from the dedicated onboarding and marketing screens.
            </div>
          </div>
          <div className="rd-inline-actions">
            <ButtonLink href="/platforms">Go to platforms</ButtonLink>
            <ButtonLink href="/posts" variant="secondary">Open posts console</ButtonLink>
          </div>
        </div>
      </Card>
    </div>
  );
}
