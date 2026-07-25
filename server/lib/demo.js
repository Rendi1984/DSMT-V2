/* Demo-mode fixtures.

   This module is the ONLY place fake data exists, and it is imported
   exclusively behind an explicit `mode === 'demo'` check. Nothing here may
   ever be used as a fallback when a live call fails — a failed live call
   must surface as an error. Silently substituting fixtures is the failure
   mode that gets reported as "the feature doesn't work" across unrelated
   testing rounds, because it never throws and never looks broken.

   Everything below is obviously synthetic (contoso.local, sequential IDs)
   so it cannot be mistaken for a real directory even out of context. */

import { toUser, toGroup } from './ad-attrs.js';

const BASE_DN = 'DC=contoso,DC=local';

const GROUPS = [
  { cn: 'Domain Users', ou: 'Users', description: 'All domain users' },
  { cn: 'IT Staff', ou: 'IT', description: 'Information Technology department' },
  { cn: 'Helpdesk', ou: 'IT', description: 'First-line support' },
  { cn: 'Domain Admins', ou: 'Users', description: 'Designated administrators of the domain' },
  { cn: 'Finance', ou: 'Departments', description: 'Finance department' },
  { cn: 'Sales', ou: 'Departments', description: 'Sales department' },
  { cn: 'VPN Users', ou: 'Access', description: 'Permitted remote access' },
  { cn: 'File Share - Projects', ou: 'Access', description: 'Read/write to \\\\fs01\\projects' },
];

const groupDn = (g) => `CN=${g.cn},OU=${g.ou},${BASE_DN}`;

const PEOPLE = [
  ['ahoffman', 'Anna Hoffman', 'IT', 'Systems Engineer', ['Domain Users', 'IT Staff', 'VPN Users'], {}],
  ['bchen', 'Ben Chen', 'IT', 'Helpdesk Technician', ['Domain Users', 'Helpdesk'], {}],
  ['cmoreau', 'Claire Moreau', 'Finance', 'Financial Controller', ['Domain Users', 'Finance'], {}],
  ['dokafor', 'David Okafor', 'Sales', 'Account Manager', ['Domain Users', 'Sales', 'VPN Users'], {}],
  ['elindqvist', 'Erik Lindqvist', 'IT', 'IT Manager', ['Domain Users', 'IT Staff', 'Domain Admins'], {}],
  ['fnakamura', 'Fumiko Nakamura', 'Sales', 'Sales Director', ['Domain Users', 'Sales'], {}],
  ['gpetrov', 'Georgi Petrov', 'Finance', 'Accountant', ['Domain Users', 'Finance'], { disabled: true }],
  ['hsalim', 'Hana Salim', 'IT', 'Security Analyst', ['Domain Users', 'IT Staff'], { locked: true }],
  ['iribeiro', 'Igor Ribeiro', 'Sales', 'Sales Representative', ['Domain Users', 'Sales'], {}],
  ['jkowalski', 'Julia Kowalski', 'Finance', 'Payroll Specialist', ['Domain Users', 'Finance'], { neverExpires: true }],
  ['kmensah', 'Kwame Mensah', 'IT', 'Network Engineer', ['Domain Users', 'IT Staff', 'VPN Users'], {}],
  ['lfernandez', 'Lucia Fernandez', 'Sales', 'Sales Representative', ['Domain Users', 'Sales'], {}],
  ['msorensen', 'Mads Sorensen', 'IT', 'Database Administrator', ['Domain Users', 'IT Staff'], {}],
  ['nadeyemi', 'Ngozi Adeyemi', 'Finance', 'Finance Analyst', ['Domain Users', 'Finance'], {}],
  ['ovasquez', 'Omar Vasquez', 'Sales', 'Regional Manager', ['Domain Users', 'Sales', 'VPN Users'], {}],
  ['psvoboda', 'Petra Svoboda', 'IT', 'Helpdesk Technician', ['Domain Users', 'Helpdesk'], {}],
  ['rduval', 'Remy Duval', 'Finance', 'Auditor', ['Domain Users', 'Finance'], { disabled: true }],
  ['stanaka', 'Sora Tanaka', 'IT', 'Cloud Engineer', ['Domain Users', 'IT Staff'], {}],
  ['tabara', 'Tunde Abara', 'Sales', 'Account Executive', ['Domain Users', 'Sales'], {}],
  ['vhorvath', 'Vera Horvath', 'Finance', 'Finance Manager', ['Domain Users', 'Finance'], {}],
];

/* FILETIME = 100-ns ticks since 1601. Fixed offsets keep the fixtures
   stable between runs rather than drifting with the clock. */
const FILETIME_EPOCH_DIFF_MS = 11644473600000;
const toFiletime = (ms) => String((ms + FILETIME_EPOCH_DIFF_MS) * 10000);
const DAY = 86400000;
const NOW = Date.UTC(2026, 0, 15, 9, 0, 0);

const UAC_NORMAL = 0x0200;
const UAC_DISABLED = 0x0002;
const UAC_NEVER_EXPIRES = 0x10000;

function buildEntry(person, index) {
  const [sam, displayName, dept, title, groups, flags] = person;
  const [givenName, surname] = displayName.split(' ');
  const ou = dept === 'IT' ? 'IT' : 'Departments';

  let uac = UAC_NORMAL;
  if (flags.disabled) uac |= UAC_DISABLED;
  if (flags.neverExpires) uac |= UAC_NEVER_EXPIRES;

  return {
    dn: `CN=${displayName},OU=${ou},${BASE_DN}`,
    sAMAccountName: sam,
    displayName,
    cn: displayName,
    givenName,
    sn: surname,
    userPrincipalName: `${sam}@contoso.local`,
    mail: `${sam}@contoso.local`,
    telephoneNumber: `+1 555 ${String(1000 + index * 7).padStart(4, '0')}`,
    title,
    department: dept,
    company: 'Contoso Ltd',
    physicalDeliveryOfficeName: dept === 'IT' ? 'Building A' : 'Building B',
    description: '',
    manager: index === 4 ? '' : `CN=Erik Lindqvist,OU=IT,${BASE_DN}`,
    userAccountControl: String(uac),
    lockoutTime: flags.locked ? toFiletime(NOW - 2 * 3600000) : '0',
    whenCreated: new Date(NOW - (400 - index * 11) * DAY)
      .toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '.0Z'),
    lastLogonTimestamp: toFiletime(NOW - (index % 9) * DAY - 3600000),
    pwdLastSet: flags.neverExpires ? toFiletime(NOW - 500 * DAY) : toFiletime(NOW - (index * 13 % 90) * DAY),
    accountExpires: '0',
    _groups: groups,
  };
}

const ENTRIES = PEOPLE.map(buildEntry);

const GROUP_ENTRIES = GROUPS.map((g) => ({
  dn: groupDn(g),
  cn: g.cn,
  sAMAccountName: g.cn.replace(/[^A-Za-z0-9]/g, ''),
  description: g.description,
}));

/* Nesting, so the transitive toggle has something real to reveal:
   Domain Admins and Helpdesk both roll up into IT Staff. */
const NESTED_INTO = {
  'Domain Admins': ['IT Staff'],
  Helpdesk: ['IT Staff'],
};

export const demoDirectoryInfo = {
  server: 'dc01.contoso.local',
  defaultNamingContext: BASE_DN,
  baseDn: BASE_DN,
  secure: true,
  userCount: ENTRIES.length,
  userCountCapped: false,
};

export const demoSqlInfo = {
  version: 'Microsoft SQL Server 2019 (RTM-CU18) - 15.0.4261.1 (X64)',
  edition: 'Standard Edition (64-bit)',
  loginName: 'CONTOSO\\svc_dsmt',
  canCreateDatabase: true,
};

export function demoListUsers({ q = '' } = {}) {
  const needle = q.trim().toLowerCase();
  const matched = needle
    ? ENTRIES.filter((e) =>
        e.sAMAccountName.toLowerCase().includes(needle) ||
        e.displayName.toLowerCase().includes(needle) ||
        e.mail.toLowerCase().includes(needle))
    : ENTRIES;
  return matched.map(toUser);
}

export function demoGetUser(sam) {
  const entry = ENTRIES.find((e) => e.sAMAccountName.toLowerCase() === String(sam).toLowerCase());
  return entry ? toUser(entry) : null;
}

export function demoGetUserGroups(sam, { transitive = false } = {}) {
  const entry = ENTRIES.find((e) => e.sAMAccountName.toLowerCase() === String(sam).toLowerCase());
  if (!entry) return null;

  const names = new Set(entry._groups);
  if (transitive) {
    for (const direct of entry._groups) {
      for (const parent of NESTED_INTO[direct] || []) names.add(parent);
    }
  }
  return GROUP_ENTRIES
    .filter((g) => names.has(g.cn))
    .map(toGroup)
    .sort((a, b) => a.name.localeCompare(b.name));
}
