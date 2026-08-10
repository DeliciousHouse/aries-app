---
name: agent-reach
version: "0.1.0"
description: "Read what is working RIGHT NOW on Instagram, X/Twitter, Reddit and Facebook for a niche, using a logged-in throwaway session. Returns top posts, hooks and formats as strict JSON — or status session_stale when the cookie has expired."
argument-hint: 'agent-reach instagram leather handbag styling | agent-reach twitter creator marketing hooks | agent-reach reddit r/femalefashionadvice bags'
allowed-tools: Bash, Read
user-invocable: true
metadata:
  openclaw:
    emoji: "🍪"
---

# agent-reach

Platform-native social reading for the Aries weekly research stage.

`/last30days` answers *"what have people been saying about this topic across the
last 30 days"* (aggregate listening). **This** answers a different question:
*"what is winning on this platform right now"* — the actual posts, opening
hooks, formats and comment language currently getting traction in a niche.

## THE ONE RULE

**A stale session is a normal answer, not an error.** These sessions are cookie
based and expire. If the session is dead, return the `session_stale` JSON below
**immediately** and stop. Do not retry, do not log in, do not ask for
credentials, do not fall back to a browser or to `curl`. The research agent is
told that `session_stale` is a reportable outcome and degrades to `/last30days`
plus `web_search` on its own. Hanging here instead burns the stage's 600 s
budget and fails the whole weekly run over a cookie.

## Steps

### 1. Check freshness FIRST (cheap, always)

```bash
python3 ~/openclaw-n8n-stack/ops/agent-reach/cookie-prober.py --status
```

Read the line for the requested platform.

* `fresh` → continue to step 2.
* `stale` → return the `session_stale` payload (step 4) and STOP.
* `unknown`, or no state file at all → run one direct check, bounded:
  `timeout 60 agent-reach doctor` — treat "login required / unauthenticated /
  expired" as stale, anything else unreadable as stale too. When in doubt,
  answer `session_stale`. A false "stale" costs one enrichment; a false "fresh"
  costs a ten-minute stall.

### 2. Read the platform

Use the Agent-Reach channel for the requested platform, read-only, with a hard
timeout so nothing can hang:

```bash
timeout 120 agent-reach <platform> <query>      # exact sub-command per `agent-reach doctor`
```

Collect at most **10** items. Reads only — never post, comment, follow, like or
DM from these accounts. They are throwaways whose only job is reading.

### 3. Return strict JSON

```json
{
  "status": "ok",
  "platform": "instagram",
  "query": "leather handbag styling",
  "observed_at": "2026-08-10T09:00:00Z",
  "items": [
    {
      "url": "https://…",
      "author": "@handle",
      "hook": "the opening line / first 8 words",
      "format": "carousel|reel|image|text|video",
      "engagement": "what the platform reported, verbatim (e.g. '12.4k likes, 310 comments')",
      "why_it_works": "one sentence, your read"
    }
  ],
  "patterns": ["2–5 short observations across the items"]
}
```

### 4. Stale-session payload

```json
{ "status": "session_stale", "platform": "instagram", "detail": "logged-out session; owner re-mint required" }
```

Never put a cookie, token, header or account password in the output — not in
`detail`, not anywhere. If a tool prints one, drop that line.

## Installation (VM, owner-action)

This file lives in the repo at `ops/agent-reach/skill/SKILL.md` and is **not**
installed by anything automatic. Copying it into the live profile is a change to
the running research pipeline:

```bash
mkdir -p ~/.hermes/profiles/aries-research/skills/social-media/agent-reach
cp <repo>/ops/agent-reach/skill/SKILL.md \
   ~/.hermes/profiles/aries-research/skills/social-media/agent-reach/SKILL.md
# then restart the aries-research gateway (port 8651) in a maintenance window
```

Install it **only** on the `aries-research` profile. The app advertises
`/agent-reach` to the weekly research stage only, for exactly this reason — see
`WEEKLY_RESEARCH_AGENT_REACH_GUIDANCE` in `backend/marketing/ports/hermes.ts`.
