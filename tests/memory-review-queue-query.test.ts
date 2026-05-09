import assert from 'node:assert/strict';
import test from 'node:test';

import { listQueuedResearchFindingsForTenant } from '@/backend/memory/research-jobs';

test('listQueuedResearchFindingsForTenant filters by tenant and decision', async () => {
  let capturedSql = '';
  let capturedParams: unknown[] = [];
  const client = {
    query: async (sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      return {
        rows: [
          {
            id: 'f1',
            job_id: 'j1',
            raw: { claim: 'x' },
            curator_decision: 'queue_for_review',
            peer: 'brand',
            approved_message_id: null,
            created_at: '2026-01-01T00:00:00.000Z',
            job_status: 'needs_review',
          },
        ],
        rowCount: 1,
      };
    },
  };

  const rows = await listQueuedResearchFindingsForTenant('42', { limit: 10 }, client);
  assert.match(capturedSql, /queue_for_review/);
  assert.match(capturedSql, /j\.tenant_id = \$1/);
  assert.deepEqual(capturedParams, ['42', 10]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].job_id, 'j1');
});
