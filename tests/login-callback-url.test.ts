import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLoginRedirect } from '../lib/auth/callback-url';

test('returns plain /login when pathname is null', () => {
  assert.equal(buildLoginRedirect(null), '/login');
});

test('returns plain /login when pathname is undefined', () => {
  assert.equal(buildLoginRedirect(undefined), '/login');
});

test('returns plain /login when pathname is empty string', () => {
  assert.equal(buildLoginRedirect(''), '/login');
});

test('returns plain /login when pathname IS /login', () => {
  assert.equal(buildLoginRedirect('/login'), '/login');
});

test('returns plain /login for nested /login paths', () => {
  assert.equal(buildLoginRedirect('/login/'), '/login');
  assert.equal(buildLoginRedirect('/login?foo=bar'), '/login');
});

test('rejects absolute URLs to avoid open redirect', () => {
  assert.equal(buildLoginRedirect('https://evil.example/steal'), '/login');
});

test('rejects protocol-relative URLs to avoid open redirect', () => {
  assert.equal(buildLoginRedirect('//evil.example/steal'), '/login');
});

test('rejects non-absolute paths', () => {
  assert.equal(buildLoginRedirect('dashboard/campaigns'), '/login');
});

test('encodes a simple protected path as callbackUrl', () => {
  assert.equal(
    buildLoginRedirect('/dashboard/campaigns'),
    '/login?callbackUrl=%2Fdashboard%2Fcampaigns',
  );
});

test('preserves query string when provided with leading ?', () => {
  assert.equal(
    buildLoginRedirect('/dashboard/campaigns', '?tab=active&sort=recent'),
    '/login?callbackUrl=%2Fdashboard%2Fcampaigns%3Ftab%3Dactive%26sort%3Drecent',
  );
});

test('preserves query string when provided without leading ?', () => {
  assert.equal(
    buildLoginRedirect('/dashboard/campaigns', 'tab=active'),
    '/login?callbackUrl=%2Fdashboard%2Fcampaigns%3Ftab%3Dactive',
  );
});

test('ignores empty search', () => {
  assert.equal(
    buildLoginRedirect('/dashboard', ''),
    '/login?callbackUrl=%2Fdashboard',
  );
  assert.equal(
    buildLoginRedirect('/dashboard', null),
    '/login?callbackUrl=%2Fdashboard',
  );
  assert.equal(
    buildLoginRedirect('/dashboard', '?'),
    '/login?callbackUrl=%2Fdashboard',
  );
});

test('encodes non-ASCII chars in path', () => {
  assert.equal(
    buildLoginRedirect('/dashboard/reports/Ω'),
    '/login?callbackUrl=%2Fdashboard%2Freports%2F%CE%A9',
  );
});
