# OpenClaw governance cleanup proposal

**Date:** April 6, 2026
**Status:** proposal only, not applied
**Scope:** approval-ready OpenClaw cleanup plan to align configured first-class agents and chief heartbeat models with current repo governance

## Explicit non-application note

This document is proposal-only.

No OpenClaw config, agent registration, model setting, scheduler state, or runtime behavior was changed in this pass.
Any OpenClaw write remains Brendan-gated.

## Why this proposal exists

Current repo governance is now explicit:
- persistent AI owners are **Jarvis**, **Forge**, **Signal**, and **Ledger** only
- legacy labels such as `aries-main`, `aries-prod`, `aries-local`, and `aries-validator` may exist as subordinate execution labels, but they are not persistent owners

Live OpenClaw config is still broader than that governance model.
This proposal defines the smallest reviewable cleanup that would bring config into line when Brendan explicitly approves it.

## Current observed truth

### Live config observed on Monday, April 6, 2026
From `/home/node/.openclaw/openclaw.json`:

Configured agent ids currently include:
- `aries-main`
- `aries-prod`
- `aries-local`
- `aries-validator`
- `main`
- `delivery-chief`
- `runtime-chief`
- `knowledge-chief`

Key current details:
- `main` is the default agent and already routes subagents only to:
  - `main`
  - `delivery-chief`
  - `runtime-chief`
  - `knowledge-chief`
- `aries-main` is still configured as a separate first-class agent and still allows:
  - `aries-prod`
  - `aries-local`
  - `aries-validator`
- chief primary models are already pinned to `openai-codex/gpt-5.4`
- default heartbeat model is still `openai-codex/gpt-5.3-codex`
- the chief entries do not currently override `heartbeat.model`

### Read-only runtime implication
Inference from current config plus the previously observed heartbeat/session behavior:
- the extra `aries-*` entries remain available as first-class configured agents even though repo governance now treats them as subordinate labels only
- chief heartbeats can still inherit the default heartbeat model instead of the chief primary model unless per-chief heartbeat overrides are added

## Desired future state

Configured first-class AI governance backbone:
- `main` -> Jarvis
- `delivery-chief` -> Forge
- `runtime-chief` -> Signal
- `knowledge-chief` -> Ledger

Legacy labels:
- `aries-main`
- `aries-prod`
- `aries-local`
- `aries-validator`

Desired handling:
- no longer present as first-class configured agents
- remain repo-language execution labels only, if Brendan still wants to refer to them descriptively in docs or proposals

Chief model policy:
- `delivery-chief` heartbeat -> `openai-codex/gpt-5.4`
- `runtime-chief` heartbeat -> `openai-codex/gpt-5.4`
- `knowledge-chief` heartbeat -> `openai-codex/gpt-5.4`

## Exact config paths implicated

Primary paths:
- `agents.list`
- `agents.list[*].id`
- `agents.list[*].workspace`
- `agents.list[*].agentDir`
- `agents.list[*].subagents.allowAgents`
- `agents.list[*].model`
- `agents.list[*].heartbeat`
- `agents.defaults.heartbeat.model`

Entry-specific paths implicated by this proposal:
- `agents.list[?id=="aries-main"]`
- `agents.list[?id=="aries-main"].subagents.allowAgents`
- `agents.list[?id=="aries-prod"]`
- `agents.list[?id=="aries-local"]`
- `agents.list[?id=="aries-validator"]`
- `agents.list[?id=="delivery-chief"].heartbeat.model`
- `agents.list[?id=="runtime-chief"].heartbeat.model`
- `agents.list[?id=="knowledge-chief"].heartbeat.model`

Paths reviewed but not targeted for change in the preferred diff:
- `agents.list[?id=="main"]`
- `agents.list[?id=="main"].subagents.allowAgents`
- `agents.defaults.heartbeat.model`

## Preferred cleanup strategy

### Preferred result
Apply the smallest precise config diff that:
1. removes the extra first-class `aries-*` agent registrations
2. leaves `main` + the three chiefs as the only configured governance backbone
3. adds explicit `heartbeat.model` overrides to the three chiefs

### Smallest safe diff

#### 1) Remove legacy first-class configured agents from `agents.list`
Remove these entries entirely:
- `agents.list[?id=="aries-main"]`
- `agents.list[?id=="aries-prod"]`
- `agents.list[?id=="aries-local"]`
- `agents.list[?id=="aries-validator"]`

#### 2) Normalize chief heartbeat models explicitly
Add:
- `agents.list[?id=="delivery-chief"].heartbeat.model = "openai-codex/gpt-5.4"`
- `agents.list[?id=="runtime-chief"].heartbeat.model = "openai-codex/gpt-5.4"`
- `agents.list[?id=="knowledge-chief"].heartbeat.model = "openai-codex/gpt-5.4"`

### Why this is the preferred diff
- it matches current repo governance exactly
- it avoids changing the default heartbeat model for unrelated agents
- it keeps Jarvis and the chief backbone intact
- it removes the config-level ambiguity that still makes `aries-*` look first-class

## Suggested rollback plan

If Brendan approves the cleanup and later wants to revert it:

1. restore the removed `agents.list` entries for:
   - `aries-main`
   - `aries-prod`
   - `aries-local`
   - `aries-validator`
2. restore `aries-main.subagents.allowAgents` to include the legacy ids if needed
3. remove the three chief `heartbeat.model` overrides or set them back to the prior value

Expected rollback effect:
- legacy `aries-*` configured agents become first-class again
- chiefs resume inheriting the default heartbeat model unless explicitly pinned

## Risk notes

1. **Legacy session / automation reference risk**
   - removing `aries-*` entries can break any out-of-band automation, saved targeting, or manual habits that still address those ids directly
   - this is the main reason the proposal should stay explicit and Brendan-gated

2. **Historical session continuity risk**
   - historical session records under the legacy ids may still exist even if the config entries are removed
   - the cleanup should be treated as forward routing cleanup, not transcript deletion

3. **Heartbeat cost / latency risk**
   - moving chief heartbeats from `gpt-5.3-codex` inheritance to explicit `gpt-5.4` may increase latency and cost

4. **Restart / reload requirement**
   - any approved config write would require normal OpenClaw config validation and runtime reload/restart behavior

## Review recommendation

If Brendan wants to close the OpenClaw side of this governance drift later, approve this exact direction:
- keep `main`, `delivery-chief`, `runtime-chief`, and `knowledge-chief`
- remove `aries-main`, `aries-prod`, `aries-local`, and `aries-validator` from `agents.list`
- add chief-only `heartbeat.model = openai-codex/gpt-5.4` overrides

That is the smallest config cleanup that aligns live first-class agent registration with repo governance without broadening the heartbeat change to unrelated agents.
