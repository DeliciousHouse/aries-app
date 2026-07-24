import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const source = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'settings-screen.tsx'),
  'utf8',
);
const businessProfileSource = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'business-profile-screen.tsx'),
  'utf8',
);
const marketingScheduleClientSource = readFileSync(
  path.join(PROJECT_ROOT, 'lib', 'api', 'marketing-schedule.ts'),
  'utf8',
);

test('settings Business Profile panel exposes Add Profile CTA and connected portal summary', () => {
  const businessProfilePanelStart = source.indexOf('eyebrow="Business Profile"');
  const channelPanelStart = source.indexOf('eyebrow="Channels / Integrations"');
  assert.ok(businessProfilePanelStart >= 0, 'Settings should render a Business Profile panel');
  assert.ok(channelPanelStart > businessProfilePanelStart, 'Settings should render channels after the Business Profile panel');

  const businessProfilePanelSource = source.slice(businessProfilePanelStart, channelPanelStart);

  assert.equal(
    businessProfilePanelSource.includes('Add Profile'),
    true,
    'The My Account / Settings Business Profile panel must include an Add Profile CTA',
  );
  assert.equal(
    businessProfilePanelSource.includes('/dashboard/settings/channel-integrations?from=business-profile'),
    true,
    'The Add Profile CTA should deep-link into the existing channel integration connection flow',
  );
  assert.equal(
    businessProfilePanelSource.includes('Connected profiles'),
    true,
    'The Business Profile panel should summarize connected media portals beside the CTA',
  );
  assert.equal(
    source.includes("connection_state === 'connected'") && source.includes('connectedProfilesSummary'),
    true,
    'The Business Profile panel should derive its portal summary from live connected integration cards',
  );
});

test('settings and Business Profile screens share connected profile labels', () => {
  assert.match(
    source,
    /import \{ connectedProfileLabel \} from '\.\/connected-profile-labels';/,
    'Settings should use the shared connected profile label helper',
  );
  assert.match(
    businessProfileSource,
    /import \{ connectedProfileLabel \} from '\.\/connected-profile-labels';/,
    'Business Profile should use the shared connected profile label helper',
  );
  assert.equal(
    source.includes('const CONNECTED_PROFILE_LABELS'),
    false,
    'Settings must not duplicate the connected profile label mapping',
  );
  assert.equal(
    businessProfileSource.includes('const CONNECTED_PROFILE_LABELS'),
    false,
    'Business Profile must not duplicate the connected profile label mapping',
  );
});

test('settings Channels panel treats integrations status:error as unavailable', () => {
  const channelPanelStart = source.indexOf('eyebrow="Channels / Integrations"');
  const teamPanelStart = source.indexOf('eyebrow="Team / Approvals"');
  assert.ok(channelPanelStart >= 0, 'Settings should render a Channels / Integrations panel');
  assert.ok(teamPanelStart > channelPanelStart, 'Settings should render Team after Channels');

  const channelPanelSource = source.slice(channelPanelStart, teamPanelStart);
  assert.equal(
    channelPanelSource.includes('integrationsUnavailable ?'),
    true,
    'Channels panel should use integrationsUnavailable so HTTP 200 status:error payloads render as unavailable',
  );
  assert.equal(
    channelPanelSource.includes('integrations.error ?'),
    false,
    'Channels panel must not treat status:error payloads as the empty integrations state',
  );
});

test('settings Channels panel gives cards without connect actions a canonical integrations link', () => {
  const channelPanelStart = source.indexOf('eyebrow="Channels / Integrations"');
  const teamPanelStart = source.indexOf('eyebrow="Team / Approvals"');
  assert.ok(channelPanelStart >= 0, 'Settings should render a Channels / Integrations panel');
  assert.ok(teamPanelStart > channelPanelStart, 'Settings should render Team after Channels');

  const channelPanelSource = source.slice(channelPanelStart, teamPanelStart);
  assert.match(
    channelPanelSource,
    /!card\.available_actions\.includes\('connect'\)[\s\S]*!card\.available_actions\.includes\('reconnect'\)[\s\S]*<Link[\s\S]*href="\/dashboard\/settings\/channel-integrations"[\s\S]*Manage integrations/,
    'Every channel without a direct Connect/Reconnect action should expose a keyboard-accessible link to the canonical integration flow',
  );
});

test('settings separates goal confirmation from approval-only saves', () => {
  const businessSaveStart = source.indexOf('async function saveBusinessProfile()');
  const approvalSaveStart = source.indexOf('async function saveApprovalSettings()');
  assert.ok(businessSaveStart >= 0, 'Settings should expose a dedicated business-profile save');
  assert.ok(
    approvalSaveStart > businessSaveStart,
    'Settings should expose a separate approval-only save after the business-profile save',
  );

  const businessSaveSource = source.slice(businessSaveStart, approvalSaveStart);
  const approvalSaveSource = source.slice(approvalSaveStart, source.indexOf('// Cadence card'));
  // Asserts the PAYLOAD, not which function issues the request: both saves now
  // go through the shared runProfileSave() helper so a failed save reports
  // itself instead of being silently discarded. The invariant under test is
  // unchanged — the business-profile save confirms the displayed goal, the
  // approval-only save (below) must never resubmit an inferred one.
  assert.match(
    businessSaveSource,
    /primaryGoal/,
    'Saving the business profile should deliberately confirm the displayed primary goal',
  );
  assert.match(
    businessSaveSource,
    /runProfileSave\(|business\.updateProfile\(/,
    'The business-profile save should still issue a profile update',
  );
  assert.doesNotMatch(
    approvalSaveSource,
    /primaryGoal/,
    'Saving approval settings must not resubmit a loaded inferred goal',
  );
  assert.match(source, /onClick=\{\(\) => void saveBusinessProfile\(\)\}/);
  assert.match(source, /onClick=\{\(\) => void saveApprovalSettings\(\)\}/);
});

// ── Cadence card (multi-brand workspaces Phase 1b, #803 task 1b) ───────────

function cadencePanelSlice(): string {
  const cadencePanelStart = source.indexOf('eyebrow="Cadence"');
  assert.ok(cadencePanelStart >= 0, 'Settings should render a Cadence panel');
  const teamPanelStart = source.indexOf('eyebrow="Team / Approvals"');
  assert.ok(teamPanelStart >= 0 && teamPanelStart < cadencePanelStart, 'Cadence should render after Team / Approvals');
  // The Posting times ShellPanel is the next panel after Cadence closes.
  const postingTimesPanelStart = source.indexOf('eyebrow="Posting times"');
  assert.ok(postingTimesPanelStart > cadencePanelStart, 'Cadence panel should close before the Posting times panel opens');
  return source.slice(cadencePanelStart, postingTimesPanelStart);
}

test('settings Cadence panel is framed as the GENERATION schedule, not posting times', () => {
  const cadencePanelSource = cadencePanelSlice();
  assert.equal(
    cadencePanelSource.startsWith('eyebrow="Cadence"'),
    true,
    'The Cadence panel should carry the eyebrow="Cadence" label',
  );
  assert.equal(
    source.includes('<ShellPanel eyebrow="Cadence" title="When Aries generates content each week">'),
    true,
    'The Cadence panel must be titled around content GENERATION — posting times are AI-derived per platform, not a fixed set time',
  );
  assert.equal(
    cadencePanelSource.includes('Weekly generation schedule'),
    true,
    'The Cadence panel should summarize the current weekly generation schedule',
  );
  assert.equal(
    cadencePanelSource.includes('derived per platform'),
    true,
    'The Cadence panel should point at the per-platform derived posting times so the two schedules are not conflated',
  );
});

test('settings Cadence panel shows role-aware copy when no schedule row exists yet', () => {
  const cadencePanelSource = cadencePanelSlice();
  assert.equal(
    cadencePanelSource.includes("Not scheduled yet — save to set this workspace's cadence."),
    true,
    'Admins should see the "Not scheduled yet" prompt when the tenant has no cadence row',
  );
  assert.equal(
    cadencePanelSource.includes('This workspace has not set a generation schedule yet.'),
    true,
    'Non-admins should see a read-only explanation when the tenant has no cadence row',
  );
  // Both empty-state strings must be gated by isWorkspaceAdmin, not shown together.
  const emptyStateStart = cadencePanelSource.indexOf('{!schedule ?');
  assert.ok(emptyStateStart >= 0, 'The empty-schedule copy should be conditioned on the absence of a schedule row');
  const emptyStateSource = cadencePanelSource.slice(emptyStateStart, emptyStateStart + 400);
  assert.equal(
    emptyStateSource.includes('isWorkspaceAdmin'),
    true,
    'The empty-schedule copy should branch on isWorkspaceAdmin so viewers/analysts never see the admin-only save prompt',
  );
});

test('settings Cadence panel only renders the editable schedule form for workspace admins', () => {
  const cadencePanelSource = cadencePanelSlice();
  const adminGateIndex = cadencePanelSource.indexOf('{isWorkspaceAdmin ? (');
  assert.ok(adminGateIndex >= 0, 'The Cadence form should be gated behind an isWorkspaceAdmin check, matching the other panels\' admin-only sections');

  const dayFieldIndex = cadencePanelSource.indexOf('Field label="Day of week"');
  const saveButtonIndex = cadencePanelSource.indexOf('Save generation schedule');
  assert.ok(dayFieldIndex > adminGateIndex, 'The day-of-week selector must live inside the isWorkspaceAdmin-gated block');
  assert.ok(saveButtonIndex > adminGateIndex, 'The save button must live inside the isWorkspaceAdmin-gated block');

  // Nothing above the admin gate (i.e. the always-visible summary card) should
  // already contain the editable-form controls — they must only appear once,
  // and only after the gate.
  const beforeGate = cadencePanelSource.slice(0, adminGateIndex);
  assert.equal(
    beforeGate.includes('Save generation schedule'),
    false,
    'The save button must not render outside the isWorkspaceAdmin gate',
  );
});

// ── Posting times card (AI-derived per-platform posting times) ─────────────

function postingTimesPanelSlice(): string {
  const panelStart = source.indexOf('eyebrow="Posting times"');
  assert.ok(panelStart >= 0, 'Settings should render a Posting times panel');
  const fieldHelperStart = source.indexOf('function Field(props');
  assert.ok(fieldHelperStart > panelStart, 'Posting times panel should close before the Field helper is declared');
  return source.slice(panelStart, fieldHelperStart);
}

test('settings Posting times panel renders derived per-platform times with a source badge', () => {
  const panelSource = postingTimesPanelSlice();
  assert.equal(
    source.includes('<ShellPanel eyebrow="Posting times" title="When your posts go live">'),
    true,
    'The Posting times panel should be titled "When your posts go live"',
  );
  assert.equal(
    panelSource.includes("entry.source === 'analytics'"),
    true,
    'Each derived row must badge its source (your analytics vs competitor analysis)',
  );
  assert.equal(
    panelSource.includes('Competitor analysis'),
    true,
    'The competitor-derived source badge copy should be present',
  );
  assert.equal(
    panelSource.includes('postingTimesEnabled'),
    true,
    'The panel must branch on the feature flag so a flag-off deployment shows the defaults explanation',
  );
});

test('settings Posting times update button is admin-gated', () => {
  const panelSource = postingTimesPanelSlice();
  const deriveButtonIndex = panelSource.indexOf('Update times now');
  assert.ok(deriveButtonIndex >= 0, 'The panel should offer an "Update times now" button');
  const adminGateIndex = panelSource.indexOf('{isWorkspaceAdmin ? (');
  assert.ok(
    adminGateIndex >= 0 && deriveButtonIndex > adminGateIndex,
    'The "Update times now" button must live inside an isWorkspaceAdmin-gated block',
  );
});

test('settings Posting times derive polling cleans up its timer on unmount', () => {
  assert.equal(
    source.includes('derivePollTimer'),
    true,
    'The derive flow should track its poll timer in a ref',
  );
  assert.equal(
    source.includes('window.clearInterval(derivePollTimer.current)'),
    true,
    'The poll timer must be cleared (unmount cleanup + re-arm) so navigation never leaves stray fetch/setState timers',
  );
});

test('lib/api/posting-times.ts routes reads and the derive trigger through requestJson, not a bare fetch', () => {
  const postingTimesClientSource = readFileSync(
    path.join(PROJECT_ROOT, 'lib', 'api', 'posting-times.ts'),
    'utf8',
  );
  assert.match(
    postingTimesClientSource,
    /import \{ ApiRequestError, requestJson \} from '\.\/http';/,
    'The posting-times client should import requestJson from lib/api/http.ts',
  );
  assert.equal(
    /\bfetch\(/.test(postingTimesClientSource),
    false,
    'The posting-times client must not bypass requestJson with a bare fetch() call',
  );
});

test('lib/api/marketing-schedule.ts routes cadence reads and writes through requestJson, not a bare fetch', () => {
  assert.match(
    marketingScheduleClientSource,
    /import \{ ApiRequestError, requestJson \} from '\.\/http';/,
    'The cadence client should import requestJson (the mutation-guard/409-aware wrapper) from lib/api/http.ts',
  );
  assert.equal(
    /\brequestJson<.*>\(SCHEDULE_PATH,\s*\{\s*method:\s*'GET'/s.test(marketingScheduleClientSource),
    true,
    'fetchMarketingSchedule should call requestJson for the GET',
  );
  assert.equal(
    /\brequestJson<.*>\(SCHEDULE_PATH,\s*\{\s*method:\s*'PATCH'/s.test(marketingScheduleClientSource),
    true,
    'updateMarketingSchedule should call requestJson for the PATCH so it carries the workspace mutation-guard header and the shared 409 interlock',
  );
  assert.equal(
    /\bfetch\(/.test(marketingScheduleClientSource),
    false,
    'The cadence client must not bypass requestJson with a bare fetch() call',
  );
});
