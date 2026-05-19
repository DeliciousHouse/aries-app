import type { MarketingJobRuntimeDocument } from '@/backend/marketing/runtime-state';

/**
 * Strips all resume tokens and secrets from a marketing job runtime document
 * before it crosses the server→client boundary (page props or API response).
 *
 * Fields removed:
 *   - approvals.current.resume_token
 *   - approvals.history[].resume_token
 *
 * The function also does a conservative deep-walk and removes any field whose
 * name ends with `_token` or `_secret` so future schema additions don't
 * silently create new leaks.
 */
export function sanitizeJobRuntimeDoc(
  doc: MarketingJobRuntimeDocument,
): Record<string, unknown> {
  const json = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  redactTokenFields(json);
  return json;
}

function redactTokenFields(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) redactTokenFields(item);
    return;
  }
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key.endsWith('_token') || key.endsWith('_secret')) {
      delete record[key];
    } else {
      redactTokenFields(record[key]);
    }
  }
}
