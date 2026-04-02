'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Building2,
  Globe,
  Palette,
  Radio,
  Save,
  ShieldCheck,
  Sparkles,
  Users2,
} from 'lucide-react';

import type {
  SettingsIntegrationAction,
  SettingsViewModel,
} from '@/frontend/aries-v1/view-models/settings';

type EditableField = 'businessName' | 'websiteUrl' | 'businessType' | 'primaryGoal';
type SettingsTab = 'business' | 'channels' | 'approvals';

export interface SettingsPresenterProps {
  model: SettingsViewModel;
  form: {
    businessName: string;
    websiteUrl: string;
    businessType: string;
    primaryGoal: string;
    launchApproverUserId: string;
  };
  onFieldChange: (field: EditableField, value: string) => void;
  onLaunchApproverChange: (value: string) => void;
  onSave: () => void;
  isSaving: boolean;
  saveErrorMessage?: string | null;
  saveSucceeded?: boolean;
  integrationsLoading?: boolean;
  integrationsErrorMessage?: string | null;
  busyAction: string | null;
  onIntegrationAction: (platform: SettingsViewModel['integrations']['cards'][number]['platform'], action: SettingsIntegrationAction) => void;
}

export default function SettingsPresenter({
  model,
  form,
  onFieldChange,
  onLaunchApproverChange,
  onSave,
  isSaving,
  saveErrorMessage,
  saveSucceeded,
  integrationsLoading = false,
  integrationsErrorMessage,
  busyAction,
  onIntegrationAction,
}: SettingsPresenterProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('business');

  return (
    <div className="space-y-8 pb-12">
      <div className="flex flex-col justify-between gap-6 md:flex-row md:items-center">
        <div>
          <div className="mb-2 flex items-center gap-3">
            <div className="rounded-lg bg-white/5 p-2">
              <Building2 className="h-5 w-5 text-primary" />
            </div>
            <h1 className="text-3xl font-display font-semibold tracking-tight text-white">Settings</h1>
          </div>
          <p className="max-w-3xl text-zinc-500">{model.hero.description}</p>
        </div>

        <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-white/75">
          <ShieldCheck className="h-4 w-4 text-emerald-300" />
          Approval owner: {model.profileSummary.launchApproverLabel}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {model.hero.metrics.map((metric, index) => (
          <motion.div
            key={metric.label}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.08 }}
            className="glass-panel p-5"
          >
            <div className="mb-4 flex items-start justify-between">
              <div className="rounded-xl bg-white/5 p-2 text-zinc-500">
                {index === 0 ? <Radio className="h-5 w-5" /> : index === 1 ? <Sparkles className="h-5 w-5" /> : index === 2 ? <Users2 className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
              </div>
              <div className={`rounded-md px-2 py-1 text-[10px] font-medium ${
                metric.tone === 'good'
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : metric.tone === 'watch'
                    ? 'bg-amber-500/10 text-amber-300'
                    : 'bg-white/5 text-zinc-400'
              }`}>
                {metric.label}
              </div>
            </div>
            <h2 className="mb-1 text-3xl font-display font-semibold text-white">{metric.value}</h2>
            <p className="text-sm leading-relaxed text-zinc-400">{metric.detail}</p>
          </motion.div>
        ))}
      </div>

      <div className="rounded-[1.8rem] border border-white/[0.05] bg-[#0b0b10] p-2">
        <div className="flex flex-wrap gap-2">
          {[
            { id: 'business' as const, label: 'Business', icon: Building2 },
            { id: 'channels' as const, label: 'Channels', icon: Radio },
            { id: 'approvals' as const, label: 'Approvals', icon: Users2 },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-medium transition-all ${
                  isActive ? 'bg-white/10 text-white shadow-[0_8px_24px_rgba(0,0,0,0.25)]' : 'text-white/55 hover:bg-white/[0.04] hover:text-white'
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <AnimatePresence mode="wait">
        {activeTab === 'business' ? (
          <motion.div
            key="business"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.24, ease: 'easeOut' }}
            className="grid grid-cols-1 gap-6 xl:grid-cols-[1.05fr_0.95fr]"
          >
            <section className="glass-panel p-6 md:p-8">
              <div className="mb-8 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-display font-semibold text-white">Brand identity</h2>
                  <p className="mt-1 text-sm text-white/45">Define how Aries understands and represents the business.</p>
                </div>
                <button
                  type="button"
                  onClick={onSave}
                  disabled={isSaving}
                  className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-medium text-white shadow-[0_0_20px_rgba(123,97,255,0.3)] transition-all hover:bg-primary/90 disabled:opacity-60"
                >
                  <Save className="h-4 w-4" />
                  {isSaving ? 'Saving…' : 'Save changes'}
                </button>
              </div>

              {model.profileAvailable ? (
                <div className="space-y-6">
                  <div className="grid gap-5 md:grid-cols-2">
                    <Field
                      label="Business name"
                      icon={<Building2 className="h-4 w-4 text-white/25" />}
                      value={form.businessName}
                      onChange={(value) => onFieldChange('businessName', value)}
                      placeholder="Company name"
                    />
                    <Field
                      label="Website"
                      icon={<Globe className="h-4 w-4 text-white/25" />}
                      value={form.websiteUrl}
                      onChange={(value) => onFieldChange('websiteUrl', value)}
                      placeholder="https://yourcompany.com"
                    />
                    <Field
                      label="Business type"
                      value={form.businessType}
                      onChange={(value) => onFieldChange('businessType', value)}
                      placeholder="e.g. SaaS, Hospitality"
                    />
                    <Field
                      label="Primary goal"
                      value={form.primaryGoal}
                      onChange={(value) => onFieldChange('primaryGoal', value)}
                      placeholder="What outcome matters most?"
                    />
                  </div>

                  <SaveStateBanner
                    incomplete={model.profileSummary.incomplete}
                    saveErrorMessage={saveErrorMessage}
                    saveSucceeded={saveSucceeded}
                  />
                </div>
              ) : (
                <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-5 text-sm text-zinc-500">
                  Business profile data is not available for this tenant.
                </div>
              )}
            </section>

            <section className="glass-panel p-6 md:p-8">
              <div className="mb-6 flex items-center gap-3">
                <div className="rounded-2xl bg-white/5 p-3">
                  <Palette className="h-5 w-5 text-white" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{model.brandKit.brandName}</h2>
                  <p className="text-sm text-white/50">{model.brandKit.sourceUrl}</p>
                </div>
              </div>

              <div className="space-y-6">
                <div className="rounded-2xl border border-primary/10 bg-primary/5 p-5 text-sm leading-relaxed text-white/65">
                  {model.profileSummary.incomplete
                    ? 'Some business context is still missing. Filling it in grounds future campaigns and improves the rest of the dashboard.'
                    : 'Business context is complete and ready to support runtime-backed campaigns.'}
                </div>

                <div>
                  <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Palette</p>
                  {model.brandKit.palette.length === 0 ? (
                    <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4 text-sm text-zinc-500">
                      No runtime brand colors are available yet.
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {model.brandKit.palette.map((color) => (
                        <div key={color} className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-3">
                          <div className="h-20 rounded-xl border border-white/10" style={{ backgroundColor: color }} />
                          <p className="mt-3 text-xs uppercase tracking-[0.18em] text-white/50">{color}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Fonts</p>
                  {model.brandKit.fonts.length === 0 ? (
                    <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4 text-sm text-zinc-500">
                      No runtime font families are available yet.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {model.brandKit.fonts.map((font) => (
                        <div key={font} className="rounded-2xl border border-white/[0.05] bg-white/[0.02] px-4 py-3 text-sm text-white/75">
                          {font}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </section>
          </motion.div>
        ) : null}

        {activeTab === 'channels' ? (
          <motion.div
            key="channels"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.24, ease: 'easeOut' }}
            className="glass-panel p-6 md:p-8"
          >
            <div className="mb-8">
              <h2 className="text-2xl font-display font-semibold text-white">Publishing surfaces</h2>
              <p className="mt-1 text-sm text-white/45">Connect channels, inspect status, and resolve anything blocking launch operations.</p>
            </div>

            {integrationsLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }, (_, index) => (
                  <div key={index} className="h-28 animate-pulse rounded-2xl border border-white/[0.05] bg-white/[0.02]" />
                ))}
              </div>
            ) : integrationsErrorMessage && model.integrations.cards.length === 0 ? (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-5 text-sm text-red-100">
                {integrationsErrorMessage}
              </div>
            ) : model.integrations.cards.length === 0 ? (
              <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-5 text-sm text-zinc-500">
                No integrations are available yet.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {model.integrations.cards.map((card) => (
                  <div key={card.platform} className="rounded-[1.6rem] border border-white/[0.05] bg-white/[0.02] p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-base font-semibold text-white">{card.displayName}</p>
                        <p className="mt-1 text-sm text-white/45">{card.handle}</p>
                      </div>
                      <span className={`rounded-full border px-3 py-1 text-xs font-medium ${integrationTone(card.statusTone)}`}>
                        {card.stateLabel}
                      </span>
                    </div>

                    <p className="mt-4 text-sm leading-relaxed text-white/58">{card.description}</p>
                    <div className="mt-4 flex flex-wrap gap-3 text-xs uppercase tracking-[0.2em] text-white/35">
                      <span>{card.permissionSummary}</span>
                      <span>{card.syncLabel}</span>
                    </div>

                    {card.errorMessage ? (
                      <div className="mt-4 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-50">
                        {card.errorMessage}
                      </div>
                    ) : null}

                    <div className="mt-5 flex flex-wrap gap-2">
                      {card.availableActions.map((action) => {
                        const actionKey = `${card.platform}:${action}`;
                        return (
                          <button
                            key={action}
                            type="button"
                            disabled={busyAction === actionKey}
                            onClick={() => onIntegrationAction(card.platform, action)}
                            className="rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 text-sm font-medium text-white/78 transition hover:bg-white/[0.08] disabled:opacity-60"
                          >
                            {busyAction === actionKey ? 'Working…' : labelForAction(action)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        ) : null}

        {activeTab === 'approvals' ? (
          <motion.div
            key="approvals"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.24, ease: 'easeOut' }}
            className="grid grid-cols-1 gap-6 xl:grid-cols-[0.92fr_1.08fr]"
          >
            <section className="glass-panel p-6 md:p-8">
              <div className="mb-6">
                <h2 className="text-2xl font-display font-semibold text-white">Launch approval owner</h2>
                <p className="mt-1 text-sm text-white/45">Choose who should be responsible for final human sign-off before launch.</p>
              </div>

              <div className="space-y-4">
                <label className="block text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">
                  Launch approver
                </label>
                <select
                  value={form.launchApproverUserId}
                  onChange={(event) => onLaunchApproverChange(event.target.value)}
                  className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4 text-white outline-none transition-all focus:border-primary/40 focus:bg-white/[0.05]"
                >
                  {model.team.approverOptions.map((option) => (
                    <option key={option.value || 'owner-default'} value={option.value} className="bg-black">
                      {option.label}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  onClick={onSave}
                  disabled={isSaving}
                  className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-medium text-white shadow-[0_0_20px_rgba(123,97,255,0.3)] transition-all hover:bg-primary/90 disabled:opacity-60"
                >
                  <Save className="h-4 w-4" />
                  {isSaving ? 'Saving…' : 'Save approval settings'}
                </button>
              </div>
            </section>

            <section className="glass-panel p-6 md:p-8">
              <div className="mb-6">
                <h2 className="text-2xl font-display font-semibold text-white">Team roster</h2>
                <p className="mt-1 text-sm text-white/45">Everyone who can influence launch safety and approvals in this tenant.</p>
              </div>

              {model.team.members.length === 0 ? (
                <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-5 text-sm text-zinc-500">
                  No team members are available yet.
                </div>
              ) : (
                <div className="space-y-4">
                  {model.team.members.map((member) => (
                    <div key={member.userId} className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-white">{member.name}</p>
                          <p className="mt-1 text-sm text-white/65">{member.role}</p>
                          <p className="mt-2 text-sm text-white/45">{member.email}</p>
                        </div>
                        {member.isApprover ? (
                          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-100">
                            <Sparkles className="h-3.5 w-3.5" />
                            Launch approver
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Field(props: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  icon?: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <label className="block text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">
        {props.label}
      </label>
      <div className="relative">
        {props.icon ? <div className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2">{props.icon}</div> : null}
        <input
          type="text"
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder={props.placeholder}
          className={`w-full rounded-2xl border border-white/10 bg-white/[0.03] py-4 text-white outline-none transition-all placeholder:text-white/20 focus:border-primary/40 focus:bg-white/[0.05] ${
            props.icon ? 'pl-12 pr-4' : 'px-5'
          }`}
        />
      </div>
    </div>
  );
}

function SaveStateBanner(props: {
  incomplete: boolean;
  saveErrorMessage?: string | null;
  saveSucceeded?: boolean;
}) {
  if (props.saveErrorMessage) {
    return (
      <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-4 text-sm text-red-100">
        {props.saveErrorMessage}
      </div>
    );
  }

  if (props.incomplete) {
    return (
      <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-4 text-sm text-amber-50">
        This profile is incomplete. Add a website, business type, and primary goal so Aries can use it across campaigns.
      </div>
    );
  }

  if (props.saveSucceeded) {
    return (
      <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-4 text-sm text-emerald-50">
        Settings saved successfully.
      </div>
    );
  }

  return null;
}

function integrationTone(tone: SettingsViewModel['integrations']['cards'][number]['statusTone']) {
  if (tone === 'good') return 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100';
  if (tone === 'watch') return 'border-amber-400/20 bg-amber-400/10 text-amber-100';
  return 'border-white/10 bg-white/[0.05] text-white/75';
}

function labelForAction(action: SettingsIntegrationAction): string {
  switch (action) {
    case 'connect':
      return 'Connect';
    case 'reconnect':
      return 'Reconnect';
    case 'disconnect':
      return 'Disconnect';
    case 'sync_now':
      return 'Sync';
    default:
      return action;
  }
}
