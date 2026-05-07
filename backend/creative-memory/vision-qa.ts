import { SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS } from '@/backend/social-content/defaults';
import type { SocialContentImageChannel } from '@/backend/social-content/aspect-matrix';
import type { VisionQAVerdict } from '@/types/vision-qa';

export const VISION_QA_THRESHOLDS = {
  brand_color_match: 0.6,
  text_legibility: 0.8,
  brand_violation: 0.3,
  forbidden_pattern_hits: 0,
} as const;

export const MAX_VISION_QA_ATTEMPTS = 3;

export type VisionQABrandKitInput = {
  name?: string | null;
  logo_urls?: string[] | null;
  colors?:
    | {
        primary?: string | null;
        secondary?: string | null;
        accent?: string | null;
        palette?: string[] | null;
      }
    | null;
  font_families?: string[] | null;
  voice?: string | null;
  offer?: string | null;
  must_avoid_aesthetics?: string[] | null;
};

export type VisionQAReasonCode =
  | 'brand_color_mismatch'
  | 'illegible_text'
  | 'forbidden_pattern'
  | 'brand_violation';

export type VisionQAScores = {
  brand_color_match: number;
  text_legibility: number;
  brand_violation: number;
  forbidden_pattern_hits: number;
};

export type VisionQAResult = {
  verdict: 'pass' | 'fail';
  scores: VisionQAScores;
  retry_eligible: boolean;
  reasons: VisionQAReasonCode[];
  attempt_number: number;
  model_version: string | null;
};

export type VisionQAClientResult = {
  brand_color_match: number;
  text_legibility: number;
  brand_violation: number;
  forbidden_patterns_detected: string[];
  model_version?: string | null;
  raw?: Record<string, unknown> | null;
};

export type VisionQAClient = (input: {
  assetUrl: string;
  brandKit: VisionQABrandKitInput;
  channel: SocialContentImageChannel;
  forbiddenPatterns: readonly string[];
}) => Promise<VisionQAClientResult>;

export type VisionQADbClient = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

export type RunVisionQAInput = {
  assetUrl: string;
  brandKit: VisionQABrandKitInput;
  channel: SocialContentImageChannel;
  attemptNumber?: number;
  visionClient?: VisionQAClient;
  db?: VisionQADbClient;
  tenantId?: number;
  postId?: bigint | number;
  creativeId?: bigint | number;
};

function clampUnit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function nonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const floored = Math.floor(value);
  return floored < 0 ? 0 : floored;
}

function normalizeAttemptNumber(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

function evaluateScores(scores: VisionQAScores): VisionQAReasonCode[] {
  const reasons: VisionQAReasonCode[] = [];
  if (scores.brand_color_match < VISION_QA_THRESHOLDS.brand_color_match) {
    reasons.push('brand_color_mismatch');
  }
  if (scores.text_legibility < VISION_QA_THRESHOLDS.text_legibility) {
    reasons.push('illegible_text');
  }
  if (scores.forbidden_pattern_hits > VISION_QA_THRESHOLDS.forbidden_pattern_hits) {
    reasons.push('forbidden_pattern');
  }
  if (scores.brand_violation >= VISION_QA_THRESHOLDS.brand_violation) {
    reasons.push('brand_violation');
  }
  return reasons;
}

async function persistVisionQARun(
  db: VisionQADbClient,
  payload: {
    tenantId: number;
    postId?: bigint | number | null;
    creativeId?: bigint | number | null;
    attemptNumber: number;
    scores: VisionQAScores;
    verdict: VisionQAVerdict;
    modelVersion: string | null;
    rawModelOutput: Record<string, unknown> | null;
  },
): Promise<void> {
  const sql = `
    INSERT INTO vision_qa_runs (
      tenant_id,
      post_id,
      creative_id,
      attempt_number,
      brand_color_match_score,
      text_legibility_score,
      forbidden_pattern_hits,
      brand_violation_score,
      verdict,
      model_version,
      raw_model_output
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `;
  await db.query(sql, [
    payload.tenantId,
    payload.postId ?? null,
    payload.creativeId ?? null,
    payload.attemptNumber,
    payload.scores.brand_color_match,
    payload.scores.text_legibility,
    payload.scores.forbidden_pattern_hits,
    payload.scores.brand_violation,
    payload.verdict,
    payload.modelVersion,
    payload.rawModelOutput ? JSON.stringify(payload.rawModelOutput) : null,
  ]);
}

function noopClient(): VisionQAClient {
  return async () => {
    throw new Error(
      'vision_qa_client_unavailable: pass `visionClient` (or configure the default Hermes client) before running QA.',
    );
  };
}

export function createHermesVisionQAClient(options: {
  gatewayUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): VisionQAClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const gateway = options.gatewayUrl.replace(/\/+$/, '');

  return async ({ assetUrl, brandKit, channel, forbiddenPatterns }) => {
    const response = await fetchImpl(`${gateway}/v1/vision/qa`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        asset_url: assetUrl,
        channel,
        brand: brandKit,
        forbidden_patterns: forbiddenPatterns,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `hermes_vision_qa_request_failed: status=${response.status} ${response.statusText}`.trim(),
      );
    }

    const body = (await response.json().catch(() => null)) as
      | Partial<VisionQAClientResult>
      | null;

    if (!body || typeof body !== 'object') {
      throw new Error('hermes_vision_qa_invalid_response');
    }

    return {
      brand_color_match: clampUnit(body.brand_color_match),
      text_legibility: clampUnit(body.text_legibility),
      brand_violation: clampUnit(body.brand_violation),
      forbidden_patterns_detected: Array.isArray(body.forbidden_patterns_detected)
        ? body.forbidden_patterns_detected.map(String)
        : [],
      model_version: typeof body.model_version === 'string' ? body.model_version : null,
      raw: (body.raw && typeof body.raw === 'object' ? body.raw : null) as
        | Record<string, unknown>
        | null,
    };
  };
}

export async function runVisionQA(input: RunVisionQAInput): Promise<VisionQAResult> {
  const client = input.visionClient ?? noopClient();
  const attemptNumber = normalizeAttemptNumber(input.attemptNumber);

  const clientResult = await client({
    assetUrl: input.assetUrl,
    brandKit: input.brandKit,
    channel: input.channel,
    forbiddenPatterns: SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS,
  });

  const scores: VisionQAScores = {
    brand_color_match: clampUnit(clientResult.brand_color_match),
    text_legibility: clampUnit(clientResult.text_legibility),
    brand_violation: clampUnit(clientResult.brand_violation),
    forbidden_pattern_hits: nonNegativeInt(clientResult.forbidden_patterns_detected.length),
  };

  const reasons = evaluateScores(scores);
  const verdict: 'pass' | 'fail' = reasons.length === 0 ? 'pass' : 'fail';
  const retry_eligible = verdict === 'fail' && attemptNumber < MAX_VISION_QA_ATTEMPTS;
  const modelVersion = clientResult.model_version ?? null;

  if (input.db && typeof input.tenantId === 'number' && Number.isFinite(input.tenantId)) {
    const rawModelOutput: Record<string, unknown> = {
      forbidden_patterns_detected: clientResult.forbidden_patterns_detected,
      reasons,
    };
    if (clientResult.raw && typeof clientResult.raw === 'object') {
      rawModelOutput.raw = clientResult.raw;
    }
    await persistVisionQARun(input.db, {
      tenantId: input.tenantId,
      postId: input.postId ?? null,
      creativeId: input.creativeId ?? null,
      attemptNumber,
      scores,
      verdict,
      modelVersion,
      rawModelOutput,
    });
  }

  return {
    verdict,
    scores,
    retry_eligible,
    reasons,
    attempt_number: attemptNumber,
    model_version: modelVersion,
  };
}
