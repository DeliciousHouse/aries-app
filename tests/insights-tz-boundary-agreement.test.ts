import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { tenantZoneDow, tenantZoneDateKey, tenantZoneParts } from '../lib/format-timestamp';
import { DOW_NAMES } from '../backend/insights/attention/attention-snapshot-builder';
import { DAY_LABELS, dowToRow, fmtHour } from '../backend/insights/audience/audience-builder';

// S2-4 / AA-95 (Gap E5, tz portion) — day-boundary timezone AGREEMENT guardrail.
//
// Proves the S2-3 fix: an event at 23:30 local in a UTC-05:00 tenant timezone
// (late-night local, but already the NEXT day in UTC) is attributed to the SAME
// tenant calendar day by BOTH the audience peakWindow and the attention dayName.
// If either section slipped back to UTC bucketing, its day flips to Friday and
// the assertions (anchored to the EXPECTED tenant day, Thursday) fail.
//
// Runs in `npm run verify` — pure + no DB (the tz math is the JS mirror the SQL
// `EXTRACT(DOW ... AT TIME ZONE $tz)` implements, driven through each section's
// REAL labeling helpers; the source-guard below pins the builder SQL itself).
// This is deliberately CI-enforced on every PR, unlike the S2-3/S2-1
// requires-infra tests that self-skip without a database.
//
// trends is EXCLUDED BY DESIGN: S2-3 deferred all trends bucketing (backlog
// item 2). Its account series is keyed on a bare DATE column that cannot be
// re-bucketed read-side, and it shares one chart axis with the comments series,
// so a partial tenant-tz fix would misalign the two. The source-guard below pins
// trends' current UTC bucketing; WHEN ITEM 2 LANDS, flip that pin and ADD trends
// to the agreement assertion here.

const TZ = 'America/New_York';                     // January = EST = UTC-05:00 (not DST)
const BOUNDARY = new Date('2026-01-16T04:30:00Z'); // = Thu 2026-01-15 23:30 EST ; Fri 2026-01-16 UTC

const EXPECTED_DAY_KEY = '2026-01-15';
const EXPECTED_DOW     = 4;            // Thursday (0=Sun..6=Sat), matches Postgres EXTRACT(DOW)
const UTC_DOW          = 5;            // Friday — what UTC bucketing would give

test('fixture sanity: the instant straddles the day boundary (tenant Thu vs UTC Fri)', () => {
  assert.equal(tenantZoneDateKey(BOUNDARY, TZ), EXPECTED_DAY_KEY, 'tenant calendar day = 2026-01-15');
  assert.equal(tenantZoneDow(BOUNDARY, TZ), EXPECTED_DOW, 'tenant DOW = Thursday (4)');
  assert.equal(tenantZoneParts(BOUNDARY, TZ)?.hour, 23, 'tenant local hour = 23');
  assert.equal(BOUNDARY.toISOString().slice(0, 10), '2026-01-16', 'UTC day = 2026-01-16');
  assert.equal(BOUNDARY.getUTCDay(), UTC_DOW, 'UTC DOW = Friday (5)');
  assert.notEqual(EXPECTED_DOW, UTC_DOW, 'tenant and UTC land on different days — the boundary case');
});

test('audience peakWindow and attention dayName agree on the tenant day (== Thursday, != UTC Friday)', () => {
  const tenantDow  = tenantZoneDow(BOUNDARY, TZ)!;
  const tenantHour = tenantZoneParts(BOUNDARY, TZ)!.hour;

  // Each section's REAL labeling helper, fed the tenant-tz dow/hour.
  const attentionDayName = DOW_NAMES[tenantDow];                 // attention section
  const audienceDay      = DAY_LABELS[dowToRow(tenantDow)];      // audience section
  const audienceHour     = fmtHour(tenantHour);                  // audience section

  // Anchored to the EXPECTED tenant day — not just mutual agreement — so a revert
  // to UTC in EITHER or BOTH sections (which would agree on Friday) still fails.
  assert.equal(attentionDayName, 'Thursday', 'attention dayName = Thursday');
  assert.equal(audienceDay,      'Thu',      'audience peakWindow.day = Thu');
  assert.equal(audienceHour,     '11 PM',    'audience peakWindow.hour = 11 PM');

  // Cross-section: both name the same weekday.
  assert.equal(audienceDay, attentionDayName.slice(0, 3), 'audience + attention name the same day');

  // And the UTC computation would disagree — the fails-before contrast.
  assert.equal(DOW_NAMES[UTC_DOW],            'Friday', 'UTC DOW would be Friday');
  assert.equal(DAY_LABELS[dowToRow(UTC_DOW)], 'Fri',    'UTC audience day would be Fri');
  assert.notEqual(attentionDayName, DOW_NAMES[UTC_DOW],            'attention must not match the UTC day');
  assert.notEqual(audienceDay,      DAY_LABELS[dowToRow(UTC_DOW)], 'audience must not match the UTC day');
});

test('source-guard: audience + attention bucket in tenant-tz ($tz); trends still UTC (deferred, item 2)', () => {
  const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '..', p), 'utf8');
  const attention = read('backend/insights/attention/attention-snapshot-builder.ts');
  const audience  = read('backend/insights/audience/audience-builder.ts');
  const trends    = read('backend/insights/trends/trends-snapshot-builder.ts');

  // Fixed sections: DOW/HOUR bucketed via the tenant tz param ($n), never 'UTC'.
  assert.match(attention, /EXTRACT\(DOW FROM p\.published_at AT TIME ZONE \$\d\)/,
    'attention best-day-of-week must bucket in the tenant tz ($n)');
  assert.doesNotMatch(attention, /published_at AT TIME ZONE 'UTC'/,
    'attention must not revert to UTC DOW bucketing');
  assert.match(audience, /EXTRACT\(DOW\s+FROM \(received_at AT TIME ZONE \$\d\)\)/,
    'audience heatmap DOW must bucket in the tenant tz ($n)');
  assert.match(audience, /EXTRACT\(HOUR FROM \(received_at AT TIME ZONE \$\d\)\)/,
    'audience heatmap HOUR must bucket in the tenant tz ($n)');
  assert.doesNotMatch(audience, /received_at AT TIME ZONE 'UTC'/,
    'audience must not revert to UTC bucketing');

  // trends is DEFERRED (backlog item 2): its comments series shares one chart axis
  // with the write-side-bound bare-DATE account series, so it stays UTC for now.
  // WHEN ITEM 2 LANDS: delete this pin and add trends to the agreement test above.
  assert.match(trends, /received_at AT TIME ZONE 'UTC'/,
    'trends comments series is intentionally still UTC (item 2) — update S2-4 when fixed');
});
