# memory/

This directory is operator-local and starts empty on a fresh clone.

The automation scripts (`scripts/automations/daily-brief.mjs`, `scripts/automations/weekly-review.mjs`) write dated Markdown notes here at runtime. These files are gitignored — they contain instance-specific session context and should never be committed.
