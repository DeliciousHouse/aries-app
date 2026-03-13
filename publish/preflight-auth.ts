// @ts-nocheck
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureFailurePayload } from './capture-failure-payload';
import { resolveN8nApiContext } from './n8n-api';
import { resolveDataPath } from '../lib/runtime-paths';

export async function preflightAuthCheck(stage: 'create' | 'update' | 'activate' | 'unknown' = 'unknown') {
  const ctx = await resolveN8nApiContext();
  const baseUrl = ctx.baseUrl;
  const outDir = resolveDataPath('generated', 'draft');
  await mkdir(outDir, { recursive: true });

  const preflightUrl = `${baseUrl}${ctx.apiBasePath}/workflows?limit=1`;
  const res = await fetch(preflightUrl, {
    method: 'GET',
    headers: ctx.headers
  });

  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}

  const result = {
    timestamp: new Date().toISOString(),
    stage,
    baseUrl,
    apiBasePath: ctx.apiBasePath,
    hasApiKey: Boolean(ctx.apiKey),
    status: res.status,
    ok: res.ok,
    authHeader: 'X-N8N-API-KEY',
    preflightUrl
  } as any;

  if (!res.ok) {
    result.failure = captureFailurePayload({
      stage,
      httpStatus: res.status,
      responseBody: body
    });
    result.failure.retryable = false;
    result.failure.reason = 'preflight-auth-failed';
  }

  await writeFile(
    path.join(outDir, 'n8n-auth-diagnosis.json'),
    JSON.stringify({ ...result, probe: ctx.probe, rawResponse: { status: res.status, body } }, null, 2),
    'utf8'
  );

  return result;
}
