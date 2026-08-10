# Hermes SOUL patches

Patches for the Hermes marketing persona files that live **outside this repo**, on
the host at `~/.hermes/profiles/<profile>/SOUL.md`. Nothing here is applied
automatically — not by a build, not by a container start, not by CI. They are
committed so the prompt change is reviewable in the PR alongside the code change
it pairs with, and applied by hand at deploy time.

Each patch is generated with `diff -u` against the live file at the commit that
introduced it, so it applies with `-p1` from inside the profile directory.

## Patches

| File | Target profile | What it changes |
| --- | --- | --- |
| `aries-strategist-SOUL.growth-objective.patch` | `aries-strategist` (strategy + publish stages) | Adds a growth-objective bullet (`followers_delta` + per-post engagement as the definition of success, subordinated to an explicitly stated campaign goal) and widens platform coverage beyond a hardcoded "(Instagram, Facebook)". |

## Applying

```bash
cd ~/.hermes/profiles/aries-strategist
cp SOUL.md "SOUL.md.bak-$(date -u +%Y%m%dT%H%M%SZ)"
patch -p1 --dry-run < /path/to/aries-strategist-SOUL.growth-objective.patch   # must print "checking file SOUL.md" and nothing else
patch -p1 < /path/to/aries-strategist-SOUL.growth-objective.patch
```

Then restart the strategist gateway (**port 8654**) so a warm process re-reads the
SOUL, and confirm the process on :8654 is genuinely serving
`--profile aries-strategist`. This matters: the research profile is NOT actually
served on its own gateway (marketing research falls through to the generalist
Operator gateway on :8642), and the same failure mode would make this patch inert
without any error.

Rollback: restore the `SOUL.md.bak-*` copy and restart the gateway.

## Why a patch and not the file itself

The SOULs are shared host state edited by more than one system; vendoring a whole
copy into this repo would invite a silent overwrite of changes made on the host.
A patch fails loudly (`Hunk #1 FAILED`) when the live file has drifted, which is
the correct behaviour — re-generate the patch against the current live file
rather than forcing it.

## Verifying the effect

The `aries-strategist` SOUL is loaded by the gateway, not by this app, so there
is no test that can assert it. The equivalent instruction ships in the code path
too — `GROWTH_OBJECTIVE_KPI` in `backend/marketing/ports/hermes.ts`, covered by
`tests/marketing/growth-objective.test.ts` — precisely so the behaviour does not
depend on whether this patch was applied. Keep the two wordings aligned: if the
subordination clause changes in one, change it in the other.
