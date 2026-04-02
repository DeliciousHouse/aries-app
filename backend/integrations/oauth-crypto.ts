import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

type EncPayload = {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  ct: string;
};

function keyFromEnv(): Buffer {
  const raw = (process.env.OAUTH_TOKEN_ENCRYPTION_KEY || '').trim();
  if (!raw) {
    throw new Error('missing_required_fields:OAUTH_TOKEN_ENCRYPTION_KEY');
  }
  const buf = Buffer.from(raw, /^[A-Za-z0-9+/=]+$/.test(raw) ? 'base64' : 'utf8');
  if (buf.length !== 32) {
    throw new Error('validation_error:OAUTH_TOKEN_ENCRYPTION_KEY_must_be_32_bytes');
  }
  return buf;
}

export function encryptToken(plaintext: string): string {
  const key = keyFromEnv();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload: EncPayload = {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
  return JSON.stringify(payload);
}

export function decryptToken(ciphertext: string): string {
  const key = keyFromEnv();
  const payload = JSON.parse(ciphertext) as EncPayload;
  if (!payload || payload.v !== 1 || payload.alg !== 'aes-256-gcm') {
    throw new Error('validation_error:unknown_token_ciphertext');
  }
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const ct = Buffer.from(payload.ct, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

