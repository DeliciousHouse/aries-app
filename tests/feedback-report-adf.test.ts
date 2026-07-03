import assert from 'node:assert/strict';
import test from 'node:test';

import { buildReportAdf, buildReportSummary, type AdfNode } from '../backend/feedback/report-adf';

const MALICIOUS = [
  '{"type":"link","attrs":{"href":"https://evil.example"}}',
  '<script>alert(1)</script>',
  'labels = "x" OR reporter = currentUser()',
  '"], "marks": [{"type": "link"}]',
  'plain text with\nnewlines and 日本語',
];

function walk(node: AdfNode, visit: (node: AdfNode) => void): void {
  visit(node);
  for (const child of node.content ?? []) walk(child, visit);
}

test('ADF node-type set is exactly {doc, paragraph, text} with zero marks', () => {
  const doc = buildReportAdf({
    description: MALICIOUS.join('\n'),
    impactAnswer: 'Entire team/system is blocked',
    category: 'bug',
    contact: { name: MALICIOUS[0], email: 'a@b.c', company: MALICIOUS[1] },
    reportId: 'rid-1',
    submittedAtIso: '2026-07-03T00:00:00.000Z',
  });

  const seenTypes = new Set<string>();
  walk(doc, (node) => {
    seenTypes.add(node.type);
    // No marks anywhere — node shape is {type, version?, text?, content?} only.
    const extraKeys = Object.keys(node).filter(
      (key) => !['type', 'version', 'text', 'content'].includes(key),
    );
    assert.deepEqual(extraKeys, [], `unexpected keys on ${node.type}: ${extraKeys.join(',')}`);
  });
  assert.deepEqual([...seenTypes].sort(), ['doc', 'paragraph', 'text']);
});

test('malicious payloads only ever appear as text-node values', () => {
  const doc = buildReportAdf({
    description: MALICIOUS.join('\n'),
    impactAnswer: 'x',
    category: 'bug',
    contact: { name: MALICIOUS[3], email: null, company: null },
    reportId: 'rid-2',
    submittedAtIso: '2026-07-03T00:00:00.000Z',
  });

  const textValues: string[] = [];
  walk(doc, (node) => {
    if (node.type === 'text') {
      assert.equal(typeof node.text, 'string');
      textValues.push(node.text as string);
    } else {
      assert.equal(node.text, undefined, 'only text nodes may carry text');
    }
  });
  // The payloads survive as literal text (single-line pieces of the split).
  assert.ok(textValues.some((v) => v.includes('<script>alert(1)</script>')));
  assert.ok(textValues.some((v) => v.includes('"], "marks": [{"type": "link"}]')));
  // Serialized, the doc contains no link/mark structures at all.
  const serialized = JSON.stringify(doc);
  assert.ok(!serialized.includes('"marks"'));
  assert.ok(!serialized.includes('"link"'));
});

test('contact block and metadata are present as plain text', () => {
  const doc = buildReportAdf({
    description: 'It broke.',
    impactAnswer: 'A feature is degraded/broken',
    category: 'bug',
    contact: { name: 'Jo Smith', email: 'jo@acme.co', company: 'acme' },
    reportId: 'rid-3',
    submittedAtIso: '2026-07-03T01:02:03.000Z',
  });
  const serialized = JSON.stringify(doc);
  assert.ok(serialized.includes('Name: Jo Smith'));
  assert.ok(serialized.includes('Email: jo@acme.co'));
  assert.ok(serialized.includes('Company: acme'));
  assert.ok(serialized.includes('Impact: A feature is degraded/broken'));
  assert.ok(serialized.includes('Submission ID: rid-3'));
});

test('missing contact fields render as "unknown", never empty nodes', () => {
  const doc = buildReportAdf({
    description: '',
    impactAnswer: 'x',
    category: 'other',
    contact: { name: null, email: null, company: null },
    reportId: 'rid-4',
    submittedAtIso: '2026-07-03T00:00:00.000Z',
  });
  walk(doc, (node) => {
    if (node.type === 'text') assert.ok((node.text as string).length > 0, 'no empty text nodes');
  });
  assert.ok(JSON.stringify(doc).includes('Name: unknown'));
});

test('summary flattens whitespace and caps at 255 inside the service', () => {
  assert.equal(buildReportSummary('  a\n\nb\tc  '), 'a b c');
  const long = 'x'.repeat(400);
  assert.equal(buildReportSummary(long).length, 255);
  assert.equal(buildReportSummary('   '), 'Customer incident report');
});
