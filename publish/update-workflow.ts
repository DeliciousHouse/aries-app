// @ts-nocheck
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preflightAuthCheck } from './preflight-auth';
import { resolveN8nApiContext } from './n8n-api';

export interface ApiResult {
  ok: boolean;
  stage: 'update';
  status: number;
  body: any;
  rawPath: string;
}

function sanitizeWorkflowForUpdate(workflow: any) {
  return {
    name: workflow?.name,
    nodes: workflow?.nodes,
    connections: workflow?.connections,
    settings: workflow?.settings || {}
  };
}

export async function updateWorkflow(workflowId: string, workflowFile: string): Promise<ApiResult> {
  const ctx = await resolveN8nApiContext();
  const baseUrl = ctx.baseUrl;
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();

  const preflight = await preflightAuthCheck('update');
  if (!preflight.ok) {
    const rawPath = path.join(projectRoot, 'generated', 'draft', 'n8n-update-raw-response.json');
    await mkdir(path.dirname(rawPath), { recursive: true });
    await writeFile(rawPath, JSON.stringify({ status: preflight.status, body: preflight.failure || { message: 'Preflight auth failed' }, workflowId }, null, 2), 'utf8');
    return {
      ok: false,
      stage: 'update',
      status: preflight.status,
      body: preflight.failure || { message: 'Preflight auth failed' },
      rawPath
    };
  }

  const workflowPath = path.join(projectRoot, 'n8n', workflowFile);
  const rawWorkflow = await readFile(workflowPath, 'utf8');
  const workflow = JSON.parse(rawWorkflow);

  const updatePayload = sanitizeWorkflowForUpdate(workflow);

  const res = await fetch(`${baseUrl}${ctx.apiBasePath}/workflows/${encodeURIComponent(workflowId)}`, {
    method: 'PUT',
    headers: ctx.headers,
    body: JSON.stringify(updatePayload)
  });

  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}

  const outDir = path.join(projectRoot, 'generated', 'draft');
  await mkdir(outDir, { recursive: true });
  const rawPath = path.join(outDir, 'n8n-update-raw-response.json');
  await writeFile(rawPath, JSON.stringify({ status: res.status, body, workflowId }, null, 2), 'utf8');

  return {
    ok: res.ok,
    stage: 'update',
    status: res.status,
    body,
    rawPath
  };
}
