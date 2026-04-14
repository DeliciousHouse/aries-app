import AriesOsPage from '@/frontend/aries-os/page';

export default async function OpsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const view = typeof params.view === 'string' ? params.view : null;
  return <AriesOsPage initialView={view} />;
}
