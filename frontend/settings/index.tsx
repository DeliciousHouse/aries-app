import React from 'react';
export interface SettingsScreenProps {
  baseUrl?: string;
}

export const SETTINGS_RUNTIME_STATUS = {
  status: 'not_implemented',
  missingEndpoint: '/api/tenant-admin/settings'
} as const;

export default function SettingsScreen(_props: SettingsScreenProps): JSX.Element {
  return (
    <div className="grid xl:grid-cols-2 gap-6">
      <div className="glass rounded-[2.5rem] p-8">
        <p className="text-xs uppercase tracking-[0.24em] text-white/35 mb-4">Runtime truth</p>
        <h2 className="text-3xl font-bold mb-4">Settings are intentionally read-only</h2>
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-5 mb-5">
          <strong className="block mb-2 text-red-100">No live tenant settings endpoint</strong>
          <span className="text-red-50/90 text-sm">
            The current runtime does not expose <code>{SETTINGS_RUNTIME_STATUS.missingEndpoint}</code>.
          </span>
        </div>
        <p className="text-white/60 leading-relaxed">
          This route stays in the shell to preserve navigation, but avoids presenting editable controls until the backend exposes a real source of truth.
        </p>
      </div>

      <div className="glass rounded-[2.5rem] p-8">
        <p className="text-xs uppercase tracking-[0.24em] text-white/35 mb-4">Next best actions</p>
        <div className="space-y-4 mb-6">
          <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 text-white/70">
            Review platform credentials and token health in <strong>Platforms</strong>.
          </div>
          <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 text-white/70">
            Use the <strong>Posts</strong> route for publish dispatch and retry controls.
          </div>
          <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 text-white/70">
            Track workflow status and approvals from the dedicated onboarding and marketing screens.
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-4">
          <a href="/platforms" className="px-6 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20 text-center">
            Go to platforms
          </a>
          <a href="/posts" className="px-6 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all text-center">
            Open posts console
          </a>
        </div>
      </div>
    </div>
  );
}
