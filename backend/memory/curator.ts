import type { CandidateFinding, CuratorOutcome, FindingSource, PeerKind } from './types';
import { isApprovalDenialReasonCode } from '@/lib/marketing/approval-denial-reason-codes';

const AUTO_APPROVE_CONFIDENCE = 0.85;
const HARD_FLOOR_CONFIDENCE = 0.5;

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'aws_secret', re: /\b[0-9a-zA-Z/+=]{40}\b(?=.*aws)/i },
  { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/ },
  { name: 'openai_key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'gemini_key', re: /\bAIza[0-9A-Za-z_\-]{20,}\b/ },
  { name: 'pem_block', re: /-----BEGIN [A-Z ]+PRIVATE KEY-----/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/ },
  { name: 'bearer', re: /\b[Bb]earer\s+[A-Za-z0-9_\-.=]{16,}\b/ },
  { name: 'cookie_header', re: /\b(set-cookie|cookie):\s/i },
];

const RAW_HTML_PATTERNS: RegExp[] = [
  /<\s*script[\s>]/i,
  /<\s*iframe[\s>]/i,
  /<!DOCTYPE\s+html/i,
  /<\s*html[\s>]/i,
  /<\s*body[\s>]/i,
];

const PROMPT_INJECTION_HINTS: RegExp[] = [
  /ignore (all )?previous (instructions|messages)/i,
  /you are now [a-z ]{0,40}(developer|admin|root)/i,
  /system prompt:/i,
  /disregard the (above|prior)/i,
  /\bjailbreak\b/i,
];

const FIRST_PARTY_PEERS: PeerKind[] = ['brand', 'policy', 'user'];
const THIRD_PARTY_PEERS: PeerKind[] = ['competitor', 'market_signal'];

export {
  APPROVAL_DENIAL_REASON_CODES,
  isApprovalDenialReasonCode,
  type ApprovalDenialReasonCode,
} from '@/lib/marketing/approval-denial-reason-codes';

export type CurateOptions = {
  jobId: string;
  approvedBy?: string;
  /**
   * Pseudonyms of OTHER tenants. If a finding mentions any of them, drop it.
   */
  foreignTenantPseudonyms?: string[];
};

export function parseStructuredDenialClaim(claim: string): {
  denial_reason_code?: string;
  stage?: string;
  research_job_id?: string;
} | null {
  try {
    const parsed = JSON.parse(claim) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      denial_reason_code: typeof parsed.denial_reason_code === 'string' ? parsed.denial_reason_code : undefined,
      stage: typeof parsed.stage === 'string' ? parsed.stage : undefined,
      research_job_id: typeof parsed.research_job_id === 'string' ? parsed.research_job_id : undefined,
    };
  } catch {
    return null;
  }
}

function explicitOperatorDenialRejectedAngle(opts: CurateOptions, finding: CandidateFinding): boolean {
  if (finding.kind !== 'rejected_angle') return false;
  const by = opts.approvedBy?.trim();
  if (!by || by === 'system') return false;
  const meta = parseStructuredDenialClaim(finding.claim);
  const code = meta?.denial_reason_code;
  return typeof code === 'string' && isApprovalDenialReasonCode(code);
}

export function curateFinding(
  finding: CandidateFinding,
  opts: CurateOptions,
): CuratorOutcome {
  const schemaError = validateSchema(finding);
  if (schemaError) return { decision: 'drop', reason: `schema_invalid:${schemaError}` };

  const haystack = buildHaystack(finding);

  const secretHit = SECRET_PATTERNS.find(p => p.re.test(haystack));
  if (secretHit) return { decision: 'drop', reason: `secret_pattern:${secretHit.name}` };

  if (RAW_HTML_PATTERNS.some(re => re.test(haystack))) {
    return { decision: 'drop', reason: 'raw_html_or_dom' };
  }

  if (PROMPT_INJECTION_HINTS.some(re => re.test(haystack))) {
    return { decision: 'drop', reason: 'prompt_injection_residue' };
  }

  const foreign = (opts.foreignTenantPseudonyms ?? []).find(p => p && haystack.includes(p));
  if (foreign) return { decision: 'drop', reason: 'cross_tenant_reference' };

  if (!Number.isFinite(finding.confidence) || finding.confidence < HARD_FLOOR_CONFIDENCE) {
    return { decision: 'drop', reason: 'confidence_below_floor' };
  }

  const peer = mapPeer(finding);
  if (!peer) return { decision: 'drop', reason: 'no_peer_mapping' };

  if (shouldQueueForReview(finding, peer, opts)) {
    return { decision: 'queue_for_review', peer, reason: queueReason(finding, peer) };
  }

  if (eligibleForAutoApprove(finding, peer, opts)) {
    return {
      decision: 'auto_approve',
      peer,
      approved: {
        kind: finding.kind,
        claim: finding.claim,
        sources: finding.sources,
        confidence: finding.confidence,
        approved_by: opts.approvedBy ?? 'system',
        approved_at: new Date().toISOString(),
        supersedes: null,
        research_job_id: opts.jobId,
      },
    };
  }

  return { decision: 'queue_for_review', peer, reason: 'below_auto_approve_threshold' };
}

function validateSchema(f: CandidateFinding): string | null {
  if (!f || typeof f !== 'object') return 'not_object';
  if (typeof f.claim !== 'string' || f.claim.trim().length === 0) return 'missing_claim';
  if (f.claim.length > 4000) return 'claim_too_long';
  if (!Array.isArray(f.sources) || f.sources.length === 0) return 'missing_sources';
  for (const s of f.sources) {
    if (!s || typeof s !== 'object') return 'malformed_source';
    if (typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url)) return 'invalid_source_url';
    if (typeof s.fetched_at !== 'string') return 'missing_fetched_at';
    if (s.trust !== 'first_party' && s.trust !== 'third_party') return 'invalid_trust';
  }
  return null;
}

function buildHaystack(f: CandidateFinding): string {
  return [
    f.claim ?? '',
    f.uncertainty ?? '',
    ...(f.sources ?? []).map(s => `${s.url} ${s.fetched_at} ${s.trust}`),
  ].join('\n');
}

function mapPeer(f: CandidateFinding): PeerKind | null {
  if (f.peerHint) return f.peerHint;
  if (f.kind === 'preference') return 'user';
  if (f.kind === 'constraint') return 'policy';
  if (f.kind === 'fact') return 'brand';
  if (f.kind === 'research_conclusion') return 'market_signal';
  if (f.kind === 'rejected_angle') return 'policy';
  return null;
}

function allFirstParty(sources: FindingSource[]): boolean {
  return sources.length > 0 && sources.every(s => s.trust === 'first_party');
}

function shouldQueueForReview(f: CandidateFinding, peer: PeerKind, opts: CurateOptions): boolean {
  if (THIRD_PARTY_PEERS.includes(peer)) return true;
  if (peer === 'audience') return true;
  if (f.kind === 'research_conclusion') return true;
  if (f.kind === 'rejected_angle') {
    if (explicitOperatorDenialRejectedAngle(opts, f)) return false;
    return true;
  }
  if (!allFirstParty(f.sources)) return true;
  return false;
}

function eligibleForAutoApprove(f: CandidateFinding, peer: PeerKind, opts: CurateOptions): boolean {
  if (peer === 'approver' && f.kind === 'fact') {
    return allFirstParty(f.sources) && f.confidence >= AUTO_APPROVE_CONFIDENCE;
  }
  if (f.kind === 'rejected_angle' && explicitOperatorDenialRejectedAngle(opts, f)) {
    if (peer !== 'brand' && peer !== 'policy') return false;
    if (!allFirstParty(f.sources)) return false;
    if (f.confidence < AUTO_APPROVE_CONFIDENCE) return false;
    return true;
  }
  if (!FIRST_PARTY_PEERS.includes(peer)) return false;
  if (f.kind !== 'fact' && f.kind !== 'preference' && f.kind !== 'constraint') return false;
  if (!allFirstParty(f.sources)) return false;
  if (f.confidence < AUTO_APPROVE_CONFIDENCE) return false;
  return true;
}

function queueReason(f: CandidateFinding, peer: PeerKind): string {
  if (THIRD_PARTY_PEERS.includes(peer)) return `third_party_peer:${peer}`;
  if (peer === 'audience') return 'audience_inference';
  if (f.kind === 'research_conclusion') return 'research_conclusion';
  if (!allFirstParty(f.sources)) return 'mixed_or_third_party_sources';
  return 'needs_review';
}
