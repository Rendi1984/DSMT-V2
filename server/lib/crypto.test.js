import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveKey, encryptSecret, decryptSecret, loadOrCreateKey } from './crypto.js';

const KEY = deriveKey('test-key-material');

test('encryptSecret round-trips', () => {
  const secret = 'S0me!Bind#Password';
  assert.equal(decryptSecret(encryptSecret(secret, KEY), KEY), secret);
});

test('encryptSecret round-trips unicode and long values', () => {
  for (const secret of ['פסגה-סיסמה', '🔐 emoji pw', 'x'.repeat(2000)]) {
    assert.equal(decryptSecret(encryptSecret(secret, KEY), KEY), secret);
  }
});

test('encryptSecret never emits the plaintext', () => {
  const secret = 'PlainTextPassword123';
  const enc = encryptSecret(secret, KEY);
  assert.ok(!enc.includes(secret), 'ciphertext must not contain the plaintext');
  assert.ok(enc.startsWith('v1.'), 'a version prefix keeps the format upgradable');
});

test('encryptSecret uses a fresh nonce each time', () => {
  // Reusing a nonce under GCM is catastrophic, and identical ciphertexts
  // would also leak that two accounts share a password.
  const a = encryptSecret('same', KEY);
  const b = encryptSecret('same', KEY);
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a, KEY), decryptSecret(b, KEY));
});

test('encryptSecret passes empty values through', () => {
  assert.equal(encryptSecret('', KEY), '');
  assert.equal(encryptSecret(null, KEY), '');
  assert.equal(decryptSecret('', KEY), '');
});

test('decryptSecret rejects a tampered ciphertext', () => {
  // GCM's auth tag is the point: a modified payload must fail loudly rather
  // than yield garbage we would then send to a domain controller.
  const enc = encryptSecret('secret', KEY);
  const parts = enc.split('.');
  const body = Buffer.from(parts[3], 'base64url');
  body[0] ^= 0xff;
  parts[3] = body.toString('base64url');

  assert.throws(() => decryptSecret(parts.join('.'), KEY));
});

test('decryptSecret rejects a tampered auth tag', () => {
  const parts = encryptSecret('secret', KEY).split('.');
  const tag = Buffer.from(parts[2], 'base64url');
  tag[0] ^= 0xff;
  parts[2] = tag.toString('base64url');

  assert.throws(() => decryptSecret(parts.join('.'), KEY));
});

test('decryptSecret rejects the wrong key', () => {
  const enc = encryptSecret('secret', KEY);
  assert.throws(() => decryptSecret(enc, deriveKey('a-different-key')));
});

test('decryptSecret rejects malformed payloads', () => {
  for (const bad of ['not-encrypted', 'v1.a.b', 'v2.a.b.c', 'v1.a.b.c.d']) {
    assert.throws(() => decryptSecret(bad, KEY), undefined, `should reject ${bad}`);
  }
});

test('deriveKey requires material and yields 32 bytes', () => {
  assert.throws(() => deriveKey(''));
  assert.throws(() => deriveKey(null));
  assert.equal(deriveKey('anything').length, 32);
});

test('loadOrCreateKey prefers the environment variable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsmt-key-'));
  try {
    const keyPath = join(dir, 'dsmt.key');
    const key = loadOrCreateKey(keyPath, { DSMT_SECRET_KEY: 'from-env' });
    assert.deepEqual(key, deriveKey('from-env'));
    assert.equal(existsSync(keyPath), false, 'no key file when the env var is set');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadOrCreateKey generates once and reuses it', () => {
  // A regenerated key would make every stored bind password undecryptable
  // after a restart, which surfaces as "the directory suddenly rejects us".
  const dir = mkdtempSync(join(tmpdir(), 'dsmt-key-'));
  try {
    const keyPath = join(dir, 'dsmt.key');
    const first = loadOrCreateKey(keyPath, {});
    const second = loadOrCreateKey(keyPath, {});
    assert.deepEqual(first, second);

    if (process.platform !== 'win32') {
      assert.equal(statSync(keyPath).mode & 0o777, 0o600, 'the key file must not be world-readable');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
