import type { ReactNode } from 'react';

import { DonorMarketingShell } from '@/frontend/donor/marketing/chrome';

export interface MarketingShellProps {
  children: ReactNode;
  currentPath?: string;
}

export function MarketingShell({
  children,
}: MarketingShellProps): JSX.Element {
  return <DonorMarketingShell>{children}</DonorMarketingShell>;
}
