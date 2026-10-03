# Contributing to Aries AI

Thanks for your interest in improving Aries AI. This guide covers how to set up
a development environment, validate your changes, and open a pull request.

## Development Setup

1. Use Node.js 24.x (the supported engine and CI runtime), npm, and the setup in
   [README.md](README.md). Live integration work additionally needs local PostgreSQL
   and a Hermes endpoint; do not use production credentials or data.
2. External contributors fork the repository; contributors with write access may
   use a branch in the upstream repository. Create a short-lived feature branch
   from current `master`. Never push directly to `master`.
3. Install dependencies with development mode forced:

   ```bash
   NODE_ENV=development npm ci
   ```

4. Copy environment placeholders:

   ```bash
   cp .env.example .env
   ```

5. Use placeholder credentials only. Never commit real secrets.

## First contribution and mentoring

Choose an open [good first issue](https://github.com/DeliciousHouse/aries-app/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).
Check dependencies and existing PRs, then comment with your proposed scope before
starting. Ask questions on GitHub Issues and pull-request threads; open a draft
PR early for feedback. Maintainers help scope a first task and explain review
feedback there. No named mentor, response-time guarantee, public chat, or office
hours is promised. If an issue depends on unmerged docs, wait for those docs
rather than treating historical proposals as current policy.

## Keep the base fresh

For an upstream branch (`origin` is DeliciousHouse/aries-app):

```bash
git fetch origin
git merge origin/master --no-edit
git rev-list --left-right --count origin/master...HEAD
```

For a fork, add the public repository as `upstream`, fetch it, and merge
`upstream/master` instead. Record the base SHA and behind/ahead counts in your PR.
Keep branches short-lived. Once pushed, merge a newer base rather than rebasing
or force-pushing published history. Resolve conflicts and rerun affected checks
before requesting review.

## Validation

Run tests covering each changed module and directly affected integrations, then
the canonical fast gate. For example, replace the test path with your scoped test:

```bash
NODE_ENV=test APP_BASE_URL=https://aries.example.com npx --no-install tsx --test tests/community-governance-contract.test.ts
npm run verify
```

The full local suite is not required. CI's `full-suite` runs all TypeScript tests,
lint/type checks, the pipeline-monitor self-test, and build on `ubuntu-latest`
with Node 24. Separate PostgreSQL jobs exercise live-DB tests; self-skips in the
main suite are not live-DB evidence. Report commands, results, skips, and platform
limitations; do not present a partial gate as a pass.

## Draft pull request

Open one focused draft PR against `master` with a conventional-commit title.
Include the issue, scope/non-goals, base SHA/distance, test evidence, screenshots
for UI changes, sensitive areas, and remaining gaps. No version or changelog bump
is needed for an ordinary documentation change. Request independent review when
ready; do not use automation labels to bypass review.

## Review and merge standards

Project policy requires an implementation-independent review recorded on the PR,
resolution of findings, and green required checks on the exact current head.
Only the assigned reviewer merges, using squash merging. Authors do not merge
their own PRs, and engineering agents do not deploy as part of contribution.

Observed settings on 2026-10-03: branch protection requires `full-suite` with a
fresh base; the active pull-request ruleset requires zero formal approvals and
allows merge, squash, and rebase. Those settings do not enforce every project
policy above. Independent review and squash-only merging are policy requirements,
not claims about stronger GitHub enforcement. Recheck settings before merging.

## Pull request rules

- Keep PRs small and focused.
- Do not include real customer data.
- Do not include production secrets.
- Do not modify deployment workflows without maintainer approval.
- Do not weaken auth, tenant isolation, OAuth, publishing approval, or callback validation.
- Include tests for behavior changes.
- Include screenshots for UI changes.

## Release cadence and versioning

`VERSION` and `package.json` record the current application version. The image
workflow in `.github/workflows/release.yml` runs on `v*` tags or manual dispatch,
publishing Linux amd64 images to `ghcr.io/delicioushouse/aries-app`; semver tags
produce version/minor tags and `latest`. Manual dispatch produces a SHA tag.
Source is distributed through this public repository; `package.json` is private,
so this is not an npm package distribution contract.

Releases are maintainer-initiated, not on a promised monthly schedule. As of
2026-10-03 there are no GitHub Releases: public-release month is GAP, and tags,
repository creation, and master deployment are not a versioned release date.
Proposed releases should explain version compatibility, migration needs, and
artifact evidence in a reviewed PR. Do not cut a release or bump versions merely
to substantiate a proposal. The separate deployment workflow is not proof of
successful public image publication or a release cadence.

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
