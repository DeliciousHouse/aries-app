import type { TenantBrandKit } from '@/backend/marketing/brand-kit';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MIN_POLL_INTERVAL_MS = 250;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'stopped']);
const SOURCE_TEXT_BUDGET = 10_000;
const SOURCE_FETCH_TIMEOUT_MS = 8_000;
const HERMES_MODEL_HINT = 'gemini/gemini-3-flash-preview';

export type BrandKitEnrichment = {
  brandVoiceSummary: string | null;
  offerSummary: string | null;
  positioning: string | null;
  audience: string | null;
  toneOfVoice: string | null;
  styleVibe: string | null;
};

type EnrichmentEnv = Partial<Record<string, string | undefined>>;
type EnrichmentFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type EnrichmentSleep = (ms: number) => Promise<void>;

export type EnrichBrandKitInput = {
  brandUrl: string;
  scrapedBrandKit: TenantBrandKit;
  env?: EnrichmentEnv;
  fetchImpl?: EnrichmentFetch;
  sleep?: EnrichmentSleep;
};

function readEnv(env: EnrichmentEnv, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readEnvInt(env: EnrichmentEnv, key: string, fallback: number): number {
  const raw = readEnv(env, key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function isEnabled(env: EnrichmentEnv): boolean {
  const flag = readEnv(env, 'ARIES_BRAND_ENRICHMENT_ENABLED').toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes';
}

function trimToBudget(value: string, budget: number): string {
  if (value.length <= budget) return value;
  return `${value.slice(0, budget)}…`;
}

function stripRawTextElementBlocks(html: string, tagName: 'script' | 'style'): string {
  let output = '';
  let cursor = 0;
  const lowerHtml = html.toLowerCase();
  const openNeedle = `<${tagName}`;
  const closeNeedle = `</${tagName}`;

  while (cursor < html.length) {
    const openStart = lowerHtml.indexOf(openNeedle, cursor);
    if (openStart < 0) {
      output += html.slice(cursor);
      break;
    }

    output += html.slice(cursor, openStart);
    const openEnd = html.indexOf('>', openStart + openNeedle.length);
    if (openEnd < 0) {
      output += ' ';
      break;
    }

    const closeStart = lowerHtml.indexOf(closeNeedle, openEnd + 1);
    if (closeStart < 0) {
      output += ' ';
      break;
    }

    const closeEnd = html.indexOf('>', closeStart + closeNeedle.length);
    if (closeEnd < 0) {
      output += ' ';
      break;
    }

    output += ' ';
    cursor = closeEnd + 1;
  }

  return output;
}

function htmlToText(html: string): string {
  // Strip script/style blocks first so their contents do not leak into the prompt.
  // Use a scanner instead of a tag-filtering regexp so malformed closing tags like
  // </script\t junk> are removed without triggering CodeQL's js/bad-tag-filter.
  const withoutScripts = stripRawTextElementBlocks(html, 'script');
  const withoutStyles = stripRawTextElementBlocks(withoutScripts, 'style');
  const stripped = withoutStyles.replace(/<[^>]+>/g, ' ');
  return stripped.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchSourceText(brandUrl: string, fetchImpl: EnrichmentFetch): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(brandUrl, {
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'AriesBrandEnricher/1.0 (+https://aries.sugarandleather.com)',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) return '';
    const html = await response.text();
    return trimToBudget(htmlToText(html), SOURCE_TEXT_BUDGET);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function instructionsBlock(): string {
  return [
    'You are a brand identity analyst. Read the website source text and the existing scraped brand kit, then return ONE strict JSON object describing the brand.',
    'No prose, no markdown fences. Reply with JSON only.',
    'Schema:',
    '{"status":"ok","output":[{"brandVoiceSummary":string|null,"offerSummary":string|null,"positioning":string|null,"audience":string|null,"toneOfVoice":string|null,"styleVibe":string|null}]}',
    'Field guidance:',
    '- brandVoiceSummary: 1-2 sentences describing how the brand speaks (tone, register, energy).',
    '- offerSummary: 1-2 sentences describing the core offer/product.',
    '- positioning: 1 sentence on who this is for and why it wins (vs. the obvious alternative).',
    '- audience: 1 sentence describing the primary target customer.',
    '- toneOfVoice: 3-6 comma-separated adjectives.',
    '- styleVibe: 3-6 comma-separated adjectives describing the visual / aesthetic vibe.',
    'If the source text is too sparse to support a field with confidence, return null for that field — never guess.',
  ].join('\n');
}

function promptBlock(input: { brandUrl: string; sourceText: string; scraped: TenantBrandKit }): string {
  const scrapedSummary = JSON.stringify(
    {
      brand_name: input.scraped.brand_name,
      colors: input.scraped.colors,
      font_families: input.scraped.font_families,
      external_links: input.scraped.external_links,
      brand_voice_summary: input.scraped.brand_voice_summary,
      offer_summary: input.scraped.offer_summary,
    },
    null,
    0,
  );
  return [
    `URL: ${input.brandUrl}`,
    `Model hint: ${HERMES_MODEL_HINT}`,
    `Existing scraped brand kit (use as priors, override when text contradicts): ${scrapedSummary}`,
    `Website source text (truncated to ~${SOURCE_TEXT_BUDGET} chars):`,
    input.sourceText || '(empty)',
    'Produce the JSON envelope now.',
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

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function enrichmentFromOutput(value: unknown): BrandKitEnrichment | null {
  const envelope = recordOrNull(value);
  if (!envelope) return null;
  // Reject error envelopes so a garbled output field isn't silently accepted.
  if (typeof envelope.status === 'string' && envelope.status !== 'ok') return null;
  const output = envelope.output;
  const first = Array.isArray(output) ? recordOrNull(output[0]) : recordOrNull(output);
  if (!first) return null;
  const result: BrandKitEnrichment = {
    brandVoiceSummary: trimmedString(first.brandVoiceSummary),
    offerSummary: trimmedString(first.offerSummary),
    positioning: trimmedString(first.positioning),
    audience: trimmedString(first.audience),
    toneOfVoice: trimmedString(first.toneOfVoice),
    styleVibe: trimmedString(first.styleVibe),
  };
  const hasAny =
    result.brandVoiceSummary ||
    result.offerSummary ||
    result.positioning ||
    result.audience ||
    result.toneOfVoice ||
    result.styleVibe;
  return hasAny ? result : null;
}

export type EnrichmentFailureReason =
  | 'disabled'
  | 'not_configured'
  | 'unreachable'
  | 'submit_rejected'
  | 'submit_invalid'
  | 'poll_rejected'
  | 'poll_invalid'
  | 'timeout'
  | 'run_failed'
  | 'output_invalid';

export type EnrichmentResult =
  | { ok: true; enrichment: BrandKitEnrichment }
  | { ok: false; reason: EnrichmentFailureReason; detail?: string };

export type OperatorBrandKitOverrides = {
  /**
   * Operator-supplied style vibe (e.g. from campaign request styleVibe field).
   * When non-empty, enrichment MUST NOT overwrite it — the operator is authoritative.
   */
  styleVibe?: string | null;
  /**
   * Operator-supplied brand voice / tone description.
   * When non-empty, enrichment MUST NOT overwrite tone_of_voice / brand_voice_summary.
   */
  brandVoice?: string | null;
  /**
   * Operator-supplied brand palette. When non-empty, enrichment MUST NOT
   * overwrite the brand kit's color palette with scraped/LLM values.
   */
  palette?: string[] | null;
};

export function stripLeadingDanglingArticleFragment(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  const stripped = trimmed.replace(/^\s*(?:a|an|the)\s*,\s+/i, '');
  if (stripped === trimmed || !stripped) {
    return trimmed;
  }
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/**
 * Merge LLM enrichment into the base brand kit.
 *
 * Precedence (highest → lowest):
 *   1. Operator-supplied request fields (operatorOverrides)
 *   2. Existing brand-kit values (base)
 *   3. LLM enrichment output
 *
 * Enrichment FILLS GAPS. It never overwrites a value the operator explicitly
 * provided, and it never overwrites an existing non-null brand-kit field when
 * the operator override for that category is set.
 */
export function applyBrandKitEnrichment(
  base: TenantBrandKit,
  enrichment: BrandKitEnrichment,
  operatorOverrides?: OperatorBrandKitOverrides,
): TenantBrandKit {
  const opStyleVibe = typeof operatorOverrides?.styleVibe === 'string' && operatorOverrides.styleVibe.trim()
    ? operatorOverrides.styleVibe.trim()
    : null;
  const opBrandVoice = typeof operatorOverrides?.brandVoice === 'string' && operatorOverrides.brandVoice.trim()
    ? operatorOverrides.brandVoice.trim()
    : null;
  const opPaletteRaw = Array.isArray(operatorOverrides?.palette) && operatorOverrides.palette.length > 0
    ? operatorOverrides.palette
    : null;

  // style_vibe: operator > base (existing) > enrichment
  const styleVibe = stripLeadingDanglingArticleFragment(opStyleVibe ?? base.style_vibe ?? enrichment.styleVibe) ?? null;

  // tone_of_voice: operator brandVoice is authoritative for tone — if operator supplied it,
  // preserve the existing base value (or null) and never let enrichment fill it in.
  // The operator's brandVoice string is their explicit tone preference; we must not let
  // LLM-scraped adjectives contradict it.
  const toneOfVoice = opBrandVoice
    ? (stripLeadingDanglingArticleFragment(base.tone_of_voice) ?? null)
    : (stripLeadingDanglingArticleFragment(enrichment.toneOfVoice ?? base.tone_of_voice) ?? null);

  // brand_voice_summary: operator brandVoice is authoritative — preserve base, never let enrichment overwrite
  const brandVoiceSummary = opBrandVoice
    ? stripLeadingDanglingArticleFragment(base.brand_voice_summary)
    : stripLeadingDanglingArticleFragment(enrichment.brandVoiceSummary ?? base.brand_voice_summary);

  // Colors: if operator supplied a palette, preserve the base colors (which were set from the operator palette
  // upstream); do not allow enrichment to clobber palette with scraped values.
  // Enrichment does not currently produce palette data, but guard here for forward-compatibility.
  const colors = opPaletteRaw ? base.colors : base.colors;

  return {
    ...base,
    colors,
    brand_voice_summary: brandVoiceSummary,
    offer_summary: stripLeadingDanglingArticleFragment(enrichment.offerSummary ?? base.offer_summary),
    positioning: stripLeadingDanglingArticleFragment(enrichment.positioning ?? base.positioning) ?? null,
    audience: stripLeadingDanglingArticleFragment(enrichment.audience ?? base.audience) ?? null,
    tone_of_voice: toneOfVoice,
    style_vibe: styleVibe,
  };
}

export async function enrichBrandKitWithGemini(input: EnrichBrandKitInput): Promise<EnrichmentResult> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  if (!isEnabled(env)) {
    return { ok: false, reason: 'disabled' };
  }
  const gatewayUrl = readEnv(env, 'HERMES_GATEWAY_URL').replace(/\/+$/, '');
  const apiKey = readEnv(env, 'HERMES_API_SERVER_KEY');
  if (!gatewayUrl || !apiKey) {
    return { ok: false, reason: 'not_configured' };
  }
  const sessionKey =
    readEnv(env, 'HERMES_BRAND_ANALYSIS_SESSION_KEY') || readEnv(env, 'HERMES_SESSION_KEY') || 'aries-main';
  const timeoutMs = readEnvInt(env, 'HERMES_BRAND_ANALYSIS_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const intervalMs = Math.max(MIN_POLL_INTERVAL_MS, readEnvInt(env, 'HERMES_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS));
  const auth = `Bearer ${apiKey}`;

  const sourceText = await fetchSourceText(input.brandUrl, fetchImpl);
  const body = {
    input: promptBlock({ brandUrl: input.brandUrl, sourceText, scraped: input.scrapedBrandKit }),
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
    if (!submit.ok) {
      return { ok: false, reason: 'submit_rejected', detail: `HTTP ${submit.status}` };
    }
    const submitJson = (await submit.json().catch(() => null)) as Record<string, unknown> | null;
    const candidate = submitJson && typeof submitJson.run_id === 'string' ? submitJson.run_id.trim() : '';
    if (!candidate) {
      return { ok: false, reason: 'submit_invalid' };
    }
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
      if (!poll.ok) {
        return { ok: false, reason: 'poll_rejected', detail: `HTTP ${poll.status}` };
      }
      pollJson = (await poll.json().catch(() => null)) as Record<string, unknown> | null;
    } catch (error) {
      return { ok: false, reason: 'unreachable', detail: error instanceof Error ? error.message : String(error) };
    }
    const status = pollJson && typeof pollJson.status === 'string' ? pollJson.status : '';
    if (!status) {
      return { ok: false, reason: 'poll_invalid' };
    }
    if (TERMINAL_STATUSES.has(status)) {
      if (status !== 'completed') {
        return { ok: false, reason: 'run_failed', detail: status };
      }
      const outputText = typeof pollJson?.output === 'string' ? pollJson.output : '';
      const enrichment = enrichmentFromOutput(tryParseJson(outputText));
      if (!enrichment) {
        return { ok: false, reason: 'output_invalid' };
      }
      return { ok: true, enrichment };
    }
    await sleep(intervalMs);
  }
  return { ok: false, reason: 'timeout' };
}
