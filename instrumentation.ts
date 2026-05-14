import {
  assertHermesSocialContentRuntimeConfigured,
  probeHermesSocialContentRuntime,
  shouldProbeHermesOnStartup,
} from '@/backend/marketing/hermes-runtime-contract';
import { assertMarketingExecutionPortConfigured } from '@/backend/marketing/provider-guard';
import { validateHonchoConfig } from '@/backend/memory/honcho-env';
import {
  partnerAttributionDeliveryConfigured,
  partnerAttributionEnabled,
} from '@/lib/partner-attribution-env';

export async function register() {
  // Fail fast on startup when HONCHO_ENABLED=true but required config is absent.
  validateHonchoConfig(process.env);

  // Weekly social content is Hermes-only. Validate the runtime contract at boot
  // so misconfigured deployments fail loudly instead of submitting a run that
  // waits forever for a callback Hermes will never send directly.
  assertMarketingExecutionPortConfigured({
    ...process.env,
    ARIES_MARKETING_EXECUTION_PROVIDER: 'hermes',
  });
  assertHermesSocialContentRuntimeConfigured(process.env);

  if (shouldProbeHermesOnStartup(process.env)) {
    const report = await probeHermesSocialContentRuntime(process.env);
    if (!report.ok) {
      throw new Error(
        report.gateway.error ||
        `Hermes social-content startup probe failed against ${report.gateway.url}.`,
      );
    }
  }

  if (partnerAttributionEnabled() && !partnerAttributionDeliveryConfigured()) {
    console.warn(
      '[startup] PARTNER_ATTRIBUTION_ENABLED is on but VMS_BASE_URL or VMS_WEBHOOK_SECRET is missing; partner delivery is disabled until configured.',
    );
  }
}
