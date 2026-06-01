import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import ComposioConnectionsScreen from '@/frontend/integrations/composio-connections-screen';

export const metadata = {
  title: 'Connections — Aries AI',
};

export default async function ConnectionsPage() {
  // Server-side auth guard: send logged-out visitors to login rather than
  // rendering page chrome. The connection APIs are independently tenant-gated;
  // this keeps the page consistent with the rest of the authenticated app.
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  return (
    <main className="min-h-screen bg-slate-950">
      <ComposioConnectionsScreen />
    </main>
  );
}
