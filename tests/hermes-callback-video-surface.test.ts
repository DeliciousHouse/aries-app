import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readWeeklySchedule,
  type WeeklyScheduleEntry,
} from '../backend/marketing/hermes-callbacks';
import type { SocialContentJobRuntimeDocument } from '../backend/marketing/runtime-state';

function docWithSchedule(schedule: unknown[]): SocialContentJobRuntimeDocument {
  return {
    stages: { publish: { primary_output: { schedule } } },
  } as unknown as SocialContentJobRuntimeDocument;
}

test('readWeeklySchedule preserves placement + media_type on a reel/video entry', () => {
  const doc = docWithSchedule([
    {
      post_number: 1,
      recommended_day: 'Monday',
      platforms: ['instagram'],
      placement: 'reel',
      media_type: 'video',
    },
  ]);
  const entries = readWeeklySchedule(doc);
  assert.equal(entries.length, 1);
  const e = entries[0] as WeeklyScheduleEntry;
  assert.equal(e.placement, 'reel');
  assert.equal(e.media_type, 'video');
});

test('readWeeklySchedule preserves per-target placement/media_type', () => {
  const doc = docWithSchedule([
    {
      post_number: 2,
      recommended_day: 'Tuesday',
      platform_targets: [
        { platform: 'instagram', placement: 'story', media_type: 'video' },
        { platform: 'facebook', placement: 'feed', media_type: 'image' },
      ],
    },
  ]);
  const entries = readWeeklySchedule(doc);
  const targets = (entries[0] as WeeklyScheduleEntry).platform_targets ?? [];
  assert.equal(targets[0]?.placement, 'story');
  assert.equal(targets[0]?.media_type, 'video');
  assert.equal(targets[1]?.placement, 'feed');
});

test('legacy schedule entry without placement/media_type yields undefined (defaulted downstream to feed/image)', () => {
  const doc = docWithSchedule([
    { post_number: 3, recommended_day: 'Wednesday', platforms: ['facebook'] },
  ]);
  const e = readWeeklySchedule(doc)[0] as WeeklyScheduleEntry;
  assert.equal(e.placement, undefined);
  assert.equal(e.media_type, undefined);
});
