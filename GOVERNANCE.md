# Governance

Aries AI is currently stewarded by Sugar & Leather, LLC. This document governs
public participation in this repository. It defines roles rather than naming
individuals so that authority can be checked from public issue, pull-request,
and repository evidence.

## Roles and permissions

### Contributor

A contributor is anyone who opens a useful issue, submits a pull request,
improves documentation, reports a reproducible problem, or participates
constructively in review.

Contributors may:

- propose and discuss work through GitHub Issues and pull requests;
- submit changes from a fork; and
- review public changes and provide evidence.

The role does not grant label, write, merge, release, or security-response
permissions.

### Triager

A triager is a contributor trusted to keep the public work queue useful.
Triagers may apply labels, identify duplicates, request missing reproduction
details, connect related issues, and recommend that an issue be accepted or
closed. They must explain a close or scope decision on the issue.

Triagers cannot push branches in this repository, merge pull requests, publish
releases, change repository settings, or handle confidential vulnerability
reports unless they separately hold a role that permits it.

### Maintainer

A maintainer is trusted with repository write access and project decisions.
Maintainers may review and merge pull requests, close or reopen issues, manage
labels and milestones, revert changes, and make deprecation or release
decisions. Only maintainers may change protected workflows, repository
settings, or public release state.

Maintainers must not push directly to `master`. They use the same short-lived
branch and pull-request path as other contributors, preserve required checks,
and arrange an independent maintainer review of their implementation pass.

## Nomination and elevation

Role changes use public evidence. A nomination is opened as a GitHub issue and
links the candidate's qualifying issues, pull requests, reviews, and conduct
record. The candidate must accept before a decision is made.

- **Contributor to triager:** at least three substantive public contributions
  over at least 30 days, including one issue reproduction or review; no
  unresolved conduct or security-handling concern; and one maintainer sponsor.
- **Triager to maintainer:** at least five accepted contributions and three
  useful triage or review decisions over at least 90 days; demonstrated care in
  a sensitive or cross-cutting area; and one maintainer sponsor who is not the
  candidate.

All non-recused active maintainers may vote for seven calendar days. Elevation
requires a simple majority and at least two affirmative votes when two or more
non-recused maintainers are available. During the founder-led stage, if only
one non-recused maintainer is available, the founding steward records the
decision and evidence publicly. Meeting a threshold makes a candidate eligible;
it does not make elevation automatic.

## Decisions and review

Maintainers apply these priorities, in order:

1. security and protection of private data;
2. tenant isolation and authorization boundaries;
3. runtime and publishing safety;
4. maintainable, testable self-hosting;
5. compatibility with the documented open-source product; and
6. contributor and operator experience.

A routine change may be accepted by one maintainer after required CI passes and
the independent review is recorded. Security-boundary, governance, licensing,
repository-policy, and release-process changes require two non-recused
maintainer votes when two are available. If evidence is incomplete, the safe
decision is to request changes, narrow the scope, or defer it rather than guess.

Maintainers may close or reject work that is unsafe, out of repository scope,
unmaintainable, hostile, duplicative, unsupported by evidence, or inconsistent
with documented project direction. The reason must be written on the issue or
pull request. A contributor may ask for reconsideration once with new evidence.

## Recusal

A decision-maker must disclose and recuse when they authored the change under
review, have a material financial or personal conflict, are the subject of a
conduct complaint, or cannot evaluate confidential security evidence
independently. Authorship does not prevent implementation, but another
maintainer must perform the independent review. A recused maintainer does not
count toward the vote denominator or quorum. The public record notes the
recusal without disclosing confidential or personal information.

## Inactivity and removal

An active triager or maintainer has performed at least one public triage,
review, merge, governance vote, release action, or documented security-response
action in the previous 180 days. After 180 days without qualifying activity, a
maintainer opens a notice issue and allows 30 days for the person to return or
request a leave. Without a response, the role moves to emeritus and repository
permissions are removed. Emeritus members may be restored through the same
public nomination process, with prior evidence considered.

Removal for serious misconduct, repeated unsafe handling, undisclosed conflict,
or abuse of access may happen immediately to protect the project. Two
non-recused maintainers must confirm the removal within seven days when two are
available; founder-led fallback authority applies otherwise. The public record
states the policy basis while protecting confidential reports.

## Governance transition stages

Stage changes are proposed and recorded in a governance pull request. Counts
exclude bots and duplicate identities and use public evidence from the trailing
window.

### Founder-led (current)

This is the current stage while the repository has fewer than three active
maintainers or cannot demonstrate a retained external-contributor cohort.
Maintainers decide routine changes; the founding steward has final authority
for tied, legal, licensing, security, and stage-transition decisions.

The project may exit after a continuous 90-day window with at least three
active maintainers, at least one maintainer whose affiliation is independent of
the founding steward, and at least two external contributors who each return
with a second accepted contribution at least 30 days after their first.

### Maintainer-led

At entry, the active maintainer body holds decision authority by simple
majority, subject to recusal and the two-vote rules above. The founding steward
has one vote and no unilateral veto except where applicable law or ownership of
credentials and trademarks requires it.

The project returns to founder-led if it remains below three active maintainers
for 60 consecutive days. It may exit to community-led after a continuous
180-day window with at least five active maintainers across at least three
independent affiliations and at least four retained external contributors.

### Community-led

At entry, the active maintainer body has final repository and release authority.
Governance, licensing, and stage changes require a two-thirds majority of
non-recused active maintainers; routine changes continue to use a simple
majority. No single employer or affiliation may supply a majority of the
eligible votes for a governance or licensing decision.

The project returns to maintainer-led if it remains below five active
maintainers or three independent affiliations for 90 consecutive days. A stage
change never removes legal ownership of trademarks, infrastructure, or private
credentials; it changes authority over this repository and its public release
process.

## Release governance

The current default branch contains a tag-triggered workflow that can publish a
container image to GHCR, and pushes to `master` drive the separate production
deployment workflow. Those capabilities are not the same as a versioned public
release. As of 2026-08-06 the repository has no GitHub Releases, and
`docs/RELEASES.md` is not present on `master`; the proposed signed-release
policy and first public release are therefore pending, not current capability.

If a release-policy change lands, `docs/RELEASES.md` becomes the detailed source
for versioning, artifacts, signatures, cadence, and release procedure. This
document remains the source for who may authorize a release: a maintainer after
required checks and independent review, with the voting rules above for a
release-process change. A Git tag, package version, deployment, or changelog
entry must not be described as a GitHub Release unless the corresponding public
release exists.

## Amending this document

Governance changes use a focused pull request, public rationale, required CI,
and independent maintainer review. The applicable stage's voting rule must be
recorded before merge. No amendment can override the Code of Conduct, security
reporting policy, or repository license.
