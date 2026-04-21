export type BusinessProfileFormInput = {
  businessName: string;
  websiteUrl: string;
};

export type BusinessProfileFieldErrors = {
  businessName?: string;
  websiteUrl?: string;
};

/**
 * Matches a well-formed absolute http(s) URL with at least one dot in the host.
 * Intentionally strict: we do NOT auto-prepend `https://` to arbitrary strings
 * the way the old form did — that caused `not-a-url` to be persisted as
 * `https://not-a-url/`. Callers must pass a complete URL.
 */
export const WEBSITE_URL_PATTERN = /^https?:\/\/[^\s/]+\.[^\s]+$/i;

export function isValidWebsiteUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!WEBSITE_URL_PATTERN.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.');
  } catch {
    return false;
  }
}

export function isValidBusinessName(value: string): boolean {
  return value.trim().length >= 1;
}

export function validateBusinessProfileForm(
  input: BusinessProfileFormInput,
): BusinessProfileFieldErrors {
  const errors: BusinessProfileFieldErrors = {};
  if (!isValidBusinessName(input.businessName)) {
    errors.businessName = 'Business name is required.';
  }
  if (!isValidWebsiteUrl(input.websiteUrl)) {
    errors.websiteUrl = 'Enter a full website URL including https://';
  }
  return errors;
}

export function hasValidationErrors(errors: BusinessProfileFieldErrors): boolean {
  return Object.values(errors).some((value) => Boolean(value));
}
