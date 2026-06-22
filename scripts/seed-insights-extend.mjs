#!/usr/bin/env node
/**
 * seed-insights-extend.mjs
 *
 * Runs AFTER `npm run db:seed-insights`. That base seeder creates the
 * "Insights Demo Brand" tenant with real source rows in:
 *   insights_accounts, insights_account_metrics_daily, insights_posts,
 *   insights_post_metrics_daily, insights_comments, insights_sync_runs
 * — which lights up Narrative, Trends, and the Conversations feed.
 *
 * This extension fills the remaining gaps so EVERY dashboard section renders
 * from real data (exactly as it would in production), by writing:
 *   - business_profiles.primary_goal           → Goal section
 *   - posts + insights_posts.aries_post_id/content_type → Activity + Top sections
 *                                                 (both filter aries_post_id IS NOT NULL)
 *   - insights_comment_classifications          → Conversation tags + lead quality,
 *                                                 Goal leads, Attention lead/question counts
 *   - scheduled_posts + posts (future, pending)  → Audience "Upcoming posts"
 *   - links the test user (test@example.com / password123) to this tenant
 *
 * NOT seeded: campaign_learning_labels (Working-with-Aries). Those rows require
 * an FK chain into prompt_recipes/generated_assets; with none present the Aries
 * section honestly shows "No Aries activity recorded this period." That is the
 * correct empty state, not a bug.
 *
 * Safe to re-run. Usage:
 *   DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass DB_NAME=aries_dev \
 *   node scripts/seed-insights-extend.mjs
 */

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     Number.parseInt(process.env.DB_PORT || '5432', 10),
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const CONTENT_TYPES = ['educational', 'lifestyle', 'testimonial', 'announcement', 'promotional', 'engagement'];

const client = await pool.connect();
try {
  await client.query('BEGIN');

  // ── 0. Resolve the demo tenant created by seed-insights.mjs ──────────────────
  const orgRes = await client.query(
    `SELECT id FROM organizations WHERE slug = 'insights-demo' LIMIT 1`,
  );
  if (orgRes.rows.length === 0) {
    throw new Error("Demo tenant not found. Run `npm run db:seed-insights` first.");
  }
  const tenantId = orgRes.rows[0].id;

  // ── 1. Business profile + primary goal (Goal section) ────────────────────────
  await client.query(
    `INSERT INTO business_profiles (tenant_id, business_name, tenant_slug, primary_goal, business_type, channels)
     VALUES ($1, 'Insights Demo Brand', 'insights-demo', 'lead_generation', 'service', ARRAY['instagram','facebook','youtube'])
     ON CONFLICT (tenant_id) DO UPDATE SET primary_goal = EXCLUDED.primary_goal,
                                           channels      = EXCLUDED.channels`,
    [tenantId],
  );

  // ── 1b. Backfill account metrics to ~190 days deep ──────────────────────────
  //    The base seed only writes ~30 days, leaving the 90-day PREVIOUS-period
  //    window (90–180 days ago) empty → the trends comparison line is flat.
  //    Backfill older days so the dashed prior line shows a real trend.
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const dateStrNDaysAgo = (n) => {
    const d = new Date();
    d.setTime(d.getTime() - n * 86400000);
    return d.toISOString().split('T')[0];
  };
  const acctRes = await client.query(
    `SELECT id, platform FROM insights_accounts WHERE tenant_id = $1`,
    [tenantId],
  );
  let backfilled = 0;
  for (const acct of acctRes.rows) {
    // Walk forward from 190d ago so followers grow over time.
    let followers = 600;
    for (let i = 190; i >= 31; i--) {
      const followersDelta = rand(3, 22);
      followers += followersDelta;
      const r = await client.query(
        `INSERT INTO insights_account_metrics_daily
           (tenant_id, account_id, platform, date,
            views, watch_time_minutes, followers, followers_delta,
            likes, comments_count, shares, raw_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (tenant_id, account_id, date) DO NOTHING`,
        [
          tenantId, acct.id, acct.platform, dateStrNDaysAgo(i),
          rand(1200, 7000), rand(2500, 18000), followers, followersDelta,
          rand(40, 260), rand(8, 70), rand(4, 45),
          JSON.stringify({ adapter: 'demo_backfill', mapping: 'v1' }),
        ],
      );
      backfilled += r.rowCount ?? 0;
    }
  }

  // ── 2. Mark every insights_post as Aries-generated (Activity + Top) ──────────
  //    Create a matching `posts` row, point aries_post_id at it, stamp content_type.
  const postsRes = await client.query(
    `SELECT id, title, caption FROM insights_posts WHERE tenant_id = $1 ORDER BY published_at DESC`,
    [tenantId],
  );

  let linked = 0;
  for (let i = 0; i < postsRes.rows.length; i++) {
    const ip = postsRes.rows[i];
    // Each insights_post gets a backing posts row (idempotent via deterministic caption marker).
    const marker = `[demo-aries-${ip.id}]`;
    const existing = await client.query(
      `SELECT id FROM posts WHERE tenant_id = $1 AND caption LIKE $2 LIMIT 1`,
      [tenantId, `${marker}%`],
    );
    let postId;
    if (existing.rows.length > 0) {
      postId = existing.rows[0].id;
    } else {
      const ins = await client.query(
        `INSERT INTO posts (tenant_id, caption, published_status, published_at)
         VALUES ($1, $2, 'published', now())
         RETURNING id`,
        [tenantId, `${marker} ${ip.title ?? 'Untitled'}`],
      );
      postId = ins.rows[0].id;
    }
    await client.query(
      `UPDATE insights_posts
         SET aries_post_id = $2,
             content_type  = $3
       WHERE id = $1`,
      [ip.id, postId, CONTENT_TYPES[i % CONTENT_TYPES.length]],
    );
    linked++;
  }

  // ── 3. Classify the seeded comments (Conversations tags, Goal leads, Attention) ─
  const commentsRes = await client.query(
    `SELECT id, body_text FROM insights_comments WHERE tenant_id = $1 ORDER BY received_at DESC`,
    [tenantId],
  );

  let classified = 0;
  for (let i = 0; i < commentsRes.rows.length; i++) {
    const c    = commentsRes.rows[i];
    const text = (c.body_text || '').toLowerCase();

    // Heuristic-ish but deterministic classification.
    const isLead   = /coach|work with you|\bdm\b|1:1|hire|pricing|quote|services/.test(text) || i % 7 === 0;
    const isQuestion = text.includes('?');
    let sentiment = 'positive';
    if (i % 10 === 4) sentiment = 'neutral';
    if (i % 10 === 9) sentiment = 'negative';

    const category = isLead ? 'other'
      : isQuestion ? 'question'
      : sentiment === 'positive' ? 'compliment'
      : 'other';

    await client.query(
      `INSERT INTO insights_comment_classifications
         (comment_id, tenant_id, sentiment, is_lead, category, classifier_version, cost_cents)
       VALUES ($1, $2, $3, $4, $5, 'demo-v1', 0)
       ON CONFLICT (comment_id) DO UPDATE
         SET sentiment = EXCLUDED.sentiment,
             is_lead   = EXCLUDED.is_lead,
             category  = EXCLUDED.category`,
      [c.id, tenantId, sentiment, isLead, category],
    );
    classified++;
  }

  // ── 4. Upcoming scheduled posts (Audience "Upcoming posts") ──────────────────
  const SCHED = [
    { caption: 'Weekend inspiration: 5 ways to refresh your brand palette', inDays: 1, platforms: ['instagram'], surface: 'feed' },
    { caption: 'Behind the scenes — our next product photoshoot',           inDays: 2, platforms: ['facebook'],  surface: 'story' },
    { caption: 'Quick reel: 30-second brand audit you can do today',         inDays: 4, platforms: ['instagram'], surface: 'reel' },
    { caption: 'Customer spotlight: how Atelier North tripled their reach',  inDays: 6, platforms: ['facebook','instagram'], surface: 'feed' },
  ];

  let scheduled = 0;
  for (const s of SCHED) {
    const marker = `[demo-sched-${s.inDays}]`;
    const existing = await client.query(
      `SELECT id FROM posts WHERE tenant_id = $1 AND caption LIKE $2 LIMIT 1`,
      [tenantId, `${marker}%`],
    );
    let postId;
    if (existing.rows.length > 0) {
      postId = existing.rows[0].id;
    } else {
      const ins = await client.query(
        `INSERT INTO posts (tenant_id, caption, published_status, scheduled_at)
         VALUES ($1, $2, 'scheduled', now() + ($3 || ' days')::interval)
         RETURNING id`,
        [tenantId, `${marker} ${s.caption}`, String(s.inDays)],
      );
      postId = ins.rows[0].id;
    }
    await client.query(
      `INSERT INTO scheduled_posts (post_id, tenant_id, scheduled_for, target_platforms, surface, dispatch_status)
       VALUES ($1, $2, now() + ($3 || ' days')::interval, $4, $5, 'pending')
       ON CONFLICT (post_id) DO UPDATE
         SET scheduled_for    = EXCLUDED.scheduled_for,
             target_platforms = EXCLUDED.target_platforms,
             surface          = EXCLUDED.surface,
             dispatch_status  = 'pending'`,
      [postId, tenantId, String(s.inDays), s.platforms, s.surface],
    );
    scheduled++;
  }

  // ── 5. Link the test user to this tenant ─────────────────────────────────────
  // auth.ts uses bcrypt.compare and rejects any hash not starting with "$2".
  const passwordHash = bcrypt.hashSync('password123', 10);
  const userRes = await client.query(
    `INSERT INTO users (email, password_hash, full_name, organization_id, role)
     VALUES ('test@example.com', $1, 'Test User', $2, 'tenant_admin')
     ON CONFLICT (email) DO UPDATE SET organization_id = $2, role = 'tenant_admin', password_hash = $1
     RETURNING id`,
    [passwordHash, tenantId],
  );

  await client.query('COMMIT');

  console.log(JSON.stringify({
    status: 'ok',
    tenantId,
    userId: userRes.rows[0].id,
    seeded: {
      accountMetricsBackfilled: backfilled,
      primaryGoal:        'lead_generation',
      ariesPostsLinked:   linked,
      commentsClassified: classified,
      scheduledPosts:     scheduled,
    },
    login: { email: 'test@example.com', password: 'password123' },
    note: 'Working-with-Aries shows its empty state until campaign_learning_labels exist (heavy FK chain — intentionally not seeded).',
  }, null, 2));

} catch (err) {
  await client.query('ROLLBACK');
  console.error('Extension seed failed — rolled back.', err);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
