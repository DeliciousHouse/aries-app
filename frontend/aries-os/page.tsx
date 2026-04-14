import { getAriesOsWorkspaceData } from '@/backend/aries-os/workspace-contract';

import AriesOsShell from './shell';

export default function AriesOsPage({ initialView }: { initialView?: string | null }) {
  const data = getAriesOsWorkspaceData(initialView);
  return <AriesOsShell data={data} />;
}
