# Security Policy

## Supported Versions

Only the latest `master` branch and tagged releases are supported.

## Reporting a Vulnerability

Email: security@sugarandleather.com

Do not open public GitHub issues for vulnerabilities involving:

- OAuth token handling
- tenant isolation
- internal callback authentication
- Hermes callback ingress
- publishing authorization
- database access
- secret leakage
- account takeover
- SSRF, RCE, path traversal, or auth bypass
- GitHub Actions or deployment secrets

Expected initial response: 72 hours.

## Scope

In scope:

- Aries app code
- API routes
- auth/session handling
- OAuth provider flows
- Hermes callback ingress
- publishing and approval flows
- tenant isolation
- generated artifact access controls
- deployment workflows

Out of scope:

- social engineering
- physical attacks
- denial-of-service without exploit detail
- vulnerabilities in third-party providers unless Aries misuse is involved
