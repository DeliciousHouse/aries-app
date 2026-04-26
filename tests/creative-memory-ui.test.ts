import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const page = readFileSync('app/creative-memory/page.tsx','utf8');
test('Creative Memory UI is Campaign Learning not a static style-card library', () => { assert.match(page,/Campaign Learning/); assert.match(page,/Baseline vs memory-assisted/); assert.match(page,/Prompt Preview/); assert.match(page,/Manual outcome labels/); assert.doesNotMatch(page,/Creative DNA Library/); });
test('Creative Memory UI exposes required trust lifecycle and golden path', () => { for (const text of ['Observed','Analyzed','Suggested','Approved for generation','Archived','Inspect retrieved context','Generate two variants','Review and label outcome']) assert.match(page, new RegExp(text)); });

test('Creative Memory UI wires generated candidate review loop', () => { for (const text of ['/api/creative-memory/generated-assets','Generated candidates: baseline vs memory-assisted','Approve candidate','Needs changes','Select for label','generatedAssetId']) assert.match(page, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); });
