import { getAriesOsWorkspaceData } from '@/backend/aries-os/workspace-contract';

import AriesOsShell from './shell';

export default function AriesOsPage(): JSX.Element {
  const data = getAriesOsWorkspaceData();
  return <AriesOsShell data={data} />;
}
