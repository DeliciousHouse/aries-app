declare const require: (name: string) => any;

type Dict = Record<string, unknown>;
const fs = require("fs");
const path = require("path");

const REQUIRED_SCHEMA_PATHS = [
  "./specs/tenant_runtime_state_schema.v1.json",
  "./specs/job_runtime_state_schema.v1.json"
] as const;

function nowIso(): string {
  return new Date().toISOString();
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

function projectRoot(): string {
  return process.env.PROJECT_ROOT || process.cwd();
}

function runtimePath(jobId: string): string {
  return path.join(projectRoot(), "generated", "draft", "marketing-jobs", `${jobId}.json`);
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
    job_type: "unknown",
    tenant_id: input.tenantId,
    state: "queued",
    status: "pending",
    attempt: 1,
    max_attempts: 3,
    inputs: {
      request: input.payload || {},
      requested_job_type: input.jobType
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
  jobType: "marketing_research" | "marketing_strategy" | "marketing_production" | "marketing_publish" | "unknown";
  payload?: Record<string, unknown>;
};

export type StartMarketingJobResponse = {
  status: "accepted";
  jobId: string;
  tenantId: string;
  jobType: StartMarketingJobRequest["jobType"];
  wiring: "n8n_research_webhook" | "backend_fallback";
  runtimePath: string;
};

export async function startMarketingJob(
  input: StartMarketingJobRequest
): Promise<StartMarketingJobResponse> {
  assertRequiredSchemas();

  const jobId = `mkt_${input.tenantId}_${Date.now()}`;
  const baseUrl = process.env.N8N_BASE_URL || "http://localhost:5678";
  const webhookUrl = `${baseUrl}/webhook/marketing-research`;

  const reqBody = {
    tenant_id: input.tenantId,
    job_type: "marketing_research",
    request: {
      job_id: jobId,
      tenant_id: input.tenantId,
      source_job_type: input.jobType,
      ...(input.payload || {})
    }
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody)
    });

    const text = await res.text();
    let body: Dict = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }

    if (res.ok && typeof body.job_id === "string") {
      const outPath = runtimePath(String(body.job_id));
      if (!fs.existsSync(outPath)) {
        createFallbackJobRuntime(input, String(body.job_id));
      }
      return {
        status: "accepted",
        jobId: String(body.job_id),
        tenantId: input.tenantId,
        jobType: input.jobType,
        wiring: "n8n_research_webhook",
        runtimePath: outPath
      };
    }
  } catch {
    // fallback below
  }

  const outPath = createFallbackJobRuntime(input, jobId);
  return {
    status: "accepted",
    jobId,
    tenantId: input.tenantId,
    jobType: input.jobType,
    wiring: "backend_fallback",
    runtimePath: outPath
  };
}
