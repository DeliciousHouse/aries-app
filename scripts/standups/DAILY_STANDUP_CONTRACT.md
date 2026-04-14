# Daily Standup Contract

Canonical standup path:
- produce the standup transcript in markdown
- archive it under `/home/node/.openclaw/projects/shared/team/meetings`
- let Mission Control read the transcript directly from the shared meetings folder

## Current flow

1. Generate the standup transcript.
2. Save it at:

```bash
/home/node/.openclaw/projects/shared/team/meetings/YYYY-MM-DD-daily-standup.md
```

3. Mission Control reads the transcript from the shared meetings folder.

## Deprecated path

The older per-chief JSON routing report flow under `/home/node/.openclaw/projects/shared/team/standups` is deprecated and should not be used for new standups.

## Notes

- `meetings/` is the canonical home for human-readable standup transcripts.
- `standups/` should be treated as legacy data only.
