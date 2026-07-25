import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeFilter, buildLdapUrl, defaultPortFor, classifyLdapError,
  LDAP_PORT, LDAPS_PORT, MATCHING_RULE_IN_CHAIN,
} from './ldap.js';

test('escapeFilter escapes exactly the RFC 4515 set', () => {
  assert.equal(escapeFilter('normal'), 'normal');
  assert.equal(escapeFilter('a*b'), 'a\\2ab');
  assert.equal(escapeFilter('a(b'), 'a\\28b');
  assert.equal(escapeFilter('a)b'), 'a\\29b');
  assert.equal(escapeFilter('a\\b'), 'a\\5cb');
  assert.equal(escapeFilter('a\0b'), 'a\\00b');
});

test('escapeFilter leaves ordinary directory values intact', () => {
  // Spaces, hyphens, dots and @ are legal in filter values; escaping them
  // would break searches for real names and addresses.
  assert.equal(escapeFilter('Smith, John'), 'Smith, John');
  assert.equal(escapeFilter('a.b@corp.local'), 'a.b@corp.local');
  assert.equal(escapeFilter('File Share - Projects'), 'File Share - Projects');
});

test('escapeFilter neutralises a filter-injection attempt', () => {
  // Without escaping, this closes the filter and appends a wildcard clause.
  const injected = escapeFilter('*)(objectClass=*');
  assert.equal(injected, '\\2a\\29\\28objectClass=\\2a');
  assert.ok(!injected.includes('('), 'no unescaped parenthesis may survive');
  assert.ok(!injected.includes(')'), 'no unescaped parenthesis may survive');
});

test('escapeFilter does not double-escape its own backslashes', () => {
  // `*` becomes `\2a`; that emitted backslash must not itself become `\5c`.
  assert.equal(escapeFilter('*'), '\\2a');
  assert.equal(escapeFilter('**'), '\\2a\\2a');
});

test('escapeFilter handles null and undefined', () => {
  assert.equal(escapeFilter(null), '');
  assert.equal(escapeFilter(undefined), '');
});

test('buildLdapUrl derives scheme and default port from the LDAPS toggle', () => {
  assert.equal(buildLdapUrl({ host: 'dc01.corp.local', useLdaps: false }),
    `ldap://dc01.corp.local:${LDAP_PORT}`);
  assert.equal(buildLdapUrl({ host: 'dc01.corp.local', useLdaps: true }),
    `ldaps://dc01.corp.local:${LDAPS_PORT}`);
});

test('buildLdapUrl lets an explicit port win', () => {
  // 3269 is the global catalog over TLS — a legitimate override.
  assert.equal(buildLdapUrl({ host: 'dc01', port: 3269, useLdaps: true }), 'ldaps://dc01:3269');
  assert.equal(buildLdapUrl({ host: 'dc01', port: 3268, useLdaps: false }), 'ldap://dc01:3268');
});

test('buildLdapUrl trims the host', () => {
  assert.equal(buildLdapUrl({ host: '  dc01  ', useLdaps: false }), `ldap://dc01:${LDAP_PORT}`);
});

test('defaultPortFor maps the toggle to 389/636', () => {
  assert.equal(defaultPortFor(false), 389);
  assert.equal(defaultPortFor(true), 636);
});

test('classifyLdapError distinguishes each cause', () => {
  const cases = [
    [{ code: 'ENOTFOUND' }, 'ldap_host_not_found'],
    [{ code: 'ECONNREFUSED' }, 'ldap_refused'],
    [{ code: 'ETIMEDOUT' }, 'ldap_timeout'],
    [{ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'ldap_tls'],
    [{ name: 'InvalidCredentialsError' }, 'ldap_credentials'],
    [{ name: 'NoSuchObjectError' }, 'ldap_base_dn'],
    [{ name: 'InsufficientAccessRightsError' }, 'ldap_access'],
  ];
  for (const [err, expected] of cases) {
    assert.equal(classifyLdapError(err, {}).code, expected);
  }
});

test('classifyLdapError always yields an actionable message', () => {
  for (const err of [{ code: 'ENOTFOUND' }, { name: 'InvalidCredentialsError' }, new Error('weird')]) {
    const info = classifyLdapError(err, { host: 'dc01', port: 389 });
    assert.ok(info.message.length > 0, 'every classification needs a message');
    assert.ok(info.code.startsWith('ldap_'), 'every code is namespaced');
  }
});

test('classifyLdapError tailors the refused hint to the LDAPS toggle', () => {
  const secure = classifyLdapError({ code: 'ECONNREFUSED' }, { useLdaps: true, host: 'dc01', port: 636 });
  assert.match(secure.hint, /636/);
});

test('the in-chain matching rule OID is the AD-documented value', () => {
  // Getting this wrong silently returns direct groups only, which looks
  // like "nested membership is broken" rather than a typo.
  assert.equal(MATCHING_RULE_IN_CHAIN, '1.2.840.113556.1.4.1941');
});
