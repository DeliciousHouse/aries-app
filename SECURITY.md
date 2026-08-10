# Security Policy

## Supported Versions

Security fixes are made on the latest `master` branch and included in the next
tagged release. Older branches, deployments, and tags are not supported unless a
repository advisory says otherwise.

## Reporting a Vulnerability

Use GitHub's private vulnerability reporting form as the primary reporting
channel:

<https://github.com/DeliciousHouse/aries-app/security/advisories/new>

This opens a private draft GitHub Security Advisory visible only to the reporter
and repository security maintainers. Include the affected component and version,
reproduction steps or a proof of concept, impact, and any suggested remediation.
Please use placeholder data and remove credentials, access tokens, and customer
data from the report.

If the GitHub form is unavailable, email `security@sugarandleather.com` with a
link-free summary and ask for a private follow-up channel. Do not send working
secrets or customer data by email.

Do not open a public GitHub issue, pull request, discussion, or social-media post
for a suspected vulnerability. This is especially important for findings about:

- OAuth token handling, auth, sessions, or account takeover
- tenant isolation, database access, or generated artifact access
- internal callback authentication or Hermes callback ingress
- publishing authorization or third-party platform integrations
- secret leakage, deployment credentials, or GitHub Actions
- SSRF, RCE, path traversal, injection, or authorization bypass

This policy is not a bug bounty program. Aries does not currently offer payment
or other compensation for reports.

## Scope

In scope:

- code and configuration in the `DeliciousHouse/aries-app` repository
- Aries API routes, browser application, and supported production deployment
- auth/session handling and OAuth provider flows
- Hermes callback ingress and internal service callbacks
- publishing, approval, and generated-artifact access controls
- tenant isolation and Aries-managed data access
- GitHub Actions and deployment workflows owned by this repository

Out of scope:

- social engineering, phishing, physical attacks, or employee targeting
- denial-of-service testing, load testing, or actions that degrade availability
- automated scanning that creates excessive traffic or accounts
- accessing, modifying, retaining, or deleting another person's data
- vulnerabilities solely in third-party providers or dependencies, unless the
  report shows that Aries misuses the provider or remains exploitable after the
  provider's supported mitigation
- reports without a reproducible security impact, such as version banners,
  missing best-practice headers with no exploit path, or self-XSS

If you are unsure whether a test is in scope, submit the proposed test privately
before running it.

## Response Process and Service Levels

The following service levels begin when a private report is received. They are
response targets, not a guarantee, and may be accelerated for active exploitation
or adjusted with the reporter when a fix depends on an upstream provider.

- We will acknowledge a new report within 2 business days.
- We will provide an initial triage decision within 7 calendar days, including
  whether the report is reproducible, in scope, and its preliminary severity.
- After validation, our target fix timelines are: critical within 7 calendar days,
  high within 30 calendar days, medium within 60 calendar days, and low within
  90 calendar days.
- We will send progress updates at least every 7 calendar days for critical and
  high findings and at least every 30 calendar days for medium and low findings.
- Our default coordinated disclosure window is within 90 calendar days of the
  initial report. We may agree to an earlier publication after a fix is available,
  or a later date when users need more time to upgrade or an upstream fix is
  pending. Active exploitation may require immediate mitigation and disclosure.

The response process is:

1. A maintainer acknowledges the report and keeps discussion in the private
   advisory.
2. The team reproduces the issue, determines affected versions and severity, and
   records any immediate containment actions.
3. The team develops and validates a fix. When useful, maintainers may use the
   advisory's temporary private fork to collaborate with the reporter.
4. The team agrees on disclosure timing, release notes, reporter credit, and any
   CVE request. Please do not publish before the agreed date.
5. The fix is released before or alongside the advisory whenever practical.
6. The repository's GitHub Security Advisories page is the authoritative public
   advisory channel: <https://github.com/DeliciousHouse/aries-app/security/advisories>.

Published advisories identify affected and fixed versions, impact, mitigations,
and credit when the reporter wants it. If a fix cannot be released before
disclosure, the advisory will say so and provide the safest available mitigation.

## Safe Harbor

Research performed in good faith and consistent with this policy is considered
authorized. Aries will not initiate or recommend legal action against a researcher
for accidental, good-faith violations of this policy. If a third party initiates
legal action over compliant research, we will make our authorization clear.

To qualify for this safe harbor:

- stop testing and report promptly after confirming the vulnerability
- avoid privacy violations, persistence, service disruption, social engineering,
  destructive actions, and access beyond the minimum needed to demonstrate impact
- do not exploit a finding for profit, demand payment, or withhold details as
  leverage
- protect any accidentally encountered data, do not share it, and delete it after
  we confirm receipt
- comply with applicable law and give us a reasonable opportunity to remediate
  before public disclosure

Safe harbor applies only to claims Aries controls and does not bind independent
third parties. Contact us privately before proceeding if you are uncertain whether
a technique is covered.

## Automated Scanning Rollout

The `Security Scans` GitHub Actions workflow runs `npm audit` and Gitleaks. It is
initially warn-only so maintainers can triage existing dependency and git-history
findings without making an unreviewed baseline public or blocking unrelated fixes.
Warnings are reviewed through the same private response process above.

Promotion to blocking will be reviewed no later than 2026-09-05 after at least 30
days of signal. At promotion, new secret findings block pull requests; high and
critical dependency findings with an available fix block pull requests. Historical
findings and accepted no-fix advisories must have a private owner, rationale, and
review date rather than a broad allowlist. The scheduled full-history scan will
remain warn-only; the blocking Gitleaks check will scan only commits introduced by
the pull request so known historical candidates do not mask new leaks.

If a secret is detected, revoke or rotate it first and review provider audit logs.
There will be no history rewrite from automated scanning alone: any rewrite needs
a separately approved incident plan because it disrupts every clone and fork.
