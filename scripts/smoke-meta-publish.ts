/**
 * End-to-end Meta publish smoke test.
 *
 * Usage:
 *   npm run smoke:meta-publish -- --tenant 16 --provider instagram
 *   npm run smoke:meta-publish -- --tenant 16 --provider facebook --dry-run
 *
 * What it does:
 *   1. Resolves a recent approved creative + caption from the tenant's runtime state.
 *   2. Mints a signed public media URL using the same logic as the publish handler.
 *   3. Curls the signed URL from outside (no auth) to confirm it is publicly reachable.
 *   4. Calls the publish route via HTTP from localhost (POST to APP_BASE_URL).
 *   5. Checks the response for platform_post_id + permalink.
 *
 * In --dry-run mode: steps 1-3 run; the actual publish call (step 4+) is skipped.
 *
 * Environment required at runtime:
 *   APP_BASE_URL        -- e.g. https://aries.sugarandleather.com (or http://localhost:3000)
 *   INTERNAL_API_SECRET -- must match the running server's secret
 *   DATA_ROOT           -- where runtime files live (defaults per lib/runtime-paths.ts)
 */

import path from 'node:path';
import { argv, env, exit } from 'node:process';

function parseFlags(args: string[]): {
  tenant: string | null;
  provider: 'instagram' | 'facebook';
  dryRun: boolean;
} {
  let tenant: string | null = null;
  let provider: 'instagram' | 'facebook' = 'instagram';
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--tenant' && args[i + 1]) {
      tenant = args[++i]!;
    } else if (arg === '--provider' && args[i + 1]) {
      const raw = args[++i]!.toLowerCase();
      if (raw !== 'instagram' && raw !== 'facebook') {
        fatal(`--provider must be instagram or facebook, got: ${raw}`);
      }
      provider = raw as 'instagram' | 'facebook';
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }

  return { tenant, provider, dryRun };
}

function log(label: string, value?: unknown): void {
  if (value === undefined) {
    console.log(`[smoke] ${label}`);
  } else {
    console.log(`[smoke] ${label}`, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
}

function pass(msg: string): void {
  console.log(`[PASS] ${msg}`);
}

function fail(msg: string): void {
  console.error(`[FAIL] ${msg}`);
}

function fatal(msg: string): never {
  console.error(`[FATAL] ${msg}`);
  exit(1);
}

// ---------------------------------------------------------------------------
// Payload builder helpers - pure logic, exported for unit testing
// ---------------------------------------------------------------------------

export function buildPublishRouteUrl(
  appBase: string,
  jobId: string,
  provider: 'instagram' | 'facebook',
): string {
  const cleanBase = appBase.replace(/\/$/, '');
  return `${cleanBase}/api/marketing/jobs/${encodeURIComponent(jobId)}/publish-${provider}`;
}

export function buildSignedPublicUrl(args: {
  mediaUrl: string;
  tenantId: string;
  appBase: string;
  secret: string;
  ttlMs?: number;
}): string {
  const { createHmac } = require('node:crypto') as typeof import('node:crypto');

  function urlSafeB64Encode(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const basename = path.basename(args.mediaUrl);
  const ttlMs = args.ttlMs ?? 3_600_000;
  const expiresAt = Date.now() + ttlMs;
  const message = `${args.tenantId}|${basename}|${expiresAt}`;
  const signature = createHmac('sha256', args.secret).update(message).digest();
  const envelope = JSON.stringify({
    tenantId: args.tenantId,
    basename,
    expiresAt,
    sig: urlSafeB64Encode(signature),
  });
  const token = urlSafeB64Encode(Buffer.from(envelope, 'utf8'));
  const cleanBase = args.appBase.replace(/\/$/, '');
  return `${cleanBase}/api/public/media/${encodeURIComponent(token)}/${encodeURIComponent(basename)}`;
}

export function pickBestCaption(
  socialCopy: { posts: Array<{ channel: string; caption: string; hashtags: string[] }> } | null,
  provider: 'instagram' | 'facebook',
): string {
  if (!socialCopy) return '';
  const channelKey = provider === 'instagram' ? 'instagram_feed' : 'facebook_feed';
  const post = socialCopy.posts.find((p) => p.channel === channelKey);
  if (!post) return '';
  const hashtags = post.hashtags.length > 0 ? `\n\n${post.hashtags.join(' ')}` : '';
  return `${post.caption}${hashtags}`;
}

// ---------------------------------------------------------------------------
// Runtime state resolution (uses same libs as the publish handler)
// ---------------------------------------------------------------------------

async function resolveJobAndCreative(
  tenantId: string,
  provider: 'instagram' | 'facebook',
): Promise<{ jobId: string; mediaUrl: string; caption: string } | null> {
  const { listSocialContentJobIdsForTenant, loadSocialContentJobRuntime } = await import(
    '../backend/marketing/runtime-state'
  );
  const { buildSocialContentWorkspaceView } = await import('../backend/marketing/workspace-views');
  const { loadSocialCopyArtifact } = await import('../backend/social-content/social-copy-store');

  const jobIds = await listSocialContentJobIdsForTenant(tenantId);
  if (jobIds.length === 0) {
    return null;
  }

  for (const jobId of jobIds) {
    const doc = await loadSocialContentJobRuntime(jobId);
    if (!doc || doc.tenant_id !== tenantId) continue;

    const publishStage = doc.stages?.['publish'];
    if (!publishStage) continue;

    let mediaUrl: string | null = null;
    try {
      const view = await buildSocialContentWorkspaceView(jobId);
      const approvedImages = (view.creativeReview?.assets ?? []).filter(
        (a) =>
          a.status === 'approved' &&
          (a.contentType?.startsWith('image/') || a.contentType === null),
      );
      for (const asset of approvedImages) {
        const url = asset.fullPreviewUrl || asset.previewUrl;
        if (url) {
          mediaUrl = url;
          break;
        }
      }
    } catch {
      continue;
    }

    if (!mediaUrl) continue;

    let caption = '';
    try {
      const socialCopy = await loadSocialCopyArtifact(jobId);
      caption = pickBestCaption(socialCopy, provider);
    } catch {
      // Non-fatal: empty caption proceeds; Instagram needs media anyway
    }

    return { jobId, mediaUrl, caption };
  }

  return null;
}

async function probeSignedUrl(signedUrl: string): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const resp = await fetch(signedUrl, {
      method: 'HEAD',
      headers: { 'user-agent': 'aries-smoke-meta-publish/1.0' },
    });
    return { ok: resp.ok, status: resp.status };
  } catch (error) {
    return { ok: false, status: 0, error: String((error as Error).message || error) };
  }
}

async function callPublishRoute(args: {
  routeUrl: string;
  caption: string;
  internalApiSecret?: string;
}): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'aries-smoke-meta-publish/1.0',
  };
  if (args.internalApiSecret) {
    headers['x-internal-api-secret'] = args.internalApiSecret;
  }

  let body: Record<string, unknown> = {};
  try {
    const resp = await fetch(args.routeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ caption: args.caption }),
    });
    try {
      body = (await resp.json()) as Record<string, unknown>;
    } catch {
      body = { _raw: 'non-json body' };
    }
    return { httpStatus: resp.status, body };
  } catch (error) {
    return {
      httpStatus: 0,
      body: { error: String((error as Error).message || error) },
    };
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(argv.slice(2));

  if (!flags.tenant) {
    fatal('--tenant <id> is required. Example: npm run smoke:meta-publish -- --tenant 16 --provider instagram');
  }

  const tenantId = flags.tenant;
  const provider = flags.provider;
  const dryRun = flags.dryRun;

  const appBase =
    (env.APP_BASE_URL || env.NEXTAUTH_URL || env.AUTH_URL || '').replace(/\/$/, '') ||
    'http://localhost:3000';
  const secret = env.INTERNAL_API_SECRET || '';

  log(`tenant=${tenantId} provider=${provider} dryRun=${dryRun}`);
  log(`appBase=${appBase}`);

  if (!secret) {
    log('WARN: INTERNAL_API_SECRET is not set -- signed URL generation will fall back to internal URL');
  }

  log('Step 1: resolving approved creative from runtime state...');
  const creative = await resolveJobAndCreative(tenantId, provider);
  if (!creative) {
    fail(`No approved creative found for tenant ${tenantId} with a publish stage. Run a full marketing campaign first.`);
    exit(1);
  }
  pass(`Found jobId=${creative.jobId} mediaUrl=${creative.mediaUrl}`);
  log('caption (first 120 chars)', creative.caption.slice(0, 120) || '(empty)');

  log('Step 2: minting signed public media URL...');
  let signedPublicUrl: string;
  if (secret && appBase) {
    signedPublicUrl = buildSignedPublicUrl({
      mediaUrl: creative.mediaUrl,
      tenantId,
      appBase,
      secret,
    });
    pass(`Signed URL minted: ${signedPublicUrl.slice(0, 100)}...`);
  } else {
    signedPublicUrl = creative.mediaUrl;
    log('WARN: using raw internal URL (no INTERNAL_API_SECRET set)');
  }

  log('Step 3: probing signed URL reachability (HEAD request, no auth)...');
  const probe = await probeSignedUrl(signedPublicUrl);
  if (probe.ok) {
    pass(`Signed URL is publicly reachable (HTTP ${probe.status})`);
  } else {
    fail(`Signed URL probe failed: HTTP ${probe.status}${probe.error ? ` -- ${probe.error}` : ''}`);
    log('NOTE: This may be expected in local dev if the server is not running at APP_BASE_URL.');
    if (dryRun) {
      log('Continuing in --dry-run mode despite probe failure.');
    } else {
      log('Re-run with --dry-run to skip the publish call and just validate payload shape.');
      exit(1);
    }
  }

  const routeUrl = buildPublishRouteUrl(appBase, creative.jobId, provider);
  log(`Publish route URL: ${routeUrl}`);

  if (dryRun) {
    pass('--dry-run: payload validated. Skipping actual Meta Graph publish call.');
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          tenantId,
          provider,
          jobId: creative.jobId,
          mediaUrl: creative.mediaUrl,
          signedPublicUrl,
          publishRouteUrl: routeUrl,
          caption: creative.caption.slice(0, 200),
        },
        null,
        2,
      ),
    );
    exit(0);
  }

  log('Step 4: calling publish route...');
  const result = await callPublishRoute({
    routeUrl,
    caption: creative.caption,
    internalApiSecret: secret || undefined,
  });

  log(`Publish route HTTP status: ${result.httpStatus}`);
  log('Publish route response:', result.body);

  if (result.httpStatus === 200 && typeof result.body.platform_post_id === 'string') {
    pass(`Published! platform_post_id=${result.body.platform_post_id}`);
    if (typeof result.body.permalink === 'string') {
      pass(`permalink=${result.body.permalink}`);
    }
    console.log(JSON.stringify({ status: 'PASS', ...result.body }, null, 2));
    exit(0);
  }

  if (result.httpStatus === 401 || result.httpStatus === 403) {
    fail(
      `Auth required (HTTP ${result.httpStatus}). The publish route needs a valid operator session. ` +
        `Use --dry-run to validate payload shape only, or run the test from a logged-in session.`,
    );
    console.log(JSON.stringify({ status: 'AUTH_REQUIRED', httpStatus: result.httpStatus, body: result.body }, null, 2));
    exit(1);
  }

  fail(`Publish route returned HTTP ${result.httpStatus}`);
  console.log(JSON.stringify({ status: 'FAIL', httpStatus: result.httpStatus, body: result.body }, null, 2));
  exit(1);
}

// Only run main when executed directly, not when imported by the test suite
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('smoke-meta-publish.ts') || process.argv[1].endsWith('smoke-meta-publish.js'));
if (isMain) {
  void main();
}
