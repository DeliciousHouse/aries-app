# Hermes SOUL patches

Patches for the Hermes marketing persona files that live **outside this repo**, on
the host at `~/.hermes/profiles/<profile>/SOUL.md`. Nothing here is applied
automatically — not by a build, not by a container start, not by CI. They are
committed so the prompt change is reviewable in the PR alongside the code change
it pairs with, and applied by hand at deploy time.

Each patch is generated with `diff -u` against the live file at the commit that
introduced it, so it applies with `-p1` from inside the profile directory.

## Patches

| File | Target profile | Gateway | What it changes |
| --- | --- | --- | --- |
| `aries-strategist-SOUL.growth-objective.patch` | `aries-strategist` (strategy + publish stages) | `:8654` | Adds a growth-objective bullet (`followers_delta` + per-post engagement as the definition of success, subordinated to an explicitly stated campaign goal) and widens platform coverage beyond a hardcoded "(Instagram, Facebook)". |
| `aries-strategist-SOUL.platform-native.patch` | `aries-strategist` (strategy + publish stages) | `:8654` | AA-217 v2. Adds per-network copy conventions (hook budget, length, hashtag policy, link policy, CTA convention for instagram/facebook/linkedin/x/reddit) and the optional `hashtags` + `platform_variants` output fields. **Every addition is CONDITIONAL on the run input naming target platforms** — see "Why these are conditional". |
| `aries-content-generator-SOUL.platform-native.patch` | `aries-content-generator` (production stage) | `:8655` | AA-217 v2. Reconciles the SOUL's flat "Do NOT write or rewrite copy" with the port's `PRODUCTION_EXECUTION_CONTRACT`, which has always required this stage to return `content_package[]`: copy (including `platform_variants`) passes through VERBATIM, and hashtags are fabricated only where Stage 2 omitted them, honouring the per-platform policy. Also conditional. |

Gateway ports verified on the host on 2026-08-11:

```
$ ps aux | grep 'hermes_cli.main --profile'
… --profile aries-strategist gateway run          # listening on :8654
… --profile aries-content-generator gateway run   # listening on :8655
… --profile aries-research gateway run
```

`:8642` is the default/generalist Operator gateway. Marketing research still falls
through to it (the research profile is not served on its own port), which is why
no research patch exists here.

## Drift status as of 2026-08-11 — READ THIS FIRST

`aries-strategist-SOUL.growth-objective.patch` **is not applied on this host.**
Verified directly: the live `~/.hermes/profiles/aries-strategist/SOUL.md` still
carries the unmodified "Your turf" paragraph ending `platform adaptation
(Instagram, Facebook).` and has no growth-objective bullet. The table above
describing it as widening platform coverage documents the patch's *intent*, not
the live file's state.

Live file hashes the platform-native patches were generated against:

```
11b23b0bbe14182c4dbb8b0875613e8ca353e80e2d77f5e55b4384720fc72235  aries-strategist/SOUL.md
e0ee7ecf9ab89047d66413f824bdc7900ae0780059a3db012d8f255cf69e8078  aries-content-generator/SOUL.md
```

If a hash no longer matches, the live file has drifted: **regenerate the patch
against the current file rather than forcing it.**

## Apply order

The two strategist patches touch **disjoint regions** of `SOUL.md`
(growth-objective: the "Your turf" paragraph at line 16 and an insertion before
line 20; platform-native: an insertion after line 25 and the "Hard rules" schema
at lines 40-53). That is deliberate, and it was verified rather than assumed:

- Both patches apply at **`--fuzz=0`** in **either order**.
- Both orders converge to a **byte-identical** result.

Recommended order (growth-objective first, since it is the older, still-unapplied
patch):

```bash
cd ~/.hermes/profiles/aries-strategist
cp SOUL.md "SOUL.md.bak-$(date -u +%Y%m%dT%H%M%SZ)"
patch -p1 --dry-run --fuzz=0 < .../aries-strategist-SOUL.growth-objective.patch   # must print "checking file SOUL.md" and nothing else
patch -p1 --fuzz=0            < .../aries-strategist-SOUL.growth-objective.patch
patch -p1 --dry-run --fuzz=0 < .../aries-strategist-SOUL.platform-native.patch    # applies at offset +1; that is expected, not fuzz
patch -p1 --fuzz=0            < .../aries-strategist-SOUL.platform-native.patch
```

Then, separately:

```bash
cd ~/.hermes/profiles/aries-content-generator
cp SOUL.md "SOUL.md.bak-$(date -u +%Y%m%dT%H%M%SZ)"
patch -p1 --dry-run --fuzz=0 < .../aries-content-generator-SOUL.platform-native.patch
patch -p1 --fuzz=0            < .../aries-content-generator-SOUL.platform-native.patch
```

Always use `--fuzz=0`. A fuzzy apply on a persona file silently lands text in the
wrong section, and there is no test that would catch it.

Restart the gateway for each profile you patched so a warm process re-reads the
SOUL — the strategist on **:8654**, the content generator on **:8655** — and
confirm the process on that port is genuinely serving the profile you think it
is (`ps aux | grep 'hermes_cli.main --profile'`). This matters: the research
profile is NOT served on its own gateway, and the same failure mode would make a
patch inert without any error.

Rollback: restore the `SOUL.md.bak-*` copy and restart the gateway.

## Why these are conditional (the tenant-15 rule)

A SOUL serves **every tenant** routed through that gateway. There is no per-tenant
persona. An unconditional persona edit therefore changes the output of a tenant
that is publishing today — outside any feature flag, and with no way to roll it
back other than un-patching the host.

So every clause the platform-native patches add is gated on the run input naming
target platforms, and each says so explicitly ("When the input names NO
platforms, behave exactly as before"). The input only ever names platforms when
`ARIES_PLATFORM_NATIVE_CONTENT_ENABLED` is on for that tenant, so these patches
are **inert until the flag flips** and are safe to apply before it.

## Why a patch and not the file itself

The SOULs are shared host state edited by more than one system; vendoring a whole
copy into this repo would invite a silent overwrite of changes made on the host.
A patch fails loudly (`Hunk #1 FAILED`) when the live file has drifted, which is
the correct behaviour — re-generate the patch against the current live file
rather than forcing it.

## Verifying the effect

A SOUL is loaded by the gateway, not by this app, so no test can assert it.
**Behaviour must not depend on whether a patch was applied**, and it does not:
the equivalent instruction ships on the code path too, and that is what is
tested.

| Patch | Code-path twin | Test |
| --- | --- | --- |
| growth-objective | `GROWTH_OBJECTIVE_KPI` (`backend/marketing/ports/hermes.ts`) | `tests/marketing/growth-objective.test.ts` |
| platform-native (both) | `PLATFORM_COPY_DIRECTIVES` / `renderPlatformVariantsContract` (`backend/social-content/platform-copy-directives.ts`), rendered into the strategy instructions and the production contract | `tests/platform-native-prompts.test.ts` |

Keep the wordings aligned: if a per-network convention or the subordination
clause changes in one, change it in the other.
