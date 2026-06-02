import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import { VariantBoard } from '@/frontend/aries-v1/variant-board';

export const metadata = {
  title: 'Pick your first post — Aries AI',
};

/**
 * Post-auth onboarding page that renders the first-post variant board. Reached
 * from /onboarding/resume when ARIES_ONBOARDING_VARIANT_BOARD_ENABLED is on.
 * Tenant scoping is enforced by the board API (GET/POST /api/onboarding/variants);
 * this page only gates on an authenticated session.
 */
export default async function OnboardingVariantBoardPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/onboarding/variants/${batchId}`)}`);
  }

  return (
    <main className="min-h-screen bg-[#0a0712] px-6 py-12 text-white">
      <div className="mx-auto max-w-6xl">
        <VariantBoard batchId={batchId} />
      </div>
    </main>
  );
}
