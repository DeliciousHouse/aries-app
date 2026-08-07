const disabledValues = new Set(['0', 'false', 'no', 'off']);
const timeoutMs = 2_000;

function enabledUnlessDisabled(value) {
  const normalized = value?.trim().toLowerCase();
  return !normalized || !disabledValues.has(normalized);
}

async function requireHealthy(label, url, headers = {}) {
  let response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`${label} healthcheck failed: ${String(error?.message || error)}`);
  }

  if (!response.ok) {
    throw new Error(`${label} healthcheck failed: HTTP ${response.status}`);
  }
  await response.body?.cancel();
}

try {
  const appUrl = process.env.ARIES_APP_HEALTHCHECK_URL
    || `http://127.0.0.1:${process.env.PORT?.trim() || '3000'}/`;
  await requireHealthy('Aries', appUrl);

  if (enabledUnlessDisabled(process.env.ARIES_HERMES_NETWORK_HEALTHCHECK_ENABLED)) {
    const gatewayUrl = process.env.HERMES_GATEWAY_URL?.trim();
    if (!gatewayUrl) {
      throw new Error('Hermes healthcheck failed: HERMES_GATEWAY_URL is required');
    }

    const gateways = new Map();
    const defaultApiKey = process.env.HERMES_API_SERVER_KEY?.trim();
    for (const [stage, urlEnvName, keyEnvName] of [
      ['default', 'HERMES_GATEWAY_URL', 'HERMES_API_SERVER_KEY'],
      ['research', 'HERMES_RESEARCH_GATEWAY_URL', 'HERMES_RESEARCH_API_SERVER_KEY'],
      ['strategist', 'HERMES_STRATEGIST_GATEWAY_URL', 'HERMES_STRATEGIST_API_SERVER_KEY'],
      ['content', 'HERMES_CONTENT_GATEWAY_URL', 'HERMES_CONTENT_API_SERVER_KEY'],
    ]) {
      const url = (process.env[urlEnvName]?.trim() || gatewayUrl).replace(/\/+$/, '');
      const gateway = gateways.get(url);
      if (gateway) {
        gateway.stages.push(stage);
      } else {
        gateways.set(url, {
          stages: [stage],
          apiKey: process.env[keyEnvName]?.trim() || defaultApiKey,
        });
      }
    }

    for (const [url, { stages, apiKey }] of gateways) {
      await requireHealthy(
        `Hermes ${stages.join('/')} gateway`,
        new URL('health', `${url}/`),
        apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      );
    }
  }

  console.log('[healthcheck] ok');
} catch (error) {
  console.error(`[healthcheck] ${String(error?.message || error)}`);
  process.exitCode = 1;
}
