/* Encryption for the directory bind password.

   The bind account can read the whole directory, so its password must not
   sit in the database in clear text. AES-256-GCM gives confidentiality plus
   tamper detection: a modified ciphertext fails to decrypt rather than
   silently yielding garbage that we would then send to a domain controller. */

import {
  randomBytes, createCipheriv, createDecipheriv, createHash,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;   // GCM's standard nonce length
const TAG_BYTES = 16;

/** Derive a 32-byte key from arbitrary key material. */
export function deriveKey(material) {
  if (!material) throw new Error('No encryption key material provided');
  return createHash('sha256').update(String(material), 'utf8').digest();
}

/** Encrypt to `v1.<iv>.<tag>.<ciphertext>`, all base64url.
    The version prefix means the scheme can change later without guessing
    at how existing rows were written. */
export function encryptSecret(plaintext, key) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return '';
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** Reverse `encryptSecret`. Throws if the payload was altered. */
export function decryptSecret(payload, key) {
  if (!payload) return '';
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Stored secret is not in the expected format');
  }
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Stored secret is malformed');
  }
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/* ── key management ───────────────────────────────────────────────────
   DSMT_SECRET_KEY wins when set (the right answer for a managed deploy).
   Otherwise a key file is generated once and reused, so a plain `npm start`
   works without ceremony and the stored password survives a restart. */
export function loadOrCreateKey(keyPath, env = process.env) {
  if (env.DSMT_SECRET_KEY) return deriveKey(env.DSMT_SECRET_KEY);

  if (existsSync(keyPath)) return deriveKey(readFileSync(keyPath, 'utf8').trim());

  const material = randomBytes(48).toString('base64');
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, material, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600); // umask can widen the mode above; force it back
  } catch { /* best effort — Windows has no POSIX modes */ }
  return deriveKey(material);
}
