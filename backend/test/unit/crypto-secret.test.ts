import { describe, it, expect } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  encryptBytes,
  decryptBytes,
} from '../../src/util/crypto-secret.js';

describe('crypto-secret', () => {
  it('round-trips a password string and the ciphertext is not the plaintext', () => {
    const plain = 'hunter2!$#';
    const enc = encryptSecret(plain);
    expect(enc).not.toBe(plain);
    expect(enc.startsWith('gcm:')).toBe(true);
    expect(isEncrypted(enc)).toBe(true);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it('produces a different ciphertext each time (random IV) but decrypts to the same value', () => {
    const a = encryptSecret('same');
    const b = encryptSecret('same');
    expect(a).not.toBe(b); // random IV → distinct ciphertexts
    expect(decryptSecret(a)).toBe('same');
    expect(decryptSecret(b)).toBe('same');
  });

  it('passes an unprefixed value through unchanged (empty / legacy plaintext / sentinel)', () => {
    expect(decryptSecret('')).toBe('');
    expect(decryptSecret('__saved__')).toBe('__saved__');
    expect(decryptSecret('plain-legacy')).toBe('plain-legacy');
    expect(isEncrypted('')).toBe(false);
    expect(isEncrypted('__saved__')).toBe(false);
  });

  it('round-trips arbitrary bytes (secret file material)', () => {
    const buf = Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\n\x00\x01\x02binary\xff', 'binary');
    const enc = encryptBytes(buf);
    expect(enc.equals(buf)).toBe(false);
    expect(decryptBytes(enc).equals(buf)).toBe(true);
  });

  it('fails to decrypt a tampered ciphertext (authenticated)', () => {
    const enc = encryptBytes(Buffer.from('secret'));
    enc[enc.length - 1] = (enc[enc.length - 1] ?? 0) ^ 0xff; // flip a byte in the cipher region
    expect(() => decryptBytes(enc)).toThrow();
  });
});
