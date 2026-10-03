# Governance

Aries AI is stewarded by the repository's project owner and delegated maintainers.
This document describes project authority, not legal ownership or employment.
Historical copyright attribution in `NOTICE` is not a current maintainer roster.

## Roles and rights

- Contributors may report issues, propose changes, review publicly, and nominate
  candidates. Contribution does not grant write, release, or production access.
- Triagers may classify, deduplicate, and scope issues and help newcomers when
  granted the corresponding GitHub permission. They cannot approve merges or releases.
- Maintainers own agreed areas, review independently, and decide whether changes
  are safe to merge. Only the assigned independent reviewer may merge a PR;
  authors and implementation agents do not merge their own work.
- The project owner retains final project-direction and access-grant authority
  during the founder-led stage. Release and operational authority must be
  explicitly delegated; a maintainer role is not automatic production access.

## Nomination and elevation

Open a GitHub issue naming the candidate's public handle, requested role,
maintainer sponsor, public evidence, scope, and the candidate's acceptance.
Triager eligibility: at least three useful issue triage or contributor-support
interactions over 30 days. Maintainer eligibility: at least three merged scoped
PRs and three substantive independent reviews over 90 days, with demonstrated
security, tenant-isolation, and CI judgement. These thresholds are eligibility,
not an entitlement to permissions; bot activity does not qualify a human.

Allow seven calendar days for public feedback. An independent maintainer records
the evidence and recommendation; the project owner decides while founder-led.
Record the decision, delegated scope, and effective date on the issue before
granting least-privilege access. Do not publish private personnel or conduct data.

## Recusal

Authors cannot be their own independent reviewer. Candidates and sponsors do not
decide their own elevation. Disclose relevant conflicts and use a non-conflicted
reviewer; if none exists, defer the decision to the project owner, or defer the
decision itself when the owner is conflicted. Never count a bot as independent
human oversight. Keep security reports out of public nomination threads.

## Inactivity and removal

After 90 days without role activity, ask whether the holder wants to remain active;
allow 30 days to respond, then record inactive status and remove unnecessary
permissions. Return requires confirmation of scope and current review practices.
Resignation is immediate on request. Unsafe access may be suspended immediately;
the project owner records a non-sensitive reason and appoints an independent
reviewer within seven days. Other removals allow seven days for a response and
an independent recommendation. Appeals go to a non-conflicted owner or delegated
maintainer panel; confidential conduct evidence stays private.

## Decision authority

Use issues or PR threads for proposals, alternatives, evidence, and decisions.
Routine scoped changes require independent review and passing current CI under
[CONTRIBUTING.md](CONTRIBUTING.md). Direction, role, or governance changes allow
seven days for feedback; founder-led deadlocks are decided by the project owner
with a recorded rationale. Priorities, in order:

1. Security
2. Tenant isolation
3. Runtime stability
4. Clear self-hosting
5. Compatibility with Aries Cloud / commercial support
6. Contributor experience

## Maintainer rights

Maintainers may close issues or PRs that are:

- unsafe
- out of scope
- unmaintainable
- hostile
- duplicative
- inconsistent with project direction

## Transition stages

Founder-led is the conservative operating model; no community-led stage is
claimed today. The following are transition targets, not measured achievements.
Publish a dated stage decision and supporting evidence in a GitHub issue, linked
from this document, before changing authority. Review progress quarterly using
[the metrics framework](docs/METRICS.md).

| Stage | Entry evidence | Authority |
| --- | --- | --- |
| Founder-led | No published decision demonstrating the next stage | Owner decides direction and role changes; independent reviewer controls each merge |
| Maintainer-led | At least three active human maintainers, including two other than the owner, each with qualifying contributions/reviews in the last 90 days; two consecutive monthly metrics snapshots; documented area ownership and owner delegation | Routine direction and elevations by majority of non-conflicted maintainers (at least two); owner retains reserved legal, spending, and access decisions |
| Community-led | Maintainer-led for six months; at least five active human maintainers across three publicly verified independent affiliations; at least half of merged human-authored PRs in the last 180 days from outside the owner-led team; published election and succession rules accepted through a governance PR | Elected maintainer council decides project policy under the accepted rules; no automatic transfer of legal ownership or infrastructure credentials |

Missing affiliation evidence blocks the relevant stage claim rather than being
counted as independence. If thresholds lapse for two quarterly reviews, record
the gap and a recovery or stage-reversion decision; do not silently retain a
community-led claim. No stage waives security, recusal, or independent review.
