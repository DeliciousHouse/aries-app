declare const require: (name: string) => any;
import { resolveDataPath, resolveSpecPath } from "../../lib/runtime-paths";
import { runAriesOpenClawWorkflow } from "../openclaw/aries-execution";
import { randomUUID } from "node:crypto";

type Dict = Record<string, unknown>;
const fs = require("fs");
const path = require("path");

const REQUIRED_SCHEMA_PATHS = [
  resolveSpecPath("tenant_runtime_state_schema.v1.json"),
  resolveSpecPath("job_runtime_state_schema.v1.json")
] as const;

function nowIso(): string {
  return new Date().toISOString();
}

function makeMarketingJobId(): string {
  return `mkt_${randomUUID()}`;
}

function assertRequiredSchemas(): void {
  for (const schemaPath of REQUIRED_SCHEMA_PATHS) {
    if (!fs.existsSync(schemaPath)) {
      throw new Error(`HARD_FAILURE: missing required schema input: ${schemaPath}`);
    }

    try {
      const raw = fs.readFileSync(schemaPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("schema root must be an object");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`HARD_FAILURE: invalid required schema input ${schemaPath}: ${message}`);
    }
  }
}

function runtimePath(jobId: string): string {
  return resolveDataPath("generated", "draft", "marketing-jobs", `${jobId}.json`);
}

function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendHistory(job: Dict, note: string, state: string, status: string): void {
  const history = Array.isArray(job.history) ? job.history : [];
  history.push({ at: nowIso(), state, status, note });
  job.history = history;
}

function createFallbackJobRuntime(input: StartMarketingJobRequest, jobId: string): string {
  const outPath = runtimePath(jobId);
  ensureParent(outPath);
  const ts = nowIso();

  const doc: Dict = {
    schema_name: "job_runtime_state_schema",
    schema_version: "1.0.0",
    job_id: jobId,
    job_type: input.jobType,
    tenant_id: input.tenantId,
    state: "queued",
    status: "pending",
    attempt: 1,
    max_attempts: 3,
    inputs: {
      request: input.payload,
      requested_job_type: input.jobType,
      brand_url: input.payload.brandUrl,
      competitor_url: input.payload.competitorUrl
    },
    outputs: {
      current_stage: "research",
      stage_status: {
        research: "queued",
        strategy: "paused",
        production: "paused",
        publish: "paused"
      },
      structured_status_updates: [
        {
          at: ts,
          state: "queued",
          status: "pending",
          step: "research",
          details: { source: "backend_fallback" }
        }
      ]
    },
    history: [
      {
        at: ts,
        state: "queued",
        status: "pending",
        note: "marketing job accepted via backend fallback"
      }
    ],
    created_at: ts,
    updated_at: ts
  };

  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2));
  return outPath;
}

export type StartMarketingJobRequest = {
  tenantId: string;
  jobType: "brand_campaign";
  payload: {
    brandUrl?: unknown;
    competitorUrl?: unknown;
    [key: string]: unknown;
  };
};

export type StartMarketingJobResponse = {
  status: "accepted";
  jobId: string;
  tenantId: string;
  jobType: StartMarketingJobRequest["jobType"];
  wiring: "openclaw_gateway";
  runtimeArtifactPath: string;
  approvalRequired: boolean;
};

function runtimeArtifactPath(jobId: string): string {
  return `generated/draft/marketing-jobs/${jobId}.json`;
}

function approvalRequiredFromOpenClaw(
  primaryOutput: Record<string, unknown> | null,
  envelope: { requiresApproval?: { resumeToken?: string } | null }
): boolean {
  if (envelope.requiresApproval?.resumeToken) {
    return true;
  }

  const approvalPreview =
    primaryOutput &&
      typeof primaryOutput.approval_preview === "object" &&
      primaryOutput.approval_preview !== null
      ? (primaryOutput.approval_preview as Record<string, unknown>)
      : null;
  const approvalStatus =
    approvalPreview && typeof approvalPreview.status === "string"
      ? approvalPreview.status.trim().toLowerCase()
      : "";

  return approvalStatus.includes("approval") || approvalStatus.includes("review");
}

export type CreateMarketingJobRuntimePayload = {
  tenant_id: string;
  job_type: string;
  request: {
    job_id?: string;
    brand_url?: string;
    competitor_url?: string;
    [key: string]: unknown;
  };
};

export function createMarketingJobRuntime(payload: CreateMarketingJobRuntimePayload): {
  status: string;
  job_id: string;
  tenant_id: string;
  job_type: string;
  job_state: string;
  job_runtime_path: string;
} {
  assertRequiredSchemas();
  const tenantId = typeof payload.tenant_id === "string" ? payload.tenant_id.trim() : "";
  const jobType = typeof payload.job_type === "string" ? payload.job_type.trim() : "brand_campaign";
  const req = payload.request && typeof payload.request === "object" ? payload.request : {};
  const brandUrl = typeof req.brand_url === "string" ? req.brand_url.trim() : "";
  const competitorUrl = typeof req.competitor_url === "string" ? req.competitor_url.trim() : "";

  if (!tenantId || !jobType) {
    throw new Error("missing_required_fields:tenant_id,job_type");
  }
  if (!brandUrl || !competitorUrl) {
    throw new Error("missing_required_fields:request.brand_url,request.competitor_url");
  }

  const jobId =
    typeof req.job_id === "string" && req.job_id.trim()
      ? req.job_id.trim()
      : makeMarketingJobId();
  const outPath = runtimePath(jobId);
  ensureParent(outPath);
  const ts = nowIso();

  const doc: Dict = {
    schema_name: "job_runtime_state_schema",
    schema_version: "1.0.0",
    job_id: jobId,
    job_type: jobType,
    tenant_id: tenantId,
    state: "queued",
    status: "pending",
    attempt: 1,
    max_attempts: 3,
    inputs: {
      request: req,
      brand_url: brandUrl,
      competitor_url: competitorUrl
    },
    outputs: {
      current_stage: "research",
      stage_status: {
        research: "queued",
        strategy: "paused",
        production: "paused",
        publish: "paused"
      },
      structured_status_updates: [
        {
          at: ts,
          state: "queued",
          status: "pending",
          step: "research",
          details: { source: "brand_campaign_api_request" }
        }
      ]
    },
    history: [
      {
        at: ts,
        state: "queued",
        status: "pending",
        note: "cohesive brand campaign workflow accepted job"
      }
    ],
    created_at: ts,
    updated_at: ts
  };

  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2));
  return {
    status: "accepted",
    job_id: jobId,
    tenant_id: tenantId,
    job_type: jobType,
    job_state: "queued",
    job_runtime_path: outPath
  };
}

function createOpenClawBackedJobRuntime(
  input: StartMarketingJobRequest,
  jobId: string,
  primaryOutput: Record<string, unknown> | null,
  envelope: { status: string; requiresApproval?: { resumeToken?: string } | null }
): string {
  const outPath = runtimePath(jobId);
  ensureParent(outPath);
  const ts = nowIso();
  const approvalRequired = approvalRequiredFromOpenClaw(primaryOutput, envelope);
  const approvalPreview =
    primaryOutput &&
      typeof primaryOutput.approval_preview === 'object' &&
      primaryOutput.approval_preview !== null
      ? (primaryOutput.approval_preview as Record<string, unknown>)
      : null;
  const stageStatus: Record<string, string> = {
    research: 'completed',
    strategy: 'completed',
    production: 'completed',
    publish:
      typeof approvalPreview?.status === 'string'
        ? String(approvalPreview.status)
        : envelope.requiresApproval?.resumeToken
          ? 'awaiting_approval'
          : 'completed',
  };

  const doc: Dict = {
    schema_name: "job_runtime_state_schema",
    schema_version: "1.0.0",
    job_id: jobId,
    job_type: input.jobType,
    tenant_id: input.tenantId,
    state: approvalRequired ? "approval_required" : "completed",
    status: approvalRequired ? "awaiting_approval" : "completed",
    attempt: 1,
    max_attempts: 3,
    inputs: {
      request: input.payload,
      requested_job_type: input.jobType,
      brand_url: input.payload.brandUrl,
      competitor_url: input.payload.competitorUrl
    },
    outputs: {
      current_stage: "publish",
      stage_status: stageStatus,
      structured_status_updates: [
        {
          at: ts,
          state: "completed",
          status: "completed",
          step: "research",
          details: { source: "openclaw_gateway" }
        },
        {
          at: ts,
          state: "completed",
          status: "completed",
          step: "strategy",
          details: { source: "openclaw_gateway" }
        },
        {
          at: ts,
          state: "completed",
          status: "completed",
          step: "production",
          details: { source: "openclaw_gateway" }
        },
        {
          at: ts,
          state: approvalRequired ? "approval_required" : "completed",
          status: approvalRequired ? "awaiting_approval" : "completed",
          step: "publish",
          details: { source: "openclaw_gateway", envelope_status: envelope.status }
        }
      ],
      openclaw: {
        envelope_status: envelope.status,
        resume_token: envelope.requiresApproval?.resumeToken || null,
        run_id: typeof primaryOutput?.run_id === 'string' ? primaryOutput.run_id : null,
        primary_output: primaryOutput,
      },
    },
    history: [
      {
        at: ts,
        state: approvalRequired ? "approval_required" : "completed",
        status: approvalRequired ? "awaiting_approval" : "completed",
        note: approvalRequired
          ? "marketing job reached launch approval via OpenClaw gateway"
          : "marketing job completed via OpenClaw gateway"
      }
    ],
    created_at: ts,
    updated_at: ts
  };

  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2));
  return outPath;
}

export async function startMarketingJob(
  input: StartMarketingJobRequest
): Promise<StartMarketingJobResponse> {
  assertRequiredSchemas();

  if (!input?.tenantId || typeof input.tenantId !== 'string' || input.tenantId.trim().length === 0) {
    console.error('startMarketingJob failed: missing tenantId', input);
    throw new Error('missing_required_fields:tenantId');
  }

  if (!input?.jobType || typeof input.jobType !== 'string') {
    console.error('startMarketingJob failed: missing jobType', input);
    throw new Error('missing_required_fields:jobType');
  }

  if (input.jobType !== "brand_campaign") {
    console.error('startMarketingJob failed: unsupported jobType', input);
    throw new Error(`unsupported_job_type:${input.jobType}`);
  }

  const brandUrl = typeof input.payload?.brandUrl === "string" ? input.payload.brandUrl.trim() : "";
  const competitorUrl = typeof input.payload?.competitorUrl === "string" ? input.payload.competitorUrl.trim() : "";
  const missingPayloadFields: string[] = [];
  if (!brandUrl) missingPayloadFields.push("payload.brandUrl");
  if (!competitorUrl) missingPayloadFields.push("payload.competitorUrl");
  if (missingPayloadFields.length > 0) {
    console.error('startMarketingJob failed: missing brand campaign payload fields', input);
    throw new Error(`missing_required_fields:${missingPayloadFields.join(",")}`);
  }

  const tenantId = input.tenantId.trim();
  const jobId = makeMarketingJobId();
  const executed = await runAriesOpenClawWorkflow('marketing_start', {
    competitor: '',
    competitor_facebook_url: competitorUrl,
    website_url: brandUrl,
    brand_slug: tenantId,
    launch_approved: false,
    notify_chat: false,
  });
  if (executed.kind === 'gateway_error') {
    throw executed.error;
  }
  if (executed.kind === 'not_implemented') {
    throw new Error(`${executed.payload.code}:${executed.payload.route}`);
  }

  const approvalRequired = approvalRequiredFromOpenClaw(executed.primaryOutput, executed.envelope);
  createOpenClawBackedJobRuntime(input, jobId, executed.primaryOutput, executed.envelope);
  return {
    status: "accepted",
    jobId,
    tenantId,
    jobType: input.jobType,
    wiring: "openclaw_gateway",
    runtimeArtifactPath: runtimeArtifactPath(jobId),
    approvalRequired,
  };
}
