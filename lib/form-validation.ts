import { useMemo } from 'react';

export const EMAIL_ADDRESS_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export function isValidEmailAddress(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && EMAIL_ADDRESS_REGEX.test(trimmed);
}

export function getRequiredFieldError(value: string, label: string): string | null {
  return value.trim().length > 0 ? null : `Enter ${label}.`;
}

export function getEmailFieldError(value: string, label = 'your email address'): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return `Enter ${label}.`;
  }
  return isValidEmailAddress(trimmed) ? null : 'Enter a valid email address.';
}

export function useDisabledUntilValid(isValid: boolean, isBusy = false): boolean {
  return useMemo(() => isBusy || !isValid, [isBusy, isValid]);
}
