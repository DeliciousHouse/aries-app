/** Map Composio connection status -> Aries normalized ConnectionStatus. */

import type { ConnectionStatus } from '../providers/types';

export function mapComposioStatus(raw: string | null | undefined): ConnectionStatus {
  switch (String(raw ?? '').toUpperCase()) {
    case 'ACTIVE':
      return 'connected';
    case 'INITIATED':
      return 'pending';
    case 'EXPIRED':
    case 'INACTIVE':
      return 'reauthorization_required';
    case 'FAILED':
      return 'error';
    default:
      return 'pending';
  }
}

export function isActiveStatus(raw: string | null | undefined): boolean {
  return String(raw ?? '').toUpperCase() === 'ACTIVE';
}
