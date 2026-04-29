'use client';

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import Link from 'next/link';

import { useBusinessProfile } from '@/hooks/use-business-profile';
import { useIntegrations } from '@/hooks/use-integrations';
import {
  hasValidationErrors,
  validateBusinessProfileForm,
  type BusinessProfileFieldErrors,
} from '@/lib/validation/business-profile';

import { connectedProfileLabel } from './connected-profile-labels';
import { customerSafeUiErrorMessage } from './customer-safe-copy';
import { DashboardHero, EmptyStatePanel, LoadingStateGrid, ShellPanel } from './components';

type ChannelOption = {
  id: string;
  label: string;
  description: string;
};

const CHANNEL_OPTIONS: ChannelOption[] = [
  {
    id: 'meta-ads',
    label: 'Meta',
    description: 'Paid social for direct-response demand capture and retargeting.',
  },
  {
    id: 'instagram',
    label: 'Instagram',
    description: 'High-visibility social presence for proof, awareness, and offer momentum.',
  },
  {
    id: 'google-business',
    label: 'Google Business',
    description: 'Local intent capture for service-led businesses that need qualified discovery.',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    description: 'Professional reach for higher-trust offers and longer consideration cycles.',
  },
];

const DEFAULT_CHANNEL_IDS = ['meta-ads', 'instagram'];

function brandKitFontStyle(family: string): CSSProperties {
  return {
    fontFamily: `"${family}", ${family}, ui-sans-serif, system-ui, sans-serif`,
  };
}

function firstPresent(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function channelLabel(channelId: string): string {
  return CHANNEL_OPTIONS.find((option) => option.id === channelId)?.label || channelId;
}

function joinedValues(values: string[], connectedProfileLabels: string[] = []): string {
  return Array.from(new Set([
    ...values.map(channelLabel),
    ...connectedProfileLabels,
  ].map((value) => value.trim()).filter(Boolean))).join(', ');
}

export default function AriesBusinessProfileScreen() {
  const business = useBusinessProfile({ autoLoad: true });
  const integrations = useIntegrations({ autoLoad: true });
  const [businessName, setBusinessName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [primaryGoal, setPrimaryGoal] = useState('');
  const [offer, setOffer] = useState('');
  const [competitorUrl, setCompetitorUrl] = useState('');
  const [selectedChannels, setSelectedChannels] = useState<string[]>(DEFAULT_CHANNEL_IDS);
  const [brandVoice, setBrandVoice] = useState('');
  const [styleVibe, setStyleVibe] = useState('');
  const [notes, setNotes] = useState('');
  const [launchApproverUserId, setLaunchApproverUserId] = useState('');
  const [fieldErrors, setFieldErrors] = useState<BusinessProfileFieldErrors>({});
  const [feedback, setFeedback] = useState<
    { kind: 'success' | 'error'; message: string } | null
  >(null);

  const profile = business.profile.data?.profile ?? null;
  const teamProfiles = business.team.data?.profiles ?? [];
  const integrationCards = integrations.data?.status === 'ok' ? integrations.data.cards : [];
  const integrationsUnavailable = integrations.error || integrations.data?.status === 'error';
  const connectedProfileLabels = Array.from(new Set(
    integrationCards
      .filter((card) => card.connection_state === 'connected')
      .map((card) => connectedProfileLabel(card.platform, card.display_name)),
  ));
  const connectedProfilesSummary = integrations.isLoading
    ? 'Checking connected profiles…'
    : integrationsUnavailable
      ? 'Connected profile status is not available right now.'
      : connectedProfileLabels.length > 0
        ? connectedProfileLabels.join(', ')
        : 'No connected social profiles yet.';
  const ready = !business.profile.isLoading && !business.team.isLoading;

  useEffect(() => {
    if (!profile) return;
    setBusinessName(profile.businessName);
    setWebsiteUrl(profile.websiteUrl || profile.brandKit?.source_url || '');
    setBusinessType(profile.businessType || '');
    setPrimaryGoal(profile.primaryGoal || '');
    setOffer(profile.offer || profile.brandIdentity?.offer || profile.brandKit?.offer_summary || '');
    setCompetitorUrl(profile.competitorUrl || '');
    setSelectedChannels(profile.channels.length > 0 ? profile.channels : DEFAULT_CHANNEL_IDS);
    setBrandVoice(profile.brandVoice || profile.brandIdentity?.toneOfVoice || '');
    setStyleVibe(profile.styleVibe || profile.brandIdentity?.styleVibe || '');
    setNotes(profile.notes || profile.brandIdentity?.summary || '');
    setLaunchApproverUserId(profile.launchApproverUserId || '');
  }, [profile]);

  async function saveProfile() {
    const errors = validateBusinessProfileForm({ businessName, websiteUrl });
    setFieldErrors(errors);
    if (hasValidationErrors(errors)) {
      setFeedback({
        kind: 'error',
        message: 'Please fix the highlighted fields before saving.',
      });
      return;
    }
    setFeedback(null);
    const response = await business.updateProfile({
      businessName: businessName.trim(),
      websiteUrl: websiteUrl.trim(),
      businessType,
      primaryGoal,
      offer,
      competitorUrl,
      channels: selectedChannels,
      brandVoice,
      styleVibe,
      notes,
      launchApproverUserId: launchApproverUserId || null,
    });
    if (response) {
      setFeedback({ kind: 'success', message: 'Business profile saved.' });
    } else {
      const serverMessage = business.save.error?.message;
      setFeedback({
        kind: 'error',
        message: serverMessage || 'Failed to save business profile.',
      });
    }
  }

  const hasErrors = hasValidationErrors(fieldErrors);

  function toggleChannel(channelId: string) {
    setSelectedChannels((current) =>
      current.includes(channelId)
        ? current.filter((value) => value !== channelId)
        : [...current, channelId],
    );
  }

  if (!ready) {
    return <LoadingStateGrid />;
  }

  if (business.profile.error || business.team.error) {
    return (
      <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
        {customerSafeUiErrorMessage(
          business.profile.error?.message || business.team.error?.message,
          'The business profile is not available right now.',
        )}
      </div>
    );
  }

  if (!profile) {
    return (
      <EmptyStatePanel
        title="Business profile not available"
        description="Aries could not load the current business profile."
      />
    );
  }

  const brandIdentity = profile.brandIdentity;
  const currentSourceUrl =
    firstPresent(
      brandIdentity?.provenance?.canonical_url,
      brandIdentity?.provenance?.source_url,
      profile.brandKit?.canonical_url,
      profile.brandKit?.source_url,
      profile.websiteUrl,
    ) || 'Add the current website to unlock the brand profile.';
  const profileSummary =
    firstPresent(brandIdentity?.summary, notes, profile.brandKit?.offer_summary) ||
    'Aries will use this operating profile to keep every new campaign aligned to the same business and brand direction.';
  const voiceSummary = firstPresent(brandIdentity?.toneOfVoice, brandVoice, profile.brandKit?.brand_voice_summary) || 'Aries will keep the voice summary current once the source site is connected.';
  const styleSummary = firstPresent(brandIdentity?.styleVibe, styleVibe) || 'Aries will derive the visual tone from the source website and any uploaded brand material.';
  const offerSummary = firstPresent(brandIdentity?.offer, offer, profile.brandKit?.offer_summary) || 'Add or confirm the primary offer so every campaign stays focused on one clear conversion.';
  const businessTypeSummary = firstPresent(businessType, profile.businessType) || 'Add the business type to keep summaries and campaign plans precise.';
  const primaryGoalSummary = firstPresent(primaryGoal, profile.primaryGoal) || 'Choose the primary goal so Aries knows what the first campaign should move.';
  const previewColors = Array.from(new Set([
    profile.brandKit?.colors.primary,
    profile.brandKit?.colors.secondary,
    profile.brandKit?.colors.accent,
    ...(profile.brandKit?.colors.palette || []),
  ].filter((value): value is string => Boolean(value))));
  const previewFonts = profile.brandKit?.font_families || [];

  return (
    <div className="space-y-6">
      <DashboardHero
        eyebrow="Business profile"
        title={profile.businessName}
        description={profileSummary}
        metrics={[
          {
            label: 'Business type',
            value: businessTypeSummary,
            detail: 'The operating category Aries uses for planning and summaries.',
          },
          {
            label: 'Primary goal',
            value: primaryGoalSummary,
            detail: 'The conversion target shaping the first campaign.',
          },
          {
            label: 'Offer',
            value: offerSummary,
            detail: 'The core offer or service Aries will put into market first.',
          },
          {
            label: 'Channels',
            value: joinedValues(selectedChannels, connectedProfileLabels),
            detail: profile.incomplete ? 'The profile still needs a few details before it is fully locked.' : 'These channels are ready for the next campaign.',
            tone: profile.incomplete ? 'watch' : 'good',
          },
        ]}
        aside={
          <div className="space-y-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Current source</p>
              <p className="mt-3 text-sm leading-7 text-white/72">{currentSourceUrl}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Launch approver</p>
              <p className="mt-3 text-sm leading-7 text-white/72">
                {profile.launchApproverName || 'Owner default'}
              </p>
            </div>
            {profile.brandKit?.extracted_at ? (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Last source review</p>
                <p className="mt-3 text-sm leading-7 text-white/72">{profile.brandKit.extracted_at}</p>
              </div>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <ShellPanel
          eyebrow="Operating profile"
          title="What Aries will carry into future campaigns"
          action={
            <button
              type="button"
              onClick={() => void saveProfile()}
              disabled={business.save.isLoading || hasErrors}
              className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c] disabled:opacity-60"
            >
              {business.save.isLoading ? 'Saving…' : 'Save profile'}
            </button>
          }
        >
          <div className="space-y-6">
            {feedback ? (
              <div
                role={feedback.kind === 'error' ? 'alert' : 'status'}
                className={
                  feedback.kind === 'success'
                    ? 'rounded-[1.25rem] border border-emerald-400/25 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-50'
                    : 'rounded-[1.25rem] border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-50'
                }
              >
                {feedback.message}
              </div>
            ) : null}
            <div className="grid gap-4 md:grid-cols-2">
              <EditableField
                label="Business name"
                hint="Use the client-facing name that should appear everywhere in Aries."
              >
                <input
                  value={businessName}
                  onChange={(event) => {
                    setBusinessName(event.target.value);
                    if (fieldErrors.businessName) {
                      setFieldErrors((prev) => ({ ...prev, businessName: undefined }));
                    }
                  }}
                  aria-invalid={Boolean(fieldErrors.businessName)}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                />
                {fieldErrors.businessName ? (
                  <p className="mt-2 text-xs text-red-200">{fieldErrors.businessName}</p>
                ) : null}
              </EditableField>
              <EditableField
                label="Website"
                hint="Aries keeps this website attached as the current brand source."
              >
                <input
                  value={websiteUrl}
                  onChange={(event) => {
                    setWebsiteUrl(event.target.value);
                    if (fieldErrors.websiteUrl) {
                      setFieldErrors((prev) => ({ ...prev, websiteUrl: undefined }));
                    }
                  }}
                  aria-invalid={Boolean(fieldErrors.websiteUrl)}
                  placeholder="https://example.com"
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                />
                {fieldErrors.websiteUrl ? (
                  <p className="mt-2 text-xs text-red-200">{fieldErrors.websiteUrl}</p>
                ) : null}
              </EditableField>
              <EditableField
                label="Business type"
                hint="Describe the business in plain language."
              >
                <input
                  value={businessType}
                  onChange={(event) => setBusinessType(event.target.value)}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                />
              </EditableField>
              <EditableField
                label="Primary goal"
                hint="The business outcome that matters most right now."
              >
                <input
                  value={primaryGoal}
                  onChange={(event) => setPrimaryGoal(event.target.value)}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                />
              </EditableField>
              <EditableField
                label="Core offering"
                hint="The core product, service, or program Aries should focus campaigns around."
              >
                <input
                  value={offer}
                  onChange={(event) => setOffer(event.target.value)}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                />
              </EditableField>
              <EditableField
                label="Competitor website"
                hint="Optional. Use one comparison site if the market context matters."
              >
                <input
                  value={competitorUrl}
                  onChange={(event) => setCompetitorUrl(event.target.value)}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                />
              </EditableField>
            </div>

            <div className="space-y-3">
              <p className="text-sm font-medium text-white/78">Channels</p>
              <div className="grid gap-3 md:grid-cols-2">
                {CHANNEL_OPTIONS.map((channel) => {
                  const selected = selectedChannels.includes(channel.id);
                  return (
                    <button
                      key={channel.id}
                      type="button"
                      onClick={() => toggleChannel(channel.id)}
                      className={selected
                        ? 'rounded-[1.3rem] border border-white/20 bg-white/[0.08] px-4 py-4 text-left text-white transition'
                        : 'rounded-[1.3rem] border border-white/8 bg-black/18 px-4 py-4 text-left text-white/62 transition hover:border-white/16 hover:text-white'}
                    >
                      <p className="font-medium">{channel.label}</p>
                      <p className="mt-2 text-sm leading-7 text-white/56">{channel.description}</p>
                    </button>
                  );
                })}
              </div>
              <div className="rounded-[1.3rem] border border-white/8 bg-black/18 px-4 py-4 text-white">
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
                <p className="mt-3 text-xs leading-6 text-white/42">
                  Newly connected media portals update this Business Profile channel summary automatically.
                </p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <EditableField
                label="Brand voice"
                hint="Refine the working summary if the source review needs clearer language."
              >
                <textarea
                  value={brandVoice}
                  onChange={(event) => setBrandVoice(event.target.value)}
                  rows={5}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                />
              </EditableField>
              <EditableField
                label="Style / vibe"
                hint="Use a short creative direction statement the team can work from."
              >
                <textarea
                  value={styleVibe}
                  onChange={(event) => setStyleVibe(event.target.value)}
                  rows={5}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                />
              </EditableField>
            </div>

            <EditableField
              label="Notes / summary"
              hint="This becomes the quick operating snapshot Aries reuses across campaigns."
            >
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={5}
                className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
              />
            </EditableField>

            {profile.incomplete ? (
              <div className="rounded-[1.25rem] border border-amber-400/20 bg-amber-400/10 px-4 py-4 text-sm text-amber-50">
                Finish the missing business details so Aries can keep future campaign briefs, reviews, and approvals consistent.
              </div>
            ) : null}
          </div>
        </ShellPanel>

        <ShellPanel eyebrow="Brand snapshot" title="Current-source identity">
          <div className="space-y-4">
            <SnapshotCard
              label="Brand voice"
              value={voiceSummary}
            />
            <SnapshotCard
              label="Style / vibe"
              value={styleSummary}
            />
            <SnapshotCard
              label="Positioning"
              value={brandIdentity?.positioning || 'Positioning will appear here once the source review is complete.'}
            />
            <SnapshotCard
              label="Audience"
              value={brandIdentity?.audience || 'Audience context will appear here once the source review is complete.'}
            />
            <SnapshotCard
              label="Promise"
              value={brandIdentity?.promise || 'Promise language will appear here once the source review is complete.'}
            />
            <SnapshotCard
              label="CTA style"
              value={brandIdentity?.ctaStyle || 'CTA guidance will appear here once the source review is complete.'}
            />
            <SnapshotCard
              label="Proof style"
              value={brandIdentity?.proofStyle || 'Proof guidance will appear here once the source review is complete.'}
            />
          </div>
        </ShellPanel>
      </div>

      <ShellPanel eyebrow="Visual identity" title="Current-source marks, palette, and typography">
        {profile.brandKit ? (
          <div className="space-y-6">
            <div className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
              <p className="text-sm font-medium text-white">
                {profile.brandKit.brand_name || profile.businessName}
              </p>
              <p className="mt-1 text-sm text-white/60">{currentSourceUrl}</p>
            </div>

            {profile.brandKit.logo_urls.length > 0 ? (
              <div className="space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Visible marks</p>
                <div className="grid gap-3 md:grid-cols-2">
                  {profile.brandKit.logo_urls.map((logoUrl, index) => (
                    <div key={`${logoUrl}-${index}`} className="overflow-hidden rounded-[1.1rem] border border-white/8 bg-white px-4 py-4">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={logoUrl} alt={`${profile.businessName} logo ${index + 1}`} className="h-24 w-full object-contain" />
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <InfoEmptyState message="No clear mark was detected from the current source yet." />
            )}

            <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
              <div className="space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Palette cues</p>
                {previewColors.length > 0 ? (
                  <div className="grid gap-3 sm:grid-cols-3">
                    {previewColors.map((color) => (
                      <div key={color} className="rounded-[1.1rem] border border-white/8 bg-black/15 p-3">
                        <div className="h-16 rounded-[0.9rem] border border-white/10" style={{ backgroundColor: color }} />
                        <p className="mt-3 text-xs uppercase tracking-[0.14em] text-white/55">{color}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <InfoEmptyState message="No strong palette cues were detected from the current source yet." />
                )}
              </div>

              <div className="space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Typography cues</p>
                {previewFonts.length > 0 ? (
                  <div className="grid gap-3">
                    {previewFonts.map((font) => (
                      <div key={font} className="rounded-[1.1rem] border border-white/8 bg-black/15 p-4">
                        <p className="text-xs uppercase tracking-[0.14em] text-white/45">{font}</p>
                        <p className="mt-3 text-2xl text-white" style={brandKitFontStyle(font)}>
                          {profile.businessName || profile.brandKit?.brand_name || 'Brand preview'}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <InfoEmptyState message="No clear typography cues were detected from the current source yet." />
                )}
              </div>
            </div>

            {profile.brandKit.external_links.length > 0 ? (
              <div className="space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Visible brand links</p>
                <div className="grid gap-3 md:grid-cols-2">
                  {profile.brandKit.external_links.map((link) => (
                    <Link
                      key={`${link.platform}-${link.url}`}
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-[1.1rem] border border-white/8 bg-black/15 px-4 py-4 text-sm text-white/75 transition hover:border-white/15 hover:text-white"
                    >
                      <p className="font-medium capitalize text-white">{link.platform}</p>
                      <p className="mt-2 break-all text-white/55">{link.url}</p>
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyStatePanel
            compact
            title="No current-source brand board yet"
            description="Add or refresh the website to populate logos, palette, typography, and visible brand links."
          />
        )}
      </ShellPanel>

      <ShellPanel eyebrow="Approvals" title="Who signs off before launch">
        {teamProfiles.length === 0 ? (
          <EmptyStatePanel
            compact
            title="No team members yet"
            description="Invite teammates or keep the owner as the default approver."
          />
        ) : (
          <div className="space-y-4">
            <EditableField
              label="Launch approver"
              hint="This person becomes the visible sign-off contact for launch-ready work."
            >
              <select
                value={launchApproverUserId}
                onChange={(event) => setLaunchApproverUserId(event.target.value)}
                className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
              >
                <option value="" className="bg-black">
                  Owner default
                </option>
                {teamProfiles.map((profileItem) => (
                  <option key={profileItem.userId} value={profileItem.userId} className="bg-black">
                    {profileItem.fullName || profileItem.email} · {profileItem.role}
                  </option>
                ))}
              </select>
            </EditableField>

            <div className="grid gap-3 md:grid-cols-2">
              {teamProfiles.map((row) => (
                <div key={row.userId} className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
                  <p className="text-sm font-medium text-white">{row.fullName || row.email}</p>
                  <p className="mt-1 text-sm text-white/70">{row.role}</p>
                  <p className="mt-2 text-sm leading-6 text-white/55">{row.email}</p>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => void saveProfile()}
              disabled={business.save.isLoading}
              className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c] disabled:opacity-60"
            >
              {business.save.isLoading ? 'Saving…' : 'Save approval settings'}
            </button>
          </div>
        )}
      </ShellPanel>
    </div>
  );
}

function EditableField(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-medium text-white/78">{props.label}</span>
      {props.children}
      {props.hint ? <p className="text-sm leading-6 text-white/45">{props.hint}</p> : null}
    </label>
  );
}

function SnapshotCard(props: { label: string; value: string }) {
  return (
    <div className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      <p className="mt-3 text-sm leading-7 text-white/72">{props.value}</p>
    </div>
  );
}

function InfoEmptyState(props: { message: string }) {
  return (
    <div className="rounded-[1.1rem] border border-white/8 bg-black/15 px-4 py-4 text-sm text-white/55">
      {props.message}
    </div>
  );
}
