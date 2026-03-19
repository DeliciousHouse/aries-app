declare const require: (name: string) => any;
import { resolveDataPath, resolveSpecPath } from "../../lib/runtime-paths";

const fs = require("fs");
const path = require("path");

const REQUIRED_SCHEMA_PATHS = [
  resolveSpecPath("tenant_runtime_state_schema.v1.json"),
  resolveSpecPath("job_runtime_state_schema.v1.json")
] as const;

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

export type MarketingJobStatusResponse = {
  jobId: string;
  runtimeFileFound: boolean;
  tenantId: string | null;
  state: string;
  status: string;
  currentStage: string | null;
  stageStatus: Record<string, string>;
  updatedAt: string | null;
  runtimeArtifactPath: string;
  approvalRequired: boolean;
};

function runtimeArtifactPath(jobId: string): string {
  return `generated/draft/marketing-jobs/${jobId}.json`;
}

function getJobOutputs(job: Record<string, unknown>): Record<string, unknown> {
  return job.outputs !== null && typeof job.outputs === "object" ? (job.outputs as Record<string, unknown>) : {};
}

function approvalRequiredFromJob(job: Record<string, unknown>): boolean {
  const outputs = getJobOutputs(job);
  const resumeToken =
    typeof outputs.openclaw === "object" && outputs.openclaw !== null
      ? (outputs.openclaw as Record<string, unknown>)
      : null;
  const openClawResumeToken =
    resumeToken && typeof resumeToken.resume_token === "string"
      ? resumeToken.resume_token.trim()
      : "";
  if (openClawResumeToken) {
    return true;
  }

  const stageStatus =
    typeof outputs.stage_status === "object" && outputs.stage_status !== null
      ? (outputs.stage_status as Record<string, unknown>)
      : {};

  return Object.values(stageStatus).some(
    (value) => typeof value === "string" && /(approval|review)/i.test(value)
  );
}

export function getMarketingJobStatus(jobId: string): MarketingJobStatusResponse {
  assertRequiredSchemas();
  const filePath = runtimePath(jobId);

  if (!fs.existsSync(filePath)) {
    return {
      jobId,
      runtimeFileFound: false,
      tenantId: null,
      state: "not_found",
      status: "error",
      currentStage: null,
      stageStatus: {},
      updatedAt: null,
      runtimeArtifactPath: runtimeArtifactPath(jobId),
      approvalRequired: false,
    };
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const job = JSON.parse(raw) as Record<string, unknown>;
  const outputs = getJobOutputs(job);
  const rawStageStatus =
    typeof outputs.stage_status === "object" && outputs.stage_status !== null
      ? (outputs.stage_status as Record<string, unknown>)
      : {};
  const stageStatus: Record<string, string> = Object.fromEntries(
    Object.entries(rawStageStatus).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  return {
    jobId,
    runtimeFileFound: true,
    tenantId: typeof job.tenant_id === "string" ? job.tenant_id : null,
    state: typeof job.state === "string" ? job.state : "unknown",
    status: typeof job.status === "string" ? job.status : "unknown",
    currentStage: typeof outputs.current_stage === "string" ? outputs.current_stage : null,
    stageStatus,
    updatedAt: typeof job.updated_at === "string" ? job.updated_at : null,
    runtimeArtifactPath: runtimeArtifactPath(jobId),
    approvalRequired: approvalRequiredFromJob(job),
  };
}
