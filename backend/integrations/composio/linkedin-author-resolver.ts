/**
 * Resolve a tenant's LinkedIn member person URN from Composio.
 *
 * The LinkedIn author URN (needed as the `author` for LINKEDIN_CREATE_LINKED_IN_POST,
 * #646) is NOT part of the Composio connection metadata, so connect-time
 * reconciliation leaves connected_accounts.external_account_id null. This helper
 * calls the verified LINKEDIN_GET_MY_INFO action (env-overridable via the
 * `account_info` op) using the connection's connectedAccountId and derives the
 * member's `urn:li:person:{id}`.
 *
 * The publisher (#646) reads connected_accounts.external_account_id straight into
 * `author`, so we persist the COMPLETE `urn:li:person:<id>` string here — never a
 * bare id (no reformatting downstream).
 *
 * Fail-safe: returns null on an unsuccessful tool call, a wrapper response that
 * is not `successful`, or when no member id is present (e.g. an APPLICATION DAY
 * 429 throttle, which can return an error/empty payload). Never invents a URN.
 * Self-only — the returned profile fields can be minimal (often id + localized
 * names; picture may be null), so the display name is best-effort.
 *
 * Response shape (verified via the live Composio catalog 2026-06-18):
 *   { data: { id, localizedFirstName, localizedLastName, ... }, successful, error }
 * Some toolkit versions wrap/batch the payload:
 *   { data: { results: [ { response: { data: { id, ... }, successful } } ] }, successful }
 */

import type { ComposioGateway } from './composio-client';
import type { ComposioConfig } from './composio-config';

export interface ResolvedLinkedInAuthor {
  /** The full author URN, e.g. `urn:li:person:abc123` — stored verbatim. */
  urn: string;
  /** Best-effort display name; may be null when the profile is minimal. */
  name: string | null;
}

/** Default verified slug; overridable via COMPOSIO_LINKEDIN_ACCOUNT_INFO_ACTION. */
export const DEFAULT_GET_MY_INFO_SLUG = 'LINKEDIN_GET_MY_INFO';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Pull the member profile object out of either the direct (`data`) shape or the
 * wrapper/batch (`data.results[0].response.data`) shape. The wrapper carries its
 * own `successful` flag, so an unsuccessful inner response yields no profile.
 */
function extractProfile(rawData: unknown): Record<string, unknown> | null {
  const data = asRecord(rawData);
  if (!data) return null;

  // Direct shape: id sits on data itself.
  if (trimmedString(data.id)) return data;

  // Wrapper/batch shape: data.results[0].response.{ data, successful }.
  const results = data.results;
  if (Array.isArray(results) && results.length > 0) {
    const response = asRecord(asRecord(results[0])?.response);
    if (response) {
      if (response.successful === false) return null;
      const inner = asRecord(response.data);
      if (inner && trimmedString(inner.id)) return inner;
    }
  }
  return null;
}

/** Best-effort display name: joined localized first/last, else name/localizedName. */
function extractName(profile: Record<string, unknown>): string | null {
  const first = trimmedString(profile.localizedFirstName);
  const last = trimmedString(profile.localizedLastName);
  const joined = [first, last].filter(Boolean).join(' ').trim();
  if (joined) return joined;
  return trimmedString(profile.name) ?? trimmedString(profile.localizedName);
}

export async function resolveLinkedInAuthorUrn(
  gateway: ComposioGateway,
  config: ComposioConfig,
  connectedAccountId: string,
): Promise<ResolvedLinkedInAuthor | null> {
  const slug = config.actionSlugFor('linkedin', 'account_info') ?? DEFAULT_GET_MY_INFO_SLUG;
  const result = await gateway.executeTool(slug, { connectedAccountId, arguments: {} });
  if (!result.successful) return null;

  const profile = extractProfile(result.data);
  if (!profile) return null;

  const id = trimmedString(profile.id);
  if (!id) return null; // never invent a URN

  return { urn: `urn:li:person:${id}`, name: extractName(profile) };
}
