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
