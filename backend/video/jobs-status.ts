declare const require: (name: string) => any;

const fs = require("fs");
const path = require("path");

type VideoStage = "ingest" | "render" | "review" | "publish";
type StageState = "queued" | "running" | "paused" | "completed" | "failed";

export type GetVideoJobStatusResponse =
  | {
      status: "ok";
      tenant_id: string;
      video_job_id: string;
      job_state: string;
      current_stage: VideoStage | null;
      stage_status: Partial<Record<VideoStage, StageState>>;
      updated_at: string | null;
      runtime_path: string;
      structured_status_updates: Array<Record<string, unknown>>;
    }
  | {
      status: "error";
      reason: "not_found" | "tenant_mismatch";
      tenant_id: string;
      video_job_id: string;
      runtime_path: string;
    };

const REQUIRED_SCHEMA_PATHS = [
  "./specs/tenant_runtime_state_schema.v1.json",
  "./specs/job_runtime_state_schema.v1.json"
] as const;

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

function runtimePath(videoJobId: string): string {
  const root = process.env.PROJECT_ROOT || process.cwd();
  return path.join(root, "generated", "draft", "video-jobs", `${videoJobId}.json`);
}

export function getVideoJobStatus(input: {
  tenant_id: string;
  video_job_id: string;
}): GetVideoJobStatusResponse {
  assertRequiredSchemas();

  const filePath = runtimePath(input.video_job_id);
  if (!fs.existsSync(filePath)) {
    return {
      status: "error",
      reason: "not_found",
      tenant_id: input.tenant_id,
      video_job_id: input.video_job_id,
      runtime_path: filePath
    };
  }

  const doc = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const tenantId = typeof doc.tenant_id === "string" ? doc.tenant_id : "";
  const videoJobId = typeof doc.video_job_id === "string" ? doc.video_job_id : input.video_job_id;

  if (tenantId !== input.tenant_id) {
    return {
      status: "error",
      reason: "tenant_mismatch",
      tenant_id: input.tenant_id,
      video_job_id: input.video_job_id,
      runtime_path: filePath
    };
  }

  return {
    status: "ok",
    tenant_id: tenantId,
    video_job_id: videoJobId,
    job_state: typeof doc.state === "string" ? doc.state : "unknown",
    current_stage: typeof doc?.outputs?.current_stage === "string" ? doc.outputs.current_stage : null,
    stage_status:
      doc?.outputs?.stage_status && typeof doc.outputs.stage_status === "object"
        ? doc.outputs.stage_status
        : {},
    updated_at: typeof doc.updated_at === "string" ? doc.updated_at : null,
    runtime_path: filePath,
    structured_status_updates: Array.isArray(doc?.outputs?.structured_status_updates)
      ? doc.outputs.structured_status_updates
      : []
  };
}
