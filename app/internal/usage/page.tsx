import { notFound } from 'next/navigation';

import InternalUsageAttributionScreen from '@/frontend/internal/usage-attribution-screen';
import { isInternalUsageDashboardEnabled } from '@/backend/telemetry/usage-attribution-env';

export const metadata = {
  title: 'Internal usage & cost — Aries AI',
};

/**
 * AA-165 — the internal ops/finance dashboard.
 *
 * Deliberately NOT wrapped in AppShellLayout and absent from
 * frontend/app-shell/routes.ts: the customer shell's nav is for customers, and
 * this surface is staff-only. The page renders no data itself — every figure
 * comes from /api/internal/usage-attribution, which is guarded by the staff
 * allow-list — so reaching this URL without a badge yields chrome and a refusal.
 *
 * Flag-gated to a real 404 so the surface does not exist at all when off.
 */
export default function InternalUsagePage() {
  if (!isInternalUsageDashboardEnabled()) {
    notFound();
  }

  return (
    <main className="min-h-screen bg-[#11161c] px-6 py-10 text-white md:px-10">
      <div className="mx-auto w-full max-w-6xl">
        <InternalUsageAttributionScreen />
      </div>
    </main>
  );
}
