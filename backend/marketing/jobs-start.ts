declare const require: (name: string) => any;
import { resolveDataPath, resolveSpecPath } from "../../lib/runtime-paths";

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
  jobType: "marketing_research" | "marketing_strategy" | "marketing_production" | "marketing_publish" | "brand_campaign" | "unknown";
  payload?: Record<string, unknown>;
};

export type StartMarketingJobResponse = {
  status: "accepted";
  jobId: string;
  tenantId: string;
  jobType: StartMarketingJobRequest["jobType"];
  wiring: "n8n_research_webhook" | "backend_fallback";
  runtimeArtifactPath: string;
};

function runtimeArtifactPath(jobId: string): string {
  return `generated/draft/marketing-jobs/${jobId}.json`;
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

  const tenantId = input.tenantId.trim();
  const jobId = `mkt_${tenantId}_${Date.now()}`;
  const baseUrl = process.env.N8N_BASE_URL || "http://localhost:5678";
  let webhookUrl = `${baseUrl}/webhook/marketing-research`;
  let reqBody: Record<string, unknown> = {
    tenant_id: tenantId,
    job_type: "marketing_research",
    request: {
      job_id: jobId,
      tenant_id: tenantId,
      source_job_type: input.jobType,
      ...(input.payload || {})
    }
  };

  if (input.jobType === "brand_campaign") {
    webhookUrl = `${baseUrl}/webhook/brand-campaign`;
    reqBody = {
      tenant_id: tenantId,
      job_type: "brand_campaign",
      request: {
        job_id: jobId,
        tenant_id: tenantId,
        brand_url: input.payload?.brandUrl,
        competitor_url: input.payload?.competitorUrl,
        ...(input.payload || {})
      }
    };
  }

  try {
    // Internal Docker traffic to n8n stays HTTP; TLS terminates at Caddy/public edge.
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(5000)
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
        tenantId,
        jobType: input.jobType,
        wiring: "n8n_research_webhook",
        runtimeArtifactPath: runtimeArtifactPath(String(body.job_id))
      };
    }
  } catch (err) {
    console.error('startMarketingJob failed: n8n request threw an exception', err);
    // fallback below
  }

  const outPath = createFallbackJobRuntime(input, jobId);
  return {
    status: "accepted",
    jobId,
    tenantId,
    jobType: input.jobType,
    wiring: "backend_fallback",
    runtimeArtifactPath: runtimeArtifactPath(jobId)
  };
}
