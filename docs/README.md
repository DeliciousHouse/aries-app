# Aries AI documentation

Developer and operator documentation, organized by the
[Diátaxis](https://diataxis.fr) framework. Each section serves a different reader
need.

## Tutorials

Learning-oriented walkthroughs. Start here if you are new to Aries.

- [Generate and approve your first week of content](tutorials/first-week-of-content.md)

## How-to guides

Task-oriented guides for getting a specific job done.

- [Generate and approve a week of social content](how-to/generate-and-approve-a-week.md)
- [Connect a social platform](how-to/connect-a-social-platform.md)
- [Connect Aries to a Hermes execution endpoint](how-to/integrate-hermes.md)
- [Run and operate the background workers](how-to/run-background-workers.md)
- [Self-hosting Aries AI](SELF_HOSTING.md) - local setup and the full environment-variable reference
- [Production deployment](DEPLOYMENT.md)

## Reference

Complete, factual descriptions of the surface you build against.

- [API: social-content jobs and callbacks](reference/api-jobs-and-callbacks.md)
- [Background workers](reference/background-workers.md)
- [OAuth providers and scopes](OAUTH_SCOPES.md)
- [System reference](SYSTEM-REFERENCE.md) - the full route and surface inventory

## Explanation

Background on why Aries works the way it does.

- [Architecture and the Hermes execution boundary](ARCHITECTURE.md)
- [Security model](SECURITY_MODEL.md) - auth, tenant isolation, the callback trust boundary
- [Commercial vs open source](COMMERCIAL.md)
- [Honcho integration](honcho-integration.md)
- [Composio integration](integrations/composio.md)

## Internal history

`plans/`, `audits/`, `prd/`, `product/`, and `operations/` hold planning notes,
PRD audits, and product specs. They record how Aries was built and are not
maintained as current product documentation; prefer the sections above for
how the system behaves today.
