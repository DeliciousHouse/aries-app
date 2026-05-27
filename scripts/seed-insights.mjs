#!/usr/bin/env node
/**
 * seed-insights.mjs
 *
 * Populates the insights_* tables with realistic fake data for local development.
 * Safe to re-run — every insert uses ON CONFLICT DO NOTHING / DO UPDATE.
 *
 * Creates:
 *   - 1 fake tenant ("Insights Demo Brand")
 *   - 1 fake YouTube insights account
 *   - 30 days of account-level daily metrics
 *   - 15 posts (mix of videos and shorts) published over the last 90 days
 *   - Per-post daily metrics for each post (from publish date up to today)
 *   - 50 comments spread across the 8 most recent posts
 *   - 1 completed backfill sync run record
 *
 * Usage:
 *   DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass DB_NAME=aries_dev \
 *   node scripts/seed-insights.mjs
 *
 *   Or add to package.json: "db:seed-insights": "node scripts/seed-insights.mjs"
 */

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number.parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Random integer between min and max (inclusive). */
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Returns a Date N days before now. Accepts fractional days. */
function daysAgo(n) {
  const d = new Date();
  d.setTime(d.getTime() - n * 24 * 60 * 60 * 1000);
  return d;
}

/** Returns a YYYY-MM-DD string for a Date. */
function dateStr(d) {
  return d.toISOString().split('T')[0];
}

// ── Seed data definitions ─────────────────────────────────────────────────────

const POST_DEFS = [
  { title: 'How We Built Our Brand from Scratch',           daysAgo: 88, type: 'video', duration: 720  },
  { title: '5 Mistakes New Brands Make on Social',          daysAgo: 75, type: 'video', duration: 540  },
  { title: 'Behind the Scenes: Our First Photoshoot',       daysAgo: 67, type: 'video', duration: 480  },
  { title: 'Quick Tip: Nail Your Brand Colors in 30s',      daysAgo: 60, type: 'short', duration: 45   },
  { title: 'Our Q1 Campaign Results — Full Breakdown',      daysAgo: 52, type: 'video', duration: 660  },
  { title: 'How to Write Copy That Actually Converts',      daysAgo: 44, type: 'video', duration: 510  },
  { title: '30-Second Brand Audit',                         daysAgo: 39, type: 'short', duration: 30   },
  { title: 'The Content Strategy That Tripled Our Reach',   daysAgo: 33, type: 'video', duration: 780  },
  { title: 'Common Brand Voice Mistakes',                   daysAgo: 27, type: 'video', duration: 420  },
  { title: 'How We Create a Month of Content in One Day',   daysAgo: 22, type: 'video', duration: 900  },
  { title: 'Quick Win: Repurpose Your Best Post',           daysAgo: 18, type: 'short', duration: 55   },
  { title: 'Mid-Year Brand Refresh — What We Changed',      daysAgo: 14, type: 'video', duration: 600  },
  { title: 'Audience Q&A: Answering Your Top Questions',    daysAgo: 10, type: 'video', duration: 840  },
  { title: 'One Tip for Better Engagement Today',           daysAgo:  6, type: 'short', duration: 40   },
  { title: 'Our Most Requested Tutorial: Brand Fonts',      daysAgo:  2, type: 'video', duration: 480  },
];

const COMMENT_BODIES = [
  "This is exactly what I needed to hear! Thank you so much 🙌",
  "Great content as always. Can you do a deep dive on brand voice next?",
  "I've been following you for months and this is your best video yet.",
  "Do you offer any 1:1 coaching? I'd love to work with you.",
  "The part about color psychology blew my mind.",
  "Sharing this with my whole team right now.",
  "How long did it take you to build your brand strategy?",
  "This helped me so much. Just redesigned my entire Instagram feed.",
  "Subscribed! Been looking for content like this forever.",
  "Could you make a video specifically about B2B brands?",
  "The editing on this is 🔥 Who does your editing?",
  "I tried this and got 40% more engagement in one week!",
  "What software do you use for your design work?",
  "Not sure I agree with the font advice but the rest is solid.",
  "Please do a part 2!!",
  "This is way better than any course I've paid for.",
  "The brand audit idea is genius. Doing mine this weekend.",
  "Love the energy in this video, super motivating.",
  "Do you have a newsletter? I want more of this.",
  "Saved this to watch again. So much value.",
  "Question: does this apply to product brands or just services?",
  "Been stuck on my brand for 6 months. This unstuck me.",
  "The before/after examples were really helpful.",
  "Would love to see you react to bad brand examples 😂",
  "Came for the title, stayed for the whole thing.",
  "Just started my brand journey and this is gold.",
  "The way you explain things makes it so easy to understand.",
  "Bookmarked and shared. Thank you!",
  "This content is free?? Should be a paid course.",
  "Hit the bell icon so I never miss a video 🔔",
  "Can you talk about rebranding a business that's been around for years?",
  "Your thumbnail game is also amazing btw.",
  "I have a small local business — does this still apply?",
  "The competitor analysis section was eye-opening.",
  "Just found this channel. Already binge-watched 5 videos.",
  "Would you ever consider doing a brand audit of viewer businesses?",
  "This is why I still watch YouTube in 2025.",
  "The stats you shared are really eye opening. Where do you source those?",
  "Working on my pitch deck and this was the perspective I needed.",
  "Genuinely useful. Not just vague advice.",
  "Can I DM you? I have a specific question about my brand.",
  "Your consistency is inspiring. Keep going!",
  "Applied this to my Etsy shop and sales went up 20%.",
  "The music choice in this video is 👌",
  "I wish I had this video 3 years ago.",
  "Just shared this in our startup Slack. Everyone loved it.",
  "Watched on 1.5x speed but still caught everything — you're clear!",
  "The comment section here is so positive, love this community.",
  "New here from a friend's recommendation. Instantly subscribed.",
  "Always learn something new from your videos. Keep it up!",
];

// ── Main ──────────────────────────────────────────────────────────────────────

const client = await pool.connect();
try {
  await client.query('BEGIN');

  // 1. Upsert the seed tenant org
  const orgResult = await client.query(
    `INSERT INTO organizations (name, slug)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    ['Insights Demo Brand', 'insights-demo'],
  );
  const tenantId = orgResult.rows[0].id;

  // 2. Upsert the fake YouTube insights account
  const accountResult = await client.query(
    `INSERT INTO insights_accounts
       (tenant_id, platform, external_account_id, display_name,
        connected_at, last_sync_at, backfill_completed_at)
     VALUES ($1, 'youtube', 'UC_insights_demo_001', 'Insights Demo Channel', $2, $3, $3)
     ON CONFLICT (tenant_id, platform, external_account_id)
       DO UPDATE SET display_name = EXCLUDED.display_name,
                     last_sync_at = EXCLUDED.last_sync_at,
                     backfill_completed_at = EXCLUDED.backfill_completed_at
     RETURNING id`,
    [tenantId, daysAgo(30), daysAgo(0)],
  );
  const accountId = accountResult.rows[0].id;

  // 3. Account-level daily metrics — 30 days
  let followers = 2000;
  for (let i = 29; i >= 0; i--) {
    const date = dateStr(daysAgo(i));
    const followersDelta = rand(3, 25);
    followers += followersDelta;
    await client.query(
      `INSERT INTO insights_account_metrics_daily
         (tenant_id, account_id, platform, date,
          views, watch_time_minutes, followers, followers_delta,
          likes, comments_count, shares, raw_source)
       VALUES ($1, $2, 'youtube', $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, account_id, date) DO NOTHING`,
      [
        tenantId, accountId, date,
        rand(1500, 8000),
        rand(3000, 20000),
        followers,
        followersDelta,
        rand(50, 300),
        rand(10, 80),
        rand(5, 50),
        JSON.stringify({ adapter: 'youtube_analytics_v2', mapping: 'v1' }),
      ],
    );
  }

  // 4. Posts
  const insertedPosts = [];
  for (const def of POST_DEFS) {
    const publishedAt = daysAgo(def.daysAgo);
    const result = await client.query(
      `INSERT INTO insights_posts
         (tenant_id, account_id, platform, external_post_id,
          published_at, media_type, title, caption, permalink,
          duration_seconds, last_metrics_fetched_at)
       VALUES ($1, $2, 'youtube', $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, platform, external_post_id)
         DO UPDATE SET title = EXCLUDED.title,
                       last_metrics_fetched_at = EXCLUDED.last_metrics_fetched_at
       RETURNING id`,
      [
        tenantId, accountId,
        `yt_demo_${def.daysAgo}_${def.type}`,
        publishedAt,
        def.type,
        def.title,
        `${def.title} — Check out the full breakdown on our website.`,
        `https://youtube.com/watch?v=demo_${def.daysAgo}`,
        def.duration,
        daysAgo(0),
      ],
    );
    insertedPosts.push({ id: result.rows[0].id, daysAgo: def.daysAgo, type: def.type });
  }

  // 5. Per-post daily metrics
  //    Views decay after the first few days — simulates real YouTube traffic patterns.
  for (const post of insertedPosts) {
    const isShort = post.type === 'short';
    // Shorts get higher raw view counts; videos get longer watch time
    const baseViews = isShort ? rand(5000, 40000) : rand(800, 15000);
    const liveDays = Math.min(post.daysAgo, 30);

    for (let i = liveDays - 1; i >= 0; i--) {
      const date = dateStr(daysAgo(i));
      const daysSincePublish = post.daysAgo - i;
      // Traffic is highest in days 1-3, then decays with sqrt curve
      const decayFactor = daysSincePublish <= 3
        ? 1.0
        : Math.max(0.05, 1 / Math.sqrt(daysSincePublish));
      const views = Math.max(1, Math.round(baseViews * decayFactor * (0.6 + Math.random() * 0.8)));

      await client.query(
        `INSERT INTO insights_post_metrics_daily
           (tenant_id, post_id, platform, date,
            views, watch_time_minutes, avg_view_duration_sec, avg_view_percentage,
            likes, comments_count, shares, raw_source)
         VALUES ($1, $2, 'youtube', $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, post_id, date) DO NOTHING`,
        [
          tenantId, post.id, date,
          views,
          Math.round(views * rand(2, 6)),
          isShort ? rand(15, 45)  : rand(60, 300),
          isShort ? rand(40, 85)  : rand(20, 65),
          Math.max(0, Math.round(views * 0.04 * Math.random())),
          Math.max(0, Math.round(views * 0.006 * Math.random())),
          Math.max(0, Math.round(views * 0.01 * Math.random())),
          JSON.stringify({ adapter: 'youtube_analytics_v2', mapping: 'v1' }),
        ],
      );
    }
  }

  // 6. Comments — 50 comments spread across the 8 most recent posts
  const recentPosts = insertedPosts.slice(-8);
  for (let i = 0; i < COMMENT_BODIES.length; i++) {
    const post = recentPosts[i % recentPosts.length];
    const receivedAt = daysAgo(rand(0, Math.min(post.daysAgo, 20)));
    await client.query(
      `INSERT INTO insights_comments
         (tenant_id, post_id, platform, external_comment_id,
          received_at, author_handle, body_text)
       VALUES ($1, $2, 'youtube', $3, $4, $5, $6)
       ON CONFLICT (tenant_id, platform, external_comment_id) DO NOTHING`,
      [
        tenantId, post.id,
        `yt_comment_demo_${i}`,
        receivedAt,
        `demo_user_${rand(1, 300)}`,
        COMMENT_BODIES[i],
      ],
    );
  }

  // 7. One completed backfill sync run record
  const syncStarted = daysAgo(0.004); // ~6 minutes ago
  const syncFinished = daysAgo(0.001); // ~1.5 minutes ago
  await client.query(
    `INSERT INTO insights_sync_runs
       (tenant_id, account_id, platform, trigger,
        started_at, finished_at, status,
        posts_seen, comments_seen, api_units_used)
     VALUES ($1, $2, 'youtube', 'backfill', $3, $4, 'ok', $5, $6, 150)`,
    [tenantId, accountId, syncStarted, syncFinished, POST_DEFS.length, COMMENT_BODIES.length],
  );

  await client.query('COMMIT');

  console.log(JSON.stringify({
    status: 'ok',
    tenantId,
    accountId,
    seeded: {
      accountMetricsDays: 30,
      posts: insertedPosts.length,
      comments: COMMENT_BODIES.length,
      syncRuns: 1,
    },
  }, null, 2));

} catch (err) {
  await client.query('ROLLBACK');
  console.error('Seed failed — rolled back.', err);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
