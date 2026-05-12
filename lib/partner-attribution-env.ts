function isTruthyEnv(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function partnerAttributionEnabled(): boolean {
  return isTruthyEnv(process.env.PARTNER_ATTRIBUTION_ENABLED);
}

export function vmsBaseUrl(): string | null {
  const u = process.env.VMS_BASE_URL?.trim();
  return u ? u.replace(/\/+$/, '') : null;
}

export function vmsWebhookSecret(): string | null {
  const s = process.env.VMS_WEBHOOK_SECRET?.trim();
  return s || null;
}

export function partnerAttributionDeliveryConfigured(): boolean {
  return partnerAttributionEnabled() && !!vmsBaseUrl() && !!vmsWebhookSecret();
}
