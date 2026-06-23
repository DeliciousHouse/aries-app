/**
 * Server-side severity inference for feedback.
 *
 * Severity is NOT asked of the user (it confused people) — the LLM decides it
 * from the comment + category. Aries has no synchronous LLM client; all model
 * work goes through Hermes (submit a run, poll for the result), mirroring
 * backend/marketing/brand-kit-enrich.ts. We do a SHORT, bounded Hermes call and
 * fall back to a deterministic heuristic if Hermes is disabled, slow, or errors —
 * so a submission never blocks for long and never fails on the LLM.
 */

import {
  FEEDBACK_SEVERITIES,
  type FeedbackCategory,
  type FeedbackSeverity,
} from './options';
import type { FeedbackSeverityLlmConfig } from './feedback-config';

const INSTRUCTIONS =
  'You triage product feedback severity for an app called Aries. ' +
  'Given a category and a user comment, respond with EXACTLY ONE word — one of: ' +
  'Low, Medium, High, Blocker. ' +
  'Blocker = the user is fully blocked (cannot log in, app is down, data loss). ' +
  'High = a broken feature or a serious bug with a workaround. ' +
  'Medium = a non-blocking bug, quality issue, or unclear problem. ' +
  'Low = a minor nit, idea, or suggestion. Output only the single word.';

export interface SeverityResult {
  severity: FeedbackSeverity;
  source: 'llm' | 'heuristic';
}

export interface ClassifyDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for the poll deadline (tests). */
  nowMs?: () => number;
}

const BLOCKER_RE =
  /\b(can'?t|cannot|can not|unable|won'?t|wont|doesn'?t work|does not work|not working|nothing (?:happens|works)|broken|down|crash(?:ed|ing)?|stuck|locked out|frozen|503|500|white screen|blank screen|data loss|lost (?:my|all) )\b/i;

/** Deterministic fallback when the LLM is unavailable. Never throws. */
export function heuristicSeverity(comment: string, category: FeedbackCategory): FeedbackSeverity {
  const blocking = BLOCKER_RE.test(comment);
  switch (category) {
    case 'Login issue':
      return blocking ? 'Blocker' : 'High';
    case 'Bug':
      return blocking ? 'High' : 'Medium';
    case 'Feature idea':
      return 'Low';
    case 'Content quality':
      return 'Medium';
    default:
      return 'Medium';
  }
}

/** Pull a severity word out of an LLM output string (priority order). */
export function parseSeverityFromOutput(output: string): FeedbackSeverity | null {
  if (!output) return null;
  const text = output.toLowerCase();
  for (const sev of FEEDBACK_SEVERITIES) {
    if (new RegExp(`\\b${sev.toLowerCase()}\\b`).test(text)) return sev;
  }
  return null;
}

async function classifyViaHermes(
  comment: string,
  category: FeedbackCategory,
  cfg: FeedbackSeverityLlmConfig,
  deps: Required<ClassifyDeps>,
): Promise<FeedbackSeverity | null> {
  const auth = `Bearer ${cfg.apiKey}`;
  const deadline = deps.nowMs() + cfg.timeoutMs;

  // Submit
  let runId: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let submit: Response;
    try {
      submit = await deps.fetchImpl(`${cfg.gatewayUrl}/v1/runs`, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          input: `Category: ${category}\nComment: ${comment}`,
          instructions: INSTRUCTIONS,
          session_id: cfg.sessionKey,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!submit.ok) return null;
    const json = (await submit.json().catch(() => null)) as Record<string, unknown> | null;
    const candidate = json && typeof json.run_id === 'string' ? json.run_id.trim() : '';
    if (!candidate) return null;
    runId = candidate;
  } catch {
    return null;
  }

  // Poll until terminal or deadline
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'errored', 'error', 'timeout']);
  while (deps.nowMs() <= deadline) {
    const remaining = deadline - deps.nowMs();
    if (remaining <= 0) break;
    let json: Record<string, unknown> | null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      let poll: Response;
      try {
        poll = await deps.fetchImpl(`${cfg.gatewayUrl}/v1/runs/${encodeURIComponent(runId)}`, {
          method: 'GET',
          headers: { authorization: auth },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!poll.ok) return null;
      json = (await poll.json().catch(() => null)) as Record<string, unknown> | null;
    } catch {
      return null;
    }
    const status = json && typeof json.status === 'string' ? json.status.toLowerCase() : '';
    if (TERMINAL.has(status)) {
      if (status !== 'completed') return null;
      const output = typeof json?.output === 'string' ? json.output : '';
      return parseSeverityFromOutput(output);
    }
    await deps.sleep(Math.min(500, Math.max(100, remaining)));
  }
  return null;
}

/**
 * Infer severity for a submission. Tries the LLM (Hermes) when configured, with a
 * heuristic fallback. Always resolves — never throws, never blocks past the
 * configured timeout.
 */
export async function classifySeverity(
  input: { comment: string; category: FeedbackCategory },
  cfg: FeedbackSeverityLlmConfig | null,
  deps: ClassifyDeps = {},
): Promise<SeverityResult> {
  const fallback = heuristicSeverity(input.comment, input.category);
  if (!cfg) return { severity: fallback, source: 'heuristic' };

  const resolved: Required<ClassifyDeps> = {
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    nowMs: deps.nowMs ?? (() => Date.now()),
  };

  try {
    const llm = await classifyViaHermes(input.comment, input.category, cfg, resolved);
    if (llm) return { severity: llm, source: 'llm' };
  } catch {
    // fall through to heuristic
  }
  return { severity: fallback, source: 'heuristic' };
}
