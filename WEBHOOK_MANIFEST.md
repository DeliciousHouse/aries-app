# Aries AI — Webhook Manifest

## Supported inbound webhooks

Aries does not expose any supported inbound webhook contract in the current direct architecture.

## What Aries does accept

- Browser requests to public pages and authenticated operator pages
- Internal UI calls to documented `/api/*` routes
- OAuth redirect/callback traffic under `/api/oauth/:provider/*`

OAuth callbacks are part of the authentication and connection lifecycle. They are not documented as general-purpose webhook endpoints.

## Verification

Use the route and banned-pattern checks to confirm the repo still documents only the supported direct contract:

```bash
./node_modules/.bin/tsx --test tests/runtime-pages.test.ts
node scripts/check-banned-patterns.mjs
```
