import { redirect } from 'next/navigation';

export const metadata = {
  title: 'Connections — Aries AI',
};

// The account-connections UI now lives inside the dashboard shell under the
// "Channel Integrations" nav entry. This standalone route is kept as a stable
// redirect so old links / bookmarks / OAuth callbacks land on the canonical
// in-dashboard surface. The destination is auth-gated by the dashboard shell.
export default function ConnectionsPage() {
  redirect('/dashboard/settings/channel-integrations');
}
