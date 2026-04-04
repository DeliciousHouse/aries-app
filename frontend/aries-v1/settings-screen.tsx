'use client';

import { useEffect, useState } from 'react';

import { useIntegrations } from '@/hooks/use-integrations';
import { useBusinessProfile } from '@/hooks/use-business-profile';

import { EmptyStatePanel, LoadingStateGrid, ShellPanel, StatusChip } from './components';

export default function AriesSettingsScreen() {
  const integrations = useIntegrations({ autoLoad: true });
  const business = useBusinessProfile({ autoLoad: true });
  const [businessName, setBusinessName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [primaryGoal, setPrimaryGoal] = useState('');
  const [launchApproverUserId, setLaunchApproverUserId] = useState('');

  const profile = business.profile.data?.profile ?? null;
  const teamProfiles = business.team.data?.profiles ?? [];
  const integrationCards = integrations.data?.status === 'ok' ? integrations.data.cards : [];

  const ready = !business.profile.isLoading && !business.team.isLoading;

  useEffect(() => {
    if (!profile) return;
    setBusinessName(profile.businessName);
    setWebsiteUrl(profile.websiteUrl || '');
    setBusinessType(profile.businessType || '');
    setPrimaryGoal(profile.primaryGoal || '');
    setLaunchApproverUserId(profile.launchApproverUserId || '');
  }, [profile?.businessName, profile?.websiteUrl, profile?.businessType, profile?.primaryGoal, profile?.launchApproverUserId]);

  async function saveProfile() {
    await business.updateProfile({
      businessName,
      websiteUrl,
      businessType,
      primaryGoal,
      launchApproverUserId: launchApproverUserId || null,
    });
  }

  async function handleIntegrationAction(
    action: 'connect' | 'reconnect' | 'disconnect',
    platform: string
  ) {
    const card = integrationCards.find((item) => item.platform === platform);
    if (!card) {
      return;
    }
    await integrations.runAction(action, card);
  }

  if (!ready || integrations.isLoading) {
    return <LoadingStateGrid />;
  }

  if (business.profile.error || business.team.error) {
    return <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">{business.profile.error?.message || business.team.error?.message}</div>;
  }

  return (
    <div className="space-y-5">
      <ShellPanel eyebrow="Business Profile" title="The business Aries is representing">
        {profile ? (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Business name"><input value={businessName} onChange={(e) => setBusinessName(e.target.value)} className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white" /></Field>
              <Field label="Website"><input value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white" /></Field>
              <Field label="Business type"><input value={businessType} onChange={(e) => setBusinessType(e.target.value)} className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white" /></Field>
              <Field label="Primary goal"><input value={primaryGoal} onChange={(e) => setPrimaryGoal(e.target.value)} className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white" /></Field>
            </div>
            <button type="button" onClick={() => void saveProfile()} disabled={business.save.isLoading} className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c] disabled:opacity-60">
              {business.save.isLoading ? 'Saving…' : 'Save business profile'}
            </button>
            {profile.incomplete ? <div className="rounded-[1.25rem] border border-amber-400/20 bg-amber-400/10 px-4 py-4 text-sm text-amber-50">This profile is incomplete. Add a website, business type, and primary goal so Aries can use it across campaigns.</div> : null}
          </div>
        ) : (
          <EmptyStatePanel title="Business profile not available" description="Aries could not load the business profile for this tenant." />
        )}
      </ShellPanel>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <ShellPanel eyebrow="Channels / Integrations" title="Where Aries can publish or monitor">
          {integrations.error ? (
            <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">{integrations.error.message}</div>
          ) : integrationCards.length === 0 ? (
            <EmptyStatePanel compact title="No integrations yet" description="Connect channels so Aries can publish, schedule, and monitor launches." />
          ) : (
            <div className="space-y-3">
              {integrationCards.map((card) => (
                <div key={card.platform} className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-white">{card.display_name}</p>
                      <p className="text-sm text-white/45">{card.connected_account?.account_label || card.platform}</p>
                    </div>
                    <StatusChip status={card.connection_state === 'connected' ? 'approved' : card.connection_state === 'reauth_required' ? 'changes_requested' : 'draft'}>
                      {card.connection_state === 'connected'
                        ? 'Healthy'
                        : card.connection_state === 'reauth_required'
                          ? 'Needs attention'
                          : card.connection_state === 'disabled'
                            ? 'Unavailable'
                            : 'Not connected'}
                    </StatusChip>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {card.available_actions.includes('connect') ? (
                      <button
                        type="button"
                        onClick={() => void handleIntegrationAction('connect', card.platform)}
                        disabled={integrations.busyAction === `${card.platform}:connect`}
                        className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-60"
                      >
                        {integrations.busyAction === `${card.platform}:connect` ? 'Connecting…' : 'Connect'}
                      </button>
                    ) : null}
                    {card.available_actions.includes('reconnect') ? (
                      <button
                        type="button"
                        onClick={() => void handleIntegrationAction('reconnect', card.platform)}
                        disabled={integrations.busyAction === `${card.platform}:reconnect`}
                        className="inline-flex items-center gap-2 rounded-full border border-amber-300/25 bg-amber-300/10 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-300/20 disabled:opacity-60"
                      >
                        {integrations.busyAction === `${card.platform}:reconnect` ? 'Reconnecting…' : 'Reconnect'}
                      </button>
                    ) : null}
                    {card.available_actions.includes('disconnect') ? (
                      <button
                        type="button"
                        onClick={() => void handleIntegrationAction('disconnect', card.platform)}
                        disabled={integrations.busyAction === `${card.platform}:disconnect`}
                        className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/20 px-3 py-1.5 text-xs font-semibold text-white/80 hover:bg-black/30 disabled:opacity-60"
                      >
                        {integrations.busyAction === `${card.platform}:disconnect` ? 'Disconnecting…' : 'Disconnect'}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ShellPanel>

        <ShellPanel eyebrow="Team / Approvals" title="Who signs off before launch">
          {teamProfiles.length === 0 ? (
            <EmptyStatePanel compact title="No team members yet" description="Invite teammates or keep the owner as the default approver." />
          ) : (
            <div className="space-y-3">
              <Field label="Launch approver">
                <select value={launchApproverUserId} onChange={(e) => setLaunchApproverUserId(e.target.value)} className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white">
                  <option value="" className="bg-black">Owner default</option>
                  {teamProfiles.map((profileItem) => (
                    <option key={profileItem.userId} value={profileItem.userId} className="bg-black">
                      {profileItem.fullName || profileItem.email} · {profileItem.role}
                    </option>
                  ))}
                </select>
              </Field>
              {teamProfiles.map((row) => (
                <div key={row.userId} className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
                  <p className="text-sm font-medium text-white">{row.fullName || row.email}</p>
                  <p className="mt-1 text-sm text-white/70">{row.role}</p>
                  <p className="mt-2 text-sm leading-6 text-white/55">{row.email}</p>
                </div>
              ))}
              <button type="button" onClick={() => void saveProfile()} disabled={business.save.isLoading} className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c] disabled:opacity-60">
                {business.save.isLoading ? 'Saving…' : 'Save approval settings'}
              </button>
            </div>
          )}
        </ShellPanel>
      </div>
    </div>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-2 block">
      <span className="text-sm font-medium text-white/70">{props.label}</span>
      {props.children}
    </label>
  );
}
