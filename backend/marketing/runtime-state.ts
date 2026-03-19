import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveDataPath, resolveSpecPath } from '@/lib/runtime-paths';

const REQUIRED_SCHEMA_PATHS = [
  resolveSpecPath('tenant_runtime_state_schema.v1.json'),
  resolveSpecPath('job_runtime_state_schema.v1.json'),
] as const;

export type MarketingJobRuntimeDocument = Record<string, unknown>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function assertMarketingRuntimeSchemas(): void {
  for (const schemaPath of REQUIRED_SCHEMA_PATHS) {
    if (!existsSync(schemaPath)) {
      throw new Error(`HARD_FAILURE: missing required schema input: ${schemaPath}`);
    }

    try {
      const raw = readFileSync(schemaPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('schema root must be an object');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`HARD_FAILURE: invalid required schema input ${schemaPath}: ${message}`);
    }
  }
}

export function marketingRuntimePath(jobId: string): string {
  return resolveDataPath('generated', 'draft', 'marketing-jobs', `${jobId}.json`);
}

export function loadMarketingJobRuntime(jobId: string): MarketingJobRuntimeDocument | null {
  const filePath = marketingRuntimePath(jobId);
  if (!existsSync(filePath)) {
    return null;
  }

  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as MarketingJobRuntimeDocument;
}

export function saveMarketingJobRuntime(jobId: string, doc: MarketingJobRuntimeDocument): string {
  const filePath = marketingRuntimePath(jobId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(doc, null, 2));
  return filePath;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

export function ensureRuntimeOutputs(doc: MarketingJobRuntimeDocument): Record<string, unknown> {
  const outputs = asRecord(doc.outputs) ?? {};
  doc.outputs = outputs;
  return outputs;
}

export function ensureRuntimeOpenClaw(doc: MarketingJobRuntimeDocument): Record<string, unknown> {
  const outputs = ensureRuntimeOutputs(doc);
  const openclaw = asRecord(outputs.openclaw) ?? {};
  outputs.openclaw = openclaw;
  return openclaw;
}

export function ensureRuntimeStageStatus(doc: MarketingJobRuntimeDocument): Record<string, string> {
  const outputs = ensureRuntimeOutputs(doc);
  const stageStatus = asRecord(outputs.stage_status) ?? {};
  outputs.stage_status = stageStatus;
  return stageStatus as Record<string, string>;
}

export function ensureStructuredStatusUpdates(doc: MarketingJobRuntimeDocument): Array<Record<string, unknown>> {
  const outputs = ensureRuntimeOutputs(doc);
  if (!Array.isArray(outputs.structured_status_updates)) {
    outputs.structured_status_updates = [];
  }
  return outputs.structured_status_updates as Array<Record<string, unknown>>;
}

export function ensureRuntimeHistory(doc: MarketingJobRuntimeDocument): Array<Record<string, unknown>> {
  if (!Array.isArray(doc.history)) {
    doc.history = [];
  }
  return doc.history as Array<Record<string, unknown>>;
}

export function marketingRunIdFromRuntime(doc: MarketingJobRuntimeDocument | null): string | null {
  const openclaw = doc ? ensureRuntimeOpenClaw(doc) : null;
  const primaryOutput = asRecord(openclaw?.primary_output);
  return (
    asString(openclaw?.run_id) ??
    asString(primaryOutput?.run_id) ??
    asString(asRecord(openclaw?.last_resume_output)?.run_id)
  );
}
