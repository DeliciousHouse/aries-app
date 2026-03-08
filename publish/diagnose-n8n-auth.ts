// @ts-nocheck
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const baseUrl = process.env.N8N_BASE_URL || null;
  const apiKey = process.env.N8N_API_KEY || '';
  const outDir = path.join(projectRoot, 'generated', 'draft');
  await mkdir(outDir, { recursive: true });

  const publishDir = path.join(projectRoot, 'publish');
  const files = (await readdir(publishDir)).filter((f) => f.endsWith('.ts') || f.endsWith('.json'));

  let headerExact = true;
  let hasAuthorizationBearer = false;
  let usesRestPath = false;

  for (const f of files) {
    if (f === 'diagnose-n8n-auth.ts') continue;
    const raw = await readFile(path.join(publishDir, f), 'utf8');
    if (raw.includes('Authorization: `Bearer') || raw.includes('Authorization\'') || raw.includes('Authorization"') || raw.includes('Authorization')) {
      hasAuthorizationBearer = true;
    }
    if (raw.includes('/rest/workflows')) usesRestPath = true;
  }

  const n8nApiRaw = await readFile(path.join(publishDir, 'n8n-api.ts'), 'utf8').catch(() => '');
  headerExact = n8nApiRaw.includes("'X-N8N-API-KEY': apiKey") && !hasAuthorizationBearer;

  const probes: any[] = [];
  async function probe(apiPath: string) {
    if (!baseUrl || !apiKey) return { apiPath, skipped: true };
    const url = `${baseUrl}${apiPath}/workflows?limit=1`;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-N8N-API-KEY': apiKey
        }
      });
      const text = await res.text();
      let body: any = text;
      try { body = JSON.parse(text); } catch {}
      return { apiPath, url, status: res.status, ok: res.ok, body: typeof body === 'string' ? body.slice(0, 300) : body };
    } catch (error: any) {
      return { apiPath, url, ok: false, error: String(error?.message || error) };
    }
  }

  probes.push(await probe('/rest'));
  probes.push(await probe('/api/v1'));

  const rest = probes.find((p) => p.apiPath === '/rest');
  const apiV1 = probes.find((p) => p.apiPath === '/api/v1');

  let rootCause = 'unknown';
  if (!baseUrl || !apiKey) {
    rootCause = 'missing_env';
  } else if (apiV1?.ok && rest && rest.status === 401) {
    rootCause = 'wrong_endpoint_path_previously_used_rest_instead_of_api_v1';
  } else if (apiV1 && apiV1.status === 401) {
    rootCause = 'bad_key_or_key_not_valid_for_instance';
  } else if (apiV1 && apiV1.status === 404) {
    rootCause = 'wrong_base_url_or_api_path';
  }

  const diagnosis = {
    timestamp: new Date().toISOString(),
    env: {
      N8N_BASE_URL: baseUrl,
      hasN8NApiKey: Boolean(apiKey),
      n8nApiKeyLength: apiKey.length
    },
    publishSubsystem: {
      headerUsesXN8NApiKeyExactly: headerExact,
      hasAuthorizationBearerHeader: hasAuthorizationBearer,
      usesRestWorkflowPathAnywhere: usesRestPath
    },
    endpointCheck: {
      preflightEndpointCorrectForLocalInstance: Boolean(apiV1?.ok),
      requestUrlCorrectForLocalInstance: Boolean(apiV1?.ok),
      probes
    },
    rootCause
  };

  await writeFile(path.join(outDir, 'n8n-auth-diagnosis.json'), JSON.stringify(diagnosis, null, 2) + '\n', 'utf8');
  await writeFile(
    path.join(outDir, 'n8n-auth-phase-log.md'),
    `# n8n auth diagnosis phase log\n\n- env base url present: ${Boolean(baseUrl)}\n- env api key present: ${Boolean(apiKey)}\n- api key length: ${apiKey.length}\n- header exact X-N8N-API-KEY: ${headerExact}\n- preflight /rest status: ${rest?.status ?? 'n/a'}\n- preflight /api/v1 status: ${apiV1?.status ?? 'n/a'}\n- root cause: ${rootCause}\n`,
    'utf8'
  );

  console.log(JSON.stringify(diagnosis, null, 2));
}

main().catch(async (error) => {
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const outDir = path.join(projectRoot, 'generated', 'draft');
  await mkdir(outDir, { recursive: true });
  const fail = {
    timestamp: new Date().toISOString(),
    rootCause: 'diagnosis_failed',
    message: String(error?.message || error)
  };
  await writeFile(path.join(outDir, 'n8n-auth-diagnosis.json'), JSON.stringify(fail, null, 2) + '\n', 'utf8');
  await writeFile(path.join(outDir, 'n8n-auth-phase-log.md'), `# n8n auth diagnosis phase log\n\n- failed: ${fail.message}\n`, 'utf8');
  process.stderr.write(String(error?.stack || error) + '\n');
  process.exit(1);
});
