import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDuplicateOrganizationHygieneDigest,
  loadDuplicateOrganizationHygieneDigest,
  type OrganizationHygieneSnapshot,
} from '@/backend/tenant/duplicate-organization-hygiene';

function organization(
  id: number,
  name: string,
  overrides: Partial<OrganizationHygieneSnapshot> = {},
): OrganizationHygieneSnapshot {
  return {
    id,
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    createdAt: '2026-01-01T00:00:00.000Z',
    activeMemberCount: 0,
    connectionCount: 0,
    publishedPostCount: 0,
    lastActivityAt: null,
    ...overrides,
  };
}

const fixtures = [
  organization(1, 'Sugar and Leather', {
    activeMemberCount: 3,
    connectionCount: 2,
    publishedPostCount: 25,
  }),
  organization(2, 'Sugar & Leather'),
  organization(3, 'Sugar + Leather'),
  organization(4, 'Sugar and Leather Coaching'),
  organization(5, 'Sugar & Leather Website'),
  organization(10, 'Aries AI', {
    activeMemberCount: 2,
    connectionCount: 3,
    publishedPostCount: 12,
  }),
  organization(11, 'Aries.AI'),
  organization(12, 'Aries AI Test'),
  organization(20, 'X SocialMedia test'),
  organization(21, 'FB Lead Test Page'),
  organization(30, 'Unrelated Production Org', { activeMemberCount: 1 }),
];

test('digest proposes the known duplicate families and obvious test-account archives', () => {
  const digest = buildDuplicateOrganizationHygieneDigest(fixtures, '2026-08-19T20:00:00.000Z');

  assert.equal(digest.type, 'duplicate_organization_hygiene_proposal');
  assert.equal(digest.proposalOnly, true);
  assert.equal(digest.requiresOwnerSignOff, true);
  assert.equal(digest.generatedAt, '2026-08-19T20:00:00.000Z');
  assert.deepEqual(
    digest.mergeCandidates.map((candidate) => ({
      family: candidate.canonicalName,
      ids: candidate.organizations.map((item) => item.id),
      keep: candidate.recommendedDisposition.keepOrganizationId,
      review: candidate.recommendedDisposition.reviewOrganizationIds,
    })),
    [
      { family: 'Aries AI', ids: [10, 11, 12], keep: 10, review: [11, 12] },
      { family: 'Sugar and Leather', ids: [1, 2, 3, 4, 5], keep: 1, review: [2, 3, 4, 5] },
    ],
  );
  assert.deepEqual(
    digest.archiveCandidates.map((candidate) => ({
      id: candidate.organization.id,
      disposition: candidate.recommendedDisposition,
    })),
    [
      { id: 12, disposition: 'archive' },
      { id: 20, disposition: 'archive' },
      { id: 21, disposition: 'archive' },
    ],
  );
  for (const candidate of [...digest.mergeCandidates, ...digest.archiveCandidates]) {
    assert.ok(candidate.evidence.length > 0);
    assert.ok(candidate.reasoning.length > 0);
  }
  assert.doesNotMatch(JSON.stringify(digest), /delete/i);
});

test('database report path executes one read-only query and returns a digest item', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return {
        rows: fixtures.map((item) => ({
          id: item.id,
          name: item.name,
          slug: item.slug,
          created_at: item.createdAt,
          active_member_count: item.activeMemberCount,
          connection_count: item.connectionCount,
          published_post_count: item.publishedPostCount,
          last_activity_at: item.lastActivityAt,
        })),
      };
    },
  };

  const digest = await loadDuplicateOrganizationHygieneDigest(
    db,
    '2026-08-19T20:00:00.000Z',
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? '', /^\s*SELECT\b/i);
  assert.doesNotMatch(calls[0]?.sql ?? '', /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP)\b/i);
  assert.deepEqual(calls[0]?.params, []);
  assert.equal(digest.mergeCandidates.length, 2);
  assert.equal(digest.archiveCandidates.length, 3);
});
