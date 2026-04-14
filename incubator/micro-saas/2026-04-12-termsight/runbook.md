# TermSight — Runbook

## Quick Start

```bash
cd incubator/micro-saas/2026-04-12-termsight/prototype

# Install dependencies
npm install

# Seed demo data (optional — creates 3 policies with realistic changes)
node seed-demo.mjs

# Start server
node server.mjs
# → TermSight running at http://localhost:3847
```

Open http://localhost:3847 in a browser.

## What You'll See

### Dashboard (Policies tab)
- List of monitored policies with status badges (No Changes / Changes Detected / Not Checked)
- Stats bar showing total monitored, changes detected, and last checked counts
- Per-policy actions: Check Now, Paste Text, View Changes, Remove

### Changes tab
- All detected changes across policies, newest first
- Risk category tags (AI/ML Training, Data Sharing, Liability, Pricing, etc.)
- AI-generated plain-language summary of what changed
- Expandable diff view showing exact text changes (green = added, red = removed)

## Demo Walkthrough

1. **Start with seeded data**: Run `node seed-demo.mjs` then `node server.mjs`
2. **View dashboard**: See 3 policies — OpenAI and Stripe show "Changes Detected"
3. **Click "Changes" tab**: See the AI summaries and risk flags
4. **Click "Show Diff"**: See exact text changes highlighted
5. **Add a new policy**: Click "+ Add Policy", enter any URL
6. **Paste text**: Use "Paste Text" to manually add policy snapshots
7. **Detect changes**: Paste a modified version — see change detection in action

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/policies | List all monitored policies |
| POST | /api/policies | Add a policy (body: `{name, url, check_frequency}`) |
| DELETE | /api/policies/:id | Remove a policy |
| POST | /api/policies/:id/check | Fetch URL and check for changes |
| POST | /api/policies/:id/paste | Submit policy text manually |
| GET | /api/policies/:id/snapshots | List snapshots for a policy |
| GET | /api/policies/:id/changes | List changes for a policy |
| GET | /api/changes | List all changes across policies |
| GET | /api/changes/:id/diff | Get full diff details for a change |
| POST | /api/check-all | Check all policies for changes |

## Configuration

- `PORT` env var: Change server port (default: 3847)
- Data is stored in `termsight-data.json` in the prototype directory

## Known Limitations (Prototype)

- **AI summaries are rule-based**, not LLM-powered (would need API key for production)
- **No email notifications** (would need SMTP or email API integration)
- **No authentication** (add auth middleware for production)
- **No scheduled checks** (would add node-cron or external scheduler)
- **Some sites block scraping** — use "Paste Text" as fallback
- **JSON file storage** — would migrate to PostgreSQL or SQLite for production

## Production Roadmap

1. Integrate Claude/GPT API for real AI change summaries
2. Add user authentication (magic link or OAuth)
3. Add email/Slack notifications via webhooks
4. Scheduled automatic checking with node-cron
5. Puppeteer/Playwright for JavaScript-rendered policy pages
6. PostgreSQL for production storage
7. Multi-tenant support
8. Stripe billing integration
