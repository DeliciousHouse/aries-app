declare const require: (name: string) => any;
import { resolveDataPath, resolveSpecPath } from "../../lib/runtime-paths";

const fs = require("fs");
const path = require("path");

type Dict = Record<string, unknown>;

type VideoStage = "ingest" | "render" | "review" | "publish";
type StageState = "queued" | "running" | "paused" | "completed" | "failed";

type StartVideoJobRequest = {
  tenant_id: string;
  video_job_id?: string;
  payload?: Dict;
};

type StartVideoJobResponse = {
  status: "accepted";
  tenant_id: string;
  video_job_id: string;
  runtime_path: string;
  current_stage: VideoStage;
  stage_status: Record<VideoStage, StageState>;
};

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

    const parsed = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`HARD_FAILURE: invalid required schema input: ${schemaPath}`);
    }
  }
}

function runtimePath(videoJobId: string): string {
  return resolveDataPath("generated", "draft", "video-jobs", `${videoJobId}.json`);
}

function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function initialStageStatus(): Record<VideoStage, StageState> {
  return {
    ingest: "queued",
    render: "paused",
    review: "paused",
    publish: "paused"
  };
}

function makeJobId(tenantId: string): string {
  return `video_${tenantId}_${Date.now()}`;
}

export function startVideoJob(input: StartVideoJobRequest): StartVideoJobResponse {
  assertRequiredSchemas();

  const videoJobId = input.video_job_id || makeJobId(input.tenant_id);
  const outPath = runtimePath(videoJobId);
  ensureParent(outPath);

  const ts = nowIso();
  const stageStatus = initialStageStatus();

  const doc: Dict = {
    schema_name: "job_runtime_state_schema",
    schema_version: "1.0.0",
    tenant_id: input.tenant_id,
    video_job_id: videoJobId,
    state: "queued",
    status: "pending",
    attempt: 1,
    max_attempts: 3,
    inputs: {
      request: input.payload || {},
      tenant_id: input.tenant_id,
      video_job_id: videoJobId
    },
    outputs: {
      current_stage: "ingest",
      stage_status: stageStatus,
      structured_status_updates: [
        {
          at: ts,
          state: "queued",
          status: "pending",
          stage: "ingest",
          details: {
            reason: "video_job_accepted",
            tenant_id: input.tenant_id,
            video_job_id: videoJobId
          }
        }
      ]
    },
    history: [
      {
        at: ts,
        state: "queued",
        status: "pending",
        note: "video job accepted"
      }
    ],
    created_at: ts,
    updated_at: ts
  };

  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2));

  return {
    status: "accepted",
    tenant_id: input.tenant_id,
    video_job_id: videoJobId,
    runtime_path: outPath,
    current_stage: "ingest",
    stage_status: stageStatus
  };
}
