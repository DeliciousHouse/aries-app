/**
 * Minimal OUTBOUND Slack client (Phase 4 PR 2).
 *
 * Posts a message via the Web API `chat.postMessage`, authenticated with a bot
 * token (`SLACK_BOT_TOKEN`, needs the `chat:write` scope). This is the smallest
 * outbound surface that supports Block Kit and can later be extended with
 * interactive elements (PR3 approve-from-Slack).
 *
 * Hard rules:
 *   - NEVER throw. The marketing callback path is the source of truth; a Slack
 *     failure must not break completion bookkeeping. Every path returns a
 *     structured `{ ok, error? }` result and logs on failure.
 *   - Bounded by an AbortController timeout so a hung Slack API can't wedge the
 *     caller. Slack itself retries inbound deliveries on slow responses; we keep
 *     the outbound call short and fire it off the request path.
 *   - Token/channel are injectable for tests; default to env + global fetch.
 */

export interface PostSlackMessageInput {
  /** Channel ID (e.g. `C0123ABCD`) or `#channel-name`. */
  channel: string;
  /** Plain-text fallback shown in notifications and on clients without blocks. */
  text: string;
  /** Optional Block Kit blocks for rich formatting. */
  blocks?: unknown[];
}

export interface PostSlackMessageResult {
  ok: boolean;
  /** Slack `error` code (e.g. `channel_not_found`) or a transport reason. */
  error?: string;
  /** Slack message timestamp on success (handle for a future thread/update). */
  ts?: string;
}

export interface SlackClientDeps {
  /** Defaults to `process.env.SLACK_BOT_TOKEN`. */
  botToken?: string;
  /** Defaults to global `fetch`. Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. Defaults to 5000. */
  timeoutMs?: number;
}

const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';
const DEFAULT_TIMEOUT_MS = 5000;

export async function postSlackMessage(
  input: PostSlackMessageInput,
  deps: SlackClientDeps = {},
): Promise<PostSlackMessageResult> {
  const botToken = deps.botToken ?? process.env.SLACK_BOT_TOKEN ?? '';
  if (!botToken) {
    console.warn('[slack-client] SLACK_BOT_TOKEN is not set; skipping outbound message');
    return { ok: false, error: 'missing_bot_token' };
  }
  if (!input.channel) {
    return { ok: false, error: 'missing_channel' };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(SLACK_POST_MESSAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel: input.channel,
        text: input.text,
        ...(input.blocks ? { blocks: input.blocks } : {}),
      }),
      signal: controller.signal,
    });

    // Slack returns HTTP 200 with `{ ok: false, error }` for API-level failures,
    // so we must inspect the body, not just the status.
    let body: { ok?: boolean; error?: string; ts?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      body = {};
    }

    if (!res.ok) {
      console.warn('[slack-client] chat.postMessage HTTP error', {
        status: res.status,
        slackError: body?.error,
      });
      return { ok: false, error: body?.error ?? `http_${res.status}` };
    }
    if (!body.ok) {
      console.warn('[slack-client] chat.postMessage returned ok:false', {
        slackError: body?.error,
      });
      return { ok: false, error: body?.error ?? 'unknown_slack_error' };
    }
    return { ok: true, ts: body.ts };
  } catch (err) {
    const reason =
      (err as Error)?.name === 'AbortError'
        ? 'timeout'
        : (err as Error)?.message ?? String(err);
    console.warn('[slack-client] chat.postMessage failed', { reason });
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}
