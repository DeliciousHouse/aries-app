import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
test('Creative Memory scripts are intentionally scoped', () => { const seed=readFileSync('scripts/creative-memory-seed.mjs','utf8'); const backfill=readFileSync('scripts/creative-memory-backfill.mjs','utf8'); const smoke=readFileSync('scripts/creative-memory-smoke.mjs','utf8'); assert.match(seed,/CREATIVE_MEMORY_TENANT_ID/); assert.match(seed,/ON CONFLICT/); assert.doesNotMatch(seed,/INSERT INTO business_profiles/); assert.match(backfill,/noop-v1/); assert.match(smoke,/Campaign Learning/); });
