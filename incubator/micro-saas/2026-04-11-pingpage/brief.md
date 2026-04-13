# PingPage - Product Brief

## One-liner

A dead-simple, self-hostable status page with built-in uptime monitoring. Deploy in 60 seconds, zero config.

## Problem

Every SaaS, API, and developer tool needs a public status page. Current options are either:
- **Expensive and manual** (Statuspage.io at $79-399/mo, no monitoring)
- **Cheap but still manual** (Instatus at $15/mo, no monitoring)
- **Free but complex** (Uptime Kuma — Docker, database, config overhead)

The result: most small teams either skip status pages entirely or set one up and forget to update it during incidents.

## Solution

PingPage is a single Node.js application that:
1. Monitors your endpoints via HTTP checks on a configurable interval
2. Stores results in a local SQLite database
3. Serves a beautiful, auto-updating public status page
4. Requires only a JSON config file to get started

No manual updates. No separate monitoring tool. No complex setup.

## Target Customer

- Solo founders and small dev teams (1-10 people)
- Running SaaS products, APIs, or developer tools
- Currently either: paying too much for Statuspage.io, using nothing, or manually updating a status page
- Values simplicity and self-hosting

## Key Features (MVP)

1. **HTTP endpoint monitoring** — configurable check interval, timeout, expected status codes
2. **Public status page** — clean, responsive UI showing current status + 90-day history
3. **Uptime percentage** — calculated from actual check results
4. **Response time tracking** — latency visualization per endpoint
5. **JSON config** — single file to define all monitors
6. **Zero dependencies beyond Node.js** — SQLite embedded, no external database needed

## What's NOT in MVP

- Alerting (email/Slack/webhook notifications)
- Custom domains
- Team management / auth
- Scheduled maintenance windows
- API for programmatic status updates
- Incident narratives / postmortems

## Monetization Model (future)

| Tier | Price | Features |
|------|-------|----------|
| Self-hosted | Free | Full feature set, you host it |
| Hosted | $9/mo | We host it, custom subdomain |
| Pro | $29/mo | Custom domain, SSL, priority checks, Slack alerts |

## Success Metrics

- Can be demoed in under 2 minutes
- Deploys with `npx pingpage` or `docker run`
- First status page visible within 60 seconds of starting
- Handles 50+ monitors on a single $5/mo VPS

## Competitive Positioning

"Uptime Kuma's simplicity, Statuspage.io's polish, at zero cost."
