import AppShellLayout from '../../frontend/app-shell/layout';
import { BrandLogo } from '@/components/redesign/brand/logo';
import { Card } from '@/components/redesign/primitives/card';
import { ButtonLink } from '@/components/redesign/primitives/button';

const STATS = [
  { label: 'Active Connections', value: '5', meta: 'of 7 supported platforms currently linked' },
  { label: 'Queue Health', value: '98%', meta: 'typed route surface responding normally' },
  { label: 'Publish Volume', value: '247', meta: 'dispatches processed this month' },
  { label: 'Attention Items', value: '2', meta: 'platforms or jobs needing human review' },
];

const RECENT_JOBS = [
  { id: 'mkt_001', topic: 'Q1 Product Launch', status: 'completed', stage: 'publish', time: '2h ago' },
  { id: 'mkt_002', topic: 'Competitor Analysis', status: 'running', stage: 'research', time: '15m ago' },
  { id: 'mkt_003', topic: 'Brand Campaign', status: 'awaiting_approval', stage: 'production', time: '1h ago' },
];

export default function DashboardPage() {
  return (
    <AppShellLayout currentRouteId="dashboard">
      <div className="rd-stat-grid" style={{ marginBottom: '1.5rem' }}>
        {STATS.map((s) => (
          <Card key={s.label}>
            <div style={{ display: 'grid', gap: '0.55rem' }}>
              <span className="rd-label">{s.label}</span>
              <strong style={{ fontFamily: 'var(--rd-font-display)', fontSize: '2rem' }}>{s.value}</strong>
              <span style={{ color: 'var(--rd-text-secondary)' }}>{s.meta}</span>
            </div>
          </Card>
        ))}
      </div>

      <div className="rd-workflow-grid rd-workflow-grid--2">
        <Card>
          <div style={{ display: 'grid', gap: '1rem' }}>
            <h2 style={{ margin: 0, fontFamily: 'var(--rd-font-display)', fontSize: '1.45rem' }}>Recent marketing jobs</h2>
            <div style={{ display: 'grid', gap: '0.85rem' }}>
              {RECENT_JOBS.map((job) => (
                <div key={job.id} className="rd-glass" style={{ padding: '1rem', borderRadius: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                    <div>
                      <code style={{ color: 'var(--rd-text-muted)' }}>{job.id}</code>
                      <p style={{ margin: '0.35rem 0 0', fontWeight: 700 }}>{job.topic}</p>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span className="rd-badge">{job.status}</span>
                      <p style={{ margin: '0.35rem 0 0', color: 'var(--rd-text-secondary)' }}>{job.stage} • {job.time}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>

        <Card>
          <div style={{ display: 'grid', gap: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem' }}>
              <BrandLogo size={40} variant="mark" />
              <span className="rd-section-label" style={{ margin: 0 }}>Aries demo surface</span>
            </div>
            <h2 style={{ margin: 0, fontFamily: 'var(--rd-font-display)', fontSize: '1.45rem' }}>Quick actions</h2>
            <p className="rd-section-description">
              Launch new workflow activity from the operator shell and keep high-signal routes within easy reach.
            </p>
            <div className="rd-hero__actions">
              <ButtonLink href="/marketing/new-job">Launch campaign</ButtonLink>
              <ButtonLink href="/platforms" variant="secondary">Review platforms</ButtonLink>
            </div>
          </div>
        </Card>
      </div>
    </AppShellLayout>
  );
}
