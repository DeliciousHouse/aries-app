// @ts-nocheck
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureFailurePayload } from './capture-failure-payload';

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

export async function preflightAuthCheck(stage: 'create' | 'update' | 'activate' | 'unknown' = 'unknown') {
  const baseUrl = requiredEnv('N8N_BASE_URL');
  const apiKey = requiredEnv('N8N_API_KEY');
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const outDir = path.join(projectRoot, 'generated', 'draft');
  await mkdir(outDir, { recursive: true });

  const res = await fetch(`${baseUrl}/rest/workflows?limit=1`, {
    method: 'GET',
    headers: buildHeaders(apiKey)
  });

  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}

  const result = {
    timestamp: new Date().toISOString(),
    stage,
    baseUrl,
    hasApiKey: Boolean(apiKey),
    status: res.status,
    ok: res.ok,
    authHeader: 'X-N8N-API-KEY'
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
    JSON.stringify({ ...result, rawResponse: { status: res.status, body } }, null, 2),
    'utf8'
  );

  return result;
}
