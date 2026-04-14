import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveCodeRoot } from '@/lib/runtime-paths';

const MARKETING_JOB_FAILURE_SOURCE = 'marketing-job-failure';

type MarketingFailureInput = {
  jobId: string;
  tenantId: string;
  runtimePath: string;
  state: string;
  status: string;
  currentStage: string;
  updatedAt: string;
  error: {
    code: string;
    message: string;
    stage: string;
    at: string;
    details?: Record<string, unknown>;
  };
};

type RuntimeIncident = {
  incidentId: string;
  fingerprint: string;
  title: string;
  service: string;
  environment: string;
  severity: string;
  source: string;
  errorMessage: string;
  details: string;
  validationCommand: string;
  repairHints: string[];
  marketingJobId: string;
  tenantId: string | null;
  marketingStage: string | null;
  marketingErrorCode: string;
  marketingErrorAt: string | null;
  runtimePath: string;
  status: string;
  attemptCount: number;
  detectionCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastDetectedAt: string;
  lastResolvedAt: string | null;
  updatedAt: string;
  owner: string;
  planSummary: string | null;
  fixSummary: string | null;
  validationSummary: string | null;
  resolutionSummary: string | null;
  lastRepairAttemptAt: string | null;
  history: Array<{ at: string; event: string; details: string }>;
};

type RuntimeIncidentLog = {
  version: number;
  service: string;
  environment: string;
  lastScanAt: string | null;
  items: RuntimeIncident[];
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeWhitespace(value: unknown) {
  return String(value || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .trim();
}

function truncate(text: string, max = 8000) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function createFingerprint(jobId: string, errorStage: string, errorCode: string, rawMessage: string) {
  return crypto
    .createHash('sha1')
    .update(`${MARKETING_JOB_FAILURE_SOURCE}\n${jobId}\n${errorStage}\n${errorCode}\n${normalizeWhitespace(rawMessage)}`)
    .digest('hex');
}

function createIncidentId(fingerprint: string) {
  const suffix = fingerprint.slice(0, 8);
  const stamp = Date.now().toString(36);
  return `inc-${MARKETING_JOB_FAILURE_SOURCE}-${stamp}-${suffix}`;
}

function incidentLogPath() {
  return path.join(resolveCodeRoot(), 'data', 'runtime-error-incidents.json');
}

function loadRuntimeIncidentLog(): RuntimeIncidentLog {
  const filePath = incidentLogPath();
  if (!existsSync(filePath)) {
    return {
      version: 1,
      service: 'aries-app',
      environment: 'repo',
      lastScanAt: null,
      items: [],
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as RuntimeIncidentLog;
    return {
      version: 1,
      service: 'aries-app',
      environment: 'repo',
      lastScanAt: typeof parsed?.lastScanAt === 'string' ? parsed.lastScanAt : null,
      items: Array.isArray(parsed?.items) ? parsed.items : [],
    };
  } catch {
    return {
      version: 1,
      service: 'aries-app',
      environment: 'repo',
      lastScanAt: null,
      items: [],
    };
  }
}

function saveRuntimeIncidentLog(log: RuntimeIncidentLog) {
  const filePath = incidentLogPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(log, null, 2)}\n`);
}

export function recordMarketingFailureRuntimeIncident(input: MarketingFailureInput) {
  try {
    const ts = nowIso();
    const rawMessage = normalizeWhitespace(input.error.message) || `Campaign workflow failed during ${input.error.stage || input.currentStage || 'unknown'} stage.`;
    const errorStage = normalizeWhitespace(input.error.stage) || normalizeWhitespace(input.currentStage) || 'unknown';
    const errorCode = normalizeWhitespace(input.error.code) || 'marketing_job_failed';
    const fingerprint = createFingerprint(input.jobId, errorStage, errorCode, rawMessage);
    const errorMessage = `Campaign job ${input.jobId} failed in ${errorStage}: ${rawMessage}`;
    const details = truncate(
      JSON.stringify(
        {
          jobId: input.jobId,
          tenantId: input.tenantId || null,
          runtimePath: input.runtimePath,
          state: input.state || null,
          status: input.status || null,
          currentStage: input.currentStage || null,
          errorStage,
          errorCode,
          errorAt: input.error.at || null,
          updatedAt: input.updatedAt || null,
          message: rawMessage,
          lastErrorDetails: input.error.details ?? null,
        },
        null,
        2,
      ),
      8000,
    );

    const log = loadRuntimeIncidentLog();
    const existing = log.items.find((item) => item.fingerprint === fingerprint);

    if (existing) {
      existing.title = 'Marketing campaign workflow failed';
      existing.severity = errorStage === 'publish' ? 'medium' : 'high';
      existing.source = MARKETING_JOB_FAILURE_SOURCE;
      existing.errorMessage = errorMessage;
      existing.details = details;
      existing.validationCommand = 'node scripts/automations/runtime-error-intake.mjs scan --json';
      existing.repairHints = [
        `Inspect marketing runtime file ${input.runtimePath} and the workflow/artifact path that failed for job ${input.jobId}.`,
        'Prefer the smallest safe fix in the failing marketing stage or workflow contract, then rerun the intake scan to verify the incident clears.',
        'If the code fix lands but the job remains failed, rerun or resume the affected campaign workflow so the runtime state no longer reports failed.',
      ];
      existing.marketingJobId = input.jobId;
      existing.tenantId = input.tenantId || null;
      existing.marketingStage = errorStage;
      existing.marketingErrorCode = errorCode;
      existing.marketingErrorAt = input.error.at || null;
      existing.runtimePath = input.runtimePath;
      existing.lastSeenAt = ts;
      existing.lastDetectedAt = ts;
      existing.updatedAt = ts;
      existing.detectionCount = (existing.detectionCount || 0) + 1;
      if (existing.status === 'resolved') {
        existing.status = 'open';
        existing.lastResolvedAt = null;
        existing.resolutionSummary = null;
        existing.history = Array.isArray(existing.history) ? existing.history : [];
        existing.history.push({ at: ts, event: 'reopened', details: errorMessage });
      } else {
        existing.history = Array.isArray(existing.history) ? existing.history : [];
        existing.history.push({ at: ts, event: 'still-failing', details: errorMessage });
      }
    } else {
      log.items.push({
        incidentId: createIncidentId(fingerprint),
        fingerprint,
        title: 'Marketing campaign workflow failed',
        service: 'aries-app',
        environment: 'repo',
        severity: errorStage === 'publish' ? 'medium' : 'high',
        source: MARKETING_JOB_FAILURE_SOURCE,
        errorMessage,
        details,
        validationCommand: 'node scripts/automations/runtime-error-intake.mjs scan --json',
        repairHints: [
          `Inspect marketing runtime file ${input.runtimePath} and the workflow/artifact path that failed for job ${input.jobId}.`,
          'Prefer the smallest safe fix in the failing marketing stage or workflow contract, then rerun the intake scan to verify the incident clears.',
          'If the code fix lands but the job remains failed, rerun or resume the affected campaign workflow so the runtime state no longer reports failed.',
        ],
        marketingJobId: input.jobId,
        tenantId: input.tenantId || null,
        marketingStage: errorStage,
        marketingErrorCode: errorCode,
        marketingErrorAt: input.error.at || null,
        runtimePath: input.runtimePath,
        status: 'open',
        attemptCount: 0,
        detectionCount: 1,
        firstSeenAt: ts,
        lastSeenAt: ts,
        lastDetectedAt: ts,
        lastResolvedAt: null,
        updatedAt: ts,
        owner: 'jarvis',
        planSummary: null,
        fixSummary: null,
        validationSummary: null,
        resolutionSummary: null,
        lastRepairAttemptAt: null,
        history: [{ at: ts, event: 'opened', details: errorMessage }],
      });
    }

    saveRuntimeIncidentLog(log);
  } catch (error) {
    console.warn('[marketing-runtime-error-bridge]', {
      event: 'record-runtime-incident-failed',
      jobId: input.jobId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
