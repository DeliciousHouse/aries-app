import { decryptToken, encryptToken } from './oauth-crypto';

/**
 * Decrypts values stored in `oauth_tokens.access_token_enc` / `refresh_token_enc`.
 * Returns null if ciphertext is invalid or decryption fails (caller treats as missing).
 */
export function decryptOAuthSecret(ciphertext: string): string | null {
  try {
    return decryptToken(ciphertext);
  } catch {
    return null;
  }
}

/** Symmetric encrypt for new token rows (same format as oauth-crypto). */
export function encryptOAuthSecret(plaintext: string): string {
  return encryptToken(plaintext);
}
