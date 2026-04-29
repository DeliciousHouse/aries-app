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
