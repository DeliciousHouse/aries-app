declare const require: (name: string) => any;

import { generatedDataPath, requiredSchemaPath } from '../runtime-paths';

const fs = require("fs");

type VideoStage = "ingest" | "render" | "review" | "publish";
type StageState = "queued" | "running" | "paused" | "completed" | "failed";

type ApproveVideoJobRequest = {
  tenant_id: string;
  video_job_id: string;
  approved_by: string;
  approved_stages?: VideoStage[];
};

type ApproveVideoJobResponse =
  | {
      status: "resumed";
      tenant_id: string;
      video_job_id: string;
      resumed_stage: VideoStage | null;
      completed: boolean;
      runtime_path: string;
      stage_status: Partial<Record<VideoStage, StageState>>;
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
  requiredSchemaPath("tenant_runtime_state_schema.v1.json"),
  requiredSchemaPath("job_runtime_state_schema.v1.json")
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
  return generatedDataPath("draft", "video-jobs", `${videoJobId}.json`);
}

function nextStage(stage: VideoStage): VideoStage | null {
  if (stage === "ingest") return "render";
  if (stage === "render") return "review";
  if (stage === "review") return "publish";
  return null;
}

function findResumableStage(stageStatus: Partial<Record<VideoStage, StageState>>, approved: Set<VideoStage>): VideoStage | null {
  const order: VideoStage[] = ["ingest", "render", "review", "publish"];
  for (const stage of order) {
    const state = stageStatus[stage];
    const isBlockedState = state === "queued" || state === "running" || state === "paused";
    const isApproved = approved.size === 0 || approved.has(stage);
    if (isBlockedState && isApproved) return stage;
  }
  return null;
}

export function approveVideoJob(input: ApproveVideoJobRequest): ApproveVideoJobResponse {
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
  if (doc.tenant_id !== input.tenant_id) {
    return {
      status: "error",
      reason: "tenant_mismatch",
      tenant_id: input.tenant_id,
      video_job_id: input.video_job_id,
      runtime_path: filePath
    };
  }

  const stageStatus: Partial<Record<VideoStage, StageState>> =
    doc?.outputs?.stage_status && typeof doc.outputs.stage_status === "object"
      ? doc.outputs.stage_status
      : { ingest: "queued", render: "paused", review: "paused", publish: "paused" };

  const updates: Array<Record<string, unknown>> = Array.isArray(doc?.outputs?.structured_status_updates)
    ? doc.outputs.structured_status_updates
    : [];

  const approved = new Set<VideoStage>(input.approved_stages || []);
  const resumedStage = findResumableStage(stageStatus, approved);
  const ts = nowIso();

  if (resumedStage) {
    stageStatus[resumedStage] = "completed";
    const next = nextStage(resumedStage);
    if (next) {
      stageStatus[next] = "queued";
      doc.outputs.current_stage = next;
      doc.state = "running";
      doc.status = "running";
    } else {
      doc.outputs.current_stage = "publish";
      doc.state = "completed";
      doc.status = "pass";
    }

    updates.push({
      at: ts,
      state: doc.state,
      status: doc.status,
      stage: resumedStage,
      details: {
        transition_to: next,
        approved_by: input.approved_by,
        tenant_id: input.tenant_id,
        video_job_id: input.video_job_id
      }
    });
  }

  doc.outputs = doc.outputs || {};
  doc.outputs.stage_status = stageStatus;
  doc.outputs.structured_status_updates = updates;
  doc.updated_at = ts;
  doc.history = Array.isArray(doc.history) ? doc.history : [];
  doc.history.push({
    at: ts,
    state: doc.state || "running",
    status: doc.status || "running",
    note: `video approval processed: ${resumedStage || "none"}`
  });

  fs.writeFileSync(filePath, JSON.stringify(doc, null, 2));

  return {
    status: "resumed",
    tenant_id: input.tenant_id,
    video_job_id: input.video_job_id,
    resumed_stage: resumedStage,
    completed: doc.state === "completed" || stageStatus.publish === "completed",
    runtime_path: filePath,
    stage_status: stageStatus,
    structured_status_updates: updates
  };
}
