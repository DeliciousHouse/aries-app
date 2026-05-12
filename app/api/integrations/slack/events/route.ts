/**
 * Slack Events API webhook — Phase 4 PR 1.
 *
 * This route does the smallest possible thing: verify the signature, handle
 * the URL verification challenge, dedupe by `event_id`, and 200 every other
 * event. **Zero business logic.** Reaction routing, reply parsing, and
 * outbound posts land in later PRs.
 *
 * Why no business logic here:
 *   1. We want to deploy the route, configure the Slack app, and watch the
 *      wire before wiring anything that touches marketing state.
 *   2. Slack retries on non-2xx within 3s. Heavy work on the request path
 *      causes spurious retries that fight idempotency.
 *
 * Idempotency: every Events API delivery has a stable top-level `event_id`
 * (note: top-level on the envelope, NOT inside the inner `event` object).
 * We insert into `slack_event_ids` with `ON CONFLICT DO NOTHING`. Slack also
 * sets `X-Slack-Retry-Num`; we observe it for logging but the event-id table
 * is the source of truth for "have I seen this?".
 */
import { NextResponse } from 'next/server';

import pool from '@/lib/db';
import { verifySlackSignature } from '@/backend/integrations/slack/events/verify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SlackUrlVerificationBody {
  type: 'url_verification';
  challenge: string;
  token?: string;
}

interface SlackEventCallbackBody {
  type: 'event_callback';
  event_id?: string;
  team_id?: string;
  event?: Record<string, unknown>;
}

type SlackInboundBody =
  | SlackUrlVerificationBody
  | SlackEventCallbackBody
  | { type?: string; [k: string]: unknown };

async function recordEventId(eventId: string): Promise<{ duplicate: boolean }> {
  try {
    const result = await pool.query(
      `INSERT INTO slack_event_ids (event_id) VALUES ($1)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eventId],
    );
    return { duplicate: result.rowCount === 0 };
  } catch (error) {
    // Fail open: if the dedupe table is unavailable, log and treat as new.
    // Business-logic PRs that arrive after PR1 must handle their own
    // idempotency (approval-store upserts, Honcho idempotency keys).
    console.error('[slack-events] dedupe insert failed', error);
    return { duplicate: false };
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const rawBody = await req.text();
  const timestamp = req.headers.get('x-slack-request-timestamp');
  const signature = req.headers.get('x-slack-signature');
  const retryNumHeader = req.headers.get('x-slack-retry-num');
  const retryReason = req.headers.get('x-slack-retry-reason');
  const retryNum = Number(retryNumHeader ?? '0') || 0;

  const signingSecret = process.env.SLACK_SIGNING_SECRET ?? '';
  if (!signingSecret) {
    console.error('[slack-events] SLACK_SIGNING_SECRET is not set; returning 503');
    return new NextResponse(null, { status: 503 });
  }

  const verification = verifySlackSignature({
    signingSecret,
    rawBody,
    timestamp,
    signature,
  });
  if (!verification.ok) {
    console.warn('[slack-events] signature rejected', { reason: verification.reason });
    return new NextResponse(null, { status: 401 });
  }

  let body: SlackInboundBody;
  try {
    body = JSON.parse(rawBody) as SlackInboundBody;
  } catch (error) {
    console.warn('[slack-events] body parse failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new NextResponse(null, { status: 400 });
  }

  // URL verification handshake. Slack expects the challenge echoed back.
  if (body?.type === 'url_verification') {
    const challenge = (body as SlackUrlVerificationBody).challenge;
    if (typeof challenge !== 'string') {
      return new NextResponse(null, { status: 400 });
    }
    return NextResponse.json({ challenge });
  }

  // Event callbacks: dedupe by event_id. Future PRs add dispatch routing.
  if (body?.type === 'event_callback') {
    const eventId = (body as SlackEventCallbackBody).event_id;
    if (typeof eventId === 'string' && eventId.length > 0) {
      const { duplicate } = await recordEventId(eventId);
      if (duplicate) {
        if (retryNum > 0) {
          console.info('[slack-events] retry dropped via dedupe', {
            eventId,
            retryNum,
            retryReason,
          });
        }
        // Idempotent ack — same response a fresh event would get.
        return new NextResponse(null, { status: 200 });
      }
    }
    // PR1 stops here. Future PRs dispatch to handlers via setImmediate.
    return new NextResponse(null, { status: 200 });
  }

  // Anything else (app_uninstalled, tokens_revoked, etc.) — ack 200. PR1
  // intentionally has zero handlers wired.
  return new NextResponse(null, { status: 200 });
}
