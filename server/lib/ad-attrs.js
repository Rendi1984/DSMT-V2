/* Active Directory attribute decoding — pure functions, no I/O.
   Everything here is directly unit-testable without a domain controller,
   which matters because the LDAP transport itself cannot be exercised
   without one. */

/* ── userAccountControl ───────────────────────────────────────────────
   A bit field. Only the flags DSMT surfaces are named here; see
   MS-ADTS 2.2.16. Enable/disable is a single bit, so any write must be a
   read-modify-write of that bit — never an assignment of a whole new
   value, which would silently clear unrelated flags. */
export const UAC = {
  ACCOUNTDISABLE: 0x0002,
  LOCKOUT: 0x0010,
  PASSWD_NOTREQD: 0x0020,
  PASSWD_CANT_CHANGE: 0x0040,
  NORMAL_ACCOUNT: 0x0200,
  DONT_EXPIRE_PASSWORD: 0x10000,
  SMARTCARD_REQUIRED: 0x40000,
  PASSWORD_EXPIRED: 0x800000,
};

/** Decode userAccountControl into named booleans. */
export function decodeUac(raw) {
  const value = Number(raw) || 0;
  return {
    value,
    disabled: (value & UAC.ACCOUNTDISABLE) !== 0,
    lockedFlag: (value & UAC.LOCKOUT) !== 0,
    passwordNotRequired: (value & UAC.PASSWD_NOTREQD) !== 0,
    cannotChangePassword: (value & UAC.PASSWD_CANT_CHANGE) !== 0,
    passwordNeverExpires: (value & UAC.DONT_EXPIRE_PASSWORD) !== 0,
    smartcardRequired: (value & UAC.SMARTCARD_REQUIRED) !== 0,
    passwordExpired: (value & UAC.PASSWORD_EXPIRED) !== 0,
  };
}

/** Flip the ACCOUNTDISABLE bit, preserving every other flag. */
export function setDisabledBit(raw, disabled) {
  const value = Number(raw) || 0;
  return disabled ? value | UAC.ACCOUNTDISABLE : value & ~UAC.ACCOUNTDISABLE;
}

/* ── lockout ──────────────────────────────────────────────────────────
   The UAC LOCKOUT bit is not reliable for reading current state — AD keeps
   the authoritative answer in lockoutTime, which is 0 (or absent) when the
   account is not locked. Real lockouts also expire on their own after the
   domain's lockout duration. */
export function isLockedOut(lockoutTime) {
  const raw = Array.isArray(lockoutTime) ? lockoutTime[0] : lockoutTime;
  if (raw === undefined || raw === null || raw === '') return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0;
}

/* ── timestamps ──────────────────────────────────────────────────────── */

const FILETIME_EPOCH_DIFF_MS = 11644473600000; // 1601-01-01 → 1970-01-01

/** Convert a Windows FILETIME (100-ns ticks since 1601) to an ISO string.
    0 and 0x7FFFFFFFFFFFFFFF are AD's "never" sentinels. */
export function filetimeToIso(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === '') return null;
  const ticks = Number(value);
  if (!Number.isFinite(ticks) || ticks <= 0) return null;
  if (ticks >= 9223372036854775000) return null; // "never expires"
  const ms = ticks / 10000 - FILETIME_EPOCH_DIFF_MS;
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Parse a generalized-time string (`20240115093000.0Z`) to an ISO string. */
export function generalizedTimeToIso(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/* ── distinguished names ─────────────────────────────────────────────── */

/** Split a DN into components, honouring `\,` escapes. */
export function splitDn(dn) {
  if (typeof dn !== 'string' || dn === '') return [];
  const parts = [];
  let current = '';
  for (let i = 0; i < dn.length; i += 1) {
    const ch = dn[i];
    if (ch === '\\' && i + 1 < dn.length) {
      current += ch + dn[i + 1];
      i += 1;
    } else if (ch === ',') {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/** The value of a DN's leading RDN — `CN=Domain Admins,OU=…` → `Domain Admins`. */
export function dnToName(dn) {
  const [first] = splitDn(dn);
  if (!first) return '';
  const eq = first.indexOf('=');
  return (eq === -1 ? first : first.slice(eq + 1)).replace(/\\(.)/g, '$1');
}

/** The container path a DN sits in, outermost first: `corp.local/IT/Groups`. */
export function dnToPath(dn) {
  const parts = splitDn(dn).slice(1);
  const dcs = [];
  const containers = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    const value = part.slice(eq + 1).replace(/\\(.)/g, '$1');
    if (key === 'DC') dcs.push(value);
    else if (key === 'OU' || key === 'CN') containers.push(value);
  }
  const domain = dcs.join('.');
  const path = containers.reverse().join('/');
  return [domain, path].filter(Boolean).join('/');
}

/** Derive the default base DN from a domain: `corp.local` → `DC=corp,DC=local`. */
export function domainToBaseDn(domain) {
  if (typeof domain !== 'string') return '';
  return domain
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .split('.')
    .filter(Boolean)
    .map((label) => `DC=${label}`)
    .join(',');
}

/* ── user projection ─────────────────────────────────────────────────── */

const first = (v) => (Array.isArray(v) ? v[0] : v) ?? null;

/** Map a raw LDAP entry to the shape the API and UI speak.
    Kept separate from the transport so it can be tested directly. */
export function toUser(entry) {
  const uac = decodeUac(first(entry.userAccountControl));
  const locked = isLockedOut(entry.lockoutTime);
  return {
    dn: entry.dn || first(entry.distinguishedName) || '',
    samAccountName: first(entry.sAMAccountName) || '',
    displayName: first(entry.displayName) || first(entry.cn) || '',
    givenName: first(entry.givenName) || '',
    surname: first(entry.sn) || '',
    userPrincipalName: first(entry.userPrincipalName) || '',
    mail: first(entry.mail) || '',
    telephone: first(entry.telephoneNumber) || first(entry.mobile) || '',
    title: first(entry.title) || '',
    department: first(entry.department) || '',
    company: first(entry.company) || '',
    office: first(entry.physicalDeliveryOfficeName) || '',
    description: first(entry.description) || '',
    managerDn: first(entry.manager) || '',
    managerName: dnToName(first(entry.manager) || ''),
    path: dnToPath(entry.dn || ''),
    whenCreated: generalizedTimeToIso(entry.whenCreated),
    lastLogon: filetimeToIso(entry.lastLogonTimestamp),
    passwordLastSet: filetimeToIso(entry.pwdLastSet),
    accountExpires: filetimeToIso(entry.accountExpires),
    status: {
      disabled: uac.disabled,
      locked,
      passwordNeverExpires: uac.passwordNeverExpires,
      passwordExpired: uac.passwordExpired,
      smartcardRequired: uac.smartcardRequired,
      cannotChangePassword: uac.cannotChangePassword,
    },
    userAccountControl: uac.value,
  };
}

/** Map a raw LDAP group entry to the API shape. */
export function toGroup(entry) {
  const dn = entry.dn || first(entry.distinguishedName) || '';
  return {
    dn,
    name: first(entry.cn) || dnToName(dn),
    samAccountName: first(entry.sAMAccountName) || '',
    description: first(entry.description) || '',
    path: dnToPath(dn),
  };
}

/** Attributes DSMT requests for a user. Explicit rather than `*` — asking
    for everything pulls large blobs (thumbnailPhoto, msExch*) for nothing. */
export const USER_ATTRS = [
  'distinguishedName', 'sAMAccountName', 'displayName', 'cn', 'givenName', 'sn',
  'userPrincipalName', 'mail', 'telephoneNumber', 'mobile', 'title', 'department',
  'company', 'physicalDeliveryOfficeName', 'description', 'manager',
  'userAccountControl', 'lockoutTime', 'whenCreated', 'lastLogonTimestamp',
  'pwdLastSet', 'accountExpires',
];

export const GROUP_ATTRS = ['distinguishedName', 'cn', 'sAMAccountName', 'description'];
