# PingPage - Runbook

## Quick Start

```bash
cd incubator/micro-saas/2026-04-11-pingpage/prototype
npm install
npm start
```

Open http://localhost:3300 to see the status page.

## Configuration

Edit `pingpage.config.json` to define your monitors:

```json
{
  "title": "My Service Status",
  "description": "Current service status and uptime history",
  "checkIntervalSeconds": 60,
  "monitors": [
    {
      "name": "Website",
      "url": "https://example.com",
      "expectedStatus": 200
    }
  ]
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3300` | HTTP server port |
| `PINGPAGE_CONFIG` | `./pingpage.config.json` | Path to config file |
| `PINGPAGE_DATA` | `./pingpage-data.json` | Path to data storage file |

## Architecture

- **server.mjs** — Single-file Express app (~200 LOC)
- **pingpage.config.json** — Monitor definitions
- **pingpage-data.json** — Auto-created, stores check history (JSON)
- No database required, no native dependencies

## How It Works

1. On startup, runs HTTP HEAD checks against all configured endpoints
2. Stores results in a local JSON file (auto-pruned to 90 days)
3. Serves a public status page at `/` with auto-refresh (60s)
4. Exposes JSON API at `/api/status`
5. Repeats checks on the configured interval

## Demo

After `npm start`:
1. Visit http://localhost:3300 — see the status page with green "All Systems Operational" banner
2. Visit http://localhost:3300/api/status — see raw JSON API response
3. Modify `pingpage.config.json` to add a bad URL, restart, and see the degraded state

## What Works in This Prototype

- HTTP endpoint monitoring with configurable expected status codes
- Auto-updating public status page with clean UI
- 90-day uptime history visualization (bar chart with tooltips)
- Per-monitor uptime percentage calculation
- Response time tracking
- Overall system status banner (operational / degraded / unknown)
- JSON API for programmatic access
- Persistent storage across restarts

## Known Limitations (Prototype)

- No alerting (email/Slack/webhook)
- No authentication for admin actions
- JSON file storage won't scale past ~50 monitors at 1-min intervals
- No custom domains or SSL
- No scheduled maintenance windows
- Single-process (no clustering)
- HEAD requests only (no GET/POST body checks)

## Next Steps to Productionize

1. Add SQLite or Postgres for storage (replace JSON file)
2. Add email/Slack alerting on status changes
3. Add incident management (manual status overrides + narratives)
4. Add Docker image for easy deployment
5. Add custom domain support with Let's Encrypt
6. Build hosted tier with Stripe billing
