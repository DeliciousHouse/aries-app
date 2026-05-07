#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import bcrypt from 'bcryptjs';
import pg from 'pg';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_DIR = path.join(REPO_ROOT, '.sisyphus', 'evidence');
const FINAL_QA_DIR = path.join(EVIDENCE_DIR, 'final-qa');
const SMOKE_GREEN_FILE = path.join(EVIDENCE_DIR, 'task-28-smoke-green.txt');

export const STEP_LABELS = Object.freeze([
  '1. signup new test tenant',
  '2. submit business profile via /api/onboarding',
  '3. connect Meta using test app token',
  '4. trigger /api/social-content/jobs',
  '5. poll runtime state until plan_review',
  '6. auto-approve plan',
  '7. wait for creative_review',
  '8. auto-approve creatives',
  '9. wait for publish_review',
  '10. auto-approve publish',
  '11. wait for completed',
  '12. assert posts.platform_post_id captured',
  '13. Graph API GET round-trip 200',
  '14. dashboard image rendering (naturalWidth > 0)',
]);

export const REQUIRED_ENV = Object.freeze([
  'APP_BASE_URL',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'META_TEST_PAGE_ID',
  'META_TEST_PAGE_ACCESS_TOKEN',
  'OAUTH_TOKEN_ENCRYPTION_KEY',
]);

const PLAN_POLL_TIMEOUT_MS = 60_000;
const REVIEW_POLL_TIMEOUT_MS = 60_000;
const COMPLETE_POLL_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_500;
const HTTP_TIMEOUT_MS = 15_000;
const PLAYWRIGHT_NAV_TIMEOUT_MS = 30_000;
const META_GRAPH_API_DEFAULT_VERSION = 'v21.0';

export class SmokeError extends Error {
  constructor(step, message, cause) {
    super(`[step ${step}] ${message}`);
    this.name = 'SmokeError';
    this.step = step;
    if (cause !== undefined) this.cause = cause;
  }
}

export function parseArgs(argv) {
  const args = { tenant: null, website: null, autoApprove: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--auto-approve') {
      args.autoApprove = true;
      continue;
    }
    if (token === '--tenant') {
      args.tenant = argv[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith('--tenant=')) {
      args.tenant = token.slice('--tenant='.length);
      continue;
    }
    if (token === '--website') {
      args.website = argv[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith('--website=')) {
      args.website = token.slice('--website='.length);
      continue;
    }
  }
  return args;
}

export function validateArgs(args) {
  const missing = [];
  if (!args.tenant || typeof args.tenant !== 'string' || args.tenant.trim() === '') {
    missing.push('--tenant <id>');
  }
  if (!args.website || typeof args.website !== 'string' || args.website.trim() === '') {
    missing.push('--website <url>');
  } else {
    try {
      new URL(args.website);
    } catch {
      missing.push('--website <url> (must be a valid URL)');
    }
  }
  if (!args.autoApprove) {
    missing.push('--auto-approve');
  }
  return missing;
}

export function validateEnv(env) {
  const missing = [];
  for (const key of REQUIRED_ENV) {
    const value = env[key];
    if (typeof value !== 'string' || value.trim() === '') {
      missing.push(key);
    }
  }
  return missing;
}

export function buildUsageText() {
  return [
    'Usage:',
    '  tsx scripts/smoke-weekly-pipeline.mjs --tenant <id> --website <url> --auto-approve',
    '',
    'Required arguments:',
    '  --tenant <id>           Test tenant slug (e.g. smoke_1715000000)',
    '  --website <url>         Brand website URL (https://...)',
    '  --auto-approve          Auto-approve every review checkpoint',
    '',
    'Required environment (from .env.test or shell):',
    `  ${REQUIRED_ENV.join(', ')}`,
    '',
    'Steps:',
    ...STEP_LABELS.map((label) => `  ${label}`),
    '',
    'Exits 0 only when every step asserts green. No skip flags. No soft-fail.',
  ].join('\n');
}

export const EVIDENCE_PATHS = Object.freeze({
  evidenceDir: EVIDENCE_DIR,
  finalQaDir: FINAL_QA_DIR,
  smokeGreenFile: SMOKE_GREEN_FILE,
});

function nowMs() {
  return performance.now();
}

function logPass(stepIndex, detail) {
  const label = STEP_LABELS[stepIndex - 1] ?? `step ${stepIndex}`;
  process.stdout.write(`PASS ${label}${detail ? ` — ${detail}` : ''}\n`);
}

function logFail(stepIndex, message) {
  const label = STEP_LABELS[stepIndex - 1] ?? `step ${stepIndex}`;
  process.stderr.write(`FAIL ${label} — ${message}\n`);
}

function ensureFetch() {
  if (typeof globalThis.fetch !== 'function') {
    throw new SmokeError(0, 'global fetch is required (Node 18+)');
  }
  return globalThis.fetch;
}

export function buildHttp(baseUrl) {
  const fetchImpl = ensureFetch();
  const cookieJar = new Map();

  function splitSetCookieHeader(header) {
    const entries = [];
    let start = 0;
    for (let index = 0; index < header.length; index += 1) {
      if (header[index] !== ',') continue;
      const nextCookiePair = /^\s*[^=;,\s]+=/.test(header.slice(index + 1));
      if (!nextCookiePair) continue;
      entries.push(header.slice(start, index).trim());
      start = index + 1;
    }
    entries.push(header.slice(start).trim());
    return entries.filter(Boolean);
  }

  function getSetCookieHeaders(headers) {
    if (typeof headers.getSetCookie === 'function') {
      return headers.getSetCookie();
    }
    const raw = headers.get('set-cookie');
    return raw ? splitSetCookieHeader(raw) : [];
  }

  function setCookiesFromResponse(response) {
    const raw = getSetCookieHeaders(response.headers);
    for (const entry of raw) {
      const semi = entry.indexOf(';');
      const pair = (semi >= 0 ? entry.slice(0, semi) : entry).trim();
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      if (value === '' || value === 'deleted') {
        cookieJar.delete(name);
      } else {
        cookieJar.set(name, value);
      }
    }
  }

  function cookieHeader() {
    if (cookieJar.size === 0) return undefined;
    return Array.from(cookieJar.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  async function request(stepIndex, method, pathOrUrl, init = {}) {
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : new URL(pathOrUrl, baseUrl).toString();
    const headers = new Headers(init.headers ?? {});
    const cookie = cookieHeader();
    if (cookie && !headers.has('cookie')) {
      headers.set('cookie', cookie);
    }
    if (init.body != null && !headers.has('content-type') && typeof init.body === 'string') {
      headers.set('content-type', 'application/json');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body: init.body,
        redirect: init.redirect ?? 'manual',
        signal: controller.signal,
      });
      setCookiesFromResponse(response);
      return response;
    } catch (error) {
      throw new SmokeError(
        stepIndex,
        `${method} ${url} failed: ${error?.message ?? String(error)}`,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get: (stepIndex, p, init) => request(stepIndex, 'GET', p, init),
    post: (stepIndex, p, body, init = {}) => {
      if (body == null) {
        return request(stepIndex, 'POST', p, init);
      }
      return request(stepIndex, 'POST', p, { ...init, body: JSON.stringify(body) });
    },
    cookies: cookieJar,
  };
}

export function encryptOAuthToken(plaintext, base64Key) {
  if (typeof base64Key !== 'string' || base64Key.trim() === '') {
    throw new Error('OAUTH_TOKEN_ENCRYPTION_KEY is required to encrypt test tokens.');
  }
  const trimmed = base64Key.trim();
  const key = Buffer.from(trimmed, /^[A-Za-z0-9+/=]+$/.test(trimmed) ? 'base64' : 'utf8');
  if (key.length !== 32) {
    throw new Error('OAUTH_TOKEN_ENCRYPTION_KEY must decode to 32 bytes.');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  });
}

async function ensureEvidenceDirs() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await mkdir(FINAL_QA_DIR, { recursive: true });
}

async function writeFinalQaArtifact(name, content) {
  const target = path.join(FINAL_QA_DIR, name);
  if (typeof content === 'string') {
    await writeFile(target, content, 'utf8');
  } else {
    await writeFile(target, content);
  }
  return target;
}

async function pollUntil(stepIndex, label, timeoutMs, fn) {
  const deadline = nowMs() + timeoutMs;
  let lastError = null;
  let lastValue = null;
  while (nowMs() < deadline) {
    try {
      const result = await fn();
      lastValue = result;
      if (result && result.done) {
        return result.value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const reason = lastError
    ? lastError.message
    : `last value: ${JSON.stringify(lastValue)}`;
  throw new SmokeError(
    stepIndex,
    `Timed out after ${timeoutMs}ms waiting for ${label}. ${reason}`,
  );
}

async function step1SignupTenant(db, args) {
  const stepIndex = 1;
  const slug = args.tenant.trim().toLowerCase();
  const email = `${slug}@smoke.aries.test`;
  const password = `Sm0ke-${randomBytes(8).toString('hex')}!Aa`;
  const passwordHash = await bcrypt.hash(password, 10);

  const orgInsert = await db.query(
    `INSERT INTO organizations (name, slug)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, slug`,
    [`Smoke ${slug}`, slug],
  );
  if (orgInsert.rowCount !== 1) {
    throw new SmokeError(stepIndex, `Failed to insert organization slug=${slug}`);
  }
  const tenantId = String(orgInsert.rows[0].id);

  const userInsert = await db.query(
    `INSERT INTO users (email, password_hash, full_name, organization_id, role)
     VALUES ($1, $2, $3, $4, 'tenant_admin')
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           organization_id = EXCLUDED.organization_id,
           role = EXCLUDED.role
     RETURNING id, email`,
    [email, passwordHash, `Smoke ${slug}`, Number(tenantId)],
  );
  if (userInsert.rowCount !== 1) {
    throw new SmokeError(stepIndex, `Failed to insert user email=${email}`);
  }
  const userId = String(userInsert.rows[0].id);

  logPass(stepIndex, `tenantId=${tenantId} userId=${userId}`);
  return { tenantId, userId, email, password, slug };
}

async function step2SubmitBusinessProfile(http, db, tenant, args) {
  const stepIndex = 2;
  const signupEventId = `smoke-${randomUUID()}`;
  const response = await http.post(stepIndex, '/api/onboarding/start', {
    tenant_id: tenant.tenantId,
    tenant_type: 'small_business',
    signup_event_id: signupEventId,
    metadata: {
      website_url: args.website,
      brand_name: `Smoke ${tenant.slug}`,
    },
  });
  if (response.status !== 200 && response.status !== 202) {
    const text = await response.text();
    throw new SmokeError(
      stepIndex,
      `POST /api/onboarding/start returned ${response.status}: ${text}`,
    );
  }
  await response.json();

  await db.query(
    `INSERT INTO business_profiles
       (tenant_id, business_name, tenant_slug, website_url, business_type, primary_goal, channels)
     VALUES ($1, $2, $3, $4, $5, $6, ARRAY['facebook','instagram'])
     ON CONFLICT (tenant_id) DO UPDATE
       SET business_name = EXCLUDED.business_name,
           tenant_slug = EXCLUDED.tenant_slug,
           website_url = EXCLUDED.website_url,
           business_type = EXCLUDED.business_type,
           primary_goal = EXCLUDED.primary_goal,
           channels = EXCLUDED.channels,
           updated_at = now()`,
    [
      Number(tenant.tenantId),
      `Smoke ${tenant.slug}`,
      tenant.slug,
      args.website,
      'small_business',
      'Weekly social content',
    ],
  );
  logPass(stepIndex, `signup_event_id=${signupEventId}`);
  return { signupEventId };
}

async function step3ConnectMeta(db, tenant, env) {
  const stepIndex = 3;
  const pageId = env.META_TEST_PAGE_ID.trim();
  const pageToken = env.META_TEST_PAGE_ACCESS_TOKEN.trim();

  const providers = ['facebook', 'instagram'];
  const connectionIds = {};
  for (const provider of providers) {
    const connection = await db.query(
      `INSERT INTO oauth_connections
         (tenant_id, provider, external_account_id, external_account_name,
          status, granted_scopes, connected_at, token_expires_at)
       VALUES ($1, $2, $3, $4, 'connected', $5, now(), now() + interval '60 days')
       ON CONFLICT (tenant_id, provider) DO UPDATE
         SET status = 'connected',
             external_account_id = EXCLUDED.external_account_id,
             external_account_name = EXCLUDED.external_account_name,
             granted_scopes = EXCLUDED.granted_scopes,
             token_expires_at = EXCLUDED.token_expires_at,
             connected_at = now(),
             last_error_code = NULL,
             last_error_message = NULL,
             updated_at = now()
       RETURNING id`,
      [
        Number(tenant.tenantId),
        provider,
        pageId,
        `Smoke ${tenant.slug} (${provider})`,
        ['pages_manage_posts', 'instagram_content_publish'],
      ],
    );
    if (connection.rowCount !== 1) {
      throw new SmokeError(
        stepIndex,
        `Failed to upsert oauth_connections for provider=${provider}`,
      );
    }
    connectionIds[provider] = String(connection.rows[0].id);

    const ciphertext = encryptOAuthToken(pageToken, env.OAUTH_TOKEN_ENCRYPTION_KEY);
    await db.query(
      `INSERT INTO oauth_tokens
         (connection_id, access_token_enc, token_type, scope, expires_at, issued_at)
       VALUES ($1, $2, 'page_access_token', $3, now() + interval '60 days', now())`,
      [
        Number(connectionIds[provider]),
        ciphertext,
        'pages_manage_posts instagram_content_publish',
      ],
    );
  }
  logPass(
    stepIndex,
    `connections facebook=${connectionIds.facebook} instagram=${connectionIds.instagram}`,
  );
  return { connectionIds };
}

async function authenticateSession(http, tenant) {
  const stepIndex = 4;
  const csrfResponse = await http.get(stepIndex, '/api/auth/csrf');
  if (csrfResponse.status !== 200) {
    throw new SmokeError(stepIndex, `/api/auth/csrf returned ${csrfResponse.status}`);
  }
  const csrf = await csrfResponse.json();
  const csrfToken = csrf?.csrfToken;
  if (typeof csrfToken !== 'string' || csrfToken.trim() === '') {
    throw new SmokeError(stepIndex, 'CSRF token missing from /api/auth/csrf');
  }
  const form = new URLSearchParams({
    email: tenant.email,
    password: tenant.password,
    csrfToken,
    callbackUrl: '/dashboard',
    json: 'true',
  });
  const response = await http.post(
    stepIndex,
    '/api/auth/callback/credentials',
    null,
    {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    },
  );
  if (response.status !== 200 && response.status !== 302) {
    const text = await response.text().catch(() => '');
    throw new SmokeError(
      stepIndex,
      `Credentials sign-in returned ${response.status}: ${text}`,
    );
  }
  const hasSessionCookie = Array.from(http.cookies.keys()).some((name) =>
    name.includes('session-token'),
  );
  if (!hasSessionCookie) {
    throw new SmokeError(
      stepIndex,
      'Sign-in succeeded but no NextAuth session cookie was set.',
    );
  }
}

async function step4TriggerJob(http, args) {
  const stepIndex = 4;
  const response = await http.post(stepIndex, '/api/social-content/jobs', {
    jobType: 'weekly_social_content',
    payload: {
      brandUrl: args.website,
      businessType: 'small_business',
      primaryGoal: 'Weekly social content',
      imageCreativeCount: 2,
      videoRenderCount: 0,
    },
  });
  if (response.status !== 202) {
    const text = await response.text();
    throw new SmokeError(
      stepIndex,
      `POST /api/social-content/jobs returned ${response.status}: ${text}`,
    );
  }
  const body = await response.json();
  if (!body || typeof body.jobId !== 'string') {
    throw new SmokeError(
      stepIndex,
      `social-content jobs response missing jobId: ${JSON.stringify(body)}`,
    );
  }
  logPass(stepIndex, `jobId=${body.jobId}`);
  return { jobId: body.jobId };
}

export function isAtApproval(status, approvalStep) {
  if (!status || typeof status !== 'object') return false;
  if (status.approvalRequired !== true) return false;
  const approval = status.approval;
  if (!approval || typeof approval !== 'object') return false;
  return approval.approvalStep === approvalStep || approval.step === approvalStep;
}

export function isCompleted(status) {
  if (!status || typeof status !== 'object') return false;
  const state = String(
    status.social_content_job_state ?? status.marketing_job_state ?? '',
  ).toLowerCase();
  return state === 'completed';
}

async function fetchJobStatus(stepIndex, http, jobId) {
  const response = await http.get(
    stepIndex,
    `/api/social-content/jobs/${encodeURIComponent(jobId)}`,
  );
  if (response.status !== 200) {
    const text = await response.text().catch(() => '');
    throw new SmokeError(
      stepIndex,
      `GET /api/social-content/jobs/${jobId} returned ${response.status}: ${text}`,
    );
  }
  return response.json();
}

async function waitForApproval(stepIndex, label, http, jobId, approvalStep, timeoutMs) {
  return pollUntil(stepIndex, label, timeoutMs, async () => {
    const value = await fetchJobStatus(stepIndex, http, jobId);
    if (isAtApproval(value, approvalStep)) {
      return { done: true, value };
    }
    return { done: false, value };
  });
}

async function approveStep(stepIndex, http, jobId, approvalStep, approvalId) {
  const response = await http.post(
    stepIndex,
    `/api/social-content/jobs/${encodeURIComponent(jobId)}/approve`,
    {
      approvedBy: 'smoke-script',
      approvalStep,
      approvalId: approvalId ?? undefined,
      approved: true,
    },
  );
  if (response.status !== 200 && response.status !== 202) {
    const text = await response.text().catch(() => '');
    throw new SmokeError(
      stepIndex,
      `Approve ${approvalStep} returned ${response.status}: ${text}`,
    );
  }
  return response.json();
}

async function waitForCompleted(stepIndex, http, jobId) {
  return pollUntil(stepIndex, 'job state completed', COMPLETE_POLL_TIMEOUT_MS, async () => {
    const value = await fetchJobStatus(stepIndex, http, jobId);
    if (isCompleted(value)) {
      return { done: true, value };
    }
    return { done: false, value };
  });
}

async function step12LoadPublishedPosts(db, tenant) {
  const stepIndex = 12;
  const result = await db.query(
    `SELECT id, platform_post_id, published_status
       FROM posts
      WHERE tenant_id = $1
        AND published_at IS NOT NULL
      ORDER BY published_at ASC`,
    [Number(tenant.tenantId)],
  );
  if (result.rowCount === 0) {
    throw new SmokeError(stepIndex, 'No published posts captured for tenant.');
  }
  const missing = result.rows.filter((row) => !row.platform_post_id);
  if (missing.length > 0) {
    throw new SmokeError(
      stepIndex,
      `Missing platform_post_id on ${missing.length} of ${result.rowCount} posts.`,
    );
  }
  logPass(stepIndex, `posts=${result.rowCount}`);
  return result.rows;
}

async function step13VerifyMetaPosts(rows, env) {
  const stepIndex = 13;
  const fetchImpl = ensureFetch();
  const versionRaw = (env.META_GRAPH_API_VERSION ?? META_GRAPH_API_DEFAULT_VERSION).trim();
  const version = versionRaw.startsWith('v') ? versionRaw : `v${versionRaw}`;
  const pageToken = env.META_TEST_PAGE_ACCESS_TOKEN.trim();
  const evidenceLines = [];
  for (const row of rows) {
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(row.platform_post_id)}?access_token=${encodeURIComponent(pageToken)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    } catch (error) {
      throw new SmokeError(
        stepIndex,
        `Graph API GET failed for ${row.platform_post_id}: ${error?.message ?? String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (response.status !== 200) {
      const text = await response.text().catch(() => '');
      throw new SmokeError(
        stepIndex,
        `Graph API GET ${row.platform_post_id} returned ${response.status}: ${text}`,
      );
    }
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== 'object' || !body.id) {
      throw new SmokeError(
        stepIndex,
        `Graph API GET ${row.platform_post_id} returned non-id payload`,
      );
    }
    if (String(body.id) !== String(row.platform_post_id)) {
      throw new SmokeError(
        stepIndex,
        `Graph API id mismatch: expected ${row.platform_post_id}, got ${body.id}`,
      );
    }
    evidenceLines.push(`${row.platform_post_id} 200 id=${body.id}`);
  }
  await writeFinalQaArtifact('graph-verify.txt', `${evidenceLines.join('\n')}\n`);
  logPass(stepIndex, `verified ${rows.length} posts`);
}

async function step14CheckDashboardImages(http, baseUrl, tenant) {
  const stepIndex = 14;
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (error) {
    throw new SmokeError(
      stepIndex,
      `Failed to import "playwright". Install it before running T28 (npm install --no-save playwright). Cause: ${error?.message ?? String(error)}`,
      error,
    );
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const cookieEntries = Array.from(http.cookies.entries()).map(([name, value]) => ({
      name,
      value,
      url: baseUrl,
    }));
    if (cookieEntries.length > 0) {
      await context.addCookies(cookieEntries);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(PLAYWRIGHT_NAV_TIMEOUT_MS);
    const target = new URL('/dashboard/posts', baseUrl).toString();
    const response = await page.goto(target, { waitUntil: 'networkidle' });
    if (!response || !response.ok()) {
      throw new SmokeError(
        stepIndex,
        `dashboard/posts navigation returned ${response?.status() ?? 'no response'}`,
      );
    }
    const screenshotPath = path.join(FINAL_QA_DIR, `dashboard-posts-${tenant.slug}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const imageStats = await page.$$eval('img', (nodes) =>
      nodes.map((node) => ({
        src: node.getAttribute('src') ?? '',
        naturalWidth: node.naturalWidth,
        naturalHeight: node.naturalHeight,
      })),
    );
    if (imageStats.length === 0) {
      throw new SmokeError(stepIndex, 'No <img> elements rendered on /dashboard/posts');
    }
    const broken = imageStats.filter((entry) => !(entry.naturalWidth > 0));
    if (broken.length > 0) {
      const sample = broken.slice(0, 3).map((entry) => entry.src).join(', ');
      throw new SmokeError(
        stepIndex,
        `${broken.length} of ${imageStats.length} <img> elements failed naturalWidth>0 check (sample: ${sample})`,
      );
    }
    await writeFinalQaArtifact(
      `dashboard-posts-${tenant.slug}.json`,
      JSON.stringify(
        { count: imageStats.length, sample: imageStats.slice(0, 5) },
        null,
        2,
      ),
    );
    logPass(
      stepIndex,
      `screenshot=${path.relative(REPO_ROOT, screenshotPath)} imgs=${imageStats.length}`,
    );
  } finally {
    await browser.close();
  }
}

async function defaultDbFactory(env) {
  const pool = new pg.Pool({
    host: env.DB_HOST,
    port: Number(env.DB_PORT),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    max: 4,
  });
  return pool;
}

export async function runSmoke(args, env, options = {}) {
  const argFailures = validateArgs(args);
  if (argFailures.length > 0) {
    throw new SmokeError(0, `Missing or invalid arguments: ${argFailures.join(', ')}`);
  }
  const missingEnv = validateEnv(env);
  if (missingEnv.length > 0) {
    throw new SmokeError(0, `Missing required env: ${missingEnv.join(', ')}`);
  }

  await ensureEvidenceDirs();

  const baseUrl = env.APP_BASE_URL.trim();
  const http = options.http ?? buildHttp(baseUrl);
  const dbFactory = options.dbFactory ?? defaultDbFactory;
  const db = await dbFactory(env);
  const startedAt = new Date();

  try {
    const tenant = await step1SignupTenant(db, args);
    await step2SubmitBusinessProfile(http, db, tenant, args);
    await step3ConnectMeta(db, tenant, env);
    await authenticateSession(http, tenant);
    const job = await step4TriggerJob(http, args);

    const planStatus = await waitForApproval(
      5,
      'plan_review',
      http,
      job.jobId,
      'approve_weekly_plan',
      PLAN_POLL_TIMEOUT_MS,
    );
    logPass(5, `approvalId=${planStatus.approval?.approvalId ?? 'unknown'}`);
    await approveStep(6, http, job.jobId, 'approve_weekly_plan', planStatus.approval?.approvalId);
    logPass(6);

    const creativeStatus = await waitForApproval(
      7,
      'creative_review',
      http,
      job.jobId,
      'approve_image_creatives',
      REVIEW_POLL_TIMEOUT_MS,
    );
    logPass(7, `approvalId=${creativeStatus.approval?.approvalId ?? 'unknown'}`);
    await approveStep(
      8,
      http,
      job.jobId,
      'approve_image_creatives',
      creativeStatus.approval?.approvalId,
    );
    logPass(8);

    const publishStatus = await waitForApproval(
      9,
      'publish_review',
      http,
      job.jobId,
      'approve_publish',
      REVIEW_POLL_TIMEOUT_MS,
    );
    logPass(9, `approvalId=${publishStatus.approval?.approvalId ?? 'unknown'}`);
    await approveStep(10, http, job.jobId, 'approve_publish', publishStatus.approval?.approvalId);
    logPass(10);

    await waitForCompleted(11, http, job.jobId);
    logPass(11);

    const rows = await step12LoadPublishedPosts(db, { tenantId: tenant.tenantId });
    await step13VerifyMetaPosts(rows, env);
    await step14CheckDashboardImages(http, baseUrl, tenant);

    const finishedAt = new Date();
    const summary = [
      'T28 weekly social content smoke green',
      `started_at=${startedAt.toISOString()}`,
      `finished_at=${finishedAt.toISOString()}`,
      `duration_ms=${finishedAt.getTime() - startedAt.getTime()}`,
      `tenant=${tenant.slug} tenantId=${tenant.tenantId} jobId=${job.jobId}`,
      `posts=${rows.length}`,
      ...STEP_LABELS.map((label) => `PASS ${label}`),
    ].join('\n');
    await writeFile(SMOKE_GREEN_FILE, `${summary}\n`, 'utf8');
    return { tenant, jobId: job.jobId, posts: rows };
  } finally {
    if (db && typeof db.end === 'function') {
      await db.end().catch(() => {});
    }
  }
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${buildUsageText()}\n`);
    return 0;
  }
  try {
    await runSmoke(args, process.env);
    process.stdout.write('[smoke] T28 PASSED — see .sisyphus/evidence/task-28-smoke-green.txt\n');
    return 0;
  } catch (error) {
    if (error instanceof SmokeError) {
      logFail(error.step ?? 0, error.message);
    } else {
      process.stderr.write(`[smoke] FAILED — ${error?.message ?? String(error)}\n`);
    }
    process.stderr.write(`${buildUsageText()}\n`);
    return 1;
  }
}

const isDirectInvocation =
  process.argv[1] != null &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectInvocation) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
