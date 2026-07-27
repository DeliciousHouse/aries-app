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

On Windows Git Bash, npm dispatches package scripts through `cmd`, so scripts with leading inline
environment assignments must be run as their underlying command. For the full suite, use
`APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test --test-concurrency=1 'tests/*.test.ts' 'tests/**/*.test.ts'`
instead of `npm run test`.

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
- `lib/db.ts`
- `lib/db-pool-config.ts`
- `.github/workflows/**`
- `docker-compose*.yml`
- `Dockerfile`

## Source License Headers

- New human-authored source files use `SPDX-License-Identifier: Apache-2.0` when the file format safely supports comments.
- Existing files are not bulk-updated to add headers.
- Generated, vendored, minified, binary/media, lock, fixture, and files that
  cannot safely carry comments are excluded.
- Third-party notices and license texts are preserved.
- An SPDX identifier never replaces required third-party attribution.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.
