// @ts-nocheck

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function n8nHeaders(apiKey: string) {
  return {
    'Content-Type': 'application/json',
    'X-N8N-API-KEY': apiKey
  };
}

export async function resolveN8nApiBasePath(baseUrl: string, apiKey: string): Promise<{ basePath: '/api/v1' | '/rest'; probe: any[] }> {
  const probe: any[] = [];
  const candidates: Array<'/api/v1' | '/rest'> = ['/api/v1', '/rest'];

  for (const basePath of candidates) {
    const url = `${baseUrl}${basePath}/workflows?limit=1`;
    try {
      const res = await fetch(url, { method: 'GET', headers: n8nHeaders(apiKey) });
      const text = await res.text();
      let body: any = text;
      try { body = JSON.parse(text); } catch {}
      probe.push({ basePath, url, status: res.status, ok: res.ok, body });
      if (res.ok) return { basePath, probe };
    } catch (error: any) {
      probe.push({ basePath, url, ok: false, error: String(error?.message || error) });
    }
  }

  return { basePath: '/rest', probe };
}

export async function resolveN8nApiContext() {
  const baseUrl = requiredEnv('N8N_BASE_URL');
  const apiKey = requiredEnv('N8N_API_KEY');
  const resolved = await resolveN8nApiBasePath(baseUrl, apiKey);
  return {
    baseUrl,
    apiKey,
    apiBasePath: resolved.basePath,
    headers: n8nHeaders(apiKey),
    probe: resolved.probe
  };
}
