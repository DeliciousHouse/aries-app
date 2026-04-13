# TermSight — Product Brief

## One-liner

AI-powered monitoring for your vendors' Terms of Service and Privacy Policies. Know when they change. Understand what changed. Stay compliant.

## Problem

Every business depends on dozens of SaaS vendors, each with Terms of Service and Privacy Policies that can change at any time. When vendors update these documents:

- **You usually don't notice.** Notification emails get lost or buried. Many vendors only post a banner on their site.
- **Changes can break your compliance.** A vendor adding an AI training clause or expanding data sharing can make YOU non-compliant with GDPR, CCPA, or HIPAA.
- **Consequences are real.** Missed ToS changes have led to data exposure, surprise costs, and regulatory penalties.

Current options: manually re-read every vendor's policy pages periodically (nobody does this), or use enterprise compliance platforms costing $5K-$50K/year that focus on YOUR policies, not your vendors'.

## Solution

TermSight monitors the ToS and Privacy Policy pages of your vendors automatically:

1. **Add URLs** of any Terms of Service or Privacy Policy page you want to track.
2. **Automated snapshots** — TermSight periodically fetches and stores the full text.
3. **Change detection** — When text changes, TermSight generates a precise diff.
4. **AI-powered summary** — Plain-language explanation of what changed and why it matters.
5. **Risk flagging** — Highlights changes related to data usage, AI training, liability, pricing, and cancellation terms.
6. **Email alerts** — Immediate notification when a monitored policy changes.

## Target Customer

- **Startup ops/legal leads** managing 20-100 vendor relationships
- **Compliance officers** at SMBs subject to GDPR, CCPA, HIPAA
- **Solo founders** who use many SaaS tools and want to stay informed
- **Privacy consultants** monitoring client vendor stacks

## Key Features (MVP)

1. **Policy URL tracking** — Add any public ToS or Privacy Policy URL
2. **Automated periodic checking** — Configurable check frequency (daily/weekly)
3. **Text extraction** — Clean extraction of policy text from web pages
4. **Visual diff view** — Side-by-side comparison showing exact changes
5. **AI change summary** — GPT/Claude-powered plain-language explanation of changes
6. **Risk category flags** — Data usage, AI/ML training, liability, pricing, cancellation, jurisdiction
7. **Email notifications** — Alert when changes are detected
8. **Dashboard** — Overview of all monitored policies, status, last change date

## Pricing Model

- **Free tier:** Monitor up to 3 policies, weekly checks
- **Pro ($9/mo):** 25 policies, daily checks, AI summaries, email alerts
- **Team ($29/mo):** 100 policies, priority checks, shared dashboard, webhook integrations

## Technical Architecture

- **Runtime:** Node.js + Express
- **Storage:** SQLite (self-contained, zero-config)
- **Scraping:** HTTP fetch + Cheerio for HTML parsing
- **Diffing:** diff library for text comparison
- **AI:** Claude/GPT API for change summarization (mock in prototype)
- **Frontend:** Vanilla HTML/CSS/JS (no framework overhead)

## Competitive Advantage

1. **Purpose-built** — Not a generic page monitor; understands policy-specific language and risk categories
2. **AI-native** — Change summaries in plain language, not raw diffs
3. **Affordable** — $9-$29/mo vs. enterprise tools at $5K+/year
4. **Simple** — Add a URL, get alerts. No onboarding, no integrations required.

## Key Risks

1. **Scraping reliability** — Some policy pages use SPAs, iframes, or require authentication. Mitigation: Focus on public pages, offer manual paste as fallback.
2. **AI summary quality** — Hallucinated or misleading summaries could erode trust. Mitigation: Always show raw diff alongside AI summary.
3. **Check frequency costs** — Frequent scraping at scale increases infra costs. Mitigation: Smart scheduling, caching, tiered frequency.
4. **Market education** — Buyers may not realize they need this until a controversy hits. Mitigation: SEO content around specific ToS changes, free tier for awareness.
