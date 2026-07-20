# Aries AI -- Webhook Manifest

## Supported inbound webhooks

| Endpoint | Source | Contract |
|---|---|---|
| `POST /api/integrations/slack/events` | Slack Events API | Verifies the Slack signing signature, answers the `url_verification` challenge, and dedupes by top-level `event_id` into the `slack_event_ids` table. Always returns 200 for verified events. |

No other inbound webhook contract is exposed in the current architecture. Hermes run delivery is **not** a webhook: the Hermes reconciler polls runs to completion and feeds the internal callback route (`POST /api/internal/hermes/runs`, `INTERNAL_API_SECRET` bearer auth).

## What Aries does accept

- Browser requests to public pages and authenticated app pages
- Internal UI calls to documented `/api/*` routes
- OAuth redirect/callback traffic under `/api/oauth/:provider/*`

OAuth callbacks are part of the authentication and connection lifecycle. They are not documented as general-purpose webhook endpoints.
