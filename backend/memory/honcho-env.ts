/**
 * Truthiness helper and fail-closed validation for the Honcho memory layer.
 *
 * HONCHO_ENABLED gates all Honcho writes and reads (onboarding seed,
 * context loads, finding appends). ARIES_RESEARCH_ENABLED is the sub-gate
 * for dispatching research jobs to Hermes; both must be true for the full
 * research-dispatch path to run.
 */

type Env = Partial<Record<string, string | undefined>>;

export function isHonchoEnabled(env: Env = process.env): boolean {
  const v = env.HONCHO_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Phase 1: strategy approvals + explicit denials → Honcho (see continuous profile writes plan). */
export function isHonchoWriteApprovalsEnabled(env: Env = process.env): boolean {
  const v = env.HONCHO_WRITE_APPROVALS_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Phase 2: publish verification, schedule, Hermes publish performance → Honcho. */
export function isHonchoWritePublishEnabled(env: Env = process.env): boolean {
  const v = env.HONCHO_WRITE_PUBLISH_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * ITEM A READ LEG: inject the compounding per-brand Honcho profile (dialectic
 * answers about audience / what works / what to avoid) into the research and
 * strategy stage submissions.
 *
 * Default OFF — ships dark. The write leg needs roughly a week of soak before
 * the deriver has folded enough performance observations and approvals into
 * `peer-brand`/`peer-policy` for a dialectic answer to be worth prompt tokens;
 * flipping this on early would spend budget on "unknown". Deploy notes flip it.
 */
export function isHonchoBrandContextEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_HONCHO_BRAND_CONTEXT_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Default dialectic timeout. /chat is LLM-backed — 15s clips legitimate answers. */
export const HONCHO_DIALECTIC_TIMEOUT_DEFAULT_MS = 30_000;

/**
 * Per-call timeout for the dialectic read, tunable without a redeploy.
 * Clamped to 1s..120s so a typo cannot make the stage submission hang.
 */
export function honchoDialecticTimeoutMs(env: Env = process.env): number {
  const raw = Number.parseInt(env.ARIES_HONCHO_DIALECTIC_TIMEOUT_MS?.trim() ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return HONCHO_DIALECTIC_TIMEOUT_DEFAULT_MS;
  return Math.min(Math.max(raw, 1_000), 120_000);
}

/** Phase 3: explicit operator creative voice/style preference toggle → Honcho. */
export function isHonchoWritePreferencesEnabled(env: Env = process.env): boolean {
  const v = env.HONCHO_WRITE_PREFERENCES_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Throws when HONCHO_ENABLED=true but required config is absent.
 * Must be called at startup (e.g. in health-check or route handler init)
 * so misconfigured containers fail-closed rather than silently skipping writes.
 */
export function validateHonchoConfig(env: Env = process.env): void {
  if (!isHonchoEnabled(env)) return;

  const salt = env.ARIES_TENANT_PSEUDONYM_SALT?.trim() ?? '';
  if (salt.length < 16) {
    throw new Error(
      '[honcho] ARIES_TENANT_PSEUDONYM_SALT must be set (≥16 chars) when HONCHO_ENABLED=true.',
    );
  }

  const baseUrl = env.HONCHO_BASE_URL?.trim() ?? '';
  if (!baseUrl) {
    throw new Error('[honcho] HONCHO_BASE_URL must be set when HONCHO_ENABLED=true.');
  }
}
