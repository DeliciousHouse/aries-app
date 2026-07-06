/**
 * backend/insights/sync/classify-comments.ts
 *
 * Comment sentiment / lead / category classification via a RAW Hermes run —
 * the same submit-and-poll pattern as brand-kit-enrich.ts (POST /v1/runs with a
 * model hint in `instructions`, then poll /v1/runs/{id} to terminal). It does
 * NOT depend on a pre-registered Hermes skill; it is a raw prompt run, so no
 * Hermes-repo change is required.
 *
 * Consumed by the insights-sync dispatcher after the comment-fetch leg. It is:
 *   - env-gated (ARIES_COMMENT_CLASSIFICATION_ENABLED, default OFF),
 *   - batched (bounded prompt + latency per sync tick),
 *   - best-effort: any failure returns { ok: false } so the sync worker's
 *     comment leg is never broken by a classification outage.
 *
 * Output vocabulary is pinned to what the readers expect (conversations-builder
 * deriveTag + goal lead counting + the classifications table CHECK comments):
 *   sentiment ∈ positive | neutral | negative
 *   isLead    ∈ true | false
 *   category  ∈ question | compliment | complaint | spam | other
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MIN_POLL_INTERVAL_MS = 250;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'stopped']);
const DEFAULT_MODEL_HINT = 'gemini/gemini-3-flash-preview';

/** Max comments classified per Hermes run — bounds prompt size + tick latency. */
export const MAX_CLASSIFY_BATCH = 40;

const SENTIMENTS = new Set(['positive', 'neutral', 'negative']);
const CATEGORIES = new Set(['question', 'compliment', 'complaint', 'spam', 'other']);

export type CommentLabel = {
  sentiment: 'positive' | 'neutral' | 'negative';
  isLead:    boolean;
  category:  'question' | 'compliment' | 'complaint' | 'spam' | 'other';
};

export type ClassifyInput = { id: number; text: string };

export type ClassifyFailureReason =
  | 'disabled'
  | 'not_configured'
  | 'empty_input'
  | 'unreachable'
  | 'submit_rejected'
  | 'submit_invalid'
  | 'poll_rejected'
  | 'poll_invalid'
  | 'timeout'
  | 'run_failed'
  | 'output_invalid';

export type ClassifyResult =
  | { ok: true; labels: Map<number, CommentLabel> }
  | { ok: false; reason: ClassifyFailureReason; detail?: string };

type ClassifyEnv = Partial<Record<string, string | undefined>>;
type ClassifyFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type ClassifySleep = (ms: number) => Promise<void>;

export type ClassifyCommentsInput = {
  comments:  ClassifyInput[];
  env?:      ClassifyEnv;
  fetchImpl?: ClassifyFetch;
  sleep?:    ClassifySleep;
};

function readEnv(env: ClassifyEnv, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readEnvInt(env: ClassifyEnv, key: string, fallback: number): number {
  const raw = readEnv(env, key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function isCommentClassificationEnabled(env: ClassifyEnv = process.env): boolean {
  const flag = readEnv(env, 'ARIES_COMMENT_CLASSIFICATION_ENABLED').toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes';
}

function instructionsBlock(): string {
  return [
    'You are a social-media comment classifier for a brand. You will receive a JSON array of comments, each with an "id" and "text".',
    'For EACH comment, classify three things:',
    '- sentiment: one of "positive", "neutral", "negative" (the commenter\'s tone toward the brand/post).',
    '- is_lead: boolean. true ONLY when the comment shows genuine purchase or inquiry intent (asking price/availability, wanting to buy/book, requesting a DM/quote, "how do I get this"). General praise is NOT a lead.',
    '- category: one of "question" (asks something answerable), "compliment" (praise/positive reaction), "complaint" (dissatisfaction/negative), "spam" (promo/bot/irrelevant), "other".',
    'Return ONE strict JSON object. No prose, no markdown fences. JSON only.',
    'Schema: {"status":"ok","output":[{"id":number,"sentiment":string,"is_lead":boolean,"category":string}]}',
    'Return exactly one output entry per input comment, echoing its id. If a comment is empty or unintelligible, use sentiment "neutral", is_lead false, category "other".',
  ].join('\n');
}

function promptBlock(comments: ClassifyInput[], modelHint: string): string {
  const payload = comments.map((c) => ({ id: c.id, text: (c.text ?? '').slice(0, 500) }));
  return [
    `Model hint: ${modelHint}`,
    'Classify these comments and return the JSON envelope now:',
    JSON.stringify(payload),
  ].join('\n');
}

function tryParseJson(text: string): unknown {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function normalizeLabel(row: Record<string, unknown>): CommentLabel {
  const s = typeof row.sentiment === 'string' ? row.sentiment.trim().toLowerCase() : '';
  const c = typeof row.category === 'string' ? row.category.trim().toLowerCase() : '';
  return {
    sentiment: (SENTIMENTS.has(s) ? s : 'neutral') as CommentLabel['sentiment'],
    isLead:    row.is_lead === true || row.is_lead === 'true',
    category:  (CATEGORIES.has(c) ? c : 'other') as CommentLabel['category'],
  };
}

function labelsFromOutput(value: unknown, validIds: Set<number>): Map<number, CommentLabel> | null {
  const envelope = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
  if (!envelope) return null;
  if (typeof envelope.status === 'string' && envelope.status !== 'ok') return null;
  const output = envelope.output;
  if (!Array.isArray(output)) return null;

  const labels = new Map<number, CommentLabel>();
  for (const entry of output) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const id = Number(row.id);
    if (!Number.isFinite(id) || !validIds.has(id)) continue;
    labels.set(id, normalizeLabel(row));
  }
  return labels.size > 0 ? labels : null;
}

/**
 * Classify a batch of comments via a raw Hermes run. Best-effort: returns
 * { ok:false, reason } on any gate/config/transport/parse failure — never throws.
 */
export async function classifyCommentsWithHermes(input: ClassifyCommentsInput): Promise<ClassifyResult> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  if (!isCommentClassificationEnabled(env)) return { ok: false, reason: 'disabled' };

  const comments = input.comments.slice(0, MAX_CLASSIFY_BATCH);
  if (comments.length === 0) return { ok: false, reason: 'empty_input' };

  const gatewayUrl = readEnv(env, 'HERMES_GATEWAY_URL').replace(/\/+$/, '');
  const apiKey = readEnv(env, 'HERMES_API_SERVER_KEY');
  if (!gatewayUrl || !apiKey) return { ok: false, reason: 'not_configured' };

  const sessionKey = readEnv(env, 'HERMES_COMMENT_CLASSIFY_SESSION_KEY') || readEnv(env, 'HERMES_SESSION_KEY') || 'aries-main';
  const modelHint = readEnv(env, 'HERMES_COMMENT_CLASSIFY_MODEL') || DEFAULT_MODEL_HINT;
  const timeoutMs = readEnvInt(env, 'HERMES_COMMENT_CLASSIFY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const intervalMs = Math.max(MIN_POLL_INTERVAL_MS, readEnvInt(env, 'HERMES_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS));
  const auth = `Bearer ${apiKey}`;
  const validIds = new Set(comments.map((c) => c.id));

  const body = {
    input: promptBlock(comments, modelHint),
    instructions: instructionsBlock(),
    session_id: sessionKey,
  };

  let runId: string;
  try {
    const submitController = new AbortController();
    const submitTimer = setTimeout(() => submitController.abort(), timeoutMs);
    let submit: Response;
    try {
      submit = await fetchImpl(`${gatewayUrl}/v1/runs`, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: submitController.signal,
      });
    } finally {
      clearTimeout(submitTimer);
    }
    if (!submit.ok) return { ok: false, reason: 'submit_rejected', detail: `HTTP ${submit.status}` };
    const submitJson = (await submit.json().catch(() => null)) as Record<string, unknown> | null;
    const candidate = submitJson && typeof submitJson.run_id === 'string' ? submitJson.run_id.trim() : '';
    if (!candidate) return { ok: false, reason: 'submit_invalid' };
    runId = candidate;
  } catch (error) {
    return { ok: false, reason: 'unreachable', detail: error instanceof Error ? error.message : String(error) };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    let pollJson: Record<string, unknown> | null;
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const pollController = new AbortController();
      const pollTimer = setTimeout(() => pollController.abort(), remaining);
      let poll: Response;
      try {
        poll = await fetchImpl(`${gatewayUrl}/v1/runs/${encodeURIComponent(runId)}`, {
          method: 'GET',
          headers: { authorization: auth },
          signal: pollController.signal,
        });
      } finally {
        clearTimeout(pollTimer);
      }
      if (!poll.ok) return { ok: false, reason: 'poll_rejected', detail: `HTTP ${poll.status}` };
      pollJson = (await poll.json().catch(() => null)) as Record<string, unknown> | null;
    } catch (error) {
      return { ok: false, reason: 'unreachable', detail: error instanceof Error ? error.message : String(error) };
    }
    const status = pollJson && typeof pollJson.status === 'string' ? pollJson.status : '';
    if (!status) return { ok: false, reason: 'poll_invalid' };
    if (TERMINAL_STATUSES.has(status)) {
      if (status !== 'completed') return { ok: false, reason: 'run_failed', detail: status };
      const outputText = typeof pollJson?.output === 'string' ? pollJson.output : '';
      const labels = labelsFromOutput(tryParseJson(outputText), validIds);
      if (!labels) return { ok: false, reason: 'output_invalid' };
      return { ok: true, labels };
    }
    await sleep(intervalMs);
  }
  return { ok: false, reason: 'timeout' };
}
