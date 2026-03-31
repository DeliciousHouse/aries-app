export const automationJobs = [
  {
    id: 'aries-private-repo-backup',
    name: 'Aries private repo backup',
    cron: '15 */6 * * *',
    tz: 'America/Los_Angeles',
    script: 'node scripts/automations/private-repo-backup.mjs',
    purpose: 'Stage, commit, and push repo state to the configured private GitHub remote.',
  },
  {
    id: 'aries-overnight-self-improve',
    name: 'Aries overnight self-improvement',
    cron: '30 1 * * *',
    tz: 'America/Los_Angeles',
    script: 'node scripts/automations/overnight-self-improve.mjs',
    purpose: 'Rotate a nightly audit, apply low-risk cleanup, and log results to memory/YYYY-MM-DD.md.',
  },
  {
    id: 'aries-daily-brief',
    name: 'Aries daily brief',
    cron: '0 8 * * *',
    tz: 'America/Los_Angeles',
    script: 'node scripts/automations/daily-brief.mjs',
    purpose: 'Generate the morning priorities/overnight activity/pending actions brief.',
  },
  {
    id: 'aries-system-reference-rollup',
    name: 'Aries rolling system reference',
    cron: '45 21 * * *',
    tz: 'America/Los_Angeles',
    script: 'node scripts/automations/rolling-system-reference.mjs',
    purpose: 'Update docs/SYSTEM-REFERENCE.md with architecture, inventory, cron jobs, and known issues.',
  },
]
