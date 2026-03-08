// @ts-nocheck
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createWorkflow } from './create-workflow';
import { updateWorkflow } from './update-workflow';
import { preflightAuthCheck } from './preflight-auth';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function buildHeaders(apiKey: string) {
  return {
    'Content-Type': 'application/json',
    'X-N8N-API-KEY': apiKey
  };
}

async function resolveWorkflowIdByName(workflowName: string): Promise<string | null> {
  const baseUrl = requiredEnv('N8N_BASE_URL');
  const apiKey = requiredEnv('N8N_API_KEY');

  const res = await fetch(`${baseUrl}/rest/workflows?limit=250`, {
    method: 'GET',
    headers: buildHeaders(apiKey)
  });

  if (!res.ok) return null;
  const payload: any = await res.json().catch(() => null);
  const items = payload?.data || payload?.items || payload || [];
  const found = Array.isArray(items) ? items.find((w: any) => w?.name === workflowName) : null;
  return found?.id ? String(found.id) : null;
}

export async function publishOrUpdate(workflowFile: string): Promise<{
  mode: 'create' | 'update';
  workflowId?: string;
  result: any;
}> {
  const preflight = await preflightAuthCheck('unknown');
  if (!preflight.ok) {
    return {
      mode: 'create',
      result: {
        ok: false,
        stage: 'create',
        status: preflight.status,
        body: preflight.failure || { message: 'Preflight auth failed' },
        rawPath: `${process.env.PROJECT_ROOT || process.cwd()}/generated/draft/n8n-auth-diagnosis.json`
      }
    };
  }

  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const workflowPath = path.join(projectRoot, 'n8n', workflowFile);
  const workflowRaw = await readFile(workflowPath, 'utf8');
  const workflow = JSON.parse(workflowRaw);
  const workflowName = workflow?.name;

  const explicitId = process.env.N8N_WORKFLOW_ID;
  if (explicitId) {
    const result = await updateWorkflow(explicitId, workflowFile);
    return { mode: 'update', workflowId: explicitId, result };
  }

  const foundId = workflowName ? await resolveWorkflowIdByName(workflowName) : null;
  if (foundId) {
    const result = await updateWorkflow(foundId, workflowFile);
    return { mode: 'update', workflowId: foundId, result };
  }

  const result = await createWorkflow(workflowFile);
  const workflowId = result?.body?.id ? String(result.body.id) : undefined;
  return { mode: 'create', workflowId, result };
}
