# Contributing to Aries AI

Thanks for your interest in improving Aries AI. This guide covers how to set up
a development environment, validate your changes, and open a pull request.

## Development Setup

1. Fork the repository.
2. Create a feature branch.
3. Install dependencies with development mode forced:

   ```bash
   NODE_ENV=development npm ci
   ```

4. Copy environment placeholders:

   ```bash
   cp .env.example .env
   ```

5. Use placeholder credentials only. Never commit real secrets.

## Validation

Before opening a PR:

```bash
npm run typecheck
npm run lint
npm run test
npm run verify
```

## Pull Request Rules

- Keep PRs small and focused.
- Do not include real customer data.
- Do not include production secrets.
- Do not modify deployment workflows without maintainer approval.
- Do not weaken auth, tenant isolation, OAuth, publishing approval, or callback validation.
- Include tests for behavior changes.
- Include screenshots for UI changes.

## Sensitive Areas

Changes to these areas require maintainer/security review:

- `app/api/auth/**`
- `app/api/oauth/**`
- `app/api/internal/**`
- `backend/auth/**`
- `backend/integrations/**`
- `backend/execution/**`
- `lib/db/**`
- `.github/workflows/**`
- `docker-compose*.yml`
- `Dockerfile`

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.
