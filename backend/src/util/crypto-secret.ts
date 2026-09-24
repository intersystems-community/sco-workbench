import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * Reversible at-rest encryption for Data Integration secrets (DB/FTP passwords
 * and secret file bytes) stored in SQLite. AES-256-GCM: authenticated, so a
 * tampered ciphertext fails to decrypt rather than yielding garbage.
 *
 * This is DELIBERATELY reversible (not a one-way hash): Deploy must recover the
 * ORIGINAL password to create the IRIS credential and to build the agent prompt,
 * so a hash would be useless here.
 *
 * The 32-byte key is derived from a fixed application secret via SHA-256. This is
 * obfuscation, not protection — it keeps secrets from sitting as cleartext in the
 * SQLite file, nothing more.
 */

const STRING_PREFIX = 'gcm:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Cache the derived 32-byte key so we don't re-hash it on every call. */
let cachedKey: Buffer | null = null;

/** The 32-byte AES key, derived from a fixed application secret via SHA-256. */
function resolveKey(): Buffer {
  if (!cachedKey) {
    cachedKey = createHash('sha256').update('sco-workbench.data-integration.default-key.v1').digest();
  }
  return cachedKey;
}

/** Encrypt a plaintext string → `gcm:<iv>:<tag>:<cipher>` (all base64). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', resolveKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${STRING_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** True when a value was produced by encryptSecret (so we know to decrypt it). */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(STRING_PREFIX);
}

/**
 * Decrypt a value produced by encryptSecret. A value WITHOUT the `gcm:` prefix is
 * returned unchanged — so an empty string, a legacy plaintext row, or the
 * "__saved__" sentinel round-trips harmlessly.
 */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  const [, ivB64, tagB64, dataB64] = stored.split(':');
  const iv = Buffer.from(ivB64 ?? '', 'base64');
  const tag = Buffer.from(tagB64 ?? '', 'base64');
  const data = Buffer.from(dataB64 ?? '', 'base64');
  const decipher = createDecipheriv('aes-256-gcm', resolveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Encrypt raw bytes → a self-describing Buffer: [iv(12)][tag(16)][cipher]. */
export function encryptBytes(plain: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', resolveKey(), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

/** Decrypt a Buffer produced by encryptBytes. */
export function decryptBytes(stored: Buffer): Buffer {
  const iv = stored.subarray(0, IV_BYTES);
  const tag = stored.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const data = stored.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', resolveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}
