// @ts-nocheck
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function now() {
  return new Date().toISOString();
}

async function readJson(file: string) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(file: string, value: any) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function exists(file: string) {
  try {
    await readFile(file, 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const root = path.resolve(process.cwd());
  const out = path.join(root, 'generated', 'validated', 'v3-orchestration-summary.json');

  const checks: Array<{ id: string; status: 'pass' | 'fail'; evidence: Record<string, any> }> = [];

  const workflowFiles = [
    'n8n/connection-events.workflow.json',
    'n8n/publish-dispatch.workflow.json',
    'n8n/publish-retry.workflow.json',
    'n8n/calendar-schedule-sync.workflow.json'
  ];

  const workflowPresence = await Promise.all(workflowFiles.map(async (f) => [f, await exists(path.join(root, f))] as const));
  checks.push({
    id: 'V3-C01-workflow-files-present',
    status: workflowPresence.every(([, ok]) => ok) ? 'pass' : 'fail',
    evidence: { workflowPresence: Object.fromEntries(workflowPresence) }
  });

  const orchestratorSource = await readFile(path.join(root, 'backend', 'integrations', 'workflow-orchestrator.ts'), 'utf8');
  const adapterRegistrySource = await readFile(path.join(root, 'backend', 'integrations', 'adapters', 'index.ts'), 'utf8');

  const hasNormalizePublish = orchestratorSource.includes('export function normalizePublishDispatch');
  const hasCalendarSync = orchestratorSource.includes("workflow: 'calendar_schedule_sync'");
  const hasRetryClamp = orchestratorSource.includes('Math.min(Math.max(input.max_attempts || 3, 1), 10)');
  const hasProviderMap = adapterRegistrySource.includes('facebook: metaAdapter') && adapterRegistrySource.includes('reddit: redditAdapter');

  checks.push({
    id: 'V3-C02-publish-normalization',
    status: hasNormalizePublish && hasProviderMap ? 'pass' : 'fail',
    evidence: { hasNormalizePublish, hasProviderMap }
  });

  checks.push({
    id: 'V3-C03-calendar-sync-event',
    status: hasCalendarSync ? 'pass' : 'fail',
    evidence: { hasCalendarSync }
  });

  checks.push({
    id: 'V3-C04-retry-event-clamped',
    status: hasRetryClamp ? 'pass' : 'fail',
    evidence: { hasRetryClamp }
  });

  const progress = await readJson(path.join(root, 'generated', 'validated', 'project-progress.json'));
  checks.push({
    id: 'V3-C05-phase-authority',
    status: progress.current_phase === 'v3_operator_surface_parity_and_shared_oauth_broker' ? 'pass' : 'fail',
    evidence: { current_phase: progress.current_phase, next_action: progress.next_action }
  });

  const status = checks.every((c) => c.status === 'pass') ? 'pass' : 'fail';
  const summary = {
    phase: 'v3_operator_surface_parity_and_shared_oauth_broker',
    objective: 'adapter_hardening_and_workflow_wiring_validation',
    status,
    generated_at: now(),
    checks
  };

  await writeJson(out, summary);
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

  if (status !== 'pass') process.exit(1);
}

main().catch(async (error) => {
  const root = path.resolve(process.cwd());
  await writeJson(path.join(root, 'generated', 'validated', 'v3-orchestration-summary.json'), {
    phase: 'v3_operator_surface_parity_and_shared_oauth_broker',
    objective: 'adapter_hardening_and_workflow_wiring_validation',
    status: 'fail',
    generated_at: now(),
    error: String(error?.message || error)
  });
  throw error;
});
