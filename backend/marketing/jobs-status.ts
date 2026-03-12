declare const require: (name: string) => any;

import { generatedDataPath, requiredSchemaPath } from '../runtime-paths';

const fs = require("fs");

const REQUIRED_SCHEMA_PATHS = [
  requiredSchemaPath("tenant_runtime_state_schema.v1.json"),
  requiredSchemaPath("job_runtime_state_schema.v1.json")
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
  return generatedDataPath("draft", "marketing-jobs", `${jobId}.json`);
}

export type MarketingJobStatusResponse = {
  jobId: string;
  tenantId: string | null;
  state: string;
  status: string;
  currentStage: string | null;
  stageStatus: Record<string, string>;
  updatedAt: string | null;
  runtimePath: string;
};

export function getMarketingJobStatus(jobId: string): MarketingJobStatusResponse {
  assertRequiredSchemas();
  const filePath = runtimePath(jobId);

  if (!fs.existsSync(filePath)) {
    return {
      jobId,
      tenantId: null,
      state: "not_found",
      status: "error",
      currentStage: null,
      stageStatus: {},
      updatedAt: null,
      runtimePath: filePath
    };
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const job = JSON.parse(raw);
  return {
    jobId,
    tenantId: typeof job.tenant_id === "string" ? job.tenant_id : null,
    state: typeof job.state === "string" ? job.state : "unknown",
    status: typeof job.status === "string" ? job.status : "unknown",
    currentStage: typeof job?.outputs?.current_stage === "string" ? job.outputs.current_stage : null,
    stageStatus: (job?.outputs?.stage_status && typeof job.outputs.stage_status === "object") ? job.outputs.stage_status : {},
    updatedAt: typeof job.updated_at === "string" ? job.updated_at : null,
    runtimePath: filePath
  };
}
