// @ts-nocheck
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface ApiResult {
  ok: boolean;
  stage: 'update';
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
    'X-N8N-API-KEY': apiKey,
    Authorization: `Bearer ${apiKey}`
  };
}

export async function updateWorkflow(workflowId: string, workflowFile: string): Promise<ApiResult> {
  const baseUrl = requiredEnv('N8N_BASE_URL');
  const apiKey = requiredEnv('N8N_API_KEY');
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();

  const workflowPath = path.join(projectRoot, 'n8n', workflowFile);
  const rawWorkflow = await readFile(workflowPath, 'utf8');
  const workflow = JSON.parse(rawWorkflow);

  const res = await fetch(`${baseUrl}/rest/workflows/${encodeURIComponent(workflowId)}`, {
    method: 'PATCH',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(workflow)
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
