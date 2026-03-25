'use client';

import Link from 'next/link';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { ARIES_CAMPAIGNS } from './data';
import { KpiStrip, RecommendationCard, ShellPanel, StatusChip } from './components';

export default function AriesResultsScreen() {
  const liveCampaign = ARIES_CAMPAIGNS.find((campaign) => campaign.status === 'live') ?? ARIES_CAMPAIGNS[0];

  return (
    <div className="space-y-5">
      <ShellPanel eyebrow="Results" title="Business-readable performance">
        <p className="max-w-3xl text-sm leading-7 text-white/65">
          Aries summarizes what is working, what needs attention, and what the next recommended move should be,
          without dumping a wall of marketing analytics on the business owner.
        </p>
      </ShellPanel>

      <ShellPanel eyebrow="Topline" title={liveCampaign.results.headline}>
        <KpiStrip items={liveCampaign.results.kpis} />
      </ShellPanel>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr_0.8fr]">
        <ShellPanel eyebrow="Trend" title="Leads and bookings">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={liveCampaign.results.trend}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.4)" />
                <YAxis stroke="rgba(255,255,255,0.4)" />
                <Tooltip
                  contentStyle={{
                    background: '#11161c',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 18,
                  }}
                />
                <Line type="monotone" dataKey="leads" stroke="#f2d5b2" strokeWidth={3} dot={false} />
                <Line type="monotone" dataKey="bookings" stroke="#ffffff" strokeWidth={3} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </ShellPanel>

        <ShellPanel eyebrow="Comparison" title="Booking momentum by week">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={liveCampaign.results.trend}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.4)" />
                <YAxis stroke="rgba(255,255,255,0.4)" />
                <Tooltip
                  contentStyle={{
                    background: '#11161c',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 18,
                  }}
                />
                <Bar dataKey="bookings" fill="#f4efe6" radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ShellPanel>

        <ShellPanel eyebrow="Recommended" title="What to do next">
          <div className="space-y-4">
            <RecommendationCard recommendation={liveCampaign.recommendations[0]} />
            <Link
              href={`/campaigns/${liveCampaign.id}`}
              className="block rounded-[1.4rem] border border-white/8 bg-black/12 px-4 py-4 transition hover:border-white/15"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-white">{liveCampaign.name}</p>
                  <p className="mt-1 text-sm text-white/55">{liveCampaign.objective}</p>
                </div>
                <StatusChip status={liveCampaign.status} />
              </div>
            </Link>
          </div>
        </ShellPanel>
      </div>
    </div>
  );
}
