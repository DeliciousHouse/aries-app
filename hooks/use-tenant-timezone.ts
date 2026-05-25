'use client';

import { useContext } from 'react';
import { SessionContext } from 'next-auth/react';
import { DEFAULT_TENANT_TIMEZONE } from '@/lib/format-timestamp';

type SessionContextValue = { data?: { user?: { timezone?: string } } | null };

export function useTenantTimezone(): string {
  const ctx = useContext(SessionContext as React.Context<SessionContextValue | undefined>);
  return ctx?.data?.user?.timezone ?? DEFAULT_TENANT_TIMEZONE;
}
