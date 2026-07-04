'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { useIntegrations } from '@/hooks/use-integrations';
import { useBusinessProfile } from '@/hooks/use-business-profile';
import { createAriesV1Api, type ReelAudioMode } from '@/lib/api/aries-v1';

type WorkspaceRole = 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer';

function workspaceRoleLabel(role: WorkspaceRole): string {
  if (role === 'tenant_admin') return 'Admin';
  if (role === 'tenant_analyst') return 'Editor';
  return 'Viewer';
}

function memberActionErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'already_member':
      return 'That person is already a member of this workspace.';
    case 'email_taken':
      return 'That email already belongs to another Aries account.';
    case 'missing_required_fields:email':
      return 'Enter an email address to invite.';
    case 'invalid_role':
      return 'Pick a valid role.';
    case 'already_active':
      return 'That member has already joined — no invite needed.';
    case 'forbidden':
      return 'Only workspace admins can manage members.';
    default:
      return 'Something went wrong. Try again.';
  }
}

import { customerSafeUiErrorMessage } from './customer-safe-copy';
import { EmptyStatePanel, LoadingStateGrid, ShellPanel, StatusChip } from './components';
import { connectedProfileLabel } from './connected-profile-labels';

export default function AriesSettingsScreen() {
  const router = useRouter();
  const integrations = useIntegrations({ autoLoad: true });
  const business = useBusinessProfile({ autoLoad: true });
  const [businessName, setBusinessName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [primaryGoal, setPrimaryGoal] = useState('');
  const [launchApproverUserId, setLaunchApproverUserId] = useState('');
  const [reelAudioMode, setReelAudioMode] = useState<ReelAudioMode>('music');

  const profile = business.profile.data?.profile ?? null;
  const teamProfiles = business.team.data?.profiles ?? [];
  const integrationCards = integrations.data?.status === 'ok' ? integrations.data.cards : [];
  const integrationsUnavailable = integrations.error || integrations.data?.status === 'error';
  const connectedProfileLabels = Array.from(new Set(
    integrationCards
      .filter((card) => card.connection_state === 'connected')
      .map((card) => connectedProfileLabel(card.platform, card.display_name)),
  ));
  const connectedProfilesSummary = integrationsUnavailable
    ? 'Connected profile status is not available right now.'
    : connectedProfileLabels.length > 0
      ? connectedProfileLabels.join(', ')
      : 'No connected social profiles yet.';

  const ready = !business.profile.isLoading && !business.team.isLoading;

  useEffect(() => {
    if (!profile) return;
    setBusinessName(profile.businessName);
    setWebsiteUrl(profile.websiteUrl || '');
    setBusinessType(profile.businessType || '');
    setPrimaryGoal(profile.primaryGoal || '');
    setLaunchApproverUserId(profile.launchApproverUserId || '');
    setReelAudioMode(profile.reelAudioMode || 'music');
  }, [profile?.businessName, profile?.websiteUrl, profile?.businessType, profile?.primaryGoal, profile?.launchApproverUserId, profile?.reelAudioMode]);

  async function saveProfile() {
    await business.updateProfile({
      businessName,
      websiteUrl,
      businessType,
      primaryGoal,
      launchApproverUserId: launchApproverUserId || null,
      reelAudioMode,
    });
  }

  const memberApi = useMemo(() => createAriesV1Api(), []);
  const viewer = business.team.data?.viewer ?? null;
  const isWorkspaceAdmin = viewer?.role === 'tenant_admin';
  const viewerUserId = viewer?.userId ?? null;

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('tenant_analyst');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [memberNotice, setMemberNotice] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);

  async function handleInviteMember(e: React.FormEvent) {
    e.preventDefault();
    if (inviteBusy) return;
    setMemberError(null);
    setMemberNotice(null);
    const email = inviteEmail.trim();
    if (!email) {
      setMemberError('Enter an email address to invite.');
      return;
    }
    setInviteBusy(true);
    try {
      const result = await memberApi.inviteTenantMember({ email, role: inviteRole });
      setInviteEmail('');
      setMemberNotice(
        result.absorb
          ? `Invite sent to ${email} — they already have an Aries account, so they'll be asked to fold their unused workspace into this one. They'll appear here once they accept.`
          : `Invite sent to ${email}.`,
      );
      await business.load();
    } catch (err) {
      setMemberError(memberActionErrorMessage((err as { code?: string })?.code));
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleMemberRoleChange(userId: string, role: WorkspaceRole) {
    setMemberError(null);
    setMemberNotice(null);
    setRowBusyId(userId);
    try {
      await memberApi.updateTenantProfile(userId, { role });
      setMemberNotice('Role updated.');
      await business.load();
    } catch (err) {
      setMemberError(memberActionErrorMessage((err as { code?: string })?.code));
    } finally {
      setRowBusyId(null);
    }
  }

  async function handleResendInvite(userId: string, email: string) {
    setMemberError(null);
    setMemberNotice(null);
    setRowBusyId(userId);
    try {
      await memberApi.resendTenantInvite(userId);
      setMemberNotice(`Invite resent to ${email}.`);
    } catch (err) {
      setMemberError(memberActionErrorMessage((err as { code?: string })?.code));
    } finally {
      setRowBusyId(null);
    }
  }

  async function handleRemoveMember(userId: string, email: string) {
    setMemberError(null);
    setMemberNotice(null);
    setRowBusyId(userId);
    try {
      await memberApi.deleteTenantProfile(userId);
      setConfirmRemoveId(null);
      setMemberNotice(`Removed ${email}.`);
      await business.load();
    } catch (err) {
      setMemberError(memberActionErrorMessage((err as { code?: string })?.code));
    } finally {
      setRowBusyId(null);
    }
  }

  async function handleIntegrationAction(
    action: 'connect' | 'reconnect' | 'disconnect',
    platform: string
  ) {
    const card = integrationCards.find((item) => item.platform === platform);
    if (!card) {
      return;
    }
    // Connect/Reconnect are brokered by Composio on the canonical "Channel
    // Integrations" screen, NOT the legacy direct-Meta OAuth path the shared
    // integrations hook would otherwise call (#704). Disconnect of an existing
    // connection keeps its current behavior so live connections are untouched.
    if (action === 'connect' || action === 'reconnect') {
      router.push('/dashboard/settings/channel-integrations');
      return;
    }
    await integrations.runAction(action, card);
  }

  if (!ready || integrations.isLoading) {
    return <LoadingStateGrid />;
  }

  if (business.profile.error || business.team.error) {
    return (
      <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
        {customerSafeUiErrorMessage(
          business.profile.error?.message || business.team.error?.message,
          'Settings are not available right now.',
        )}
      </div>
    );
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
              <Field label="Reel audio">
                <select
                  value={reelAudioMode}
                  onChange={(e) => setReelAudioMode(e.target.value as ReelAudioMode)}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                >
                  <option value="music">Music only</option>
                  <option value="voiceover">Voiceover only</option>
                  <option value="both">Voiceover + music</option>
                </select>
                <p className="mt-2 text-xs leading-6 text-white/50">
                  Default audio for generated reels (weekly + one-off). Voiceover needs the
                  account voiceover capability turned on; otherwise reels fall back to music.
                </p>
              </Field>
            </div>
            <div className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4 text-white">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-medium">Connected profiles</p>
                  <p className="mt-2 text-sm leading-7 text-white/58">{connectedProfilesSummary}</p>
                </div>
                <Link
                  href="/dashboard/settings/channel-integrations?from=business-profile"
                  className="inline-flex shrink-0 items-center justify-center rounded-full border border-white/15 bg-white px-4 py-2 text-sm font-semibold text-[#11161c] transition hover:bg-white/90"
                >
                  Add Profile
                </Link>
              </div>
              <p className="mt-3 text-xs leading-6 text-white/70">
                Newly connected media portals update this Business Profile summary automatically.
              </p>
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
          {integrationsUnavailable ? (
            <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
              {customerSafeUiErrorMessage(
                integrations.error?.message || (integrations.data?.status === 'error' ? integrations.data.error.message : undefined),
                'Channel status is not available right now.',
              )}
            </div>
          ) : integrationCards.length === 0 ? (
            <EmptyStatePanel compact title="No integrations yet" description="Connect channels so Aries can publish, schedule, and monitor launches." />
          ) : (
            <div className="space-y-3">
              {integrationCards.map((card) => (
                <div key={card.platform} className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-white">{card.display_name}</p>
                      <p className="text-sm text-white/70">{card.description}</p>
                    </div>
                    <StatusChip status={card.connection_state === 'connected' ? 'approved' : card.connection_state === 'reauth_required' ? 'changes_requested' : 'draft'}>
                      {card.connection_state === 'connected'
                        ? 'Connected'
                        : card.connection_state === 'reauth_required'
                          ? 'Needs attention'
                          : card.connection_state === 'disabled'
                            ? 'Setup needed'
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

        <ShellPanel eyebrow="Team / Approvals" title="Who can view and manage the schedule">
          <div className="space-y-4">
            {isWorkspaceAdmin ? (
              <form onSubmit={handleInviteMember} className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4 space-y-3">
                <p className="text-sm font-medium text-white">Invite a teammate</p>
                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="teammate@email.com"
                    className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                  />
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as WorkspaceRole)}
                    className="rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                  >
                    <option value="tenant_admin" className="bg-black">Admin — full control</option>
                    <option value="tenant_analyst" className="bg-black">Editor — can change the schedule</option>
                    <option value="tenant_viewer" className="bg-black">Viewer — read only</option>
                  </select>
                </div>
                <button
                  type="submit"
                  disabled={inviteBusy}
                  className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c] disabled:opacity-60"
                >
                  {inviteBusy ? 'Sending…' : 'Send invite'}
                </button>
                <p className="text-xs leading-6 text-white/55">
                  They&apos;ll get an email with a link to set a password and join this workspace.
                </p>
              </form>
            ) : null}

            {memberError ? (
              <div className="rounded-[1rem] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100" role="alert">
                {memberError}
              </div>
            ) : null}
            {memberNotice ? (
              <div className="rounded-[1rem] border border-emerald-400/20 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-50">
                {memberNotice}
              </div>
            ) : null}

            {teamProfiles.length === 0 ? (
              <EmptyStatePanel compact title="No team members yet" description="Invite teammates above so more people can view and change the schedule." />
            ) : (
              <div className="space-y-3">
                <Field label="Launch approver">
                  <select value={launchApproverUserId} onChange={(e) => setLaunchApproverUserId(e.target.value)} className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white">
                    <option value="" className="bg-black">Owner default</option>
                    {teamProfiles.map((profileItem) => (
                      <option key={profileItem.userId} value={profileItem.userId} className="bg-black">
                        {profileItem.fullName || profileItem.email} · {workspaceRoleLabel(profileItem.role)}
                      </option>
                    ))}
                  </select>
                </Field>
                {teamProfiles.map((row) => {
                  const isSelf = viewerUserId === row.userId;
                  const rowBusy = rowBusyId === row.userId;
                  return (
                    <div key={row.userId} className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-white">
                            {row.fullName || row.email}
                            {isSelf ? <span className="text-white/50"> (you)</span> : null}
                          </p>
                          <p className="mt-2 text-sm leading-6 text-white/55">{row.email}</p>
                        </div>
                        <StatusChip status={row.status === 'invited' ? 'draft' : 'approved'}>
                          {row.status === 'invited' ? 'Invited' : 'Active'}
                        </StatusChip>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {isWorkspaceAdmin && !isSelf ? (
                          <select
                            value={row.role}
                            disabled={rowBusy}
                            onChange={(e) => void handleMemberRoleChange(row.userId, e.target.value as WorkspaceRole)}
                            className="rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs text-white disabled:opacity-60"
                          >
                            <option value="tenant_admin" className="bg-black">Admin</option>
                            <option value="tenant_analyst" className="bg-black">Editor</option>
                            <option value="tenant_viewer" className="bg-black">Viewer</option>
                          </select>
                        ) : (
                          <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs text-white/70">
                            {workspaceRoleLabel(row.role)}
                          </span>
                        )}
                        {isWorkspaceAdmin && row.status === 'invited' ? (
                          <button
                            type="button"
                            disabled={rowBusy}
                            onClick={() => void handleResendInvite(row.userId, row.email)}
                            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-60"
                          >
                            {rowBusy ? 'Sending…' : 'Resend invite'}
                          </button>
                        ) : null}
                        {isWorkspaceAdmin && !isSelf ? (
                          confirmRemoveId === row.userId ? (
                            <span className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                disabled={rowBusy}
                                onClick={() => void handleRemoveMember(row.userId, row.email)}
                                className="inline-flex items-center gap-2 rounded-full border border-red-400/25 bg-red-500/15 px-3 py-1.5 text-xs font-semibold text-red-100 hover:bg-red-500/25 disabled:opacity-60"
                              >
                                {rowBusy ? 'Removing…' : 'Confirm remove'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmRemoveId(null)}
                                className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/20 px-3 py-1.5 text-xs font-semibold text-white/80 hover:bg-black/30"
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmRemoveId(row.userId)}
                              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/20 px-3 py-1.5 text-xs font-semibold text-white/80 hover:bg-black/30"
                            >
                              Remove
                            </button>
                          )
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                <button type="button" onClick={() => void saveProfile()} disabled={business.save.isLoading} className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c] disabled:opacity-60">
                  {business.save.isLoading ? 'Saving…' : 'Save approval settings'}
                </button>
              </div>
            )}
          </div>
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
