import AppShellLayout from '../../frontend/app-shell/layout';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = ['9 AM', '12 PM', '3 PM', '6 PM', '9 PM'];

export default function CalendarPage() {
  return (
    <AppShellLayout currentRouteId="calendar">
      <div className="glass-card-static" style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700 }}>Publish Schedule</h3>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <span className="btn btn-sm btn-secondary">← Prev</span>
            <span className="btn btn-sm btn-secondary" style={{ background: 'rgba(194,53,80,0.15)', borderColor: 'rgba(194,53,80,0.3)' }}>This Week</span>
            <span className="btn btn-sm btn-secondary">Next →</span>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', tableLayout: 'fixed' }}>
            <thead>
              <tr>
                <th style={{ width: '60px', padding: '8px', color: 'rgba(248,245,242,0.3)' }}></th>
                {DAYS.map((day) => (
                  <th key={day} style={{ padding: '8px', color: 'rgba(248,245,242,0.5)', fontWeight: 600, textAlign: 'center' }}>{day}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {HOURS.map((hour) => (
                <tr key={hour} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '12px 8px', color: 'rgba(248,245,242,0.3)', fontSize: '0.75rem' }}>{hour}</td>
                  {DAYS.map((day) => (
                    <td key={`${hour}-${day}`} style={{ padding: '4px', height: '48px' }}>
                      {hour === '12 PM' && day === 'Tue' && (
                        <div style={{ padding: '4px 6px', borderRadius: '4px', background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.2)', fontSize: '0.7rem', color: '#34D399' }}>
                          IG Post
                        </div>
                      )}
                      {hour === '3 PM' && day === 'Thu' && (
                        <div style={{ padding: '4px 6px', borderRadius: '4px', background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.2)', fontSize: '0.7rem', color: '#60A5FA' }}>
                          LinkedIn
                        </div>
                      )}
                      {hour === '6 PM' && day === 'Fri' && (
                        <div style={{ padding: '4px 6px', borderRadius: '4px', background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.2)', fontSize: '0.7rem', color: '#FBBF24' }}>
                          X Thread
                        </div>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="glass-card-static">
        <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.75rem' }}>Sync Configuration</h3>
        <p style={{ fontSize: '0.875rem', color: 'rgba(248,245,242,0.65)' }}>
          Calendar sync currently runs through the repo-managed dispatch layer, with the scheduling contract defined in
          <code style={{ color: 'rgba(248,245,242,0.8)' }}> workflows/</code> and app runtime handlers.
          Publish windows and retry scheduling are managed through the workflow engine.
        </p>
      </div>
    </AppShellLayout>
  );
}
