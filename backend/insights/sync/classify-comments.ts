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

import {
  hermesResultOutcome,
  withTaskExecutionLog,
  type RecordTaskExecutionOptions,
} from '@/backend/telemetry/task-execution-log';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MIN_POLL_INTERVAL_MS = 250;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'stopped']);
const DEFAULT_MODEL_HINT = 'gemini/gemini-3-flash-preview';

/**
 * Preflight probe (probeClassifierGateway): a run id that cannot exist, so the
 * gateway answers 404 without doing any work. A 404 is a SUCCESSFUL probe —
 * the question is reachability, not whether the run exists.
 */
const PROBE_RUN_ID = '__aries_preflight__';
const PROBE_TIMEOUT_MS = 5_000;

/** Max comments classified per Hermes run — bounds prompt size + tick latency. */
export const MAX_CLASSIFY_BATCH = 40;

/**
 * S4-3 (gap C5) — the label vocabulary + prompt this module currently produces.
 *
 * BUMP THIS whenever `instructionsBlock()`, the model hint, or the output
 * vocabulary changes in a way that would produce different labels. It lives in
 * this file, beside the prompt it describes, so a prompt edit and its version
 * bump are a one-file change and cannot drift apart.
 *
 * What a bump DOES: every already-classified comment inside the sync's 30-day
 * comment window stops matching the current version, becomes eligible for the
 * dispatcher's re-classify sweep, and is re-labelled at one bounded batch per
 * account per tick (the same bound as first-time classification). Newer
 * comments are re-swept first — the sweep orders by received_at DESC — so a
 * bump never starves incoming comments behind a backlog.
 *
 * What a bump COSTS: one Hermes run per batch until the window converges. That
 * is the intended price of shipping a better classifier; the per-tick bound is
 * what keeps it from becoming a stampede.
 *
 * Before this existed, `ON CONFLICT (comment_id) DO NOTHING` plus a hardcoded
 * version froze every label at whatever the first classifier produced, which is
 * why the S1-11 flag flip shipped with a documented "labels are frozen" caveat.
 */
export const CURRENT_CLASSIFIER_VERSION = 'hermes-comment-v1';

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

/** Why a preflight probe could not confirm the gateway is reachable. */
export type ProbeFailureReason = 'disabled' | 'not_configured' | 'unauthorized' | 'unreachable';

export type ProbeResult =
  | { ok: true }
  | { ok: false; reason: ProbeFailureReason; detail?: string };

type ClassifyEnv = Partial<Record<string, string | undefined>>;
type ClassifyFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type ClassifySleep = (ms: number) => Promise<void>;

export type ClassifyCommentsInput = {
  comments:  ClassifyInput[];
  tenantId?: number | string | null;
  telemetryDb?: RecordTaskExecutionOptions['db'];
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

/**
 * The model hint Aries SENDS to the gateway for this run. Hermes owns actual
 * routing, so this is "requested", not "resolved" — the AA-159 execution log
 * records it as `model_requested` and leaves `model_reported` NULL until the
 * gateway reports what it ran.
 */
export function resolveClassifyModelHint(env: ClassifyEnv = process.env): string {
  return readEnv(env, 'HERMES_COMMENT_CLASSIFY_MODEL') || DEFAULT_MODEL_HINT;
}

/**
 * `host:port` of HERMES_GATEWAY_URL, or '' when unset/unparseable.
 *
 * Diagnostic ONLY — it is appended to every `unreachable` detail so the log
 * line names WHICH host failed to resolve/connect. This is the difference
 * between "classifyComments: unreachable (fetch failed)" (the 30-min-forever
 * line that told nobody anything) and one that says the sidecar was trying to
 * reach `host.docker.internal:8642` — the symptom of a container that has the
 * gateway URL but not the `host.docker.internal:host-gateway` extra_hosts
 * mapping that makes that name resolvable.
 *
 * NEVER touches HERMES_API_SERVER_KEY, and deliberately drops any userinfo the
 * URL might carry, so no credential can reach a log line through this path.
 */
export function classifyGatewayOrigin(env: ClassifyEnv = process.env): string {
  const raw = readEnv(env, 'HERMES_GATEWAY_URL');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.host; // host:port — never username/password
  } catch {
    return '';
  }
}

/**
 * One cheap GET against the gateway to answer "can this process reach Hermes
 * at all?" — without submitting a run.
 *
 * Any HTTP response at all (including 404 for the sentinel run id we ask for)
 * proves reachability + a listening gateway, which is the whole question. Only
 * 401/403 is special-cased, because that means "reached it, key is wrong" — a
 * different fix from "cannot reach it".
 *
 * Best-effort and total: never throws, so a caller can `void` it at boot.
 */
export async function probeClassifierGateway(input: {
  env?: ClassifyEnv;
  fetchImpl?: ClassifyFetch;
  timeoutMs?: number;
} = {}): Promise<ProbeResult> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;

  if (!isCommentClassificationEnabled(env)) return { ok: false, reason: 'disabled' };

  const gatewayUrl = readEnv(env, 'HERMES_GATEWAY_URL').replace(/\/+$/, '');
  const apiKey = readEnv(env, 'HERMES_API_SERVER_KEY');
  if (!gatewayUrl || !apiKey) return { ok: false, reason: 'not_configured' };

  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${gatewayUrl}/v1/runs/${PROBE_RUN_ID}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'unauthorized', detail: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: describeUnreachable(error, env),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `<error message> (gateway <host:port>)` — the shape every `unreachable`
 * detail takes. Kept in one place so the two classify call sites and the probe
 * can never drift.
 */
function describeUnreachable(error: unknown, env: ClassifyEnv): string {
  const msg = error instanceof Error ? error.message : String(error);
  const origin = classifyGatewayOrigin(env);
  return origin ? `${msg} (gateway ${origin})` : msg;
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
  const modelHint = resolveClassifyModelHint(env);
  const timeoutMs = readEnvInt(env, 'HERMES_COMMENT_CLASSIFY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const intervalMs = Math.max(MIN_POLL_INTERVAL_MS, readEnvInt(env, 'HERMES_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS));
  const auth = `Bearer ${apiKey}`;
  const validIds = new Set(comments.map((c) => c.id));

  const body = {
    input: promptBlock(comments, modelHint),
    instructions: instructionsBlock(),
    session_id: sessionKey,
  };

  let runId = '';
  return withTaskExecutionLog(
    {
      engine: 'AI_LLM',
      taskKey: 'insights.classify_comments',
      tenantId: input.tenantId,
      modelRequested: modelHint,
      detailsFromResult: () => ({ externalRunId: runId || null }),
      outcomeFromResult: hermesResultOutcome,
    },
    async () => {
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
    return { ok: false, reason: 'unreachable', detail: describeUnreachable(error, env) };
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
      return { ok: false, reason: 'unreachable', detail: describeUnreachable(error, env) };
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
    },
    { env, db: input.telemetryDb },
  );
}
