# Project metrics

This is a measurement contract, not evidence that a grant target was achieved.
Maintainers collect monthly UTC snapshots and submit them through independently
reviewed PRs at `docs/metrics/YYYY-MM.md`. That directory and snapshot automation
are not implemented by this document. Missing evidence is GAP, never zero.
Targets, when adopted in an issue, must be published separately from measured
values. No growth, adoption, retention, or security-score target is claimed met.

## Collection and identity rules

Record collection time, default-branch SHA, source commands/API and tool versions,
numerator/denominator, exclusions, identity mapping evidence, missing data, and
window. Use `origin/master`, not `--all`: rejected proposal and recovery branches
must not inflate counts. Collect paginated GitHub data, for example:

```bash
git fetch origin
git rev-parse origin/master
git shortlog -sn origin/master
gh api --paginate 'repos/DeliciousHouse/aries-app/pulls?state=all&per_page=100'
gh api --paginate 'repos/DeliciousHouse/aries-app/contributors?per_page=100'
```

Inspect author identity data locally without publishing private email addresses.
Exclude GitHub Bot accounts, `[bot]` signatures and known automation identities
(including agent accounts typed as User). Publish the exclusion rules, not raw
personal data. Deduplicate only with exact identity reuse or corroborating public
profiles; keep ambiguous aliases separate and state that ceiling. Do not infer
employment from an email domain. Classify internal/external only with current
positive evidence; otherwise use unclassified. Affiliation-dependent denominators
must report coverage and GAP when classification is incomplete. PR coauthors and
squashed author signatures are not automatically independent contributors.

Observation date: 2026-10-03; base `29884c0142c0351582787b39fae88ffa088f4594`.
The live repository is public and Apache-2.0; GitHub Releases count is zero, so
public-release month is GAP. Successful image workflow runs are not GitHub Releases.
The Scorecard workflow exists and the run on this base succeeded; that fact is
not a measured Scorecard rating. Historical PR #949 is closed unmerged, not an
accepted governance policy or a baseline snapshot.

## 1. Contributor growth

- Formula: distinct eligible human contributors whose first merged PR to master falls in the month; growth percentage = 100 × (this month's active humans − prior month's active humans) / prior month's active humans. Active means at least one merged authored PR in that month.
- Unit: people and percent; zero prior denominator gives N/A, not infinite growth.
- Source: paginated GitHub pulls (author, created_at, merged_at, base.ref), public identity evidence, and default-branch git history as a cross-check.
- Cohort/window: calendar UTC month; all-history first-merge lookup; internal, external, and unclassified reported separately, excluding bots.
- Cadence: monthly.
- Owner: delegated community-metrics maintainer; project owner until delegated.
- Publication: reviewed `docs/metrics/YYYY-MM.md` with source SHA and identity coverage.
- Baseline (2026-10-03): GAP — no reviewed monthly first-merge/active-human snapshot exists.
- Caveats: commits, API contributor totals, stars, and PR coauthors are not this metric; alias ambiguity and missing author accounts limit completeness.

## 2. Contributor retention

- Formula: 100 × humans with a merged PR in both month M and M+1 / humans with a merged PR in month M; publish numerator and denominator.
- Unit: percent; empty month-M cohort gives N/A.
- Source: the same paginated merged-PR and identity dataset as growth.
- Cohort/window: UTC calendar-month M cohort followed through the complete next month, stratified by known affiliation and unclassified identities; bots excluded.
- Cadence: monthly, one month in arrears.
- Owner: community-metrics maintainer, or project owner until delegated.
- Publication: reviewed `docs/metrics/YYYY-MM.md` naming both months.
- Baseline (2026-10-03): GAP — no complete paired monthly cohort has been published.
- Caveats: current-month cohorts are censored and cannot be reported as churn; vacation, project demand, and small denominators affect interpretation. Report absolute cohort size.

## 3. Time to first merged PR

- Formula: for each human's first merged PR to master, elapsed hours = (merged_at − created_at) / 3600; publish median and nearest-rank p90, plus sample size. This measures PR review latency, not time since discovering the project.
- Unit: hours per person; empty samples give N/A.
- Source: paginated GitHub pulls across all history; retain base.ref, author, created_at, merged_at, and first-merge identity evidence.
- Cohort/window: people whose first merge occurred in the UTC reporting month; exclude bots; report external/internal/unclassified separately.
- Cadence: monthly.
- Owner: review-process maintainer, or project owner until delegated.
- Publication: reviewed `docs/metrics/YYYY-MM.md`; public PR numbers suffice, no private profiles.
- Baseline (2026-10-03): GAP — no reproducible first-merge latency snapshot exists.
- Caveats: unmerged first PRs are right-censored, not zero hours; publish their count and age separately. A later-created PR may merge first; select by earliest merged_at, not issue number. Closed rejected PRs are not merges.

## 4. Adoption

- Formula: count distinct independently operated installations with affirmative, public, dated evidence of use in the last 90 days. Report stars and forks separately as interest proxies, never add them to installations.
- Unit: installations; no telemetry coverage means GAP, not zero adoption.
- Source: voluntarily public GitHub issue/PR deployment reports with operator consent; repository API for separately labeled stars/forks. No new telemetry or private tenant-data collection is authorized here.
- Cohort/window: rolling 90 days ending at snapshot time; exclude CI, demos, bot reports, duplicate installations, and the project's own test stack.
- Cadence: monthly.
- Owner: community-metrics maintainer, or project owner until delegated.
- Publication: reviewed `docs/metrics/YYYY-MM.md` with consenting public evidence and coverage limits.
- Baseline (2026-10-03): GAP — no reviewed independent-installation dataset exists.
- Caveats: self-reporting is incomplete and selected; image pulls are not unique users or installs. Never expose tenant identities or infer installations from stars.

## 5. Dependency health

- Formula: count unique vulnerable dependency/advisory pairs by severity in the locked tree; remediation age in days = snapshot UTC time − first recorded detection time. Separately count direct dependencies with available newer versions / total direct dependencies.
- Unit: vulnerable pairs by severity, days, and outdated direct dependencies / total.
- Source: `npm audit --json`, `npm outdated --json`, `package-lock.json`, `package.json`, and previous dated snapshots for first detection. Preserve tool version, exit code, advisory IDs, and registry time; audit/outdated may return nonzero when findings exist.
- Cohort/window: exact default-branch lockfile at collection; include production and development dependencies but report them separately; age requires historic first-detection evidence.
- Cadence: monthly and after material dependency/security changes.
- Owner: dependency/security maintainer, or project owner until delegated.
- Publication: reviewed `docs/metrics/YYYY-MM.md` with sanitized aggregate results.
- Baseline (2026-10-03): GAP — no dated audit/outdated/first-detection baseline collected for this proposal.
- Caveats: do not sum npm's package-level vulnerability counts as unique advisories. Newer is not necessarily vulnerable; absent registry data is GAP. Bot remediation PRs may improve health but do not increase human growth/retention.

## 6. OpenSSF Scorecard

- Formula: report the service's overall score and each named check score verbatim (0–10); do not calculate a substitute overall average. Flag unavailable checks separately.
- Unit: service-reported score out of 10.
- Source: `.github/workflows/scorecard.yml`, its run/artifact, and the public Scorecard API for `github.com/DeliciousHouse/aries-app`; record result date, analyzed SHA and Scorecard version.
- Cohort/window: latest available default-branch analysis as of snapshot time; stale SHA/date must be explicit.
- Cadence: workflow runs weekly, on master pushes and branch-protection changes; maintainer publishes monthly snapshot.
- Owner: supply-chain maintainer, or project owner until delegated.
- Publication: README badge/public Scorecard service and reviewed `docs/metrics/YYYY-MM.md` containing the dated numeric result.
- Baseline (2026-10-03): GAP — workflow success observed on base SHA, but no numeric service result collected for this proposal.
- Caveats: workflow success is not a rating or security certification. Do not equate a historical badge, unpublished artifact, or target score with a current measurement.
