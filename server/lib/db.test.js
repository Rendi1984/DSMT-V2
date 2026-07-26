import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseServerSpec, resolveEndpoint, buildSqlConfig, classifySqlError,
  assertSafeIdentifier, DEFAULT_SQL_PORT, resolveAuthMode, processIdentity,
} from './db.js';

test('parseServerSpec accepts a bare host', () => {
  assert.deepEqual(parseServerSpec('sql01'), { server: 'sql01', instanceName: undefined, port: undefined });
});

test('parseServerSpec accepts SSMS comma-port syntax', () => {
  // This is what an admin pastes from SSMS, so it has to work.
  assert.deepEqual(parseServerSpec('sql01,1433'),
    { server: 'sql01', instanceName: undefined, port: 1433 });
});

test('parseServerSpec accepts colon-port syntax', () => {
  assert.deepEqual(parseServerSpec('sql01:1433'),
    { server: 'sql01', instanceName: undefined, port: 1433 });
});

test('parseServerSpec accepts a named instance and never pairs it with a port', () => {
  // Named instances resolve via SQL Browser; sending a port as well makes
  // tedious ignore the instance and dial the wrong endpoint.
  const parsed = parseServerSpec('sql01\\SQLEXPRESS');
  assert.deepEqual(parsed, { server: 'sql01', instanceName: 'SQLEXPRESS', port: undefined });
});

test('parseServerSpec trims and tolerates empty input', () => {
  assert.equal(parseServerSpec('  sql01  ').server, 'sql01');
  assert.deepEqual(parseServerSpec(''), { server: '', instanceName: undefined, port: undefined });
  assert.deepEqual(parseServerSpec(undefined), { server: '', instanceName: undefined, port: undefined });
});

/* ── resolveEndpoint: the wizard's three separate fields ─────────────── */

test('resolveEndpoint defaults to port 1433', () => {
  assert.deepEqual(resolveEndpoint({ server: 'sql01' }),
    { server: 'sql01', instanceName: undefined, port: DEFAULT_SQL_PORT });
});

test('resolveEndpoint uses an explicit port field', () => {
  assert.equal(resolveEndpoint({ server: 'sql01', port: 14330 }).port, 14330);
});

test('resolveEndpoint uses an explicit instance field', () => {
  const r = resolveEndpoint({ server: 'sql01', instance: 'SQLEXPRESS' });
  assert.equal(r.instanceName, 'SQLEXPRESS');
  assert.equal(r.port, undefined, 'an instance must never be paired with a port');
});

test('resolveEndpoint drops the port when an instance is set', () => {
  // Both supplied: the instance wins and the port is discarded, because
  // sending both makes the driver dial the port and ignore the instance.
  const r = resolveEndpoint({ server: 'sql01', port: 1433, instance: 'SQLEXPRESS' });
  assert.equal(r.instanceName, 'SQLEXPRESS');
  assert.equal(r.port, undefined);
});

test('resolveEndpoint lets a pasted spec override the separate fields', () => {
  // Pasting `sql01\SQLEXPRESS` is a more specific statement of intent than a
  // port box still sitting on its untouched default.
  const r = resolveEndpoint({ server: 'sql01\\SQLEXPRESS', port: 1433 });
  assert.equal(r.server, 'sql01');
  assert.equal(r.instanceName, 'SQLEXPRESS');
  assert.equal(r.port, undefined);

  const withPort = resolveEndpoint({ server: 'sql02,14330', port: 1433 });
  assert.equal(withPort.server, 'sql02');
  assert.equal(withPort.port, 14330);
});

test('resolveEndpoint ignores a nonsense port', () => {
  for (const port of [0, -1, NaN, 'abc', undefined, null]) {
    assert.equal(resolveEndpoint({ server: 'sql01', port }).port, DEFAULT_SQL_PORT,
      `should fall back for ${JSON.stringify(port)}`);
  }
});

test('buildSqlConfig defaults to encrypted with certificate validation on', () => {
  const cfg = buildSqlConfig({ server: 'sql01', username: 'sa', password: 'p' }, 'master');
  assert.equal(cfg.options.encrypt, true);
  assert.equal(cfg.options.trustServerCertificate, false);
  assert.equal(cfg.database, 'master');
});

test('buildSqlConfig honours the trust-certificate escape hatch', () => {
  const cfg = buildSqlConfig({ server: 'sql01', username: 'sa', password: 'p', trustServerCert: true }, 'DSMT');
  assert.equal(cfg.options.trustServerCertificate, true);
});

/* ── blank credentials mean "the account running DSMT" ──────────────── */

test('resolveAuthMode picks integrated when both credentials are blank', () => {
  assert.equal(resolveAuthMode({ server: 'sql01' }), 'integrated');
  assert.equal(resolveAuthMode({ server: 'sql01', username: '', password: '' }), 'integrated');
  assert.equal(resolveAuthMode({ server: 'sql01', username: '   ' }), 'integrated');
});

test('resolveAuthMode picks SQL or NTLM when credentials are given', () => {
  assert.equal(resolveAuthMode({ username: 'sa', password: 'p' }), 'sql');
  assert.equal(resolveAuthMode({ username: 'sa', password: 'p', authMode: 'windows' }), 'ntlm');
});

test('resolveAuthMode does not fall back to integrated on a half-filled form', () => {
  // A username with no password is a typo, not a request for integrated auth.
  // Silently connecting as the service account there would be surprising.
  assert.equal(resolveAuthMode({ username: 'sa', password: '' }), 'sql');
  assert.equal(resolveAuthMode({ username: '', password: 'p' }), 'sql');
});

test('buildSqlConfig asks for a trusted connection and sends no credentials', () => {
  const cfg = buildSqlConfig({ server: 'sql01' }, 'DSMT');
  assert.equal(cfg.authMode, 'integrated');
  assert.equal(cfg.options.trustedConnection, true);
  assert.equal(cfg.user, undefined, 'integrated auth must not send a username');
  assert.equal(cfg.password, undefined, 'integrated auth must not send a password');
  assert.equal(cfg.authentication, undefined);
});

test('buildSqlConfig leaves trustedConnection off when credentials are given', () => {
  const cfg = buildSqlConfig({ server: 'sql01', username: 'sa', password: 'p' }, 'DSMT');
  assert.equal(cfg.authMode, 'sql');
  assert.equal(cfg.options.trustedConnection, undefined);
});

test('processIdentity reports an account and whether integrated auth can work', () => {
  const id = processIdentity();
  assert.equal(typeof id.account, 'string');
  assert.equal(typeof id.platform, 'string');
  // Integrated auth is a Windows facility; the flag must track the real platform
  // so the wizard can say so instead of failing at the Test button.
  assert.equal(id.platformSupportsIntegrated, process.platform === 'win32');
});

test('buildSqlConfig uses SQL authentication by default', () => {
  const cfg = buildSqlConfig({ server: 'sql01', username: 'sa', password: 'secret' }, 'DSMT');
  assert.equal(cfg.user, 'sa');
  assert.equal(cfg.password, 'secret');
  assert.equal(cfg.authentication, undefined);
});

test('buildSqlConfig splits DOMAIN\\user for NTLM', () => {
  const cfg = buildSqlConfig({
    server: 'sql01', authMode: 'windows', username: 'CONTOSO\\svc_dsmt', password: 'secret',
  }, 'DSMT');

  assert.equal(cfg.authentication.type, 'ntlm');
  assert.equal(cfg.authentication.options.userName, 'svc_dsmt');
  assert.equal(cfg.authentication.options.domain, 'CONTOSO');
  assert.equal(cfg.user, undefined, 'NTLM must not also set a top-level user');
});

test('buildSqlConfig keeps an explicit NTLM domain field', () => {
  const cfg = buildSqlConfig({
    server: 'sql01', authMode: 'windows', username: 'svc_dsmt', domain: 'CONTOSO', password: 'p',
  }, 'DSMT');
  assert.equal(cfg.authentication.options.userName, 'svc_dsmt');
  assert.equal(cfg.authentication.options.domain, 'CONTOSO');
});

test('buildSqlConfig sets instanceName instead of a port for named instances', () => {
  const cfg = buildSqlConfig({ server: 'sql01\\SQLEXPRESS', username: 'sa', password: 'p' }, 'DSMT');
  assert.equal(cfg.options.instanceName, 'SQLEXPRESS');
  assert.equal(cfg.port, undefined);
});

test('buildSqlConfig carries the wizard port through to the driver', () => {
  const cfg = buildSqlConfig({ server: 'sql01', port: 14330, username: 'sa', password: 'p' }, 'DSMT');
  assert.equal(cfg.port, 14330);
  assert.equal(cfg.options.instanceName, undefined);
});

test('assertSafeIdentifier accepts ordinary names and bracket-quotes them', () => {
  assert.equal(assertSafeIdentifier('DSMT'), '[DSMT]');
  assert.equal(assertSafeIdentifier('DSMT_Prod'), '[DSMT_Prod]');
  assert.equal(assertSafeIdentifier('_staging1'), '[_staging1]');
});

test('assertSafeIdentifier rejects injection rather than escaping it', () => {
  // CREATE DATABASE cannot be parameterised, so the name is allowlisted.
  const bad = ['DSMT];DROP DATABASE master--', 'DSMT DB', '1DSMT', '', 'a'.repeat(64), 'DS-MT', 'DSMT]'];
  for (const name of bad) {
    assert.throws(() => assertSafeIdentifier(name), /Invalid database name/, `should reject ${JSON.stringify(name)}`);
  }
});

test('classifySqlError distinguishes each cause', () => {
  const cases = [
    [{ code: 'ENOTFOUND' }, 'sql_host_not_found'],
    [{ code: 'ECONNREFUSED' }, 'sql_refused'],
    [{ code: 'ETIMEOUT' }, 'sql_timeout'],
    [{ number: 18456 }, 'sql_login'],
    [{ number: 4060 }, 'sql_db_access'],
    [{ number: 262 }, 'sql_permission'],
  ];
  for (const [err, expected] of cases) {
    assert.equal(classifySqlError(err, {}).code, expected);
  }
});

test('classifySqlError names dbcreator for a permission failure', () => {
  // The single most likely wizard failure: a login that can connect but
  // cannot CREATE DATABASE. The hint has to say what role is missing.
  const info = classifySqlError({ number: 262, message: 'CREATE DATABASE permission denied in database master' });
  assert.equal(info.code, 'sql_permission');
  assert.match(info.hint, /dbcreator/);
});

test('classifySqlError reads the number nested under originalError', () => {
  // tedious surfaces the SQL error number here rather than on the top level.
  const info = classifySqlError({ originalError: { info: { number: 18456 } }, message: 'Login failed' });
  assert.equal(info.code, 'sql_login');
});

test('classifySqlError falls back without throwing', () => {
  const info = classifySqlError(new Error('something unexpected'));
  assert.equal(info.code, 'sql_error');
  assert.ok(info.message.length > 0);
});
