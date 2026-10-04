/** Synthetic component verifier, never a production replacement phase probe. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export function validateFixtureConfig(env: Record<string, string | undefined>): void {
  assert.match(env.DB_NAME ?? '', /^aries_release_fixture_[a-f0-9]{16}$/);
  assert.ok(env.DB_USER && env.DB_HOST?.startsWith('/'), 'explicit fixture Unix socket required');
  assert.ok(env.DOTENV_CONFIG_PATH?.startsWith('/'), 'disable implicit dotenv before importing workers');
  assert.match(env.ARIES_RELEASE_FIXTURE_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.match(env.ARIES_RELEASE_FIXTURE_DIGEST ?? '', /^sha256:[a-f0-9]{64}$/);
}

export function assertNoDefaultRoute(ipv4: string, ipv6: string): void {
  assert.ok(!ipv4.split('\n').some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[1] === '00000000' && (Number.parseInt(fields[3], 16) & 1) !== 0;
  }), 'IPv4 egress must be disabled');
  assert.ok(!ipv6.split('\n').some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[0] === '0'.repeat(32) && fields[1] === '00'
      && (Number.parseInt(fields[8], 16) & 1) !== 0;
  }), 'IPv6 egress must be disabled');
}

const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

async function schemaFingerprint(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query(`
    SELECT kind, name, definition FROM (
      SELECT 'column' AS kind, c.relname || '.' || a.attname AS name,
        concat_ws('|', format_type(a.atttypid, a.atttypmod), a.attnotnull,
          pg_get_expr(d.adbin, d.adrelid), a.attidentity, a.attgenerated) AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public'
      UNION ALL SELECT 'constraint', conrelid::regclass::text || '.' || conname,
        pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
      UNION ALL SELECT 'index', indexname, indexdef FROM pg_indexes WHERE schemaname='public'
      UNION ALL SELECT 'relation', c.relname, concat_ws('|', c.relkind, c.relowner, c.relacl)
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      UNION ALL SELECT 'trigger', tgrelid::regclass::text || '.' || tgname, pg_get_triggerdef(oid)
        FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
    ) definitions ORDER BY kind, name, definition`);
  return hash(JSON.stringify(rows));
}

export async function verifyWorkerFixture(): Promise<Record<string, unknown>> {
  validateFixtureConfig(process.env);
  assert.equal(process.platform, 'linux', 'isolated Linux network namespace required');
  await assert.rejects(readFile(process.env.DOTENV_CONFIG_PATH!),
    (error: unknown) => (error as { code?: string }).code === 'ENOENT', 'dotenv path must not exist');
  assertNoDefaultRoute(await readFile('/proc/net/route', 'utf8'), await readFile('/proc/net/ipv6_route', 'utf8'));
  const namespace = await readlink('/proc/self/ns/net');
  const pool = new pg.Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER, database: process.env.DB_NAME, max: 4,
    options: '-c search_path=public -c statement_timeout=10000', connectionTimeoutMillis: 5000 });
  let server: ReturnType<typeof createServer> | undefined;
  const previous = { APP_BASE_URL: process.env.APP_BASE_URL, INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET };
  const startedAt = new Date().toISOString();
  try {
    // Dora must create this schema-only companion from the isolated restored schema,
    // with NO rows/secrets/assets. The marker is not a substitute for host isolation.
    const identity = await pool.query(`SELECT current_database() AS name,
      shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname=current_database()`);
    assert.equal(identity.rows[0]?.name, process.env.DB_NAME);
    assert.equal(identity.rows[0]?.marker, 'aries synthetic release fixture v1');
    const tables = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
    for (const { tablename } of tables.rows) {
      const count = await pool.query(`SELECT count(*)::int AS n FROM public."${String(tablename).replaceAll('"', '""')}"`);
      assert.equal(count.rows[0].n, 0, 'fixture must start empty');
    }
    assert.ok((await pool.query("SELECT to_regclass('public.marketing_weekly_claims') AS claims")).rows[0].claims,
      'missing claims table is a schema boundary; verifier must not repair it');
    const before = await schemaFingerprint(pool);
    const tenant = Number((await pool.query("INSERT INTO organizations(name, slug) VALUES ('Synthetic release fixture', 'release-fixture') RETURNING id")).rows[0].id);
    const requests = { scheduled: 0, metrics: 0, weekly: 0 };
    const secret = randomBytes(32).toString('hex');
    let metricsFail = false;
    // Explicit local protocol sinks, NOT production provider/Hermes adapters.
    server = createServer(async (req, res) => {
      const reply = (body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      try {
        if (req.headers.authorization !== `Bearer ${secret}`) return reply({ error: 'invalid_internal_auth' }, 401);
        if (req.url === '/metrics') {
          requests.metrics++;
          return metricsFail ? reply({ error: 'fixture_failure' }, 503) : reply([{
            date: new Date().toISOString().slice(0, 10), views: 23, watchTimeMinutes: 0,
            followers: 17, followersDelta: 1, likes: 3, commentsCount: 2, shares: 1, reach: 11, rawSource: {},
          }]);
        }
        if (req.url === '/api/internal/publishing/scheduled-dispatch' && req.method === 'GET') return reply({ status: 'ready' });
        let text = '';
        for await (const chunk of req) { text += chunk; assert.ok(text.length < 8192); }
        const body = JSON.parse(text);
        if (req.url === '/api/internal/publishing/scheduled-dispatch' && req.method === 'POST') {
          assert.equal(body.tenant_id, String(tenant));
          assert.ok(body.dispatch_attempt_token);
          requests.scheduled++;
          return reply({ results: [{ provider: 'facebook', ok: true, platformPostId: 'fixture-published' }] });
        }
        if (req.url === '/hermes-submit' && req.method === 'POST') {
          assert.equal(body.tenantId, String(tenant));
          assert.equal(body.jobType, 'weekly_social_content');
          requests.weekly++;
          return reply({ status: 'accepted', jobId: 'fixture-weekly' }, 202);
        }
        return reply({ error: 'unexpected_fixture_request' }, 404);
      } catch { reply({ error: 'fixture_assertion_failed' }, 500); }
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.APP_BASE_URL = base;
    process.env.INTERNAL_API_SECRET = secret;
    const request = async (route: string, body?: unknown) => {
      const res = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      assert.ok(res.ok, 'local sink refused request');
      return res.json();
    };
    const scheduled = await import(pathToFileURL(path.resolve('scripts/automations/scheduled-posts-worker.mjs')).href);
    await scheduled.runWorkerReadinessCheck(pool);
    const post = Number((await pool.query("INSERT INTO posts(tenant_id,caption,published_status) VALUES($1,'Synthetic fixture','approved') RETURNING id", [tenant])).rows[0].id);
    const schedule = Number((await pool.query("INSERT INTO scheduled_posts(post_id,tenant_id,scheduled_for,target_platforms) VALUES($1,$2,now()-interval '1 minute',ARRAY['facebook']) RETURNING id", [post, tenant])).rows[0].id);
    const first = await scheduled.tick(pool);
    assert.equal(first.dispatched, 1);
    assert.equal(first.failed, 0);
    await scheduled.tick(pool);
    assert.equal(requests.scheduled, 1, 'terminal dispatch must not replay');
    const child = (await pool.query('SELECT status, attempts FROM scheduled_post_dispatches WHERE scheduled_post_id=$1', [schedule])).rows;
    assert.equal(child.length, 1);
    assert.equal(child[0].status, 'dispatched');
    assert.equal(child[0].attempts, 1);
    assert.equal((await pool.query('SELECT published_status FROM posts WHERE id=$1', [post])).rows[0].published_status, 'published');
    // Lost outcome after the provider fence: quarantine, never automatic replay.
    await pool.query("UPDATE scheduled_posts SET dispatch_status='in_flight',dispatch_claimed_at=now()-interval '2 hours',dispatch_started_at=now()-interval '2 hours' WHERE id=$1", [schedule]);
    await pool.query("UPDATE scheduled_post_dispatches SET status='pending',platform_post_id=NULL WHERE scheduled_post_id=$1", [schedule]);
    await scheduled.tick(pool);
    assert.equal((await pool.query('SELECT dispatch_status FROM scheduled_posts WHERE id=$1', [schedule])).rows[0].dispatch_status, 'manual_reconciliation');
    assert.equal(requests.scheduled, 1);

    const { ensureInsightsAccountsForConnectedPlatforms } = await import('../../backend/insights/sync/ensure-account');
    const { syncAccountForTenant } = await import('../../backend/insights/sync/dispatcher');
    const { tickSafe } = await import('../automations/insights-sync-worker');
    await pool.query(`INSERT INTO connected_accounts(tenant_id,external_user_id,platform,provider,connected_account_id,external_account_id,status)
      VALUES($1,'fixture-user','facebook','composio','fixture-connection','fixture-page','connected')`, [tenant]);
    const bridge = await ensureInsightsAccountsForConnectedPlatforms(pool, {
      NODE_ENV: 'development', ANALYTICS_PROVIDER: 'composio', COMPOSIO_ENABLED: 'true',
    }, { config: null });
    assert.equal(bridge.upserted, 1);
    const account = Number((await pool.query('SELECT id FROM insights_accounts WHERE tenant_id=$1', [tenant])).rows[0].id);
    const sync = () => syncAccountForTenant(tenant, account, 'interval', { pool,
      resolveAdapter: () => ({ platform: 'facebook', fetchPostList: async () => [],
        fetchAccountMetrics: async () => request('/metrics'), fetchPostMetrics: async () => [], fetchComments: async () => [] }) });
    let outcome = await sync();
    assert.equal(outcome.status, 'ok');
    assert.equal(Number((await pool.query('SELECT followers FROM insights_account_metrics_daily WHERE account_id=$1', [account])).rows[0].followers), 17);
    metricsFail = true;
    outcome = await sync();
    assert.equal(outcome.status, 'partial');
    assert.equal((await pool.query('SELECT status FROM insights_sync_runs WHERE id=$1', [outcome.syncRunId])).rows[0].status, 'partial');
    const stranded = Number((await pool.query(`INSERT INTO insights_sync_runs(tenant_id,account_id,platform,trigger,status,started_at)
      VALUES($1,$2,'facebook','interval','running',now()-interval '2 hours') RETURNING id`, [tenant, account])).rows[0].id);
    metricsFail = false;
    await tickSafe(pool, async (id) => { assert.equal(id, tenant); return [await sync()]; });
    assert.equal((await pool.query('SELECT status FROM insights_sync_runs WHERE id=$1', [stranded])).rows[0].status, 'failed');
    assert.equal((await pool.query('SELECT status FROM insights_sync_runs ORDER BY id DESC LIMIT 1')).rows[0].status, 'ok');
    assert.equal(requests.metrics, 3);

    const weekly = await import('../automations/weekly-job-trigger-worker');
    const { triggerWeeklyJobForTenant } = await import('../../backend/marketing/weekly-trigger');
    await weekly.ensureClaimsTable(pool);
    const now = new Date();
    await pool.query("INSERT INTO marketing_schedule(tenant_id,day_of_week,hour,timezone,enabled) VALUES($1,$2,0,'UTC',true)", [tenant, now.getUTCDay()]);
    let jobId: string | null = null;
    const trigger = () => triggerWeeklyJobForTenant(String(tenant), {
      loadPayloadDefaults: async () => ({ websiteUrl: 'https://fixture.invalid', businessType: 'fixture' }),
      findRecentJobId: async () => jobId,
      startJob: async (input) => { const accepted = await request('/hermes-submit', input); jobId = accepted.jobId;
        return { status: 'accepted', jobId: accepted.jobId } as Awaited<ReturnType<NonNullable<import('../../backend/marketing/weekly-trigger').WeeklyTriggerDeps['startJob']>>>; },
    });
    const fetchTrigger: typeof fetch = async (url, init) => {
      assert.equal(String(url), `${base}/api/internal/marketing/weekly-trigger`);
      assert.equal(JSON.parse(String(init?.body)).tenant_id, String(tenant));
      return new Response(JSON.stringify(await trigger()), { status: 200 });
    };
    const tick = await weekly.tick(pool, { now, fetchImpl: fetchTrigger });
    assert.equal(tick.claimed, 1); assert.equal(tick.started, 1); assert.equal(tick.failed, 0);
    assert.equal((await weekly.tick(pool, { now, fetchImpl: fetchTrigger })).claimed, 0);
    assert.equal((await trigger()).status, 'started');
    assert.equal(requests.weekly, 1, 'worker slot and helper dedup must prevent duplicate submission');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM marketing_weekly_claims')).rows[0].n, 0);
    const after = await schemaFingerprint(pool);
    assert.equal(after, before, 'schema changed: not compatible image-only');
    return { status: 'synthetic_components_passed', deployed: false, rolloutAccepted: false,
      suppliedSourceSha: process.env.ARIES_RELEASE_FIXTURE_SHA, suppliedImageDigest: process.env.ARIES_RELEASE_FIXTURE_DIGEST,
      imageIdentityVerified: false,
      verifierSha256: hash(await readFile(path.resolve('scripts/release/verify-worker-fixture.ts'))),
      namespace, startedAt, finishedAt: new Date().toISOString(), schemaBefore: before, schemaAfter: after,
      scheduled: { dispatched: 1, duplicateRequests: 0, ambiguous: 'manual_reconciliation' },
      insights: { bridged: 1, persistedFollowers: 17, success: 'ok', error: 'partial', stranded: 'failed' },
      weekly: { claimed: 1, submissions: 1, duplicateClaims: 0, markers: 0 },
      excluded: ['real app HTTP routes/auth', 'real provider adapters', 'real Hermes execution port/callbacks',
        'restored private rows/assets', 'standing worker startup', 'host containment/reconciliation', 'production acceptance'] };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await pool.end();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const timeout = setTimeout(() => { console.error('worker_fixture_timeout'); process.exit(1); }, 120_000);
  verifyWorkerFixture().then((receipt) => console.log(JSON.stringify(receipt)))
    .catch((error: unknown) => {
      // Do not emit driver values, request bodies, credentials or private rows.
      const failure = error as { code?: string; stack?: string };
      console.error('worker_fixture_failed', failure.code ?? 'assertion',
        failure.stack?.split('\n').filter((line) => /^\s+at .*verify-worker-fixture/.test(line)).join('\n'));
      process.exitCode = 1;
    })
    .finally(() => clearTimeout(timeout));
}
