import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dashboardPath = new URL('../ops/grafana/aries-estimated-cost-dashboard.json', import.meta.url);

test('Grafana cost/day panel is tenant-scoped and labels all currency as estimates', () => {
  const dashboard = JSON.parse(readFileSync(dashboardPath, 'utf8')) as {
    title: string;
    panels: Array<{
      title: string;
      description?: string;
      fieldConfig?: { defaults?: { thresholds?: { steps?: Array<{ value: number | null }> } } };
      targets?: Array<{ rawSql?: string }>;
    }>;
  };

  assert.match(dashboard.title, /estimated/i);
  const panel = dashboard.panels.find((candidate) => /cost\/day/i.test(candidate.title));
  assert.ok(panel, 'dashboard must contain a cost/day panel');
  assert.match(panel.title, /estimated/i);
  const sql = panel.targets?.[0]?.rawSql ?? '';
  assert.match(sql, /daily_company_usage/);
  assert.match(sql, /company_id/);
  assert.match(sql, /total_cogs_cents/);
  assert.match(sql, /tasks_with_usage_reported\s*>\s*0/);
  assert.match(sql, /estimated/i);
  assert.ok(
    panel.fieldConfig?.defaults?.thresholds?.steps?.some((step) => step.value === 100),
    'panel must show the flagship $100/day threshold',
  );
  const coveragePanel = dashboard.panels.find((candidate) => /coverage/i.test(candidate.title));
  assert.ok(coveragePanel, 'partial estimates need a visible token-reporting coverage panel');
  assert.match(coveragePanel.targets?.[0]?.rawSql ?? '', /tasks_with_usage_reported/);
  assert.match(coveragePanel.targets?.[0]?.rawSql ?? '', /ai_tasks/);
  for (const candidate of dashboard.panels) {
    if (/cost|currency|usd/i.test(`${candidate.title} ${candidate.description ?? ''} ${candidate.targets?.[0]?.rawSql ?? ''}`)) {
      assert.match(`${candidate.title} ${candidate.description ?? ''}`, /estimate/i);
    }
  }
});
