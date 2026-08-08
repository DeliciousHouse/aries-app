# Project metrics

This document is the public measurement contract for Aries AI. It defines what
is counted, how it is reproduced, and which numbers are observations rather
than goals. A value is not "measured" until its source query, collection time,
window, and caveats are published together.

Monthly snapshots belong in `docs/metrics/YYYY-MM.md` and should link the commit
that produced them. Until the first snapshot exists, the baseline entries below
are the published record. Maintainers own collection and review; a contributor
may prepare a snapshot through the normal pull-request process.

## Measured values, targets, and gaps

Measured values and targets are deliberately separate:

- **Measured** means the source was queried for a named window on a named date.
- **Target** means a future outcome approved in a governance or planning pull
  request. A target must never be presented as an observed result.
- **GAP** means the required source, identity evidence, historical window, or
  collection run is missing. A gap is reported, not estimated away.

No numerical targets are approved in this document. The first three monthly
snapshots should establish normal variation before maintainers propose targets.

Publication status was rechecked on 2026-08-07: GitHub Releases contains zero
releases, `docs/RELEASES.md` is absent, signed-release PR #937 closed without
merging, and security PR #938, Scorecard PR #936, and canonical-license PR #951
merged. The official Scorecard workflow and canonical Apache-2.0 license are
current capability; the closed release proposal is not current policy.

## Identity and privacy rules

Contributor metrics count people, not raw Git author strings.

1. Start with paginated merged pull-request authors and
   `git shortlog -sne origin/master`, which includes only commits reachable from
   the fetched default branch.
2. Exclude GitHub accounts whose API `type` is `Bot`, logins ending in `[bot]`,
   and repository-known automation identities such as dependency, model, or
   agent committers. Record the exclusion list in each snapshot.
3. Normalize name and email case. Apply the repository `.mailmap` when one
   exists. Until then, collapse duplicate identities only with reproducible
   evidence such as the same verified email, the same GitHub login, or a public
   profile that links the identities. Publish the mapping rationale, but never
   publish a private email address.
4. Classify **verified internal** only when a public profile or commit identity
   proves affiliation with the steward. Classify **verified external** only
   when public evidence proves a different affiliation or independent status.
   Absence of an organization email is not proof of external status; unresolved
   people stay **unclassified (GAP)**.
5. Do not publish names for cohorts smaller than five. Publish aggregate counts
   and keep vulnerability reports, customer data, and private contact data out
   of metrics artifacts.

The inventory was recomputed at `2026-08-08T02:56:24Z` against `origin/master`
`89af7950879d3579b05584220cf0fd8a0396e1dc`. Its merged-only shortlog produced
19 raw signatures. Nine known automation signatures were excluded; three
duplicate human signatures were collapsed using the same public commit address or
GitHub identity. The remaining human history contains **7 people: 4 verified internal + 0 verified external + 3 unclassified human contributors (GAP)**. Public profile or commit evidence supports the four internal classifications; absence of equivalent evidence leaves three people unclassified. No `.mailmap` exists yet, so unresolved aliases remain explicit rather than guessed. This is an affiliation inventory, not a growth or retention result.

## Contributor growth

| Field | Contract |
| --- | --- |
| **Definition / formula** | For calendar month `m`, `new_humans(m)` is the number of deduplicated non-bot people whose first merged pull request landed in `m`. Absolute growth is `new_humans(m) - new_humans(m-1)`. Percentage growth is that difference divided by `new_humans(m-1)` when the denominator is greater than zero; otherwise report `not applicable`. Report verified internal, verified external, and unclassified cohorts separately. |
| **Unit** | People, plus month-over-month people and percentage. |
| **Data source** | GitHub pull requests API (`merged_at`, `user.login`) joined to default-branch-reachable commits from `git shortlog -sne origin/master` and `.mailmap` when present. Reproducible starting commands: `gh api --paginate 'repos/DeliciousHouse/aries-app/pulls?state=closed&per_page=100&sort=created&direction=asc' --jq '.[] | select(.merged_at != null) | {number, user: .user.login, created_at, merged_at}'` and `git shortlog -sne origin/master`. Pagination is required; a fixed recent-result limit is not a complete contributor history. |
| **Cohort / window** | Calendar month in UTC; all merged pull requests through the final UTC day of the month. |
| **Cadence** | Monthly, collected within seven days after month end. |
| **Owner** | Maintainers; prepared by a maintainer or contributor and independently reviewed in a pull request. |
| **Publication** | Dated `docs/metrics/YYYY-MM.md` snapshot; latest status remains linked from this file. |
| **Baseline** | **Not yet measured as of 2026-08-06.** The 7-person identity inventory above cannot establish growth without first-merge dates and a prior-month comparison. |
| **Caveats** | Squashed commits can hide original Git authors, so pull-request authorship is primary. Bot filtering and duplicate identity mapping materially affect the result. Affiliation gaps remain separate rather than being guessed into the external cohort. |

## Contributor retention

| Field | Contract |
| --- | --- |
| **Definition / formula** | For people whose first merged pull request lands in cohort month `m`, 90-day retention is `people with another merged pull request 30 through 90 days after first merge / eligible cohort members whose full 90-day window has elapsed`. Publish numerator, denominator, and rate. Report affiliation cohorts separately. |
| **Unit** | Retained people / eligible people and percentage. |
| **Data source** | GitHub pull requests API merged events, deduplicated with the identity process above. Use pull-request numbers and timestamps as the audit trail; Git commit counts alone are not sufficient. |
| **Cohort / window** | First-merge calendar-month cohort; return window begins 30 days after the first merge and ends at day 90. |
| **Cadence** | Monthly, recomputing every cohort whose observation window has closed. |
| **Owner** | Maintainers. |
| **Publication** | Dated `docs/metrics/YYYY-MM.md` snapshot with cohort month, numerator, denominator, and exclusions. |
| **Baseline** | **Not yet measured as of 2026-08-06.** No completed, deduplicated cohort analysis is published. |
| **Caveats** | Recent cohorts are right-censored and must not enter the denominator. Reviews and issue help are valuable but are not counted in this code-contribution retention formula. Small cohorts are volatile and must be published as counts as well as rates. |

## Time to first merged pull request

| Field | Contract |
| --- | --- |
| **Definition / formula** | For each deduplicated human's first merged pull request, compute `merged_at - created_at`. Publish the monthly median and 75th percentile, plus the number of eligible first pull requests. Separate verified external and unclassified cohorts; do not silently combine them. |
| **Unit** | Elapsed hours, with cohort size in pull requests. |
| **Data source** | GitHub pull requests API fields `created_at`, `merged_at`, `user.login`, and `number`; identity classification follows this document. |
| **Cohort / window** | Pull requests first merged during a calendar month in UTC. Draft time remains included because it is part of the contributor's experienced path. |
| **Cadence** | Monthly. |
| **Owner** | Maintainers. |
| **Publication** | Dated `docs/metrics/YYYY-MM.md` snapshot, with median, P75, cohort count, and exact query time. |
| **Baseline** | **Not yet measured as of 2026-08-06.** |
| **Caveats** | A pull request prepared privately before opening appears faster than the full effort. Closed-unmerged pull requests are excluded from this measure and should be reported separately if rejection experience is studied. Maintainer-authored and bot pull requests do not represent newcomer latency. |

## Adoption

Aries has no opt-in product telemetry. Adoption is therefore reported through
public-distribution and repository proxies, not as active users or installed
instances.

| Field | Contract |
| --- | --- |
| **Definition / formula** | Primary proxy: GitHub's rolling `uniques` count from the repository clones endpoint. Supporting observations: stars, forks, and, once a GitHub Release exists, release-asset download counts. Report each separately; never add them into a fabricated "users" total. |
| **Unit** | Unique cloners in GitHub's available traffic window; stars; forks; release downloads by asset. |
| **Data source** | `GET /repos/DeliciousHouse/aries-app/traffic/clones`, repository API `stargazers_count` and `forks_count`, and `GET /repos/DeliciousHouse/aries-app/releases` asset `download_count`. Anonymous GHCR pulling was verified through the public registry token and tags endpoints, but GHCR does not expose a trustworthy public unique-install count here. |
| **Cohort / window** | GitHub's returned rolling traffic window (currently 14 daily buckets); repository totals at collection time; release downloads per immutable release asset. |
| **Cadence** | Capture traffic weekly because GitHub retains only a short window; summarize monthly. Repository and release totals are collected monthly. |
| **Owner** | Maintainers. |
| **Publication** | Weekly source rows summarized in `docs/metrics/YYYY-MM.md`; release downloads may also be recorded in release notes after a real release exists. |
| **Baseline** | Measured 2026-08-06 at 23:08 UTC: **262 unique cloners / 2,422 clones** for 2026-07-23 through 2026-08-05, **2 stars**, and **1 fork**. GitHub Releases API returned **0 releases**, so release downloads are **GAP / not applicable**. |
| **Caveats** | Clone traffic includes maintainers, CI, automation, repeated clean checkouts, and possibly duplicate people; it is not an installed-user count. Stars and forks indicate interest, not use. GitHub reports a March 2026 repository-creation month and current public visibility, but its repository API does not prove the initial-publication date; neither fact is a versioned public release. No customer or production telemetry is used. |

## Dependency health

| Field | Contract |
| --- | --- |
| **Definition / formula** | Publish (a) open Dependabot alerts by severity, (b) direct dependencies with a newer compatible version, (c) direct dependencies with a newer major version, and (d) median age in days of open dependency-update pull requests. Never publish vulnerability exploit details before a fix is available. |
| **Unit** | Alert count by severity, dependency count by update class, and median days. |
| **Data source** | GitHub Dependabot alerts API, `.github/dependabot.yml`, `package.json`, `package-lock.json`, `npm outdated --json`, and Dependabot pull requests from the GitHub API. The lockfile, not a developer's shared `node_modules`, is the dependency inventory source of truth. |
| **Cohort / window** | State at the collection timestamp; pull-request age uses all open Dependabot pull requests. |
| **Cadence** | Weekly alert review; monthly public aggregate. Critical alerts trigger the security policy rather than waiting for the monthly report. |
| **Owner** | Maintainers, with sensitive details handled through the security process. |
| **Publication** | Aggregate counts in `docs/metrics/YYYY-MM.md`; fixed advisories may be linked after disclosure is safe. |
| **Baseline** | Partial observation on 2026-08-06: the Dependabot alerts API returned **1 open high-severity alert**, but the exact collection time was not retained. Version-currency and update-age baselines are **not yet measured** from a clean lockfile install, so the combined dependency-health baseline remains **GAP**. |
| **Caveats** | Registry `latest` can be an incompatible or misleading channel, especially for prereleases. An alert count is not a risk score. Private advisory details, dependency paths, and exploit information must not be exposed merely to make the metric reproducible. |

## OpenSSF Scorecard

| Field | Contract |
| --- | --- |
| **Definition / formula** | The overall score emitted by OpenSSF Scorecard for the default branch, on its 0-10 scale. Publish the overall score, tool version, commit SHA, run time, and per-check scores; do not recompute an average from rounded check values. |
| **Unit** | Score out of 10, plus per-check scores out of 10. |
| **Data source** | OpenSSF Scorecard CLI or the official Scorecard GitHub Action in `.github/workflows/scorecard.yml`. Record the immutable workflow run or command, tool version, and scanned commit. |
| **Cohort / window** | Repository/default-branch state at one exact commit and collection timestamp. |
| **Cadence** | Weekly and on default-branch changes; monthly snapshots use the latest completed scan in the month. |
| **Owner** | Maintainers. |
| **Publication** | Dated `docs/metrics/YYYY-MM.md`; the official workflow result and security-results page are the primary evidence. |
| **Baseline** | **Partial historical observation (GAP).** OpenSSF Scorecard CLI v5.5.0 reported **6.6 / 10** for commit `84f77eacb8ad3e94684af0dda90f829c29927e27` at `2026-08-06T07:53:25-07:00`. [Merged PR #936](https://github.com/DeliciousHouse/aries-app/pull/936) records the exact command, archive file mode, 18-check set, and selected per-check values. The complete per-check JSON was not preserved in the versioned repository, so this observation does not meet the full measured-baseline definition. `master` had moved to `89af7950879d3579b05584220cf0fd8a0396e1dc` when rechecked; 6.6 is not a claim about that unscanned commit. |
| **Caveats** | The score reflects observable repository controls, not proof that the application is secure. A policy or workflow proposed in an unmerged pull request does not improve the default-branch baseline. GitHub outages and permission failures must be reported as missing scans, never converted into scores. |

## Reproduction checklist

Every snapshot must include:

1. UTC collection time, default-branch SHA, command or API endpoint, and tool
   version where applicable;
2. the raw numerator and denominator behind every percentage;
3. bot exclusions, duplicate identity mappings, and affiliation gaps;
4. the exact source window returned by GitHub rather than an assumed window;
5. a clear `measured`, `target`, `not applicable`, or `GAP` status; and
6. an independent maintainer review through the normal pull-request process.

If a source is unavailable, retain the previous dated observation and label the
new period `GAP`; do not carry a stale number forward as though it was measured
again.
