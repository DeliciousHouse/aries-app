import crypto from 'node:crypto';

/**
 * Provider-neutral marketing workflow envelope.
 *
 * The orchestrator normalizes Hermes execution results into this shape so the
 * downstream stage-hydration code has a single, stable contract to read from.
 */
export type MarketingWorkflowApprovalRequest = {
  type?: string;
  prompt?: string;
  resumeToken?: string;
  [key: string]: unknown;
};

export type MarketingWorkflowEnvelope = {
  ok: boolean;
  status: string;
  output?: unknown[];
  requiresApproval?: MarketingWorkflowApprovalRequest | null;
  [key: string]: unknown;
};

export type MarketingResumeTokenDescriptor = {
  fingerprint: string;
  stateKeys: string[];
};

function fingerprintToken(token: string): string {
  return crypto.createHash('sha1').update(token).digest('hex').slice(0, 12);
}

function compatibilityStateKeys(stateKey: string): string[] {
  const normalized = stateKey.trim();
  if (!normalized) {
    return [];
  }

  const candidates = new Set<string>([normalized]);
  const match = normalized.match(/^(workflow[-_]resume)([_-].+)$/);
  if (!match) {
    return [...candidates];
  }

  const suffix = match[2];
  const cleanSuffix = suffix.replace(/^[_-]/, '');
  candidates.add(`workflow_resume${suffix}`);
  candidates.add(`workflow-resume${suffix}`);
  candidates.add(`workflow_resume_${cleanSuffix}`);
  candidates.add(`workflow-resume_${cleanSuffix}`);
  candidates.add(`workflow_resume-${cleanSuffix}`);
  candidates.add(`workflow-resume-${cleanSuffix}`);
  return [...candidates];
}

function decodedOpaqueToken(token: string): { payload: Record<string, unknown>; stateKey: string } | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const stateKey = typeof parsed.stateKey === 'string' ? parsed.stateKey.trim() : '';
    if (!stateKey) {
      return null;
    }
    return { payload: parsed, stateKey };
  } catch {
    return null;
  }
}

/**
 * Derive a stable fingerprint and the set of resume-state keys for a workflow
 * resume token. Pure token parsing — used for approval-record bookkeeping and
 * lifecycle logging.
 */
export function describeMarketingResumeToken(token: string): MarketingResumeTokenDescriptor {
  const normalized = token.trim();
  if (!normalized) {
    return { fingerprint: 'missing', stateKeys: [] };
  }

  const decoded = decodedOpaqueToken(normalized);
  const stateKeys = decoded
    ? compatibilityStateKeys(decoded.stateKey)
    : /^workflow[-_]resume[_-]/.test(normalized)
      ? compatibilityStateKeys(normalized)
      : [];

  return {
    fingerprint: fingerprintToken(normalized),
    stateKeys,
  };
}
