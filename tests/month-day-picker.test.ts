import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

import { MonthDayPicker, isNearYearEnd } from '../frontend/marketing/month-day-picker';

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// --- Pure date-math unit tests ---

test('isNearYearEnd: June 15 → false (far from year end)', () => {
  const year = new Date().getFullYear();
  assert.equal(isNearYearEnd(new Date(`${year}-06-15`)), false);
});

test('isNearYearEnd: Dec 10 → true (within 30 days of Dec 31)', () => {
  const year = new Date().getFullYear();
  assert.equal(isNearYearEnd(new Date(`${year}-12-10`)), true);
});

test('isNearYearEnd: Dec 1 → true (30 days before Dec 31)', () => {
  const year = new Date().getFullYear();
  assert.equal(isNearYearEnd(new Date(`${year}-12-01`)), true);
});

test('isNearYearEnd: Nov 30 → false (31 days before Dec 31)', () => {
  const year = new Date().getFullYear();
  assert.equal(isNearYearEnd(new Date(`${year}-11-30`)), false);
});

// --- Rendered component tests using react-test-renderer ---

test('emits empty string until both month AND day are selected', async () => {
  const { act, create } = await import('react-test-renderer');

  const emitted: string[] = [];

  let root!: import('react-test-renderer').ReactTestRenderer;
  await act(async () => {
    root = create(
      React.createElement(MonthDayPicker, {
        value: '',
        onChange: (v: string) => emitted.push(v),
        ariaLabel: 'Test date',
      }),
    );
    await flushMicrotasks();
  });

  const selects = root.root.findAllByType('select');
  const monthSelect = selects.find((s) => s.props['aria-label'] === 'Month');
  assert.ok(monthSelect, 'Month select not found');

  // Select month only — should emit ''
  await act(async () => {
    monthSelect!.props.onChange({ target: { value: '6' } });
    await flushMicrotasks();
  });
  assert.equal(emitted[emitted.length - 1], '');

  // Now also select day — should emit a full date
  const daySelect = root.root.findAllByType('select').find((s) => s.props['aria-label'] === 'Day');
  assert.ok(daySelect, 'Day select not found');
  await act(async () => {
    daySelect!.props.onChange({ target: { value: '14' } });
    await flushMicrotasks();
  });
  const last = emitted[emitted.length - 1];
  assert.match(last, /^\d{4}-06-14$/);
});

test('Feb has 29 days in leap year 2024, 28 days in non-leap 2025', () => {
  // Verify via daysInMonth logic: new Date(year, 2, 0).getDate()
  assert.equal(new Date(2024, 2, 0).getDate(), 29, 'leap year Feb should have 29 days');
  assert.equal(new Date(2025, 2, 0).getDate(), 28, 'non-leap year Feb should have 28 days');
});

test('changing month from March to April when day=31 clears day and emits empty', async () => {
  const { act, create } = await import('react-test-renderer');

  const emitted: string[] = [];

  let root!: import('react-test-renderer').ReactTestRenderer;
  await act(async () => {
    root = create(
      React.createElement(MonthDayPicker, {
        value: '',
        onChange: (v: string) => emitted.push(v),
        ariaLabel: 'Test date',
      }),
    );
    await flushMicrotasks();
  });

  const getSelects = () => root.root.findAllByType('select');
  const monthSelect = () => getSelects().find((s) => s.props['aria-label'] === 'Month')!;
  const daySelect = () => getSelects().find((s) => s.props['aria-label'] === 'Day')!;

  // Select March (month=3)
  await act(async () => {
    monthSelect().props.onChange({ target: { value: '3' } });
    await flushMicrotasks();
  });

  // Select day 31
  await act(async () => {
    daySelect().props.onChange({ target: { value: '31' } });
    await flushMicrotasks();
  });
  assert.match(emitted[emitted.length - 1]!, /^\d{4}-03-31$/);

  // Switch to April (max 30 days) — day 31 should be cleared
  await act(async () => {
    monthSelect().props.onChange({ target: { value: '4' } });
    await flushMicrotasks();
  });
  assert.equal(emitted[emitted.length - 1], '', 'day 31 in April should clear and emit empty string');
});

test('year selector is HIDDEN when _today is June 15', async () => {
  const { act, create } = await import('react-test-renderer');

  const currentYear = new Date().getFullYear();
  const june15 = new Date(`${currentYear}-06-15T12:00:00`);

  let root!: import('react-test-renderer').ReactTestRenderer;
  await act(async () => {
    root = create(
      React.createElement(MonthDayPicker, {
        value: '',
        onChange: () => {},
        ariaLabel: 'Test date',
        _today: june15,
      }),
    );
    await flushMicrotasks();
  });

  const selects = root.root.findAllByType('select');
  const yearSelect = selects.find((s) => s.props['aria-label'] === 'Year');
  assert.equal(yearSelect, undefined, 'Year selector should not be present in June');
});

test('year selector is VISIBLE when _today is Dec 10 with two options', async () => {
  const { act, create } = await import('react-test-renderer');

  const currentYear = new Date().getFullYear();
  const dec10 = new Date(`${currentYear}-12-10T12:00:00`);

  let root!: import('react-test-renderer').ReactTestRenderer;
  await act(async () => {
    root = create(
      React.createElement(MonthDayPicker, {
        value: '',
        onChange: () => {},
        ariaLabel: 'Test date',
        _today: dec10,
      }),
    );
    await flushMicrotasks();
  });

  const selects = root.root.findAllByType('select');
  const yearSelect = selects.find((s) => s.props['aria-label'] === 'Year');
  assert.ok(yearSelect, 'Year selector should be present in December');

  const options = yearSelect!.props.children as React.ReactElement[];
  assert.ok(Array.isArray(options), 'Year select should have option children');
  assert.equal(options.length, 2, 'Year select should have exactly 2 options');
});

test('year selector defaults to currentYear when shown', async () => {
  const { act, create } = await import('react-test-renderer');

  const currentYear = new Date().getFullYear();
  const dec15 = new Date(`${currentYear}-12-15T12:00:00`);

  let root!: import('react-test-renderer').ReactTestRenderer;
  await act(async () => {
    root = create(
      React.createElement(MonthDayPicker, {
        value: '',
        onChange: () => {},
        ariaLabel: 'Test date',
        _today: dec15,
      }),
    );
    await flushMicrotasks();
  });

  const selects = root.root.findAllByType('select');
  const yearSelect = selects.find((s) => s.props['aria-label'] === 'Year');
  assert.ok(yearSelect, 'Year selector should be present');
  assert.equal(yearSelect!.props.value, currentYear, 'Year selector should default to currentYear');
});

test('incoming value "2026-06-14" populates month=6 (June), day=14', async () => {
  const { act, create } = await import('react-test-renderer');

  let root!: import('react-test-renderer').ReactTestRenderer;
  await act(async () => {
    root = create(
      React.createElement(MonthDayPicker, {
        value: '2026-06-14',
        onChange: () => {},
        ariaLabel: 'Test date',
      }),
    );
    await flushMicrotasks();
  });

  const selects = root.root.findAllByType('select');
  const monthSelect = selects.find((s) => s.props['aria-label'] === 'Month');
  const daySelect = selects.find((s) => s.props['aria-label'] === 'Day');

  assert.ok(monthSelect, 'Month select not found');
  assert.ok(daySelect, 'Day select not found');
  assert.equal(monthSelect!.props.value, 6, 'Month should be 6 (June)');
  assert.equal(daySelect!.props.value, 14, 'Day should be 14');
});

test('emitted date string zero-pads month and day ("2026-06-04" not "2026-6-4")', async () => {
  const { act, create } = await import('react-test-renderer');

  const emitted: string[] = [];

  let root!: import('react-test-renderer').ReactTestRenderer;
  await act(async () => {
    root = create(
      React.createElement(MonthDayPicker, {
        value: '',
        onChange: (v: string) => emitted.push(v),
        ariaLabel: 'Test date',
      }),
    );
    await flushMicrotasks();
  });

  const selects = root.root.findAllByType('select');
  const monthSelect = selects.find((s) => s.props['aria-label'] === 'Month')!;
  const daySelect = selects.find((s) => s.props['aria-label'] === 'Day')!;

  await act(async () => {
    monthSelect.props.onChange({ target: { value: '6' } });
    await flushMicrotasks();
  });
  await act(async () => {
    daySelect.props.onChange({ target: { value: '4' } });
    await flushMicrotasks();
  });

  const last = emitted[emitted.length - 1];
  assert.match(last!, /^\d{4}-06-04$/, 'Month and day must be zero-padded');
});
