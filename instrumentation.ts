import { validateHonchoConfig } from '@/backend/memory/honcho-env';
import {
  partnerAttributionDeliveryConfigured,
  partnerAttributionEnabled,
} from '@/lib/partner-attribution-env';

export async function register() {
  // Fail fast on startup when HONCHO_ENABLED=true but required config is absent.
  validateHonchoConfig(process.env);

  if (partnerAttributionEnabled() && !partnerAttributionDeliveryConfigured()) {
    console.warn(
      '[startup] PARTNER_ATTRIBUTION_ENABLED is on but VMS_BASE_URL or VMS_WEBHOOK_SECRET is missing; partner delivery is disabled until configured.',
    );
  }
}
