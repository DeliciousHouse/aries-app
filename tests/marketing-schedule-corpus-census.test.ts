import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { censusScheduleCorpus } from '../scripts/marketing/census-schedule-weekdays';

function job(jobId: string, primaryOutput: Record<string, unknown>): Record<string, unknown> {
  return {
    job_id: jobId,
    stages: { publish: { primary_output: primaryOutput } },
  };
}

test('schedule corpus census reads source documents with the production reader', async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-schedule-census-'));
  const jobsRoot = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs');
  await mkdir(jobsRoot, { recursive: true });

  try {
    await Promise.all([
      writeFile(path.join(jobsRoot, 'a.json'), JSON.stringify(job('a', {
        schedule: [
          { recommended_day: 'Monday' },
          { day: 'Tuesday' },
          { recommended_day: 'Wednesday', day: 'Thursday' },
          {},
          { recommended_day: 'Mon' },
        ],
      }))),
      writeFile(path.join(jobsRoot, 'b.json'), JSON.stringify(job('b', {
        weekly_schedule: [{ day: 'Sunday' }],
      }))),
      writeFile(path.join(jobsRoot, 'nested.json'), JSON.stringify(job('nested', {
        publish_package: { schedule: [{ day: 'Friday' }] },
      }))),
      writeFile(path.join(jobsRoot, 'invalid.json'), '{'),
    ]);

    const census = await censusScheduleCorpus(dataRoot);
    assert.equal(census.corpusPath, jobsRoot);
    assert.deepEqual({ ...census, corpusPath: '<root>' }, {
      corpusPath: '<root>',
      documents: 4,
      invalidDocuments: ['invalid.json'],
      documentsWithAnyScheduleKey: ['a.json', 'b.json', 'nested.json'],
      documentsWithAnyWeekdayKey: ['a.json', 'b.json', 'nested.json'],
      readableScheduleDocuments: ['a.json', 'b.json'],
      readableEntries: 6,
      recommendedDayOnlyEntries: 2,
      dayOnlyEntries: 2,
      bothWeekdayFieldsEntries: 1,
      noWeekdayFieldEntries: 1,
      recognizedWeekdayEntries: 4,
      unparseableWeekdayEntries: [{ document: 'a.json', index: 4, value: 'Mon' }],
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
