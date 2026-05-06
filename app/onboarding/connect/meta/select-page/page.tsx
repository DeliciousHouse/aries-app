import { redirect } from 'next/navigation';

import { dbGetPendingState } from '@/backend/integrations/oauth-db';
import { loadTenantContextOrResponse } from '@/lib/tenant-context-http';

import MetaPagePickerForm, { type PickerPage } from './PagePickerForm';

type StoredPickerPayload = {
  pages?: Array<{
    id?: string;
    name?: string;
    instagramBusinessAccountId?: string | null;
  }>;
};

export const dynamic = 'force-dynamic';

export default async function MetaSelectPagePage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const params = await searchParams;
  const state = params.state?.trim() ?? '';
  if (!state) {
    redirect('/onboarding/start');
  }

  const tenantResult = await loadTenantContextOrResponse();
  if ('response' in tenantResult) {
    redirect('/login?next=/onboarding');
  }

  const pending = await dbGetPendingState(state);
  if (!pending || pending.provider !== 'facebook' || !pending.picker_payload) {
    redirect('/onboarding/start');
  }
  if (new Date(pending.expires_at).getTime() <= Date.now()) {
    redirect('/onboarding/start');
  }
  if (String(pending.tenant_id) !== String(tenantResult.tenantContext.tenantId)) {
    redirect('/onboarding/start');
  }

  const stored = pending.picker_payload as StoredPickerPayload;
  const pages: PickerPage[] = (stored.pages ?? [])
    .filter((p): p is { id: string; name?: string; instagramBusinessAccountId?: string | null } =>
      typeof p?.id === 'string' && p.id.length > 0,
    )
    .map((p) => ({
      id: p.id,
      name: typeof p.name === 'string' && p.name.length > 0 ? p.name : p.id,
      hasInstagram: typeof p.instagramBusinessAccountId === 'string' && p.instagramBusinessAccountId.length > 0,
    }));

  if (pages.length === 0) {
    redirect('/onboarding/start');
  }

  return (
    <div className="min-h-screen bg-[#0a0a14] text-white px-4 py-12">
      <div className="w-full max-w-2xl mx-auto">
        <div className="mb-8">
          <p className="text-[11px] uppercase tracking-[0.22em] text-[#666] mb-2 font-medium">
            Connect Meta · Choose a Page
          </p>
          <h2 className="text-3xl font-bold text-white mb-2">Pick the Facebook Page to connect</h2>
          <p className="text-[#888] text-base leading-relaxed">
            Aries publishes to one Facebook Page (and its linked Instagram Business Account if available). Pages
            without an Instagram Business Account will publish to Facebook only.
          </p>
        </div>
        <MetaPagePickerForm state={state} pages={pages} />
      </div>
    </div>
  );
}
