import type { TenantContext } from '@/lib/tenant-context';
import { TenantMemoryClient } from './honcho-client';
import type { HonchoTransport } from './honcho-client';
import { HonchoHttpTransport } from './honcho-http-transport';
import { workspaceIdForTenant } from './pseudonym';
import { MemoryError } from './errors';

const DEFAULT_MAX_POLLS = 5;
const DEFAULT_POLL_DELAY_MS = 500;

export type TenantDeletionResult =
  | { status: 'ok' }
  | { status: 'incomplete'; survivors: string[] };

type MinimalCtx = Pick<TenantContext, 'tenantId' | 'tenantSlug' | 'userId' | 'role'>;

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function archiveTenantMemory(
  ctx: MinimalCtx,
  options: {
    transport?: HonchoTransport;
    maxPolls?: number;
    pollDelayMs?: number;
  } = {},
): Promise<TenantDeletionResult> {
  const transport: HonchoTransport = options.transport ?? new HonchoHttpTransport();
  const client = new TenantMemoryClient(transport);
  const maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS;
  const pollDelayMs = options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS;

  const workspaceId = workspaceIdForTenant(ctx.tenantId);

  try {
    await client.deleteWorkspace(ctx);
  } catch (err) {
    if (err instanceof MemoryError && err.code === 'workspace_not_found') {
      return { status: 'ok' };
    }
    throw err;
  }

  const survivors: string[] = [];

  for (let poll = 0; poll < maxPolls; poll++) {
    await sleep(pollDelayMs);

    const stillPresent: string[] = [];

    const workspaceCheck = await checkGone(transport, 'GET', `/v3/workspaces/${workspaceId}`, workspaceId);
    if (!workspaceCheck) stillPresent.push('workspace');

    const peersCheck = await checkEmpty(transport, 'GET', `/v3/workspaces/${workspaceId}/peers`, workspaceId);
    if (!peersCheck) stillPresent.push('peers');

    const sessionsCheck = await checkEmpty(transport, 'GET', `/v3/workspaces/${workspaceId}/sessions`, workspaceId);
    if (!sessionsCheck) stillPresent.push('sessions');

    if (stillPresent.length === 0) {
      return { status: 'ok' };
    }

    if (poll === maxPolls - 1) {
      survivors.push(...stillPresent);
    }
  }

  if (survivors.length > 0) {
    return { status: 'incomplete', survivors };
  }

  return { status: 'ok' };
}

async function checkGone(
  transport: HonchoTransport,
  method: 'GET',
  path: string,
  workspaceId: string,
): Promise<boolean> {
  try {
    await transport.request({ method, path, workspaceId });
    return false;
  } catch (err) {
    if (err instanceof MemoryError && err.code === 'workspace_not_found') {
      return true;
    }
    return true;
  }
}

async function checkEmpty(
  transport: HonchoTransport,
  method: 'GET',
  path: string,
  workspaceId: string,
): Promise<boolean> {
  try {
    const result = await transport.request<{ items?: unknown[] }>({ method, path, workspaceId });
    const items = result?.items;
    return !items || items.length === 0;
  } catch (err) {
    if (err instanceof MemoryError && (err.code === 'workspace_not_found' || err.status === 404)) {
      return true;
    }
    return true;
  }
}
