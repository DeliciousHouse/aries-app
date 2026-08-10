/**
 * ITEM B — the `agent-reach` skill is offered to the WEEKLY research stage only.
 *
 * WHY THIS FILE EXISTS (three silent-failure modes, one per section):
 *
 *  1. SCOPE. The skill is installed into the aries-research profile
 *     (`~/.hermes/profiles/aries-research/skills/social-media/agent-reach`).
 *     The shared RESEARCH_TOOL_POLICY is ALSO served to the brand-campaign
 *     (`marketing_pipeline`) path on the default 8642 gateway, whose profile is
 *     not known to carry it. Unlike `/last30days` — whose worst case on a
 *     profile that lacks it is a skipped enrichment — an unknown slash command
 *     has no defined no-op: the agent either errors or falls through to
 *     `terminal`, which loops to the 600s "did not reach a terminal status"
 *     timeout. Nothing in the type system stops someone moving the guidance
 *     into the shared string; this does.
 *
 *  2. THE SHARED STRING IS A PINNED CONSTANT. Seven copies of
 *     RESEARCH_TOOL_POLICY / its "12 total tool calls" ceiling exist across the
 *     suite: research-depth.test.ts (×3), hermes-runtime-contract.test.ts (×2,
 *     live import → hard-fails on drift) and build-hermes-instructions.test.ts
 *     (×2 verbatim mirror that deliberately does NOT import this module to
 *     avoid zod — so it rots SILENTLY instead of failing). The mirror below
 *     closes that hole: it is the same verbatim text, asserted against the REAL
 *     module, so a shared-policy edit that leaves the mirror stale fails here.
 *
 *  3. FAIL-SOFT. Cookie sessions expire (ops/agent-reach/README.md). The
 *     wrapper skill answers `{"status":"session_stale"}` instead of hanging,
 *     and the guidance is what tells the agent that answer is a reportable
 *     outcome rather than a failure to retry into the timeout. If that wording
 *     is lost, a dead throwaway account silently converts every weekly run into
 *     a 10-minute research stall.
 *
 * Pure string assertions over the real builders — no network, no DB, no fs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHermesInstructions,
  buildHermesStageInstructions,
} from '../../backend/marketing/ports/hermes';
import { SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY } from '../../backend/social-content/defaults';

/**
 * The shared research tool policy, verbatim. Byte-identical to
 * backend/marketing/ports/hermes.ts:RESEARCH_TOOL_POLICY and to the two mirrors
 * in tests/marketing/build-hermes-instructions.test.ts. ITEM B must not have
 * changed a character of it.
 */
const SHARED_RESEARCH_TOOL_POLICY =
  'Research stage tool policy: during the research stage you may use ONLY these tools: web_extract, web_search, and the last30days Hermes skill. You MUST NOT call read_file, search_files, write_file, execute_code, or terminal. There is no Aries workspace available to this agent — calling local-workspace tools will loop until the 600s "did not reach a terminal status" timeout fires. Required tool sequence: (1) call web_extract once for the brand URL when present, (2) call web_search once for the brand, (3) if a competitor URL or competitor brand is provided, call web_extract once for the competitor URL and web_search once for the competitor, (4) optionally invoke `/last30days` for the brand and (if a competitor URL or competitor brand is provided) for the competitor, (5) spend any remaining budget on further web_search / web_extract calls that deepen the highest-value threads — audience language, competitor hooks, and seasonal angles, and, when the input carries a "Last 28 days performance" block, whatever that block reports as a winning or a losing hook, format or topic. Do not exceed 12 total tool calls during the research stage. After these tool calls, stop using tools and return the strict JSON checkpoint immediately.';

/** Every non-weekly route into the combined brand-campaign instruction set. */
const BRAND_CAMPAIGN_KEYS = ['marketing_pipeline', 'some_other_workflow'];

const weeklyResearch = () =>
  buildHermesStageInstructions(SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY, 'research');

// ── 1. The weekly research stage is offered the skill ───────────────────────

test('weekly research instructions offer /agent-reach as a slash command, never as terminal', () => {
  const instructions = weeklyResearch();

  assert.ok(instructions.includes('`agent-reach` Hermes skill'), 'the skill must be named');
  assert.ok(
    instructions.includes('`/agent-reach <platform> <query>`'),
    'invocation form must be the slash command, with its argument shape',
  );
  for (const platform of ['instagram', 'twitter', 'reddit', 'facebook']) {
    assert.ok(instructions.includes(platform), `platform ${platform} must be named`);
  }

  // The whole point of the slash-command convention: `terminal` is forbidden by
  // the shared policy, and a shell fallthrough is the 600s loop.
  assert.ok(
    instructions.includes('Do NOT shell out to terminal for agent-reach'),
    'the no-terminal rule must be restated for agent-reach specifically',
  );
  assert.ok(
    !instructions.includes('run agent-reach via terminal'),
    'agent-reach must never be reframed as a terminal command',
  );
  assert.ok(
    !instructions.includes('agent-reach command'),
    'agent-reach must never be reframed as a bare CLI command',
  );
});

test('the weekly budget override raises the ceiling to 16 without contradicting the shared 12', () => {
  const instructions = weeklyResearch();

  // Both numbers are present by design: the shared policy still says 12 (it is
  // byte-frozen), and the weekly override explicitly supersedes it. If the
  // override were ever dropped while agent-reach guidance stayed, the agent
  // would be told to make an extra class of calls inside an unchanged budget.
  assert.ok(instructions.includes('12 total tool calls'), 'the shared ceiling is still stated');
  assert.ok(instructions.includes('raised to 16 total tool calls here'), 'the weekly override must be present');
  assert.ok(
    instructions.includes('reserved for `/agent-reach`'),
    'the override must say what the extra calls are for, or they get spent on web_search',
  );
  assert.ok(
    instructions.includes('Every other'),
    'the override must preserve the rest of the policy explicitly',
  );
});

test('a stale cookie session is framed as a reportable outcome, not a stage failure', () => {
  const instructions = weeklyResearch();

  assert.ok(instructions.includes('session_stale'), 'the wrapper skill status must be named literally');
  assert.ok(instructions.includes('NOT a stage failure'), 'staleness must be explicitly non-fatal');
  assert.ok(
    instructions.includes('Do not retry the same platform'),
    'without a retry bound a dead session becomes a 600s stall',
  );
  assert.ok(
    instructions.includes('fall back to `/last30days` and web_search'),
    'the degraded path must be named',
  );
});

test('agent-reach findings are labelled observation, never first-party performance', () => {
  const instructions = weeklyResearch();
  assert.ok(
    instructions.includes('platform-native observations'),
    'agent-reach output must be labelled as observation in the artifacts',
  );
  assert.ok(
    instructions.includes('never measured first-party performance'),
    'only the 28-day block is measured first-party data; conflating them corrupts the scoreboard',
  );
});

test('the weekly last30days mandate survives alongside agent-reach', () => {
  // agent-reach COMPLEMENTS last30days (live on-platform winners vs. 30-day
  // aggregate listening). A previous draft of this item replaced one with the
  // other; both must ride.
  const instructions = weeklyResearch();
  assert.ok(instructions.includes('mandatory here, not optional'), 'the last30days mandate is untouched');
  assert.ok(instructions.includes('/last30days'), 'last30days is still invoked');
  assert.ok(instructions.includes('performance_signals'), 'the tie-back mandate is untouched');
});

// ── 2. The brand-campaign path is never told about a skill it may not have ──

test('no agent-reach wording reaches the default-gateway brand-campaign instructions', () => {
  for (const key of BRAND_CAMPAIGN_KEYS) {
    const instructions = buildHermesInstructions(key);
    assert.ok(
      !instructions.includes('agent-reach'),
      `${key}: the 8642 profile is not known to carry the skill — naming it risks an unknown-command failure`,
    );
    assert.ok(
      !instructions.includes('/agent-reach'),
      `${key}: no slash command that profile may not have`,
    );
    assert.ok(
      !instructions.includes('16 total tool calls'),
      `${key}: the raised ceiling is weekly-only — it exists solely to pay for agent-reach`,
    );
    assert.ok(
      instructions.includes('12 total tool calls'),
      `${key}: the shared ceiling is unchanged by this item`,
    );
  }
});

// ── 3. The shared policy is byte-frozen ────────────────────────────────────

test('RESEARCH_TOOL_POLICY is byte-identical on both paths after this item', () => {
  // This is the assertion tests/marketing/build-hermes-instructions.test.ts
  // CANNOT make: that file mirrors the policy verbatim but does not import the
  // module (it avoids zod), so its copy going stale fails nothing. Here the
  // same text is checked against the real builders, so any edit to the shared
  // string fails immediately and the stale mirror is found in the same run.
  assert.ok(
    weeklyResearch().includes(SHARED_RESEARCH_TOOL_POLICY),
    'weekly research still ships the shared policy verbatim',
  );
  for (const key of BRAND_CAMPAIGN_KEYS) {
    assert.ok(
      buildHermesInstructions(key).includes(SHARED_RESEARCH_TOOL_POLICY),
      `${key}: brand-campaign instructions still ship the shared policy verbatim`,
    );
  }
});
