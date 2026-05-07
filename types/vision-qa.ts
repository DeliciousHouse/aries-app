export const visionQAVerdicts = ['pass', 'fail', 'operator_override'] as const;

export type VisionQAVerdict = typeof visionQAVerdicts[number];

export interface VisionQARun {
  id: bigint;
  tenant_id: number;
  post_id?: bigint | null;
  creative_id?: bigint | null;
  attempt_number: number;
  brand_color_match_score?: number | null;
  text_legibility_score?: number | null;
  forbidden_pattern_hits?: number | null;
  brand_violation_score?: number | null;
  verdict?: VisionQAVerdict | null;
  model_version?: string | null;
  raw_model_output?: Record<string, unknown> | null;
  created_at: Date;
}

export interface CreateVisionQARunInput {
  tenant_id: number;
  post_id?: bigint;
  creative_id?: bigint;
  attempt_number?: number;
  brand_color_match_score?: number;
  text_legibility_score?: number;
  forbidden_pattern_hits?: number;
  brand_violation_score?: number;
  verdict?: VisionQAVerdict;
  model_version?: string;
  raw_model_output?: Record<string, unknown>;
}

export interface UpdateVisionQARunInput {
  brand_color_match_score?: number;
  text_legibility_score?: number;
  forbidden_pattern_hits?: number;
  brand_violation_score?: number;
  verdict?: VisionQAVerdict;
  model_version?: string;
  raw_model_output?: Record<string, unknown>;
}
