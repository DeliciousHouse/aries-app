import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveCodePath } from '../../lib/runtime-paths';
import { OpenClawGatewayError, runOpenClawLobsterWorkflow, type LobsterEnvelope } from './gateway-client';
import { getAriesOpenClawWorkflow, type AriesOpenClawWorkflowKey } from './workflow-catalog';

export type ParityStubPayload = {
  status: 'not_implemented';
  code: 'workflow_missing_for_route';
  route: string;
  message: string;
  [key: string]: unknown;
};

export type AriesWorkflowExecutionResult =
  | { kind: 'ok'; envelope: LobsterEnvelope; primaryOutput: Record<string, unknown> | null }
  | { kind: 'not_implemented'; payload: ParityStubPayload }
  | { kind: 'gateway_error'; error: OpenClawGatewayError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isMarketingWorkflowKey(key: AriesOpenClawWorkflowKey): boolean {
  // These are the atomic tenant-workflow adapters. Client-facing marketing jobs
  // stay on backend/marketing/orchestrator.ts and the monolithic pipeline.
  return key.startsWith('marketing_');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const candidate = stringValue(value);
    if (candidate) return candidate;
  }
  return '';
}

function slugifyMarketingValue(value: string, fallback = 'client-brand'): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function pickMarketingArg(
  topLevel: Record<string, unknown>,
  inputArgs: Record<string, unknown>,
  names: string[],
): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(topLevel, name) && topLevel[name] !== undefined) {
      return topLevel[name];
    }
  }
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(inputArgs, name) && inputArgs[name] !== undefined) {
      return inputArgs[name];
    }
  }
  return undefined;
}

function pickMarketingRecordArg(
  topLevel: Record<string, unknown>,
  inputArgs: Record<string, unknown>,
  names: string[],
): Record<string, unknown> | null {
  const value = pickMarketingArg(topLevel, inputArgs, names);
  return isRecord(value) ? value : null;
}

function hasMarketingArg(
  topLevel: Record<string, unknown>,
  inputArgs: Record<string, unknown>,
  names: string[],
): string | null {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(topLevel, name) && topLevel[name] !== undefined) {
      return name;
    }
  }
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(inputArgs, name) && inputArgs[name] !== undefined) {
      return name;
    }
  }
  return null;
}

function normalizeMarketingWorkflowArgs(args: Record<string, unknown>): Record<string, unknown> {
  const inputArgs = isRecord(args.inputs) ? args.inputs : {};
  const normalized: Record<string, unknown> = {
    ...inputArgs,
    ...args,
  };
  delete normalized.inputs;

  const brandUrl = pickMarketingArg(args, inputArgs, ['brand_url', 'brandUrl', 'website_url', 'websiteUrl']);
  if (brandUrl !== undefined) {
    normalized.brand_url = brandUrl;
    normalized.website_url = brandUrl;
  }

  const competitorUrl = pickMarketingArg(args, inputArgs, ['competitor_url', 'competitorUrl']);
  if (competitorUrl !== undefined) {
    normalized.competitor_url = competitorUrl;
  }

  const competitor = pickMarketingArg(args, inputArgs, ['competitor', 'competitorName']);
  if (competitor !== undefined) {
    normalized.competitor = competitor;
  }

  const competitorBrand = pickMarketingArg(args, inputArgs, ['competitor_brand', 'competitorBrand']);
  if (competitorBrand !== undefined) {
    normalized.competitor_brand = competitorBrand;
  }

  const facebookPageUrl = pickMarketingArg(args, inputArgs, [
    'facebook_page_url',
    'facebookPageUrl',
    'competitorFacebookUrl',
  ]);
  if (facebookPageUrl !== undefined) {
    normalized.facebook_page_url = facebookPageUrl;
    if (normalized.competitor_facebook_url === undefined) {
      normalized.competitor_facebook_url = facebookPageUrl;
    }
  }

  const competitorFacebookUrl = pickMarketingArg(args, inputArgs, [
    'competitor_facebook_url',
    'competitorFacebookUrl',
  ]);
  if (competitorFacebookUrl !== undefined) {
    normalized.competitor_facebook_url = competitorFacebookUrl;
    if (normalized.facebook_page_url === undefined) {
      normalized.facebook_page_url = competitorFacebookUrl;
    }
  }

  const adLibraryUrl = pickMarketingArg(args, inputArgs, ['ad_library_url', 'adLibraryUrl']);
  if (adLibraryUrl !== undefined) {
    normalized.ad_library_url = adLibraryUrl;
  }

  const metaPageId = pickMarketingArg(args, inputArgs, ['meta_page_id', 'metaPageId']);
  if (metaPageId !== undefined) {
    normalized.meta_page_id = metaPageId;
  }

  const researchModel = pickMarketingArg(args, inputArgs, ['research_model', 'researchModel']);
  if (researchModel !== undefined) {
    normalized.research_model = researchModel;
  }

  const runId = pickMarketingArg(args, inputArgs, ['run_id', 'runId']);
  if (runId !== undefined) {
    normalized.run_id = runId;
  }

  const researchOutput = pickMarketingRecordArg(args, inputArgs, [
    'research_output',
    'researchOutput',
    'stage1_output',
    'stage1Output',
  ]);
  if (researchOutput) {
    normalized.research_output = researchOutput;
  }

  const strategyHandoff = pickMarketingRecordArg(args, inputArgs, ['strategy_handoff', 'strategyHandoff']);
  if (strategyHandoff) {
    normalized.strategy_handoff = strategyHandoff;
  }

  const productionHandoff = pickMarketingRecordArg(args, inputArgs, ['production_handoff', 'productionHandoff']);
  if (productionHandoff) {
    normalized.production_handoff = productionHandoff;
  }

  const explicitBrandSlug = pickMarketingArg(args, inputArgs, ['brand_slug', 'brandSlug']);
  if (typeof explicitBrandSlug === 'string' && explicitBrandSlug.trim()) {
    normalized.brand_slug = explicitBrandSlug.trim();
  } else {
    const tenantId = pickMarketingArg(args, inputArgs, ['tenant_id', 'tenantId']);
    if (typeof tenantId === 'string' && tenantId.trim()) {
      normalized.brand_slug = slugifyMarketingValue(tenantId, 'client-brand');
    }
  }

  return normalized;
}

function primaryOutputRecord(envelope: LobsterEnvelope): Record<string, unknown> | null {
  if (!Array.isArray(envelope.output) || envelope.output.length === 0) return null;
  const first = envelope.output[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
  return first as Record<string, unknown>;
}

function asParityStubPayload(record: Record<string, unknown> | null): ParityStubPayload | null {
  if (!record) return null;
  if (record.status !== 'not_implemented' || record.code !== 'workflow_missing_for_route') return null;
  if (typeof record.route !== 'string' || typeof record.message !== 'string') return null;
  return record as unknown as ParityStubPayload;
}

function marketingInputError(message: string): OpenClawGatewayError {
  return new OpenClawGatewayError('openclaw_gateway_request_invalid', message, 400);
}

function encodeBase64Json(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

async function loadCachedMarketingPayload(
  runId: string,
  input: {
    envKey: string;
    fallbackDir: string;
    stepName: string;
    workflowKey: AriesOpenClawWorkflowKey;
    contractName: string;
  },
): Promise<Record<string, unknown>> {
  const cacheRoot = process.env[input.envKey]?.trim() || path.join(tmpdir(), input.fallbackDir);
  const payloadPath = path.join(cacheRoot, runId, `${input.stepName}.json`);
  let raw = '';
  try {
    raw = await readFile(payloadPath, 'utf8');
  } catch {
    throw marketingInputError(
      `${input.workflowKey} requires ${input.contractName}; no cached ${input.stepName} payload was found for run_id=${runId}.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw marketingInputError(
      `${input.workflowKey} expected valid JSON in ${payloadPath}, but parsing failed: ${message}.`,
    );
  }

  if (!isRecord(parsed)) {
    throw marketingInputError(`${input.workflowKey} expected ${payloadPath} to contain a JSON object.`);
  }
  return parsed;
}

function resolvedBrandSlug(args: Record<string, unknown>, ...fallbacks: unknown[]): string {
  const explicit = stringValue(args.brand_slug);
  if (explicit) return explicit;
  for (const fallback of fallbacks) {
    const candidate = stringValue(fallback);
    if (candidate) return slugifyMarketingValue(candidate, 'client-brand');
  }
  return 'client-brand';
}

function cachedPayloadBrandSlug(payload: Record<string, unknown>): string {
  const strategyHandoff = isRecord(payload.strategy_handoff) ? payload.strategy_handoff : {};
  const productionHandoff = isRecord(payload.production_handoff) ? payload.production_handoff : {};
  const brandProfile = isRecord(payload.brand_profiles_record) ? payload.brand_profiles_record : {};
  const reviewPacket = isRecord(payload.review_packet) ? payload.review_packet : {};
  return firstNonEmptyString(
    payload.brand_slug,
    strategyHandoff.brand_slug,
    productionHandoff.brand_slug,
    brandProfile.brand_slug,
    reviewPacket.brand_slug,
  );
}

const MARKETING_DEPRECATED_TRANSPORTS: Partial<Record<AriesOpenClawWorkflowKey, Array<{ names: string[]; replacement: string }>>> = {
  marketing_stage2_strategy_review: [
    { names: ['stage1_summary_base64', 'stage1SummaryBase64'], replacement: 'brand_url plus run_id or research_output' },
  ],
  marketing_stage3_production_review: [
    { names: ['strategy_handoff_base64', 'strategyHandoffBase64'], replacement: 'run_id or strategy_handoff' },
  ],
  marketing_stage4_publish_review: [
    { names: ['production_handoff_base64', 'productionHandoffBase64'], replacement: 'run_id or production_handoff' },
    { names: ['production_handoff_path', 'productionHandoffPath'], replacement: 'run_id or production_handoff' },
  ],
  marketing_stage4_publish_finalize: [
    { names: ['production_handoff_base64', 'productionHandoffBase64'], replacement: 'run_id' },
    { names: ['production_handoff_path', 'productionHandoffPath'], replacement: 'run_id' },
  ],
};

function rejectDeprecatedMarketingTransportArgs(
  key: AriesOpenClawWorkflowKey,
  topLevel: Record<string, unknown>,
): void {
  if (!isMarketingWorkflowKey(key)) return;
  const inputArgs = isRecord(topLevel.inputs) ? topLevel.inputs : {};
  const deprecated = MARKETING_DEPRECATED_TRANSPORTS[key] ?? [];
  for (const entry of deprecated) {
    const matchedName = hasMarketingArg(topLevel, inputArgs, entry.names);
    if (!matchedName) continue;
    throw marketingInputError(`${key} no longer accepts ${matchedName}. Pass ${entry.replacement} instead.`);
  }
}

async function buildMarketingExecutionArgs(
  key: AriesOpenClawWorkflowKey,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (key) {
    case 'marketing_stage1_research': {
      const locatorFields = [
        args.competitor_url,
        args.competitor,
        args.facebook_page_url,
        args.competitor_facebook_url,
        args.ad_library_url,
        args.meta_page_id,
      ];
      if (!locatorFields.some((value) => stringValue(value))) {
        throw marketingInputError(
          `${key} requires at least one competitor locator: competitor_url, competitor, facebook_page_url, competitor_facebook_url, ad_library_url, or meta_page_id.`,
        );
      }

      return {
        competitor: stringValue(args.competitor),
        competitor_url: stringValue(args.competitor_url),
        competitor_brand: stringValue(args.competitor_brand),
        facebook_page_url: stringValue(args.facebook_page_url),
        ad_library_url: stringValue(args.ad_library_url),
        meta_page_id: stringValue(args.meta_page_id),
        competitor_facebook_url: stringValue(args.competitor_facebook_url),
        research_model: firstNonEmptyString(args.research_model, 'gemini/gemini-3-pro-image-preview'),
      };
    }
    case 'marketing_stage2_strategy_review': {
      const brandUrl = firstNonEmptyString(args.brand_url, args.website_url);
      if (!brandUrl) {
        throw marketingInputError(`${key} requires brand_url.`);
      }

      const researchOutput =
        (isRecord(args.research_output) ? args.research_output : null) ??
        (stringValue(args.run_id)
          ? await loadCachedMarketingPayload(stringValue(args.run_id), {
              envKey: 'LOBSTER_STAGE1_CACHE_DIR',
              fallbackDir: 'lobster-stage1-cache',
              stepName: 'ads_analyst_compile',
              workflowKey: key,
              contractName: 'a stage-1 research run_id or research_output',
            })
          : null);

      if (!researchOutput) {
        throw marketingInputError(`${key} requires brand_url plus run_id or research_output.`);
      }

      return {
        brand_url: brandUrl,
        brand_slug: resolvedBrandSlug(args, args.tenant_id),
        research_model: firstNonEmptyString(args.research_model, 'gemini/gemini-3-flash-preview'),
        stage1_summary_base64: encodeBase64Json(researchOutput),
      };
    }
    case 'marketing_stage2_strategy_finalize': {
      const runId = stringValue(args.run_id);
      if (!runId) {
        throw marketingInputError(`${key} requires run_id.`);
      }

      return {
        brand_slug: resolvedBrandSlug(args, args.tenant_id),
        research_model: firstNonEmptyString(args.research_model, 'gemini/gemini-3-flash-preview'),
        run_id: runId,
      };
    }
    case 'marketing_stage3_production_review': {
      const strategyPayload =
        (isRecord(args.strategy_handoff) ? args.strategy_handoff : null) ??
        (stringValue(args.run_id)
          ? await loadCachedMarketingPayload(stringValue(args.run_id), {
              envKey: 'LOBSTER_STAGE2_CACHE_DIR',
              fallbackDir: 'lobster-stage2-cache',
              stepName: 'head_of_marketing',
              workflowKey: key,
              contractName: 'a stage-2 finalize run_id or strategy_handoff',
            })
          : null);

      if (!strategyPayload) {
        throw marketingInputError(`${key} requires run_id or strategy_handoff.`);
      }

      return {
        brand_slug: resolvedBrandSlug(args, cachedPayloadBrandSlug(strategyPayload), args.tenant_id),
        research_model: firstNonEmptyString(args.research_model, 'gemini/gemini-3-flash-preview'),
        strategy_handoff_base64: encodeBase64Json(strategyPayload),
      };
    }
    case 'marketing_stage3_production_finalize': {
      const runId = stringValue(args.run_id);
      if (!runId) {
        throw marketingInputError(`${key} requires run_id.`);
      }

      const reviewPayload = await loadCachedMarketingPayload(runId, {
        envKey: 'LOBSTER_STAGE3_CACHE_DIR',
        fallbackDir: 'lobster-stage3-cache',
        stepName: 'production_review_preview',
        workflowKey: key,
        contractName: 'a stage-3 review run_id',
      });

      return {
        brand_slug: resolvedBrandSlug(args, cachedPayloadBrandSlug(reviewPayload), args.tenant_id),
        research_model: firstNonEmptyString(args.research_model, 'gemini/gemini-3-flash-preview'),
        run_id: runId,
      };
    }
    case 'marketing_stage4_publish_review': {
      const productionPayload =
        (isRecord(args.production_handoff) ? args.production_handoff : null) ??
        (stringValue(args.run_id)
          ? await loadCachedMarketingPayload(stringValue(args.run_id), {
              envKey: 'LOBSTER_STAGE3_CACHE_DIR',
              fallbackDir: 'lobster-stage3-cache',
              stepName: 'creative_director_finalize',
              workflowKey: key,
              contractName: 'a stage-3 finalize run_id or production_handoff',
            })
          : null);

      if (!productionPayload) {
        throw marketingInputError(`${key} requires run_id or production_handoff.`);
      }

      return {
        brand_slug: resolvedBrandSlug(args, cachedPayloadBrandSlug(productionPayload), args.tenant_id),
        production_handoff_base64: encodeBase64Json(productionPayload),
      };
    }
    case 'marketing_stage4_publish_finalize': {
      const runId = stringValue(args.run_id);
      if (!runId) {
        throw marketingInputError(`${key} requires run_id.`);
      }

      const productionPayload = await loadCachedMarketingPayload(runId, {
        envKey: 'LOBSTER_STAGE3_CACHE_DIR',
        fallbackDir: 'lobster-stage3-cache',
        stepName: 'creative_director_finalize',
        workflowKey: key,
        contractName: 'a stage-3 finalize run_id',
      });

      return {
        brand_slug: resolvedBrandSlug(args, cachedPayloadBrandSlug(productionPayload), args.tenant_id),
        run_id: runId,
      };
    }
    default:
      return args;
  }
}

export async function runAriesOpenClawWorkflow(
  key: AriesOpenClawWorkflowKey,
  args: Record<string, unknown>,
): Promise<AriesWorkflowExecutionResult> {
  const workflow = getAriesOpenClawWorkflow(key);
  const gatewayCwd =
    process.env.OPENCLAW_GATEWAY_LOBSTER_CWD?.trim() ||
    process.env.OPENCLAW_LOBSTER_CWD?.trim() ||
    workflow.cwd ||
    resolveCodePath('lobster');
  try {
    rejectDeprecatedMarketingTransportArgs(key, args);
    const normalizedArgs = isMarketingWorkflowKey(key) ? normalizeMarketingWorkflowArgs(args) : args;
    const executionArgs = isMarketingWorkflowKey(key) ? await buildMarketingExecutionArgs(key, normalizedArgs) : args;
    const envelope = await runOpenClawLobsterWorkflow({
      pipeline: workflow.pipeline,
      cwd: gatewayCwd,
      argsJson: JSON.stringify(executionArgs),
      allowLocalFallback: !isMarketingWorkflowKey(key),
    });
    const primaryOutput = primaryOutputRecord(envelope);
    const parityStub = asParityStubPayload(primaryOutput);
    if (parityStub) {
      return { kind: 'not_implemented', payload: parityStub };
    }
    return { kind: 'ok', envelope, primaryOutput };
  } catch (error) {
    if (error instanceof OpenClawGatewayError) {
      return { kind: 'gateway_error', error };
    }
    throw error;
  }
}

export function mapOpenClawGatewayError(error: OpenClawGatewayError): { status: number; body: Record<string, unknown> } {
  switch (error.code) {
    case 'openclaw_gateway_not_configured':
      return { status: 503, body: { status: 'error', reason: error.code, message: error.message } };
    case 'openclaw_gateway_unauthorized':
      return { status: 401, body: { status: 'error', reason: error.code, message: error.message } };
    case 'openclaw_gateway_tool_unavailable':
      return { status: 500, body: { status: 'error', reason: error.code, message: error.message } };
    case 'openclaw_gateway_request_invalid':
      return { status: 400, body: { status: 'error', reason: error.code, message: error.message } };
    case 'openclaw_gateway_unreachable':
      return { status: 503, body: { status: 'error', reason: error.code, message: error.message } };
    default:
      return { status: error.status || 500, body: { status: 'error', reason: error.code, message: error.message } };
  }
}
