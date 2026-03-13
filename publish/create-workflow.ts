// @ts-nocheck
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preflightAuthCheck } from './preflight-auth';
import { resolveN8nApiContext } from './n8n-api';
import { resolveCodePath, resolveDataPath } from '../lib/runtime-paths';

export interface ApiResult {
  ok: boolean;
  stage: 'create';
  status: number;
  body: any;
  rawPath: string;
}

function sanitizeWorkflowForCreate(workflow: any) {
  return {
    name: workflow?.name,
    nodes: workflow?.nodes,
    connections: workflow?.connections,
    settings: workflow?.settings || {}
  };
}

export async function createWorkflow(workflowFile: string): Promise<ApiResult> {
  const ctx = await resolveN8nApiContext();
  const baseUrl = ctx.baseUrl;

  const preflight = await preflightAuthCheck('create');
  if (!preflight.ok) {
    const rawPath = resolveDataPath('generated', 'draft', 'n8n-create-raw-response.json');
    await mkdir(path.dirname(rawPath), { recursive: true });
    await writeFile(rawPath, JSON.stringify({ status: preflight.status, body: preflight.failure || { message: 'Preflight auth failed' } }, null, 2), 'utf8');
    return {
      ok: false,
      stage: 'create',
      status: preflight.status,
      body: preflight.failure || { message: 'Preflight auth failed' },
      rawPath
    };
  }

  const workflowPath = resolveCodePath('n8n', workflowFile);
  const rawWorkflow = await readFile(workflowPath, 'utf8');
  const workflow = JSON.parse(rawWorkflow);

  const createPayload = sanitizeWorkflowForCreate(workflow);

  const res = await fetch(`${baseUrl}${ctx.apiBasePath}/workflows`, {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify(createPayload)
  });

  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}

  const outDir = resolveDataPath('generated', 'draft');
  await mkdir(outDir, { recursive: true });
  const rawPath = path.join(outDir, 'n8n-create-raw-response.json');
  await writeFile(rawPath, JSON.stringify({ status: res.status, body }, null, 2), 'utf8');

  return {
    ok: res.ok,
    stage: 'create',
    status: res.status,
    body,
    rawPath
  };
}
