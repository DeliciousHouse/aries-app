import { redirect } from 'next/navigation';

/**
 * AA-229/PR2b: /dashboard/results is retired. Its content (the weekly recap
 * report + the live-posts roster) now lives on /insights — the recap report
 * as Section 10 (frontend/insights/WeeklyRecapSection.tsx), and the roster's
 * job was superseded by the real analytics dashboard. See
 * frontend/aries-v1/results-screen.tsx (deleted) for the retired roster.
 */
export default function DashboardResultsPage() {
  redirect('/insights');
}
