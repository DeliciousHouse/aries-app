import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../frontend/donor/marketing/home-page.tsx', import.meta.url),
  'utf8',
);

function sourceBetween(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);

  assert.notEqual(startIndex, -1, `missing source boundary: ${start}`);
  assert.notEqual(endIndex, -1, `missing source boundary: ${end}`);

  return source.slice(startIndex, endIndex);
}

const criticalSections = [
  ['problem', sourceBetween('function Problem()', 'function Features()')],
  ['features', sourceBetween('function Features()', 'function HowItWorks()')],
  ['how it works', sourceBetween('function HowItWorks()', '/** Demo schedule')],
  ['early access', sourceBetween('function EarlyAccessSignup()', 'function Pricing()')],
  ['final call to action', sourceBetween('function FinalCTA()', 'export default function DonorHomePage()')],
  ['meet Aries', sourceBetween('<section id="meet-aries"', '<Features />')],
] as const;

test('AA-152 keeps the four transformation steps in the public homepage', () => {
  for (const copy of [
    'Connect your business',
    'Review the plan',
    'Approve and launch',
    'See what delivered results',
  ]) {
    assert.match(source, new RegExp(copy));
  }
});

test('AA-152 keeps critical homepage content independent of viewport-triggered animation', () => {
  for (const [label, sectionSource] of criticalSections) {
    assert.doesNotMatch(
      sectionSource,
      /initial=\{\{\s*opacity:\s*0/,
      `${label} must render visibly in server HTML before JavaScript runs`,
    );
    assert.doesNotMatch(
      sectionSource,
      /whileInView=/,
      `${label} must not depend on IntersectionObserver or viewport state to appear`,
    );
    assert.doesNotMatch(
      sectionSource,
      /viewport=\{\{/,
      `${label} must not install a viewport gate for essential content`,
    );
  }
});
