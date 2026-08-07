# Contributing to Aries AI

Thanks for improving Aries AI. This repository uses one trunk (`master`),
short-lived branches, and pull requests. GitHub Issues and pull-request comments
are the public coordination and mentoring surfaces; this repository does not
currently operate a public chat or GitHub Discussions forum.

Read the [Code of Conduct](CODE_OF_CONDUCT.md), [Governance](GOVERNANCE.md), and
[Security Policy](SECURITY.md) before starting. Do not open a public issue for a
vulnerability.

## Choose an issue

1. Search [open and closed issues](https://github.com/DeliciousHouse/aries-app/issues)
   to avoid duplicate work.
2. For a bounded first contribution, choose an open
   [`good first issue`](https://github.com/DeliciousHouse/aries-app/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).
3. Comment on the issue with the approach you intend to take and any question
   that blocks you. A maintainer or triager will answer on that issue; no private
   community channel is required.
4. Keep one pull request tied to one issue or one independently reviewable
   concern. If the work grows beyond the acceptance criteria, stop and discuss
   the split before adding scope.

Good-first-issue mentoring happens in public. Ask implementation questions on
the issue, open a draft pull request early, and use review threads for line-level
feedback. Maintainers send work back with a concrete reason and the evidence or
test needed to move forward.

## Branch workflow

### External fork-and-PR path

Fork the repository on GitHub, then clone your fork and add the upstream source:

```bash
git clone https://github.com/<your-user>/aries-app.git
cd aries-app
git remote add upstream https://github.com/DeliciousHouse/aries-app.git
git fetch upstream --prune
git switch -c docs/short-description upstream/master
```

Use a short-lived branch named for the work, such as `docs/...`, `fix/...`, or
`feat/...`. Push the branch to your fork and open a pull request against
`DeliciousHouse/aries-app:master`.

### Repository collaborator path

People with repository write access follow the same branch-and-PR model, but
branch from `origin/master` and push the short-lived branch to `origin`:

```bash
git fetch origin --prune
git switch -c fix/short-description origin/master
```

Never push directly to `master`.

### Keep the base fresh

Immediately before the final push, fetch and rebase rather than merging the
trunk into the branch:

```bash
# External fork
git fetch upstream --prune
git rebase upstream/master
git rev-list --count HEAD..upstream/master  # must print 0
git push --force-with-lease origin HEAD

# Collaborator
git fetch origin --prune
git rebase origin/master
git rev-list --count HEAD..origin/master  # must print 0
git push --force-with-lease origin HEAD
```

Resolve a conflict by reading the upstream change and rerunning affected tests;
do not mechanically choose one side. `--force-with-lease` protects work that may
have appeared on the remote branch while you were rebasing.

## Development setup

Aries requires Node.js 24.x, npm, PostgreSQL 16 for database-backed tests, and a
Hermes endpoint only for live execution. Required CI is the authoritative Linux
check and also runs Node.js 24. For ordinary local development:

```bash
NODE_ENV=development npm ci
cp .env.example .env
npm run workspace:verify
```

Use placeholder or local-only credentials. Never commit `.env`, real secrets,
tokens, cookies, customer data, or production exports.

## Tests and scope

Write or update a test first for behavior changes, confirm that it fails for the
missing behavior, and then implement the smallest passing change. Run every
test file that covers a changed module plus directly affected integration tests.
For example:

```bash
APP_BASE_URL=https://aries.example.com npx --no-install tsx --test tests/<file>.test.ts
npm run verify
```

`npm run verify` is the canonical local pre-push gate. A full local `npm test`
is optional; GitHub's `full-suite` job runs the complete test inventory on
Ubuntu with Node 24 and PostgreSQL. Include screenshots for visible UI changes
and exact command output for documentation, workflow, or schema changes.

Do not mix unrelated refactors, generated artifacts, dependency updates, or
formatting churn into the pull request. Do not weaken authentication, tenant
isolation, OAuth, publishing approval, callback validation, or tests to make a
check pass.

## Draft pull request

Open a draft pull request as soon as the approach is reviewable. The body must:

- link the selected issue and explain why the change matters;
- describe the bounded implementation and any explicit non-goals;
- list changed surfaces and sensitive areas;
- provide the targeted tests and `npm run verify` result;
- include screenshots for UI changes; and
- state any dependency, gap, or behavior that remains unmeasured.

Keep the pull request in draft while tests are red, the base is stale, or review
feedback remains unresolved. Respond to review feedback in the relevant thread,
push the correction to the same branch, rerun affected checks, and summarize the
new evidence. Do not open a replacement pull request just to escape review
history.

## Review and merge standards

Project policy requires an independent maintainer review of every change,
including maintainer-authored work. The implementer may not perform this review.
Repository automation can record implementation and reviewer lanes under the
same service identity, so the evidence is the separate review findings rather
than a distinct GitHub account or formal `APPROVED` state. GitHub branch
protection currently requires the `full-suite` status check and does not
configure a required approval count, so the recorded maintainer review is a
project-process requirement rather than a platform approval rule.

Maintainers merge only when:

- the pull request still targets `master` from a short-lived branch;
- the branch has been rebased onto current `master`;
- the required `full-suite` check and all relevant CI are green;
- the independent maintainer review finds the acceptance criteria satisfied;
- every unresolved review thread is addressed; and
- the pull request contains no secret, private data, or unsafe production change.

The project uses squash merge for short-lived contribution branches. Repository
settings also permit merge commits and rebase merges, but contributors should
not depend on those methods. The maintainer performing the merge chooses the
method and final commit message.

A maintainer will send work back when it is stale, red, too broad, missing a
regression test, unverifiable, unsafe, inconsistent with repository scope, or
missing review evidence. A failing required check is never accepted as good
enough.

## Current repository publication state

As of 2026-08-07, GitHub Releases contains zero releases and
`docs/RELEASES.md` is absent from `master`. Signed-release proposal #937 closed
without merging; security policy and scanning PR #938 merged; OpenSSF Scorecard
PR #936 and canonical-license PR #951 remain open and unmerged. An unmerged or
closed proposal is not current repository policy.

## Sensitive areas

The following paths require an explicit security or platform-focused review:

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

Changes involving production configuration, a release, repository visibility,
credentials, paid services, destructive data work, or the license require prior
maintainer authorization. A normal contribution must not deploy, cut a release,
or mutate production.

## License and conduct

Contributions submitted for inclusion are accepted under the terms in the
current [LICENSE](LICENSE). Package metadata declares `Apache-2.0`, but GitHub
currently classifies that file as `Other` / `NOASSERTION`; canonical Apache-2.0
replacement PR #951 remains unmerged. By participating, you agree to follow the
[Contributor Covenant](CODE_OF_CONDUCT.md).
