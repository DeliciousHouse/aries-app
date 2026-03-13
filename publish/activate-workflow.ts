// @ts-nocheck
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preflightAuthCheck } from './preflight-auth';
import { resolveN8nApiContext } from './n8n-api';
import { resolveDataPath } from '../lib/runtime-paths';

export interface ApiResult {
  ok: boolean;
  stage: 'activate';
  status: number;
  body: any;
  rawPath: string;
}

export async function activateWorkflow(workflowId: string): Promise<ApiResult> {
  const ctx = await resolveN8nApiContext();
  const baseUrl = ctx.baseUrl;

  const preflight = await preflightAuthCheck('activate');
  if (!preflight.ok) {
    const rawPath = resolveDataPath('generated', 'draft', 'n8n-activate-raw-response.json');
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

  const res = await fetch(`${baseUrl}${ctx.apiBasePath}/workflows/${encodeURIComponent(workflowId)}/activate`, {
    method: 'POST',
    headers: ctx.headers
  });

  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}

  const outDir = resolveDataPath('generated', 'draft');
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
