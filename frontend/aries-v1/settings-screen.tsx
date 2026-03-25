'use client';

import { useMemo } from 'react';

import { useIntegrations } from '@/hooks/use-integrations';

import { hydrateChannelsFromRuntime } from './adapters';
import { ChannelHealthIndicator, ShellPanel } from './components';

const teamRows = [
  {
    name: 'Morgan',
    role: 'Owner and final approver',
    detail: 'Approves launches, reschedules, and material creative changes.',
  },
  {
    name: 'Jules',
    role: 'Marketing support',
    detail: 'Prepares edits and campaign updates but cannot launch without approval.',
  },
];

export default function AriesSettingsScreen() {
  const integrations = useIntegrations({ autoLoad: true });
  const liveIntegrations = integrations.data?.status === 'ok' ? integrations.data : null;
  const channels = useMemo(() => hydrateChannelsFromRuntime(liveIntegrations), [liveIntegrations]);

  return (
    <div className="space-y-5">
      <ShellPanel eyebrow="Business Profile" title="The business Aries is representing">
        <div className="grid gap-4 md:grid-cols-2">
          <InfoTile label="Business name" value="Northstar Studio" />
          <InfoTile label="Website" value="northstarstudio.com" />
          <InfoTile label="Category" value="Wellness studio" />
          <InfoTile label="Primary goal" value="Book more appointments" />
        </div>
      </ShellPanel>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <ShellPanel eyebrow="Channels / Integrations" title="Where Aries can publish or monitor">
          <div className="space-y-3">
            {channels.map((channel) => (
              <ChannelHealthIndicator key={channel.id} channel={channel} />
            ))}
          </div>
        </ShellPanel>

        <ShellPanel eyebrow="Team / Approvals" title="Who signs off before launch">
          <div className="space-y-3">
            {teamRows.map((row) => (
              <div key={row.name} className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
                <p className="text-sm font-medium text-white">{row.name}</p>
                <p className="mt-1 text-sm text-white/70">{row.role}</p>
                <p className="mt-2 text-sm leading-6 text-white/55">{row.detail}</p>
              </div>
            ))}
            <div className="rounded-[1.25rem] border border-emerald-400/15 bg-emerald-400/10 px-4 py-4 text-sm text-emerald-50">
              Material edits after approval automatically return to review before scheduling continues.
            </div>
          </div>
        </ShellPanel>
      </div>
    </div>
  );
}

function InfoTile(props: { label: string; value: string }) {
  return (
    <div className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      <p className="mt-2 text-sm text-white/78">{props.value}</p>
    </div>
  );
}
