/**
 * Frontend-safe mapping for marketing job-create failures (AA-131).
 *
 * startSocialContentJob surfaces operator-actionable failures as coded Error
 * messages (`brand_kit_fetch_failed:<inner>`, `missing_required_fields:<list>`,
 * `needs_brand_kit:<inner>`). Before this module the jobs handler echoed those
 * raw codes to the browser and the create form printed them verbatim — the
 * operator saw `brand_kit_fetch_failed:fetch failed` with no hint which input
 * to fix. Each mapping below pins the failure to the form field that needs
 * attention (fieldErrors keyed by the form's field names) plus a one-line
 * sentence the operator can act on.
 *
 * The inner detail after the first colon (an undici cause, a DNS error, a
 * stack fragment) is deliberately collapsed out of the response body — same
 * rationale as classifyClientError in app/api/business/profile/route.ts
 * (CodeQL js/stack-trace-exposure). Callers keep the raw message server-side
 * in logs.
 *
 * Lives in lib/ (not backend/ or app/api/) because both the route handler and
 * the browser form import it: the handler to build the response, the form to
 * humanize legacy/raw codes that reach it from older response shapes.
 */

export interface MarketingCreateFailureMapping {
  status: number;
  /** Stable machine-readable code (no dynamic inner detail). */
  error: string;
  /** One-line operator-actionable sentence. */
  message: string;
  /** Per-field copy keyed by the create form's field names. */
  fieldErrors?: Record<string, string>;
}

export const WEBSITE_URL_REQUIRED_COPY = 'Website URL is required.';
export const WEBSITE_UNREACHABLE_COPY =
  "We couldn't reach this website. Check the address is correct and the site is online, then try again.";
export const WEBSITE_LOW_SIGNAL_COPY =
  "We couldn't find enough brand detail (logo, colors, copy) at this address. Point Aries at your main marketing site.";
export const WEBSITE_BRAND_KIT_GENERIC_COPY =
  "We couldn't build a brand kit from this website. Double-check the address and try again.";
export const BUSINESS_TYPE_MISSING_COPY =
  'Your business type is missing. Add it in Settings → Business profile, then try again.';

/**
 * missing_required_fields:<list> entries → the form field that carries the
 * inline error. Both the payload.* spelling (thrown by the orchestrator) and
 * the bare spelling (thrown by older validators) are accepted.
 */
const MISSING_FIELD_MAPPINGS: Record<string, { field: string; copy: string }> = {
  'payload.brandUrl': { field: 'websiteUrl', copy: WEBSITE_URL_REQUIRED_COPY },
  brandUrl: { field: 'websiteUrl', copy: WEBSITE_URL_REQUIRED_COPY },
  websiteUrl: { field: 'websiteUrl', copy: WEBSITE_URL_REQUIRED_COPY },
  'payload.businessType': { field: 'businessType', copy: BUSINESS_TYPE_MISSING_COPY },
  businessType: { field: 'businessType', copy: BUSINESS_TYPE_MISSING_COPY },
};

/**
 * Map a job-create failure message to a frontend-safe response shape, or null
 * when the message is not a known operator-actionable failure (the caller
 * falls through to its existing handling).
 */
export function mapMarketingCreateFailure(rawMessage: string): MarketingCreateFailureMapping | null {
  if (typeof rawMessage !== 'string' || rawMessage.length === 0) {
    return null;
  }

  // The weekly brand-kit refresh path wraps the same failures as
  // needs_brand_kit:<inner>; classify the inner message.
  const message = rawMessage.startsWith('needs_brand_kit:')
    ? rawMessage.slice('needs_brand_kit:'.length)
    : rawMessage;

  if (message === 'brand_url_missing') {
    return {
      status: 422,
      error: 'missing_required_fields:websiteUrl',
      message: WEBSITE_URL_REQUIRED_COPY,
      fieldErrors: { websiteUrl: WEBSITE_URL_REQUIRED_COPY },
    };
  }

  if (message.startsWith('brand_kit_fetch_failed')) {
    return {
      status: 422,
      error: 'brand_kit_fetch_failed',
      message: WEBSITE_UNREACHABLE_COPY,
      fieldErrors: { websiteUrl: WEBSITE_UNREACHABLE_COPY },
    };
  }

  if (message.startsWith('brand_kit_insufficient_source_data')) {
    return {
      status: 422,
      error: 'brand_kit_insufficient_source_data',
      message: WEBSITE_LOW_SIGNAL_COPY,
      fieldErrors: { websiteUrl: WEBSITE_LOW_SIGNAL_COPY },
    };
  }

  if (message.startsWith('brand_kit_') || message.startsWith('invalid_tenant_brand_kit')) {
    return {
      status: 422,
      error: 'brand_kit_error',
      message: WEBSITE_BRAND_KIT_GENERIC_COPY,
      fieldErrors: { websiteUrl: WEBSITE_BRAND_KIT_GENERIC_COPY },
    };
  }

  if (message.startsWith('missing_required_fields:')) {
    const fields = message
      .slice('missing_required_fields:'.length)
      .split(',')
      .map((field) => field.trim())
      .filter(Boolean);
    const fieldErrors: Record<string, string> = {};
    const unmappedFields: string[] = [];
    for (const field of fields) {
      const known = MISSING_FIELD_MAPPINGS[field];
      if (known) {
        fieldErrors[known.field] = known.copy;
      } else {
        unmappedFields.push(field);
      }
    }

    const sentences = [...new Set(Object.values(fieldErrors))];
    if (unmappedFields.length > 0) {
      sentences.push(`Required information is missing: ${unmappedFields.join(', ')}.`);
    }

    return {
      status: 400,
      // The field list is server-derived (never echoes operator input), so the
      // raw code stays useful for API consumers and log correlation.
      error: message,
      message: sentences.join(' ') || 'Required information is missing.',
      ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
    };
  }

  return null;
}

/**
 * Best-effort humanizer for the create form: returns the mapped one-line
 * sentence for a known failure code, or the input unchanged. Used as a
 * fallback for error strings that arrive without the structured shape.
 */
export function humanizeMarketingCreateMessage(raw: string): string {
  return mapMarketingCreateFailure(raw)?.message ?? raw;
}
