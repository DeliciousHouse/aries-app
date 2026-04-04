'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { useBusinessProfile } from '@/hooks/use-business-profile';

import { EmptyStatePanel, LoadingStateGrid, ShellPanel } from './components';

function parseChannelsInput(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  ));
}

function brandKitFontStyle(family: string) {
  return {
    fontFamily: `"${family}", ${family}, ui-sans-serif, system-ui, sans-serif`,
  };
}

export default function AriesBusinessProfileScreen() {
  const business = useBusinessProfile({ autoLoad: true });
  const [businessName, setBusinessName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [primaryGoal, setPrimaryGoal] = useState('');
  const [offer, setOffer] = useState('');
  const [competitorUrl, setCompetitorUrl] = useState('');
  const [channels, setChannels] = useState('');
  const [brandVoice, setBrandVoice] = useState('');
  const [styleVibe, setStyleVibe] = useState('');
  const [notes, setNotes] = useState('');
  const [launchApproverUserId, setLaunchApproverUserId] = useState('');

  const profile = business.profile.data?.profile ?? null;
  const teamProfiles = business.team.data?.profiles ?? [];

  const ready = !business.profile.isLoading && !business.team.isLoading;

  useEffect(() => {
    if (!profile) return;
    setBusinessName(profile.businessName);
    setWebsiteUrl(profile.websiteUrl || '');
    setBusinessType(profile.businessType || '');
    setPrimaryGoal(profile.primaryGoal || '');
    setOffer(profile.offer || '');
    setCompetitorUrl(profile.competitorUrl || '');
    setChannels(profile.channels.join(', '));
    setBrandVoice(profile.brandVoice || '');
    setStyleVibe(profile.styleVibe || '');
    setNotes(profile.notes || '');
    setLaunchApproverUserId(profile.launchApproverUserId || '');
  }, [
    profile?.businessName,
    profile?.websiteUrl,
    profile?.businessType,
    profile?.primaryGoal,
    profile?.offer,
    profile?.competitorUrl,
    profile?.channels,
    profile?.brandVoice,
    profile?.styleVibe,
    profile?.notes,
    profile?.launchApproverUserId,
  ]);

  async function saveProfile() {
    await business.updateProfile({
      businessName,
      websiteUrl,
      businessType,
      primaryGoal,
      offer,
      competitorUrl,
      channels: parseChannelsInput(channels),
      brandVoice,
      styleVibe,
      notes,
      launchApproverUserId: launchApproverUserId || null,
    });
  }

  if (!ready) {
    return <LoadingStateGrid />;
  }

  if (business.profile.error || business.team.error) {
    return (
      <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
        {business.profile.error?.message || business.team.error?.message}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <ShellPanel eyebrow="Business Profile" title="The business Aries is representing">
        {profile ? (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Business name">
                <input
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                />
              </Field>
              <Field label="Website">
                <input
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                />
              </Field>
              <Field label="Business type">
                <input
                  value={businessType}
                  onChange={(e) => setBusinessType(e.target.value)}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                />
              </Field>
              <Field label="Primary goal">
                <input
                  value={primaryGoal}
                  onChange={(e) => setPrimaryGoal(e.target.value)}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                />
              </Field>
              <Field label="Offer">
                <input
                  value={offer}
                  onChange={(e) => setOffer(e.target.value)}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                />
              </Field>
              <Field label="Competitor website">
                <input
                  value={competitorUrl}
                  onChange={(e) => setCompetitorUrl(e.target.value)}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                />
              </Field>
              <Field label="Channels">
                <input
                  value={channels}
                  onChange={(e) => setChannels(e.target.value)}
                  placeholder="meta-ads, instagram, linkedin"
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                />
              </Field>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Brand voice">
                <textarea
                  value={brandVoice}
                  onChange={(e) => setBrandVoice(e.target.value)}
                  rows={5}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                />
              </Field>
              <Field label="Style / vibe">
                <textarea
                  value={styleVibe}
                  onChange={(e) => setStyleVibe(e.target.value)}
                  rows={5}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
                />
              </Field>
            </div>
            <Field label="Notes">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white"
              />
            </Field>
            <div className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4 text-sm text-white/65">
              Aries reuses this tenant profile to prefill new campaigns. Brand-kit signals below are extracted from the
              saved website and kept separate from the editable operating profile.
            </div>
            <button
              type="button"
              onClick={() => void saveProfile()}
              disabled={business.save.isLoading}
              className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c] disabled:opacity-60"
            >
              {business.save.isLoading ? 'Saving…' : 'Save business profile'}
            </button>
            {profile.incomplete ? (
              <div className="rounded-[1.25rem] border border-amber-400/20 bg-amber-400/10 px-4 py-4 text-sm text-amber-50">
                This profile is incomplete. Add a website, business type, and primary goal so Aries can use it across
                campaigns.
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyStatePanel
            title="Business profile not available"
            description="Aries could not load the business profile for this tenant."
          />
        )}
      </ShellPanel>

      <ShellPanel eyebrow="Derived Brand Context" title="Logo, palette, fonts, and brand signals">
        {profile?.brandKit ? (
          <div className="space-y-6">
            <div className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
              <p className="text-sm font-medium text-white">{profile.brandKit.brand_name || profile.businessName}</p>
              <p className="mt-1 text-sm text-white/60">{profile.brandKit.source_url || profile.websiteUrl || 'No website saved'}</p>
              {profile.brandKit.canonical_url ? (
                <p className="mt-1 text-xs uppercase tracking-[0.14em] text-white/40">{profile.brandKit.canonical_url}</p>
              ) : null}
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <ReadOnlyField
                label="Brand voice"
                value={profile.brandVoice || profile.brandKit.brand_voice_summary || 'No brand voice has been captured yet.'}
              />
              <ReadOnlyField
                label="Style / vibe"
                value={profile.styleVibe || 'No style / vibe has been captured yet.'}
              />
            </div>

            <div className="space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Logo</p>
              {profile.brandKit.logo_urls.length === 0 ? (
                <div className="rounded-[1.1rem] border border-white/8 bg-black/15 px-4 py-4 text-sm text-white/55">
                  No logo was extracted from the saved website.
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {profile.brandKit.logo_urls.map((logoUrl, index) => (
                    <div key={`${logoUrl}-${index}`} className="overflow-hidden rounded-[1.1rem] border border-white/8 bg-white px-4 py-4">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={logoUrl} alt={`${profile.businessName} logo ${index + 1}`} className="h-24 w-full object-contain" />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Colors</p>
              {profile.brandKit.colors.palette.length === 0 ? (
                <div className="rounded-[1.1rem] border border-white/8 bg-black/15 px-4 py-4 text-sm text-white/55">
                  No color palette was extracted from the saved website.
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-3">
                  {Array.from(new Set([
                    profile.brandKit.colors.primary,
                    profile.brandKit.colors.secondary,
                    profile.brandKit.colors.accent,
                    ...profile.brandKit.colors.palette,
                  ].filter((value): value is string => typeof value === 'string' && value.length > 0))).map((color) => (
                    <div key={color} className="rounded-[1.1rem] border border-white/8 bg-black/15 p-3">
                      <div className="h-16 rounded-[0.9rem] border border-white/10" style={{ backgroundColor: color }} />
                      <p className="mt-3 text-xs uppercase tracking-[0.14em] text-white/55">{color}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Fonts</p>
              {profile.brandKit.font_families.length === 0 ? (
                <div className="rounded-[1.1rem] border border-white/8 bg-black/15 px-4 py-4 text-sm text-white/55">
                  No font families were extracted from the saved website.
                </div>
              ) : (
                <div className="grid gap-3">
                  {profile.brandKit.font_families.map((font) => (
                    <div key={font} className="rounded-[1.1rem] border border-white/8 bg-black/15 p-4">
                      <p className="text-xs uppercase tracking-[0.14em] text-white/45">{font}</p>
                      <p className="mt-3 text-2xl text-white" style={brandKitFontStyle(font)}>
                        {profile.businessName || profile.brandKit?.brand_name || 'Brand preview'}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {profile.brandKit.external_links.length > 0 ? (
              <div className="space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">External links</p>
                <div className="grid gap-3">
                  {profile.brandKit.external_links.map((link) => (
                    <Link
                      key={`${link.platform}-${link.url}`}
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-[1.1rem] border border-white/8 bg-black/15 px-4 py-4 text-sm text-white/75 transition hover:border-white/15 hover:text-white"
                    >
                      {link.platform}: {link.url}
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyStatePanel
            compact
            title="No brand extraction yet"
            description="Save a valid website URL to extract logo, colors, fonts, and other brand signals."
          />
        )}
      </ShellPanel>

      <ShellPanel eyebrow="Team / Approvals" title="Who signs off before launch">
        {teamProfiles.length === 0 ? (
          <EmptyStatePanel compact title="No team members yet" description="Invite teammates or keep the owner as the default approver." />
        ) : (
          <div className="space-y-3">
            <Field label="Launch approver">
              <select
                value={launchApproverUserId}
                onChange={(e) => setLaunchApproverUserId(e.target.value)}
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
            </Field>
            {teamProfiles.map((row) => (
              <div key={row.userId} className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
                <p className="text-sm font-medium text-white">{row.fullName || row.email}</p>
                <p className="mt-1 text-sm text-white/70">{row.role}</p>
                <p className="mt-2 text-sm leading-6 text-white/55">{row.email}</p>
              </div>
            ))}
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

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-medium text-white/70">{props.label}</span>
      {props.children}
    </label>
  );
}

function ReadOnlyField(props: { label: string; value: string }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-white/70">{props.label}</p>
      <div className="rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-sm leading-7 text-white/75 whitespace-pre-wrap">
        {props.value}
      </div>
    </div>
  );
}
