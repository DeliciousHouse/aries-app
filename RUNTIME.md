# RUNTIME.md — Aries App Runtime Truth Rules

## Purpose

This file defines how to talk about `aries-app` runtime status truthfully.

## Source-of-truth order

1. live runtime, tests, logs, and health checks
2. current repo and config files
3. durable memory
4. inference

## Rules

- Prefer live evidence when describing current status.
- Use repo files for expected behavior, not proof of current runtime state.
- If visibility is missing, say it is missing.
- Do not fill gaps with polished guesses.

## Valid status language

Use labels like:
- verified
- unverified
- unavailable
- failing
- passing
- inferred
- stale

## Never do this

- present remembered context as current runtime truth
- imply a route, workflow, or integration is live without verification
- import runtime claims from another project into `aries-app`
