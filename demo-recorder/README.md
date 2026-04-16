# Aries demo recorder

Playwright-driven B-roll recorder for the LinkedIn Live demo. Every spec in `tests/` produces one 1920×1080 WebM; `scripts/convert-webm-to-mp4.sh` re-encodes them to MP4 for OBS/Premiere.

## What each clip covers

| Spec | Clip | Needs auth? |
|---|---|---|
| `tests/01-public-tour.spec.ts` | Home hero → Problem → Features → Meet Aries → Early Access, then a marketing-subpage flyover (features / docs / api-docs / privacy / terms) | No |
| `tests/02-signup-form.spec.ts` | Signup form fill-in (does NOT submit) | No |
| `tests/03-onboarding.spec.ts` | Onboarding steps 1 → 4 complete, step 5 demonstrates the channel grid but intentionally does not click the broken "Continue to workspace" button | Yes |
| `tests/04-new-campaign.spec.ts` | `/marketing/new-job` fill + submit, wait for redirect to `/marketing/job-status?jobId=...` | Yes |
| `tests/05-job-status.spec.ts` | Scroll tour of the 4-stage pipeline + audit trail for `DEMO_JOB_ID` | Yes |

## First-time setup

```bash
cd demo-recorder
npm install
npm run install:browser          # downloads chromium
cp .env.example .env.local && vim .env.local   # set DEMO_PASSWORD at minimum
```

The authed specs need a session cookie. Generate it once per stream:

```bash
set -a && source .env.local && set +a
npm run auth:refresh             # runs fixtures/auth-setup.spec.ts, writes storage-state.json
```

If the seeded account is NOT onboarded, `/onboarding/start` will be the only route it can reach. The audit found a P0 bug where the onboarding submit button is stuck disabled — so **complete onboarding manually with this account before recording**, or re-run the setup script after the bug is fixed.

## Recording

```bash
# All six clips, ~12 minutes of real browser time
npm run record:all

# Just the public-tour clips (no auth needed)
npm run record:public

# Just the authed clips (requires storage-state.json)
npm run record:authed

# One specific clip
npm run record:one -- "new campaign form"
```

Each clip lands in `test-results/<test-name>/video.webm`.

## Convert to MP4

```bash
npm run convert:mp4
ls -lh clips-mp4/
```

Uses ffmpeg's `libx264` at CRF 18 (visually lossless), `yuv420p` for LinkedIn compatibility, `+faststart` so they scrub cleanly in OBS.

Needs ffmpeg:
```bash
sudo apt-get install ffmpeg     # or: brew install ffmpeg
```

## Customizing the brand narrative

All brand-story text (URLs, names, voice, competitor, etc.) is in `fixtures/demo-config.ts` and can be overridden via `.env.local`:

```env
DEMO_BRAND_URL=https://your-brand.com
DEMO_BRAND_NAME=Your Brand
DEMO_BUSINESS_TYPE=Whatever your business type is
DEMO_COMPETITOR_URL=https://real-competitor.com
```

This is how you'd swap Sugar & Leather for a different dogfooding target without touching the specs.

## Known limitations (matches the audit-log findings)

- `tests/03-onboarding.spec.ts` deliberately stops before clicking "Continue to workspace" on step 5 — that button is currently stuck disabled in production (see `/tmp/aries-demo-audit/error-log.md` §4). If/when the bug is fixed, extend the spec to click it and wait for `waitForURL(/\/dashboard|\/marketing\//)`.
- `tests/05-job-status.spec.ts` requires a pre-existing `DEMO_JOB_ID` OR needs to run after `tests/04-new-campaign.spec.ts` and read the new jobId from the URL — currently it will `test.skip` if `DEMO_JOB_ID` is empty. Chain the runs or update the env var between them.
- The review surface at `/review/{jobId}::approval` is middleware-blocked for accounts with `onboarded: false`, so there's no spec for it yet. Add one once the seeded account can reach it.

## Tweaking pacing

Each spec uses `waitForTimeout` + `pressSequentially({ delay: N })` to make the clips watchable rather than robotic. Bump `delay` higher (60-80) or `waitForTimeout` calls up by ~50% if you want slower, more cinematic pacing for VO recording.
