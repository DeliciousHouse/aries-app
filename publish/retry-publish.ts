// @ts-nocheck
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { publishOrUpdate } from './publish-or-update';
import { activateWorkflow } from './activate-workflow';
import { captureFailurePayload } from './capture-failure-payload';
import { boundedRepair } from './bounded-repair';

export interface RetryPublishSummary {
  workflowFile: string;
  createOrUpdateSucceeded: boolean;
  activateSucceeded: boolean;
  repairLoopSucceeded: boolean;
  attemptsUsed: number;
  hardFailure: boolean;
  failure?: any;
  rawResponses: any[];
}

export async function retryPublish(workflowFile: string): Promise<RetryPublishSummary> {
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const workflowPath = path.join(projectRoot, 'n8n', workflowFile);
  const outDir = path.join(projectRoot, 'generated', 'draft');
  await mkdir(outDir, { recursive: true });

  const originalWorkflow = JSON.parse(await readFile(workflowPath, 'utf8'));
  let currentWorkflow = JSON.parse(JSON.stringify(originalWorkflow));

  const rawResponses: any[] = [];
  const phaseLog: string[] = [];
  let createOrUpdateSucceeded = false;
  let activateSucceeded = false;
  let repairLoopSucceeded = false;
  let hardFailure = false;
  let lastFailure: any = null;

  for (let attempt = 1; attempt <= 4; attempt++) {
    await writeFile(workflowPath, JSON.stringify(currentWorkflow, null, 2), 'utf8');
    phaseLog.push(`- Attempt ${attempt}: publishOrUpdate start`);

    let publishResult: any;
    try {
      publishResult = await publishOrUpdate(workflowFile);
      rawResponses.push({ attempt, stage: publishResult.mode, response: publishResult.result });
    } catch (error: any) {
      const failure = captureFailurePayload({ stage: 'create', error });
      rawResponses.push({ attempt, stage: 'create', error: failure });
      lastFailure = failure;
      hardFailure = true;
      phaseLog.push(`- Attempt ${attempt}: publishOrUpdate threw ${failure.message}`);
      break;
    }

    if (!publishResult.result.ok) {
      const failure = captureFailurePayload({
        stage: publishResult.mode === 'update' ? 'update' : 'create',
        httpStatus: publishResult.result.status,
        responseBody: publishResult.result.body
      });
      rawResponses.push({ attempt, stage: 'capture-failure', failure });
      lastFailure = failure;
      phaseLog.push(`- Attempt ${attempt}: ${failure.stage} failed ${failure.httpStatus} ${failure.message}`);

      if (attempt > 3 || !failure.retryable) {
        hardFailure = true;
        break;
      }

      const repair = boundedRepair({ workflow: currentWorkflow, originalWorkflow, failure, attempt });
      rawResponses.push({ attempt, stage: 'repair', repair });
      if (!repair.repaired) {
        hardFailure = true;
        phaseLog.push(`- Attempt ${attempt}: repair skipped (${repair.reason})`);
        break;
      }

      currentWorkflow = repair.workflow;
      phaseLog.push(`- Attempt ${attempt}: patched ${repair.patchedSection}`);
      continue;
    }

    createOrUpdateSucceeded = true;
    phaseLog.push(`- Attempt ${attempt}: create/update succeeded`);

    const workflowId = publishResult.workflowId || publishResult.result.body?.id;
    if (!workflowId) {
      hardFailure = true;
      lastFailure = captureFailurePayload({ stage: 'activate', error: new Error('Missing workflow id after publish') });
      rawResponses.push({ attempt, stage: 'activate', error: lastFailure });
      break;
    }

    const activateResult = await activateWorkflow(String(workflowId));
    rawResponses.push({ attempt, stage: 'activate', response: activateResult });

    if (activateResult.ok) {
      activateSucceeded = true;
      repairLoopSucceeded = attempt > 1;
      phaseLog.push(`- Attempt ${attempt}: activation succeeded`);
      break;
    }

    const failure = captureFailurePayload({
      stage: 'activate',
      httpStatus: activateResult.status,
      responseBody: activateResult.body
    });
    rawResponses.push({ attempt, stage: 'capture-failure', failure });
    lastFailure = failure;
    phaseLog.push(`- Attempt ${attempt}: activation failed ${failure.httpStatus} ${failure.message}`);

    if (attempt > 3 || !failure.retryable) {
      hardFailure = true;
      break;
    }

    const repair = boundedRepair({ workflow: currentWorkflow, originalWorkflow, failure, attempt });
    rawResponses.push({ attempt, stage: 'repair', repair });

    if (!repair.repaired) {
      hardFailure = true;
      phaseLog.push(`- Attempt ${attempt}: repair skipped (${repair.reason})`);
      break;
    }

    currentWorkflow = repair.workflow;
    phaseLog.push(`- Attempt ${attempt}: patched ${repair.patchedSection}`);
    repairLoopSucceeded = true;
  }

  const summary: RetryPublishSummary = {
    workflowFile,
    createOrUpdateSucceeded,
    activateSucceeded,
    repairLoopSucceeded,
    attemptsUsed: Math.min(rawResponses.filter(r => r.stage === 'activate' || r.stage === 'create' || r.stage === 'update').length + 1, 4),
    hardFailure,
    failure: lastFailure,
    rawResponses
  };

  await writeFile(path.join(outDir, 'n8n-publish-results.json'), JSON.stringify(summary, null, 2), 'utf8');
  await writeFile(path.join(outDir, 'n8n-publish-phase-log.md'), `# n8n publish phase log\n\n${phaseLog.join('\n')}\n`, 'utf8');
  await writeFile(path.join(outDir, 'n8n-publish-defect-report.json'), JSON.stringify({
    hardFailure,
    lastFailure,
    repairLoopSucceeded,
    patchedAttempts: rawResponses.filter(r => r.stage === 'repair')
  }, null, 2), 'utf8');

  return summary;
}
