declare const require: (name: string) => any;
import { resolveDataPath, resolveSpecPath } from "../../lib/runtime-paths";

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
  wiring: "n8n_approval_resume_webhook" | "backend_fallback";
};

export async function approveMarketingJob(input: ApproveMarketingJobRequest): Promise<ApproveMarketingJobResponse> {
  assertRequiredSchemas();

  const baseUrl = process.env.N8N_BASE_URL || "http://localhost:5678";
  const webhookUrl = `${baseUrl}/webhook/marketing-approval-resume`;

  const body = {
    job_id: input.jobId,
    tenant_id: input.tenantId,
    resume_publish_if_needed: input.resumePublishIfNeeded ?? true,
    approval: {
      decision: "approved",
      approved_by: input.approvedBy,
      approved_stages: input.approvedStages || [],
      approved_at: nowIso()
    }
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    let payload: any = {};
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }

    if (res.ok && payload.status === "resumed") {
      return {
        status: "resumed",
        jobId: input.jobId,
        tenantId: input.tenantId,
        resumedStage: Array.isArray(payload.resumed_stages) ? (payload.resumed_stages[0] || null) : null,
        completed: Array.isArray(payload.resumed_stages) && payload.resumed_stages.includes("publish"),
        wiring: "n8n_approval_resume_webhook"
      };
    }
  } catch {
    // fallback below
  }

  const filePath = runtimePath(input.jobId);
  if (!fs.existsSync(filePath)) {
    return {
      status: "error",
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: null,
      completed: false,
      wiring: "backend_fallback"
    };
  }

  const job = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const progress = localApproveProgress(job);
  fs.writeFileSync(filePath, JSON.stringify(job, null, 2));

  return {
    status: "resumed",
    jobId: input.jobId,
    tenantId: input.tenantId,
    resumedStage: progress.resumedStage,
    completed: progress.completed,
    wiring: "backend_fallback"
  };
}
