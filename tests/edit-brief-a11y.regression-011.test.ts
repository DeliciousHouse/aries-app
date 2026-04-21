import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const source = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'campaign-workspace.tsx'),
  'utf8',
);

// ISSUE-EDIT-BRIEF (H2/H3/H7/H8) — the Edit brief affordance on the brand
// view of a campaign must: validate the Website URL, label fields without
// concatenating the current value, enforce maxLength + char counters on
// every textarea, move focus to the first field on open, and dismiss on Esc.

test('Website URL input is type="url", required, with pattern and inputMode', () => {
  const urlInput = source.match(
    /<input\b[\s\S]*?id="edit-brief-website-url"[\s\S]*?\/>/,
  );
  assert.ok(urlInput, 'expected to find the Website URL <input>');
  assert.match(urlInput![0], /type="url"/);
  assert.match(urlInput![0], /\brequired\b/);
  assert.match(urlInput![0], /inputMode="url"/);
  assert.match(urlInput![0], /pattern="https\?:\/\/\.\+"/);
});

test('Save brief button is disabled when the URL is empty or invalid', () => {
  assert.match(
    source,
    /disabled=\{props\.saving \|\| !urlIsValid\}/,
    'Save button must be disabled while urlIsValid is false',
  );
  assert.match(
    source,
    /const urlIsValid = \/\^https\?:\\\/\\\/\\S\+\/i\.test\(trimmedUrl\);/,
    'urlIsValid must test trimmed value against /^https?:\\/\\//i',
  );
  // handleSave must bail before persisting when URL is invalid.
  assert.match(
    source,
    /async function handleSave\(\)\s*\{\s*if \(!urlIsValid\)/,
    'handleSave must short-circuit when urlIsValid is false',
  );
});

test('Each editable textarea has a maxLength and a visible character counter', () => {
  const requiredIds = [
    'edit-brief-brand-voice',
    'edit-brief-style-vibe',
    'edit-brief-visual-references',
    'edit-brief-must-use',
    'edit-brief-must-avoid',
    'edit-brief-notes',
  ];
  for (const id of requiredIds) {
    const callSite = new RegExp(`<EditableBriefField[^>]*id="${id}"[^>]*maxLength=\\{\\d+\\}`);
    assert.match(source, callSite, `expected ${id} to pass a maxLength prop`);
  }
  // The EditableBriefField component must render a live counter when maxLength is present.
  assert.match(
    source,
    /\{props\.value\.length\} \/ \{props\.maxLength\}/,
    'EditableBriefField must render a "current / max" counter',
  );
});

test('Labels bind via htmlFor/id and do not wrap the input (H7 fix)', () => {
  // The editable label element must use htmlFor and must no longer wrap the
  // <input>/<textarea>. A <label> that wraps the control concatenates label
  // text with the current value in the accessibility tree.
  assert.match(
    source,
    /<label\s+htmlFor=\{props\.id\}/,
    'EditableBriefField <label> must use htmlFor={props.id}',
  );
  assert.doesNotMatch(
    source,
    /<label className=[^>]*>\s*<p className="text-\[11px\] font-semibold uppercase tracking-\[0\.24em\] text-white\/35">\{props\.label\}<\/p>/,
    'EditableBriefField must not regress to a wrapping <label> with a nested <p> that contains the input',
  );
});

test('Edit region has role="region", aria-label, focus management, and Esc handler', () => {
  // role=region + accessible name so the edit cluster is announced.
  assert.match(source, /role="region"\s+aria-label="Edit brief"/);
  // useRef for the first input and for the region, used for focus move + keydown.
  assert.match(source, /websiteInputRef\s*=\s*useRef<HTMLInputElement \| null>\(null\)/);
  assert.match(source, /websiteInputRef\.current\?\.focus\(\)/);
  // Esc triggers cancel.
  assert.match(
    source,
    /if \(event\.key === 'Escape'\)[\s\S]*?handleCancelEdit\(\)/,
    'Esc key must invoke the cancel handler',
  );
});
