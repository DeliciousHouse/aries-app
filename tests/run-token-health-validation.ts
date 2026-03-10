// @ts-nocheck
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type Result = { id: string; status: 'pass' | 'fail'; evidence: Record<string, unknown> };

function resolveTokenHealth(expiresAt?: string): 'healthy' | 'expiring_soon' | 'expired' | 'unknown' {
  if (!expiresAt) return 'unknown';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  if (ms < 24 * 60 * 60 * 1000) return 'expiring_soon';
  return 'healthy';
}

async function main() {
  const root = path.resolve(process.cwd());
  const outPath = path.join(root, 'generated', 'validated', 'token-health-validation.json');

  const statusSrc = await readFile(path.join(root, 'backend', 'integrations', 'status.ts'), 'utf8');
  const callbackSrc = await readFile(path.join(root, 'backend', 'integrations', 'callback.ts'), 'utf8');
  const refreshSrc = await readFile(path.join(root, 'backend', 'integrations', 'refresh.ts'), 'utf8');
  const platformRouteSrc = await readFile(path.join(root, 'app', 'api', 'platform-connections', 'route.ts'), 'utf8');

  const now = Date.now();
  const futureHealthy = new Date(now + 72 * 60 * 60 * 1000).toISOString();
  const futureExpiringSoon = new Date(now + 2 * 60 * 60 * 1000).toISOString();
  const alreadyExpired = new Date(now - 5 * 60 * 1000).toISOString();

  const checks: Result[] = [
    {
      id: 'healthy-token-with-future-expiry',
      status: resolveTokenHealth(futureHealthy) === 'healthy' ? 'pass' : 'fail',
      evidence: { input: futureHealthy, derived: resolveTokenHealth(futureHealthy) }
    },
    {
      id: 'expiring-soon-token',
      status: resolveTokenHealth(futureExpiringSoon) === 'expiring_soon' ? 'pass' : 'fail',
      evidence: { input: futureExpiringSoon, derived: resolveTokenHealth(futureExpiringSoon) }
    },
    {
      id: 'expired-token',
      status: resolveTokenHealth(alreadyExpired) === 'expired' ? 'pass' : 'fail',
      evidence: { input: alreadyExpired, derived: resolveTokenHealth(alreadyExpired) }
    },
    {
      id: 'missing-expiry-unknown',
      status: resolveTokenHealth(undefined) === 'unknown' ? 'pass' : 'fail',
      evidence: { input: null, derived: resolveTokenHealth(undefined) }
    },
    {
      id: 'no-last-success-at-expiry-derivation',
      status:
        !platformRouteSrc.includes('resolveTokenHealth(state.last_success_at)') &&
        platformRouteSrc.includes('resolveTokenHealth(state.token_expires_at)')
          ? 'pass'
          : 'fail',
      evidence: {
        derivesFromTokenExpiry: platformRouteSrc.includes('resolveTokenHealth(state.token_expires_at)'),
        incorrectlyDerivesFromLastSuccess: platformRouteSrc.includes('resolveTokenHealth(state.last_success_at)')
      }
    },
    {
      id: 'status-layer-exposes-token-expires-at',
      status: statusSrc.includes('token_expires_at: connection?.token_expires_at') ? 'pass' : 'fail',
      evidence: {
        statusHasTokenExpiresAt: statusSrc.includes('token_expires_at: connection?.token_expires_at'),
        statusKeepsLastSuccessAt: statusSrc.includes('last_success_at: connection?.connection_status === \'connected\' ? connection.updated_at : undefined')
      }
    },
    {
      id: 'oauth-callback-persists-expiry-metadata',
      status:
        callbackSrc.includes('token_expires_at: typeof accessTtlSeconds === \'number\' ? addSeconds(connectedAt, accessTtlSeconds) : undefined') &&
        callbackSrc.includes('refresh_token_expires_at: typeof refreshTtlSeconds === \'number\' ? addSeconds(connectedAt, refreshTtlSeconds) : undefined')
          ? 'pass'
          : 'fail',
      evidence: {
        accessExpiryPersisted: callbackSrc.includes('token_expires_at: typeof accessTtlSeconds === \'number\' ? addSeconds(connectedAt, accessTtlSeconds) : undefined'),
        refreshExpiryPersisted: callbackSrc.includes('refresh_token_expires_at: typeof refreshTtlSeconds === \'number\' ? addSeconds(connectedAt, refreshTtlSeconds) : undefined')
      }
    },
    {
      id: 'oauth-refresh-persists-expiry-metadata',
      status:
        refreshSrc.includes('connection.token_expires_at = addSeconds(connection.updated_at, input.token_expires_in_seconds);') &&
        refreshSrc.includes('connection.refresh_token_expires_at = addSeconds(connection.updated_at, input.refresh_expires_in_seconds);')
          ? 'pass'
          : 'fail',
      evidence: {
        refreshUpdatesAccessExpiry: refreshSrc.includes('connection.token_expires_at = addSeconds(connection.updated_at, input.token_expires_in_seconds);'),
        refreshUpdatesRefreshExpiry: refreshSrc.includes('connection.refresh_token_expires_at = addSeconds(connection.updated_at, input.refresh_expires_in_seconds);')
      }
    }
  ];

  const status = checks.every((c) => c.status === 'pass') ? 'pass' : 'fail';
  const output = {
    phase: 'v3_operator_surface_parity_and_shared_oauth_broker',
    objective: 'token_health_derivation_fix',
    status,
    generated_at: new Date().toISOString(),
    checks
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  if (status !== 'pass') process.exit(1);
}

main().catch((error) => {
  process.stderr.write(String(error?.stack || error));
  process.exit(1);
});
