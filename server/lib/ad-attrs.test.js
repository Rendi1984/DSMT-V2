import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UAC, decodeUac, setDisabledBit, isLockedOut, filetimeToIso,
  generalizedTimeToIso, splitDn, dnToName, dnToPath, domainToBaseDn, toUser,
} from './ad-attrs.js';

test('decodeUac reads the flags DSMT surfaces', () => {
  // 512 = NORMAL_ACCOUNT, the baseline for an ordinary enabled user.
  const normal = decodeUac(512);
  assert.equal(normal.disabled, false);
  assert.equal(normal.passwordNeverExpires, false);

  const disabled = decodeUac(514); // 512 | 2
  assert.equal(disabled.disabled, true);

  const neverExpires = decodeUac(66048); // 512 | 0x10000
  assert.equal(neverExpires.passwordNeverExpires, true);
  assert.equal(neverExpires.disabled, false);
});

test('decodeUac tolerates strings and missing values', () => {
  assert.equal(decodeUac('514').disabled, true);
  assert.equal(decodeUac(undefined).value, 0);
  assert.equal(decodeUac(null).disabled, false);
});

test('setDisabledBit preserves every other flag', () => {
  // The whole point: disabling must not clear DONT_EXPIRE_PASSWORD.
  const start = UAC.NORMAL_ACCOUNT | UAC.DONT_EXPIRE_PASSWORD; // 66048
  const disabled = setDisabledBit(start, true);

  assert.equal((disabled & UAC.ACCOUNTDISABLE) !== 0, true);
  assert.equal((disabled & UAC.DONT_EXPIRE_PASSWORD) !== 0, true);
  assert.equal((disabled & UAC.NORMAL_ACCOUNT) !== 0, true);

  // And re-enabling must round-trip exactly.
  assert.equal(setDisabledBit(disabled, false), start);
});

test('setDisabledBit is idempotent', () => {
  const once = setDisabledBit(512, true);
  assert.equal(setDisabledBit(once, true), once);
});

test('isLockedOut reads lockoutTime, not the UAC bit', () => {
  assert.equal(isLockedOut('0'), false);
  assert.equal(isLockedOut(0), false);
  assert.equal(isLockedOut(undefined), false);
  assert.equal(isLockedOut(''), false);
  assert.equal(isLockedOut('133516320000000000'), true);
  assert.equal(isLockedOut(['133516320000000000']), true);
});

test('filetimeToIso converts and recognises the never sentinels', () => {
  // 2024-01-15T00:00:00Z as 100-ns ticks since 1601.
  const ticks = String((Date.UTC(2024, 0, 15) + 11644473600000) * 10000);
  assert.equal(filetimeToIso(ticks), '2024-01-15T00:00:00.000Z');

  assert.equal(filetimeToIso('0'), null);
  assert.equal(filetimeToIso('9223372036854775807'), null); // "never"
  assert.equal(filetimeToIso(undefined), null);
  assert.equal(filetimeToIso(''), null);
});

test('generalizedTimeToIso parses AD whenCreated', () => {
  assert.equal(generalizedTimeToIso('20240115093000.0Z'), '2024-01-15T09:30:00.000Z');
  assert.equal(generalizedTimeToIso('nonsense'), null);
  assert.equal(generalizedTimeToIso(undefined), null);
});

test('splitDn honours escaped commas', () => {
  assert.deepEqual(splitDn('CN=Smith,OU=IT,DC=corp,DC=local'),
    ['CN=Smith', 'OU=IT', 'DC=corp', 'DC=local']);

  // A CN containing a literal comma must not split into two components.
  assert.deepEqual(splitDn('CN=Smith\\, John,OU=IT,DC=corp,DC=local'),
    ['CN=Smith\\, John', 'OU=IT', 'DC=corp', 'DC=local']);
});

test('dnToName returns the leading RDN value, unescaped', () => {
  assert.equal(dnToName('CN=Domain Admins,CN=Users,DC=corp,DC=local'), 'Domain Admins');
  assert.equal(dnToName('CN=Smith\\, John,OU=IT,DC=corp,DC=local'), 'Smith, John');
  assert.equal(dnToName(''), '');
});

test('dnToPath renders the container path outermost first', () => {
  assert.equal(dnToPath('CN=Anna,OU=Staff,OU=IT,DC=corp,DC=local'), 'corp.local/IT/Staff');
  assert.equal(dnToPath('CN=Guest,CN=Users,DC=corp,DC=local'), 'corp.local/Users');
});

test('domainToBaseDn builds a base DN from a domain name', () => {
  assert.equal(domainToBaseDn('corp.local'), 'DC=corp,DC=local');
  assert.equal(domainToBaseDn('a.b.c.example.com'), 'DC=a,DC=b,DC=c,DC=example,DC=com');
  assert.equal(domainToBaseDn('  corp.local. '), 'DC=corp,DC=local');
  assert.equal(domainToBaseDn(''), '');
});

test('toUser projects an LDAP entry into the API shape', () => {
  const user = toUser({
    dn: 'CN=Anna Hoffman,OU=IT,DC=corp,DC=local',
    sAMAccountName: 'ahoffman',
    displayName: 'Anna Hoffman',
    givenName: 'Anna',
    sn: 'Hoffman',
    mail: 'ahoffman@corp.local',
    userAccountControl: '514', // disabled
    lockoutTime: '0',
    manager: 'CN=Erik Lind,OU=IT,DC=corp,DC=local',
    whenCreated: '20230301120000.0Z',
  });

  assert.equal(user.samAccountName, 'ahoffman');
  assert.equal(user.displayName, 'Anna Hoffman');
  assert.equal(user.status.disabled, true);
  assert.equal(user.status.locked, false);
  assert.equal(user.managerName, 'Erik Lind');
  assert.equal(user.path, 'corp.local/IT');
  assert.equal(user.whenCreated, '2023-03-01T12:00:00.000Z');
});

test('toUser falls back to cn when displayName is absent', () => {
  const user = toUser({ dn: 'CN=Bob,OU=IT,DC=corp,DC=local', cn: 'Bob', sAMAccountName: 'bob' });
  assert.equal(user.displayName, 'Bob');
});

test('toUser handles array-valued attributes', () => {
  // ldapjs returns arrays whenever an attribute has multiple values.
  const user = toUser({
    dn: 'CN=Ann,DC=corp,DC=local',
    sAMAccountName: ['ann'],
    userAccountControl: ['512'],
  });
  assert.equal(user.samAccountName, 'ann');
  assert.equal(user.status.disabled, false);
});
