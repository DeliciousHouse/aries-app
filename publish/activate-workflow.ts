// @ts-nocheck
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preflightAuthCheck } from './preflight-auth';

export interface ApiResult {
  ok: boolean;
  stage: 'activate';
  status: number;
  body: any;
  rawPath: string;
}

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

export async function activateWorkflow(workflowId: string): Promise<ApiResult> {
  const baseUrl = requiredEnv('N8N_BASE_URL');
  const apiKey = requiredEnv('N8N_API_KEY');
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();

  const preflight = await preflightAuthCheck('activate');
  if (!preflight.ok) {
    const rawPath = path.join(projectRoot, 'generated', 'draft', 'n8n-activate-raw-response.json');
    await mkdir(path.dirname(rawPath), { recursive: true });
    await writeFile(rawPath, JSON.stringify({ status: preflight.status, body: preflight.failure || { message: 'Preflight auth failed' }, workflowId }, null, 2), 'utf8');
    return {
      ok: false,
      stage: 'activate',
      status: preflight.status,
      body: preflight.failure || { message: 'Preflight auth failed' },
      rawPath
    };
  }

  const res = await fetch(`${baseUrl}/rest/workflows/${encodeURIComponent(workflowId)}`, {
    method: 'PATCH',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({ active: true })
  });

  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}

  const outDir = path.join(projectRoot, 'generated', 'draft');
  await mkdir(outDir, { recursive: true });
  const rawPath = path.join(outDir, 'n8n-activate-raw-response.json');
  await writeFile(rawPath, JSON.stringify({ status: res.status, body, workflowId }, null, 2), 'utf8');

  return {
    ok: res.ok,
    stage: 'activate',
    status: res.status,
    body,
    rawPath
  };
}
