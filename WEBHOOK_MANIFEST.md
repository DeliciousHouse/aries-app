# Aries AI -- Webhook Manifest

## Supported inbound webhooks

Aries does not expose any supported inbound webhook contract in the current architecture.

## What Aries does accept

- Browser requests to public pages and authenticated app pages
- Internal UI calls to documented `/api/*` routes
- OAuth redirect/callback traffic under `/api/oauth/:provider/*`

OAuth callbacks are part of the authentication and connection lifecycle. They are not documented as general-purpose webhook endpoints.
