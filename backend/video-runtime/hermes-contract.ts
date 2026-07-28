import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';

import { z } from 'zod';

import {
  HermesRunCallbackPayloadSchema,
  HermesRunSubmissionSchema,
  type HermesRunCallbackPayload,
  type HermesRunSubmission,
} from '@aries/hermes-protocol';

const PRODUCTION_MARKETING_JOB_ID = /^mkt_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARIES_RUN_ID = /^arun_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_EXECUTION_OWNERSHIP_KEYS = new Set([
  'provider',
  'media_provider',
  'model',
  'model_id',
  'provider_options',
]);
const MAX_SOURCE_REDIRECTS = 5;

function ipv4Octets(hostname: string): number[] | null {
  const octets = hostname.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function isPublicIpv4(hostname: string): boolean {
  const octets = ipv4Octets(hostname);
  if (!octets) return false;
  const [a, b] = octets;
  return !(
    a === 0
    || a === 10
    || (a === 100 && b >= 64 && b <= 127)
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && octets[2] === 0)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && octets[2] === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && octets[2] === 100)
    || (a === 203 && b === 0 && octets[2] === 113)
    || a >= 224
  );
}

function ipv6Bytes(hostname: string): number[] | null {
  let normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').split('%', 1)[0];
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const octets = ipv4Octets(normalized.slice(lastColon + 1));
    if (!octets) return null;
    normalized = `${normalized.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function isPublicIpv6(hostname: string): boolean {
  const bytes = ipv6Bytes(hostname);
  if (!bytes) return false;

  const ipv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (ipv4Mapped) {
    return isPublicIpv4(bytes.slice(12).join('.'));
  }

  // Public unicast IPv6 is 2000::/3. This excludes unspecified/loopback,
  // link-local fe80::/10, ULA fc00::/7, multicast ff00::/8, and transition/
  // documentation ranges that are not routable public source destinations.
  return (bytes[0] & 0xe0) === 0x20;
}

function normalizedHostname(raw: string): string {
  return raw.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function isPublicVideoSourceUrl(raw: string): boolean {
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const hostname = normalizedHostname(url.hostname);
    if (
      !hostname
      || hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || hostname.endsWith('.internal')
      || hostname.endsWith('.home.arpa')
    ) {
      return false;
    }
    const ipVersion = isIP(hostname);
    if (ipVersion === 4) return isPublicIpv4(hostname);
    if (ipVersion === 6) return isPublicIpv6(hostname);
    return true;
  } catch {
    return false;
  }
}

export type VideoSourceHostLookup = (hostname: string) => Promise<string[]>;
export type VideoSourceFetch = (
  input: string | URL,
  init?: RequestInit,
  approvedAddresses?: readonly string[],
) => Promise<Response>;

async function lookupHostAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function assertPublicSourceUrl(raw: string): URL {
  if (!isPublicVideoSourceUrl(raw)) {
    throw new Error('video source locator must be a public HTTPS URL without credentials, traversal, or private addressing');
  }
  return new URL(raw);
}

async function assertPublicResolvedHost(url: URL, lookupHost: VideoSourceHostLookup): Promise<string[]> {
  const hostname = normalizedHostname(url.hostname);
  if (isIP(hostname)) return [hostname];
  let addresses: string[];
  try {
    addresses = await lookupHost(hostname);
  } catch {
    throw new Error('video source locator hostname could not be resolved safely');
  }
  if (addresses.length === 0 || addresses.some((address) => {
    const normalized = normalizedHostname(address);
    return isIP(normalized) === 4 ? !isPublicIpv4(normalized) : !isPublicIpv6(normalized);
  })) {
    throw new Error('video source locator must resolve only to public HTTPS destinations');
  }
  return addresses.map(normalizedHostname);
}

function fetchPinnedPublicSource(
  input: string | URL,
  init: RequestInit = {},
  approvedAddresses: readonly string[] = [],
): Promise<Response> {
  const target = input instanceof URL ? input : new URL(input);
  const approvedAddress = approvedAddresses[0];
  if (target.protocol !== 'https:' || !approvedAddress) {
    return Promise.reject(new Error('video source request requires a validated public HTTPS address'));
  }

  const originalHostname = normalizedHostname(target.hostname);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  headers.host = target.host;

  return new Promise((resolve, reject) => {
    let settled = false;
    const request = httpsRequest({
      protocol: 'https:',
      hostname: approvedAddress,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: init.method ?? 'GET',
      headers,
      servername: isIP(originalHostname) ? undefined : originalHostname,
      timeout: 10_000,
    }, (response) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(name, item);
        } else if (value !== undefined) {
          responseHeaders.set(name, String(value));
        }
      }
      settled = true;
      const rawStatus = response.statusCode ?? 502;
      const status = rawStatus >= 200 && rawStatus <= 599 ? rawStatus : 502;
      resolve(new Response(null, { status, statusText: response.statusMessage, headers: responseHeaders }));
      response.destroy();
    });
    request.once('timeout', () => request.destroy(new Error('video source validation request timed out')));
    request.once('error', (error) => {
      if (!settled) reject(error);
    });
    request.end();
  });
}

/**
 * Validate the complete HTTP redirect chain before accepting a source URL.
 * A bounded GET mirrors the method used for real retrieval; redirects are
 * followed manually so every Location is checked before fetch can connect to
 * it, preventing a public URL from pivoting into a private host.
 */
export async function validatePublicVideoSourceUrl(
  raw: string,
  fetchImpl: VideoSourceFetch = fetchPinnedPublicSource,
  lookupHost: VideoSourceHostLookup = lookupHostAddresses,
): Promise<string> {
  let current = assertPublicSourceUrl(raw);
  for (let redirectCount = 0; redirectCount <= MAX_SOURCE_REDIRECTS; redirectCount += 1) {
    const approvedAddresses = await assertPublicResolvedHost(current, lookupHost);
    const response = await fetchImpl(current, {
      method: 'GET',
      headers: { range: 'bytes=0-0' },
      redirect: 'manual',
    }, approvedAddresses);
    await response.body?.cancel().catch(() => {});
    if (response.status < 300 || response.status >= 400) return current.toString();
    const location = response.headers.get('location');
    if (!location) throw new Error('video source redirect is missing Location');
    if (redirectCount === MAX_SOURCE_REDIRECTS) throw new Error('video source redirect limit exceeded');
    current = assertPublicSourceUrl(new URL(location, current).toString());
  }
  throw new Error('video source redirect limit exceeded');
}

const PublicHttpsUrlSchema = z.string().min(1).refine(isPublicVideoSourceUrl, {
  message: 'video source locators must be public HTTPS URLs without credentials, traversal, or private addressing',
});

export const VideoSourceAssetSchema = z.object({
  type: z.literal('https_url'),
  url: PublicHttpsUrlSchema,
  mime_type: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
}).strict();

export const VideoRenderBriefSchema = z.object({
  prompt: z.string().min(1),
  aspect_ratio: z.enum(['9:16', '16:9', '1:1']),
  duration_seconds: z.number().int().min(1).max(300),
  input_assets: z.array(VideoSourceAssetSchema).max(16).default([]),
}).strict();

/** Enforce the public-source boundary on raw briefs at the live submit chokepoint. */
export async function validateVideoRenderSourceUrls(
  value: unknown,
  fetchImpl?: VideoSourceFetch,
  lookupHost?: VideoSourceHostLookup,
): Promise<void> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const rawBrief = (value as Record<string, unknown>).video_brief;
  if (rawBrief === undefined) return;
  const brief = VideoRenderBriefSchema.parse(rawBrief);
  for (const asset of brief.input_assets) {
    await validatePublicVideoSourceUrl(asset.url, fetchImpl, lookupHost);
  }
}

const VideoTerminalEventBaseSchema = z.object({
  event_type: z.enum([
    'video_render.completed',
    'video_render.failed',
    'video_render.cancelled',
  ]),
  runtime_phase: z.enum(['succeeded', 'failed', 'cancelled']),
  callback: HermesRunCallbackPayloadSchema,
}).strict();

const TERMINAL_BINDINGS = {
  'video_render.completed': { runtimePhase: 'succeeded', callbackStatus: 'completed' },
  'video_render.failed': { runtimePhase: 'failed', callbackStatus: 'failed' },
  'video_render.cancelled': { runtimePhase: 'cancelled', callbackStatus: 'cancelled' },
} as const;

export const VideoTerminalEventSchema = VideoTerminalEventBaseSchema.superRefine((event, ctx) => {
  const binding = TERMINAL_BINDINGS[event.event_type];
  if (event.runtime_phase !== binding.runtimePhase) {
    ctx.addIssue({
      code: 'custom',
      path: ['runtime_phase'],
      message: `${event.event_type} requires runtime_phase=${binding.runtimePhase}`,
    });
  }
  const callbackStatus = event.callback.status === 'stopped' ? 'cancelled' : event.callback.status;
  if (callbackStatus !== binding.callbackStatus) {
    ctx.addIssue({
      code: 'custom',
      path: ['callback', 'status'],
      message: `${event.event_type} requires callback.status=${binding.callbackStatus}`,
    });
  }
  if (event.callback.stage !== 'video_render') {
    ctx.addIssue({
      code: 'custom',
      path: ['callback', 'stage'],
      message: 'video terminal callbacks require stage=video_render',
    });
  }
  if (event.event_type === 'video_render.failed' && !event.callback.error) {
    ctx.addIssue({
      code: 'custom',
      path: ['callback', 'error'],
      message: 'video_render.failed requires callback.error',
    });
  }
}).transform((event) => event.callback.status === 'stopped'
  ? { ...event, callback: { ...event.callback, status: 'cancelled' as const } }
  : event);

function findForbiddenOwnershipKey(value: Record<string, unknown>, pathPrefix: string): string | null {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_EXECUTION_OWNERSHIP_KEYS.has(key)) return `${pathPrefix}.${key}`;
  }
  return null;
}

function hasStructuredVideoGenerateRequest(input: string): boolean {
  const prefix = 'Request (JSON):';
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(prefix)) continue;
    try {
      const request = JSON.parse(trimmed.slice(prefix.length).trim()) as unknown;
      if (!request || typeof request !== 'object' || Array.isArray(request)) continue;
      const requestRecord = request as Record<string, unknown>;
      const requestInput = requestRecord.input;
      if (!requestInput || typeof requestInput !== 'object' || Array.isArray(requestInput)) continue;
      const mediaRequests = (requestInput as Record<string, unknown>).media_requests;
      if (!Array.isArray(mediaRequests)) continue;
      if (mediaRequests.some((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
        const type = (entry as Record<string, unknown>).type;
        return type === 'video.generate' || type === 'video_generate';
      })) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

export function isVideoRenderHermesSubmission(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = (value as Record<string, unknown>).input;
  return typeof input === 'string' && (
    hasStructuredVideoGenerateRequest(input)
    || /^Video context \([1-9][0-9]* videos? requested\):$/m.test(input)
  );
}

/**
 * Validate video-specific invariants on the raw payload before the shared Zod
 * parser can strip unknown fields. The returned value is the exact shared
 * Hermes wire contract, not a parallel transport envelope.
 */
export function validateVideoRenderHermesSubmission(value: unknown): HermesRunSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('video_render_submission_invalid: submission must be an object');
  }
  const inputRecord = value as Record<string, unknown>;
  const inputContext = inputRecord.callback_context;
  const forbiddenInputPath = findForbiddenOwnershipKey(inputRecord, '$')
    ?? (
      inputContext && typeof inputContext === 'object' && !Array.isArray(inputContext)
        ? findForbiddenOwnershipKey(inputContext as Record<string, unknown>, '$.callback_context')
        : null
    );
  if (forbiddenInputPath) {
    throw new Error(`video_render_submission_invalid: Hermes owns execution selection; remove ${forbiddenInputPath}`);
  }
  const submission = HermesRunSubmissionSchema.parse(value);
  if (!PRODUCTION_MARKETING_JOB_ID.test(submission.job_id ?? '')) {
    throw new Error('video_render_submission_invalid: job_id must be a production mkt_<uuid> identifier');
  }
  if (!ARIES_RUN_ID.test(submission.aries_run_id ?? '')) {
    throw new Error('video_render_submission_invalid: aries_run_id must be an arun_<uuid> identifier');
  }
  if (!isVideoRenderHermesSubmission(submission)) {
    throw new Error('video_render_submission_invalid: input must contain an explicit video generation request');
  }
  if (
    submission.callback_context.aries_run_id !== submission.aries_run_id
    || submission.callback_context.job_id !== submission.job_id
    || submission.callback_context.tenant_id !== submission.tenant_id
  ) {
    throw new Error('video_render_submission_invalid: callback context ownership must match the submission');
  }
  return submission;
}

export function projectVideoTerminalEventToHermesCallback(value: unknown): HermesRunCallbackPayload {
  return VideoTerminalEventSchema.parse(value).callback;
}
