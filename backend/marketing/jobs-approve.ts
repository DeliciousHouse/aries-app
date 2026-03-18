declare const require: (name: string) => any;
import { resolveDataPath, resolveSpecPath } from "../../lib/runtime-paths";
import { runAriesOpenClawWorkflow } from "../openclaw/aries-execution";

const fs = require("fs");
const path = require("path");

const REQUIRED_SCHEMA_PATHS = [
  resolveSpecPath("tenant_runtime_state_schema.v1.json"),
  resolveSpecPath("job_runtime_state_schema.v1.json")
] as const;

function nowIso(): string { return new Date().toISOString(); }

function assertRequiredSchemas(): void {
  for (const schemaPath of REQUIRED_SCHEMA_PATHS) {
    if (!fs.existsSync(schemaPath)) {
      throw new Error(`HARD_FAILURE: missing required schema input: ${schemaPath}`);
    }
    const parsed = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`HARD_FAILURE: invalid required schema input: ${schemaPath}`);
    }
  }
}

function runtimePath(jobId: string): string {
  return resolveDataPath("generated", "draft", "marketing-jobs", `${jobId}.json`);
}

function localApproveProgress(job: any): { resumedStage: string | null; completed: boolean } {
  if (!job.outputs) job.outputs = {};
  if (!job.outputs.stage_status) {
    job.outputs.stage_status = { research: "queued", strategy: "paused", production: "paused", publish: "paused" };
  }

  const s = job.outputs.stage_status;
  const updates = Array.isArray(job.outputs.structured_status_updates) ? job.outputs.structured_status_updates : [];
  const ts = nowIso();

  const completeStage = (stage: string, next: string | null) => {
    s[stage] = "completed";
    if (next) s[next] = "queued";
    updates.push({ at: ts, state: "running", status: "running", step: stage, details: { transition: next ? `${stage}->${next}` : `${stage}->complete` } });
    job.outputs.current_stage = next || "done";
    return stage;
  };

  let resumed: string | null = null;

  if (s.research === "queued" || s.research === "running" || s.research === "paused") resumed = completeStage("research", "strategy");
  else if (s.strategy === "queued" || s.strategy === "running" || s.strategy === "paused") resumed = completeStage("strategy", "production");
  else if (s.production === "queued" || s.production === "running" || s.production === "paused") resumed = completeStage("production", "publish");
  else if (s.publish === "queued" || s.publish === "running" || s.publish === "paused") {
    resumed = completeStage("publish", null);
    job.state = "completed";
    job.status = "pass";
  }

  job.outputs.structured_status_updates = updates;
  job.updated_at = ts;
  const history = Array.isArray(job.history) ? job.history : [];
  history.push({ at: ts, state: job.state || "running", status: job.status || "running", note: `approval_resume ${resumed || 'none'}` });
  job.history = history;

  return { resumedStage: resumed, completed: job.state === "completed" || (s.publish === "completed") };
}

export type ApproveMarketingJobRequest = {
  jobId: string;
  tenantId: string;
  approvedBy: string;
  approvedStages?: Array<"research" | "strategy" | "production" | "publish">;
  resumePublishIfNeeded?: boolean;
};

export type ApproveMarketingJobResponse = {
  status: "resumed" | "error";
  jobId: string;
  tenantId: string;
  resumedStage: string | null;
  completed: boolean;
  wiring: "openclaw_gateway";
  reason?: string;
};

export async function approveMarketingJob(input: ApproveMarketingJobRequest): Promise<ApproveMarketingJobResponse> {
  assertRequiredSchemas();

  if (!input.approvedBy?.trim()) {
    return {
      status: "error",
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: null,
      completed: false,
      wiring: "openclaw_gateway",
      reason: 'missing_approved_by',
    };
  }

  const filePath = runtimePath(input.jobId);
  if (!fs.existsSync(filePath)) {
    return {
      status: "error",
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: null,
      completed: false,
      wiring: "openclaw_gateway",
      reason: 'job_not_found',
    };
  }

  const job = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (typeof job.tenant_id !== 'string' || job.tenant_id !== input.tenantId) {
    return {
      status: "error",
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: null,
      completed: false,
      wiring: "openclaw_gateway",
      reason: 'tenant_mismatch',
    };
  }

  const executed = await runAriesOpenClawWorkflow('marketing_approve', {
    job_id: input.jobId,
    tenant_id: input.tenantId,
    approved_by: input.approvedBy.trim(),
    approved_stages: input.approvedStages || [],
    resume_publish_if_needed: input.resumePublishIfNeeded ?? true,
  });
  if (executed.kind === 'gateway_error') {
    throw executed.error;
  }
  if (executed.kind === 'not_implemented') {
    return {
      status: "error",
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: null,
      completed: false,
      wiring: "openclaw_gateway",
      reason: executed.payload.code,
    };
  }

  return {
    status: "resumed",
    jobId: input.jobId,
    tenantId: input.tenantId,
    resumedStage: null,
    completed: false,
    wiring: "openclaw_gateway"
  };
}
