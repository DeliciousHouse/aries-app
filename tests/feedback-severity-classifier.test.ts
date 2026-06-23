import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifySeverity,
  heuristicSeverity,
  parseSeverityFromOutput,
} from '@/lib/feedback/severity-classifier';
import type { FeedbackSeverityLlmConfig } from '@/lib/feedback/feedback-config';

const cfg: FeedbackSeverityLlmConfig = {
  gatewayUrl: 'http://hermes',
  apiKey: 'k',
  sessionKey: 's',
  timeoutMs: 5000,
};

const noWait = { sleep: async () => {}, nowMs: () => 0 };

test('heuristicSeverity maps category + blocker words', () => {
  assert.equal(heuristicSeverity('cannot log in at all', 'Login issue'), 'Blocker');
  assert.equal(heuristicSeverity('the logo is slightly off', 'Login issue'), 'High');
  assert.equal(heuristicSeverity('app is completely broken', 'Bug'), 'High');
  assert.equal(heuristicSeverity('I lost all my campaign data', 'Login issue'), 'Blocker');
  assert.equal(heuristicSeverity('lost my drafts', 'Bug'), 'High');
  assert.equal(heuristicSeverity('minor typo in tooltip', 'Bug'), 'Medium');
  assert.equal(heuristicSeverity('please add dark mode', 'Feature idea'), 'Low');
  assert.equal(heuristicSeverity('copy reads awkwardly', 'Content quality'), 'Medium');
  assert.equal(heuristicSeverity('just saying hi', 'Other'), 'Medium');
});

test('parseSeverityFromOutput extracts the severity word', () => {
  assert.equal(parseSeverityFromOutput('High'), 'High');
  assert.equal(parseSeverityFromOutput('The severity is Blocker.'), 'Blocker');
  assert.equal(parseSeverityFromOutput('i think this is low priority'), 'Low');
  assert.equal(parseSeverityFromOutput('no idea'), null);
  assert.equal(parseSeverityFromOutput(''), null);
});

test('classifySeverity uses the heuristic when no LLM config', async () => {
  const r = await classifySeverity({ comment: 'cannot log in', category: 'Login issue' }, null, noWait);
  assert.equal(r.source, 'heuristic');
  assert.equal(r.severity, 'Blocker');
});

test('classifySeverity returns the LLM verdict on a completed Hermes run', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL, opts?: { method?: string }) => {
    const u = String(url);
    calls.push(`${opts?.method ?? 'GET'} ${u}`);
    if (u.endsWith('/v1/runs')) {
      return new Response(JSON.stringify({ run_id: 'r1' }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: 'completed', output: 'High' }), { status: 200 });
  }) as unknown as typeof fetch;

  const r = await classifySeverity({ comment: 'a feature broke', category: 'Bug' }, cfg, {
    ...noWait,
    fetchImpl,
  });
  assert.equal(r.source, 'llm');
  assert.equal(r.severity, 'High');
  assert.equal(calls.length, 2); // submit + one poll
  assert.match(calls[0], /POST http:\/\/hermes\/v1\/runs$/);
});

test('classifySeverity falls back to heuristic when Hermes errors', async () => {
  const fetchImpl = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;

  const r = await classifySeverity({ comment: 'cannot log in', category: 'Login issue' }, cfg, {
    ...noWait,
    fetchImpl,
  });
  assert.equal(r.source, 'heuristic');
  assert.equal(r.severity, 'Blocker');
});

test('classifySeverity falls back when the run does not complete successfully', async () => {
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith('/v1/runs')) return new Response(JSON.stringify({ run_id: 'r1' }), { status: 200 });
    return new Response(JSON.stringify({ status: 'failed' }), { status: 200 });
  }) as unknown as typeof fetch;

  const r = await classifySeverity({ comment: 'typo', category: 'Bug' }, cfg, { ...noWait, fetchImpl });
  assert.equal(r.source, 'heuristic');
  assert.equal(r.severity, 'Medium');
});
