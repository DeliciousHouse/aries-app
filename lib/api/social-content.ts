export type SocialContentJobType = 'weekly_social_content';
export type FieldError = { field: string; message: string };

export type SocialContentStage =
  | 'intake'
  | 'research'
  | 'planning'
  | 'plan_review'
  | 'copy_production'
  | 'image_briefing'
  | 'image_generation'
  | 'creative_review'
  | 'video_script'
  | 'video_review'
  | 'video_render'
  | 'publish_review'
  | 'completed'
  | 'failed';

export type SocialContentApprovalStep =
  | 'approve_weekly_plan'
  | 'approve_post_copy'
  | 'approve_image_creatives'
  | 'approve_video_script'
  | 'approve_video_render'
  | 'approve_publish';

export interface WeeklySocialContentPayload {
  brandUrl: string;
  businessName?: string;
  businessType: string;
  primaryGoal: string;
  offer?: string;
  audience?: string;
  competitorUrl?: string;
  competitorBrand?: string;
  facebookPageUrl?: string;
  adLibraryUrl?: string;
  channels: Array<'meta' | 'instagram' | 'linkedin' | 'x' | 'tiktok' | 'youtube'>;
  campaignWindowDays: number;
  staticPostCount: number;
  imageCreativeCount: number;
  videoScriptCount: number;
  videoRenderCount: number;
  brandVoice?: string;
  styleVibe?: string;
  visualReferences?: string[];
  mustUseCopy?: string;
  mustAvoidAesthetics?: string;
  forbiddenVisualPatterns?: string[];
  notes?: string;
}

export type SocialContentJobCreateResponse = {
  social_content_job_status: 'accepted' | 'needs_connection' | string;
  jobId: string;
  jobType: SocialContentJobType;
  social_content_stage: string | null;
  approvalRequired: boolean;
  reason?: string;
  message?: string;
  jobStatusUrl: string;
};

export class SocialContentApiError extends Error {
  status: number;
  body: unknown;
  fieldErrors: FieldError[];

  constructor(message: string, status: number, body: unknown, fieldErrors: FieldError[] = []) {
    super(message);
    this.name = 'SocialContentApiError';
    this.status = status;
    this.body = body;
    this.fieldErrors = fieldErrors;
  }
}

export type SocialContentApiClient = {
  createJob: (payload: FormData | WeeklySocialContentPayload) => Promise<SocialContentJobCreateResponse>;
  approveJob: (
    jobId: string,
    payload: {
      approvedBy: string;
      approved?: boolean;
      approvalId?: string;
      approvalStep?: SocialContentApprovalStep;
    },
  ) => Promise<{
    social_content_approval_status: 'submitted' | 'already_resolved' | 'error';
    approval_status: 'submitted' | 'already_resolved' | 'error';
    jobId: string;
    resumedStage: string | null;
    completed: boolean;
    approvalId?: string | null;
    reason?: string;
    jobStatusUrl?: string;
  }>;
};

function parseApiError(body: unknown): { message: string; fieldErrors: FieldError[] } {
  if (!body || typeof body !== 'object') {
    return { message: 'Request failed', fieldErrors: [] };
  }
  const candidate = body as { error?: unknown; message?: unknown; fieldErrors?: unknown };
  const message =
    typeof candidate.message === 'string'
      ? candidate.message
      : typeof candidate.error === 'string'
        ? candidate.error
        : 'Request failed';
  const fieldErrors = Array.isArray(candidate.fieldErrors)
    ? candidate.fieldErrors.filter(
        (entry): entry is FieldError =>
          !!entry &&
          typeof entry === 'object' &&
          typeof (entry as { field?: unknown }).field === 'string' &&
          typeof (entry as { message?: unknown }).message === 'string',
      )
    : [];
  return { message, fieldErrors };
}

export function createSocialContentApi(
  baseUrl = '/api/social-content/jobs',
  fetchImpl: typeof fetch = fetch,
): SocialContentApiClient {
  return {
    async createJob(payload) {
      const requestInit: RequestInit =
        payload instanceof FormData
          ? { method: 'POST', body: payload }
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jobType: 'weekly_social_content', payload }),
            };

      const response = await fetchImpl(baseUrl, requestInit);
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        const parsed = parseApiError(body);
        throw new SocialContentApiError(parsed.message, response.status, body, parsed.fieldErrors);
      }

      return body as SocialContentJobCreateResponse;
    },
    async approveJob(jobId, payload) {
      const response = await fetchImpl(`${baseUrl}/${encodeURIComponent(jobId)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        const parsed = parseApiError(body);
        throw new SocialContentApiError(parsed.message, response.status, body, parsed.fieldErrors);
      }

      return body as {
        social_content_approval_status: 'submitted' | 'already_resolved' | 'error';
        approval_status: 'submitted' | 'already_resolved' | 'error';
        jobId: string;
        resumedStage: string | null;
        completed: boolean;
        approvalId?: string | null;
        reason?: string;
        jobStatusUrl?: string;
      };
    },
  };
}
