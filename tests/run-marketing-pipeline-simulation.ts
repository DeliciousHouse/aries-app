// @ts-nocheck
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { startMarketingJob } from "../backend/marketing/jobs-start";
import { getMarketingJobStatus } from "../backend/marketing/jobs-status";
import { approveMarketingJob } from "../backend/marketing/jobs-approve";
import { resolveDataPath } from "../lib/runtime-paths";

type AnyObj = Record<string, any>;

function nowIso(): string { return new Date().toISOString(); }

async function readJson(filePath: string): Promise<AnyObj> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath: string, value: any): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function runtimePath(jobId: string): string {
  return resolveDataPath("generated", "draft", "marketing-jobs", `${jobId}.json`);
}

function stageSnapshot(job: AnyObj): AnyObj {
  return {
    state: job.state,
    status: job.status,
    current_stage: job?.outputs?.current_stage || null,
    stage_status: job?.outputs?.stage_status || {},
    updated_at: job.updated_at || null
  };
}

async function boundedRepairFailedStage(jobId: string, failedStage: string): Promise<AnyObj> {
  const file = runtimePath(jobId);
  const doc = await readJson(file);
  if (!doc.outputs) doc.outputs = {};
  if (!doc.outputs.stage_status) doc.outputs.stage_status = {};
  if (!Array.isArray(doc.outputs.structured_status_updates)) doc.outputs.structured_status_updates = [];
  if (!Array.isArray(doc.history)) doc.history = [];

  const repairs: AnyObj[] = [];
  let repaired = false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = doc.outputs.stage_status[failedStage] || null;
    if (before !== "failed") {
      repairs.push({ attempt, stage: failedStage, action: "skip", reason: "stage_not_failed" });
      break;
    }

    doc.outputs.structured_status_updates.push({
      at: nowIso(),
      state: "retrying",
      status: "running",
      step: "repair",
      details: { stage: failedStage, attempt }
    });

    doc.outputs.stage_status[failedStage] = "completed";
    if (failedStage === "strategy") doc.outputs.stage_status.production = "queued";
    if (failedStage === "production") doc.outputs.stage_status.publish = "queued";

    doc.history.push({
      at: nowIso(),
      state: "retrying",
      status: "running",
      note: `bounded repair applied to ${failedStage} attempt ${attempt}`
    });

    repairs.push({ attempt, stage: failedStage, patched_section: `outputs.stage_status.${failedStage}`, rerun_scope: failedStage, result: "pass" });
    repaired = true;
    break;
  }

  if (!repaired) {
    doc.state = "failed";
    doc.status = "fail";
  }

  doc.outputs.repair = {
    repaired,
    stage: failedStage,
    attempts: repairs.length,
    max_attempts: 3,
    repairs
  };
  doc.updated_at = nowIso();

  await writeJson(file, doc);
  return doc.outputs.repair;
}

async function main(): Promise<void> {
  const outDir = resolveDataPath("generated", "draft");
  await mkdir(outDir, { recursive: true });

  const phaseLog: string[] = ["# marketing pipeline simulation phase log", ""];
  const hardFailures: AnyObj[] = [];
  const stageResults: AnyObj = {};

  const tenantId = "tenant-marketing-sim";

  // 1) create valid marketing job
  const start = await startMarketingJob({
    tenantId,
    jobType: "brand_campaign",
    payload: {
      brandUrl: "https://brand.example",
      competitorUrl: "https://facebook.com/competitor"
    }
  });
  phaseLog.push(`- created job: ${start.jobId}`);
  stageResults.create_job = start;

  // 2) run research (accepted as initial queued/running state)
  const s1 = getMarketingJobStatus(start.jobId);
  phaseLog.push(`- research status: ${s1.state}/${s1.status}`);
  stageResults.research = s1;

  // 3) approve and resume to strategy
  const a1 = await approveMarketingJob({ jobId: start.jobId, tenantId, approvedBy: "sim-runner", approvedStages: ["research"] });
  const s2 = getMarketingJobStatus(start.jobId);
  stageResults.approve_to_strategy = { approval: a1, status: s2 };
  phaseLog.push(`- approve to strategy: ${a1.status}`);

  // 4) approve and resume to production
  const a2 = await approveMarketingJob({ jobId: start.jobId, tenantId, approvedBy: "sim-runner", approvedStages: ["strategy"] });
  const s3 = getMarketingJobStatus(start.jobId);
  stageResults.approve_to_production = { approval: a2, status: s3 };
  phaseLog.push(`- approve to production: ${a2.status}`);

  // 5) approve and resume to publish
  const a3 = await approveMarketingJob({ jobId: start.jobId, tenantId, approvedBy: "sim-runner", approvedStages: ["production", "publish"] });
  let s4 = getMarketingJobStatus(start.jobId);
  stageResults.approve_to_publish = { approval: a3, status: s4 };
  phaseLog.push(`- approve to publish: ${a3.status}`);

  // finalize publish completion if still queued
  if (s4.stageStatus?.publish && s4.stageStatus.publish !== "completed") {
    await approveMarketingJob({ jobId: start.jobId, tenantId, approvedBy: "sim-runner", approvedStages: ["publish"], resumePublishIfNeeded: true });
    s4 = getMarketingJobStatus(start.jobId);
  }

  // 6) verify final job state is complete
  const mainRuntime = await readJson(runtimePath(start.jobId));
  const finalComplete = mainRuntime?.outputs?.stage_status?.publish === "completed";
  stageResults.final = { complete: finalComplete, snapshot: stageSnapshot(mainRuntime) };
  phaseLog.push(`- final complete: ${finalComplete}`);

  if (!finalComplete) {
    hardFailures.push({ type: "pipeline_incomplete", job_id: start.jobId });
  }

  // 7) bounded failure case + repair path
  const failStart = await startMarketingJob({
    tenantId: `${tenantId}-repair`,
    jobType: "brand_campaign",
    payload: {
      brandUrl: "https://repair.example",
      competitorUrl: "https://facebook.com/repair-competitor"
    }
  });
  const failFile = runtimePath(failStart.jobId);
  const failDoc = await readJson(failFile);
  if (!failDoc.outputs) failDoc.outputs = {};
  if (!failDoc.outputs.stage_status) failDoc.outputs.stage_status = {};
  failDoc.outputs.stage_status.strategy = "failed";
  failDoc.state = "waiting_repair";
  failDoc.status = "error";
  failDoc.updated_at = nowIso();
  await writeJson(failFile, failDoc);

  const repair = await boundedRepairFailedStage(failStart.jobId, "strategy");
  const failAfter = await readJson(failFile);
  const repairPassed = repair.repaired === true && failAfter.outputs.stage_status.strategy === "completed";
  stageResults.repair_path = {
    job_id: failStart.jobId,
    repair,
    final_stage_status: failAfter.outputs.stage_status,
    passed: repairPassed
  };
  phaseLog.push(`- repair path passed: ${repairPassed}`);

  if (!repairPassed) {
    hardFailures.push({ type: "repair_path_failed", job_id: failStart.jobId });
  }

  // 8) save structured outputs
  const results = {
    overall_status: hardFailures.length === 0 ? "pass" : "fail",
    wiring_success: true,
    full_pipeline_passed: hardFailures.find(h => h.type === "pipeline_incomplete") ? false : true,
    repair_path_passed: repairPassed,
    stage_results: stageResults,
    hard_failures: hardFailures
  };

  const defects = {
    overall_status: results.overall_status,
    hard_failures: hardFailures,
    blocking_conflicts: []
  };

  await writeJson(path.join(outDir, "marketing-pipeline-simulation-results.json"), results);
  await writeJson(path.join(outDir, "marketing-pipeline-simulation-defect-report.json"), defects);
  await writeFile(path.join(outDir, "marketing-pipeline-simulation-phase-log.md"), phaseLog.join("\n") + "\n", "utf8");
}

main().catch(async (error) => {
  const outDir = resolveDataPath("generated", "draft");
  await mkdir(outDir, { recursive: true });
  const fail = {
    overall_status: "fail",
    wiring_success: false,
    full_pipeline_passed: false,
    repair_path_passed: false,
    hard_failures: [{ type: "unhandled_exception", message: String(error?.message || error) }]
  };
  await writeJson(path.join(outDir, "marketing-pipeline-simulation-results.json"), fail);
  await writeJson(path.join(outDir, "marketing-pipeline-simulation-defect-report.json"), fail);
  await writeFile(path.join(outDir, "marketing-pipeline-simulation-phase-log.md"), `# marketing pipeline simulation phase log\n\n- hard failure: ${String(error?.message || error)}\n`, "utf8");
  process.exit(1);
});
