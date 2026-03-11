import AppShellLayout from '../../frontend/app-shell/layout';

const STATS = [
  { label: 'Active Connections', value: '5', meta: 'of 7 platforms connected' },
  { label: 'Queue Health', value: '98%', meta: 'n8n dispatch queue operational' },
  { label: 'Publish Volume', value: '247', meta: 'posts dispatched this month' },
  { label: 'Token Status', value: '2', meta: 'tokens expiring within 7 days' },
];

const RECENT_JOBS = [
  { id: 'mkt_001', topic: 'Q1 Product Launch', status: 'completed', stage: 'publish', time: '2h ago' },
  { id: 'mkt_002', topic: 'Competitor Analysis', status: 'running', stage: 'research', time: '15m ago' },
  { id: 'mkt_003', topic: 'Brand Campaign', status: 'awaiting_approval', stage: 'production', time: '1h ago' },
];

export default function DashboardPage() {
  return (
    <AppShellLayout currentRouteId="dashboard">
      <div className="grid-4" style={{ marginBottom: '2rem' }}>
        {STATS.map((s) => (
          <div className="stat-card" key={s.label}>
            <div className="stat-label">{s.label}</div>
            <div className="stat-value">{s.value}</div>
            <div className="stat-meta">{s.meta}</div>
          </div>
        ))}
      </div>

      <div className="glass-card-static">
        <h2 style={{ fontSize: '1.125rem', fontWeight: 700, marginBottom: '1rem' }}>Recent Marketing Jobs</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
              <th style={{ textAlign: 'left', padding: '8px 12px', color: 'rgba(248,245,242,0.4)', fontWeight: 600, fontSize: '0.75rem', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Job ID</th>
              <th style={{ textAlign: 'left', padding: '8px 12px', color: 'rgba(248,245,242,0.4)', fontWeight: 600, fontSize: '0.75rem', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Topic</th>
              <th style={{ textAlign: 'left', padding: '8px 12px', color: 'rgba(248,245,242,0.4)', fontWeight: 600, fontSize: '0.75rem', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Stage</th>
              <th style={{ textAlign: 'left', padding: '8px 12px', color: 'rgba(248,245,242,0.4)', fontWeight: 600, fontSize: '0.75rem', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Status</th>
              <th style={{ textAlign: 'left', padding: '8px 12px', color: 'rgba(248,245,242,0.4)', fontWeight: 600, fontSize: '0.75rem', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Time</th>
            </tr>
          </thead>
          <tbody>
            {RECENT_JOBS.map((job) => (
              <tr key={job.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <td style={{ padding: '10px 12px' }}><code style={{ fontSize: '0.8rem' }}>{job.id}</code></td>
                <td style={{ padding: '10px 12px', fontWeight: 500 }}>{job.topic}</td>
                <td style={{ padding: '10px 12px', color: 'rgba(248,245,242,0.65)' }}>{job.stage}</td>
                <td style={{ padding: '10px 12px' }}>
                  <span style={{
                    display: 'inline-block',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    background: job.status === 'completed' ? 'rgba(52,211,153,0.15)' : job.status === 'running' ? 'rgba(96,165,250,0.15)' : 'rgba(251,191,36,0.15)',
                    color: job.status === 'completed' ? '#34D399' : job.status === 'running' ? '#60A5FA' : '#FBBF24',
                  }}>
                    {job.status}
                  </span>
                </td>
                <td style={{ padding: '10px 12px', color: 'rgba(248,245,242,0.4)', fontSize: '0.8rem' }}>{job.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppShellLayout>
  );
}
