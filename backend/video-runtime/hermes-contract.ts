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

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return (
    octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
  );
}

function isPublicHttpsUrl(raw: string): boolean {
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (
      !hostname
      || hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname === '::1'
      || hostname.startsWith('fc')
      || hostname.startsWith('fd')
      || hostname.startsWith('fe80:')
      || isPrivateIpv4(hostname)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

const PublicHttpsUrlSchema = z.string().min(1).refine(isPublicHttpsUrl, {
  message: 'video source locators must be public HTTPS URLs without credentials or traversal segments',
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
  if (event.callback.status !== binding.callbackStatus) {
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
});

function findForbiddenOwnershipKey(value: Record<string, unknown>, path: string): string | null {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_EXECUTION_OWNERSHIP_KEYS.has(key)) return `${path}.${key}`;
  }
  return null;
}

/**
 * Validate the video-specific invariants layered on the shared Hermes wire
 * schema. This is a projection validator: the returned object is the exact
 * payload sent to `/v1/runs`, not a second transport envelope.
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
  if (!submission.input.includes('video.generate')) {
    throw new Error('video_render_submission_invalid: input must contain a video.generate media request');
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
