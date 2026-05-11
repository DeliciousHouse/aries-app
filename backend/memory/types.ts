export type FindingKind =
  | 'fact'
  | 'preference'
  | 'constraint'
  | 'rejected_angle'
  | 'research_conclusion';

export type SourceTrust = 'first_party' | 'third_party';

export type FindingSource = {
  url: string;
  fetched_at: string;
  trust: SourceTrust;
};

/** Optional curator metadata (Honcho append uses claim only; this gates auto-approve). */
export type CandidateFindingMetadata = {
  /** When true, a `preference` may auto-approve (explicit UI save path only). */
  explicit_user_intent?: boolean;
};

export type CandidateFinding = {
  kind: FindingKind;
  claim: string;
  sources: FindingSource[];
  confidence: number;
  uncertainty?: string;
  peerHint?: PeerKind;
  metadata?: CandidateFindingMetadata;
};

export type PeerKind =
  | 'brand'
  | 'policy'
  | 'user'
  | 'approver'
  | 'competitor'
  | 'audience'
  | 'market_signal';

export type ApprovedMessage = {
  kind: FindingKind;
  claim: string;
  sources: FindingSource[];
  confidence: number;
  approved_by: string;
  approved_at: string;
  supersedes: string | null;
  research_job_id: string;
};

export type CuratorOutcome =
  | { decision: 'auto_approve'; peer: PeerKind; approved: ApprovedMessage }
  | { decision: 'queue_for_review'; peer: PeerKind | null; reason: string }
  | { decision: 'drop'; reason: string };

export type ResearchEnvelope = {
  status: 'ok' | 'partial' | 'failed';
  findings: CandidateFinding[];
  summary?: string;
  trace_session_id?: string;
};
