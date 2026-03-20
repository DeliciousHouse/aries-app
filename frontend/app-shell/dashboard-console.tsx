'use client';

import { Activity, ArrowRight, Cable, Sparkles, Workflow } from 'lucide-react';

import { useIntegrations } from '@/hooks/use-integrations';
import { useTenantWorkflows } from '@/hooks/use-tenant-workflows';
import StatusBadge from '@/frontend/components/status-badge';

function MetricCard({
  label,
  value,
  meta,
}: {
  label: string;
  value: string;
  meta: string;
}) {
  return (
    <div className="glass rounded-[2rem] p-6">
      <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-3">{label}</p>
      <div className="text-4xl font-bold mb-2">{value}</div>
      <p className="text-white/55 text-sm leading-relaxed">{meta}</p>
    </div>
  );
}

export default function DashboardConsole(): JSX.Element {
  const integrations = useIntegrations();
  const tenantWorkflows = useTenantWorkflows();

  const cards = integrations.data?.status === 'ok' ? integrations.data.cards : [];
  const summary =
    integrations.data?.status === 'ok'
      ? integrations.data.summary
      : { total: 0, connected: 0, not_connected: 0, attention_required: 0 };
  const workflows = tenantWorkflows.list.data ?? [];

  return (
    <div className="space-y-8">
      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-6">
        <MetricCard
          label="Connected platforms"
          value={String(summary.connected)}
          meta={`${summary.total} supported providers visible inside the Aries OAuth broker.`}
        />
        <MetricCard
          label="Attention required"
          value={String(summary.attention_required)}
          meta="Providers needing reconnects or manual attention."
        />
        <MetricCard
          label="Workflow routes"
          value={String(workflows.length)}
          meta="Tenant-scoped Aries routes available to launch or resume."
        />
        <MetricCard
          label="Browser boundary"
          value="100%"
          meta="Interactive flows stay on Aries internal APIs only."
        />
      </div>

      <div className="grid xl:grid-cols-[1.3fr_0.9fr] gap-6">
        <div className="glass rounded-[2.5rem] p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Workflow className="w-6 h-6 text-primary" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-white/35">Workflow catalog</p>
              <h2 className="text-2xl font-bold">Live Aries workflow routes</h2>
            </div>
          </div>

          {tenantWorkflows.list.isLoading ? (
            <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-6 text-white/60">
              Loading workflow routes…
            </div>
          ) : workflows.length === 0 ? (
            <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-6 text-white/60">
              No tenant workflow routes are currently visible for this session.
            </div>
          ) : (
            <div className="space-y-4">
              {workflows.map((workflow) => (
                <div key={workflow.id} className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-2">{workflow.route}</p>
                    <h3 className="text-lg font-semibold mb-1">{workflow.id}</h3>
                    <p className="text-sm text-white/55">{workflow.pipeline}</p>
                  </div>
                  <StatusBadge status={workflow.mode === 'real' ? 'ready' : 'accepted'} />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="glass rounded-[2.5rem] p-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-2xl bg-secondary/10 border border-secondary/20 flex items-center justify-center">
                <Cable className="w-6 h-6 text-secondary" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/35">Connection summary</p>
                <h2 className="text-2xl font-bold">Platform health</h2>
              </div>
            </div>

            {integrations.isLoading ? (
              <div className="text-white/60">Loading platform status…</div>
            ) : integrations.error ? (
              <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
                {integrations.error.message}
              </div>
            ) : (
              <div className="space-y-3">
                {cards.slice(0, 4).map((card) => (
                  <div key={card.platform} className="rounded-[1.25rem] border border-white/10 bg-white/5 px-4 py-3 flex items-center justify-between gap-4">
                    <div>
                      <div className="font-semibold">{card.display_name}</div>
                      <div className="text-sm text-white/50">{card.connection_state.replace(/_/g, ' ')}</div>
                    </div>
                    <StatusBadge status={card.connection_state === 'connected' ? 'completed' : card.connection_state === 'reauth_required' ? 'required' : 'accepted'} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="glass rounded-[2.5rem] p-8">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-12 h-12 rounded-2xl bg-white/10 border border-white/10 flex items-center justify-center">
                <Activity className="w-6 h-6 text-white" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/35">Runtime reality</p>
                <h2 className="text-2xl font-bold">Recent jobs</h2>
              </div>
            </div>
            <p className="text-white/60 leading-relaxed mb-6">
              The current backend does not yet expose a browser-safe tenant job list, so the dashboard surfaces live workflow routes and connection health first.
            </p>
            <div className="flex flex-col gap-3">
              <a href="/marketing/new-job" className="px-6 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20 flex items-center justify-center gap-2">
                Launch campaign <ArrowRight className="w-4 h-4" />
              </a>
              <a href="/platforms" className="px-6 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all flex items-center justify-center gap-2">
                Review platforms <Sparkles className="w-4 h-4" />
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
