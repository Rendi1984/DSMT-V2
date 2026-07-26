/* Setup wizard.

   Forward navigation is gated on each step's connection test actually
   passing. Editing a tested field revokes that pass, so the review step can
   never describe settings that were never verified. */

import { api } from './api.js';
import {
  $, $$, el, mountVersion, setBusy, showResult, showError,
  clearResult, setFieldError, validate, required,
} from './shell.js';

mountVersion('#version');

/* ── step navigation ─────────────────────────────────────────────────── */

let current = 1;
const LAST = 4;

function goTo(step) {
  current = step;
  for (const panel of $$('.wizard__panel')) {
    panel.hidden = Number(panel.dataset.panel) !== step;
  }
  for (const marker of $$('.step')) {
    const n = Number(marker.dataset.step);
    marker.dataset.state = n === step ? 'active' : n < step ? 'done' : '';
    marker.setAttribute('aria-current', n === step ? 'step' : 'false');
  }
  // Move focus to the new panel's heading so keyboard and screen-reader
  // users land on the step they just opened rather than back at the top.
  const heading = $(`.wizard__panel[data-panel="${step}"] h2`);
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

for (const button of $$('[data-next]')) {
  button.addEventListener('click', () => goTo(Number(button.dataset.next)));
}
for (const button of $$('[data-back]')) {
  button.addEventListener('click', () => goTo(Number(button.dataset.back)));
}

/* ── gathering form values ───────────────────────────────────────────── */

const dbFields = {
  server: $('#db-server'),
  port: $('#db-port'),
  instance: $('#db-instance'),
  auth: $('#db-auth'),
  user: $('#db-user'),
  pass: $('#db-pass'),
  name: $('#db-name'),
  trust: $('#db-trust'),
};

const dirFields = {
  host: $('#dir-host'),
  port: $('#dir-port'),
  ldaps: $('#dir-ldaps'),
  trust: $('#dir-trust'),
  domain: $('#dir-domain'),
  baseDn: $('#dir-basedn'),
  bindDn: $('#dir-binddn'),
  bindPw: $('#dir-bindpw'),
};

const dbSettings = () => ({
  server: dbFields.server.value.trim(),
  port: Number(dbFields.port.value) || undefined,
  instance: dbFields.instance.value.trim(),
  authMode: dbFields.auth.value,
  username: dbFields.user.value.trim(),
  password: dbFields.pass.value,
  database: dbFields.name.value.trim() || 'DSMT',
  trustServerCert: dbFields.trust.checked,
});

const dirSettings = () => ({
  host: dirFields.host.value.trim(),
  port: Number(dirFields.port.value) || undefined,
  domain: dirFields.domain.value.trim(),
  baseDn: dirFields.baseDn.value.trim(),
  bindDn: dirFields.bindDn.value.trim(),
  bindPassword: dirFields.bindPw.value,
  useLdaps: dirFields.ldaps.checked,
  trustServerCert: dirFields.trust.checked,
});

/* ── verification state ──────────────────────────────────────────────
   A passed test is tied to the exact values that produced it. Any edit
   clears it, so "Continue" can never carry forward a stale result. */

const verified = { db: false, dir: false };

function invalidate(which) {
  verified[which] = false;
  if (which === 'db') {
    $('#db-create').disabled = true;
    clearResult($('#db-result'));
  } else {
    $('#dir-next').disabled = true;
    clearResult($('#dir-result'));
  }
}

for (const input of Object.values(dbFields)) {
  input.addEventListener('input', () => invalidate('db'));
  input.addEventListener('change', () => invalidate('db'));
}
for (const input of Object.values(dirFields)) {
  input.addEventListener('input', () => invalidate('dir'));
  input.addEventListener('change', () => invalidate('dir'));
}

/* ── SQL Server endpoint fields ──────────────────────────────────────
   Server, port and instance are three boxes, but an admin will still paste
   whatever SSMS showed them into the first one. Rather than rejecting that,
   split it across the fields so they can see what DSMT understood. */

const DEFAULT_SQL_PORT = 1433;

dbFields.server.addEventListener('blur', () => {
  const raw = dbFields.server.value.trim();

  const backslash = raw.indexOf('\\');
  if (backslash !== -1) {
    dbFields.server.value = raw.slice(0, backslash).trim();
    dbFields.instance.value = raw.slice(backslash + 1).trim();
  } else {
    const sep = raw.search(/[,:]/);
    if (sep !== -1) {
      const port = Number(raw.slice(sep + 1).trim());
      dbFields.server.value = raw.slice(0, sep).trim();
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        dbFields.port.value = String(port);
      }
    }
  }
  syncInstanceAndPort();
});

/* A named instance is resolved by the SQL Browser service. Sending a port as
   well makes the driver dial that port and ignore the instance, which surfaces
   as a baffling timeout — so the two are mutually exclusive on screen too. */
function syncInstanceAndPort() {
  const hasInstance = dbFields.instance.value.trim() !== '';
  dbFields.port.disabled = hasInstance;
  dbFields.port.closest('.field').dataset.disabled = hasInstance ? 'true' : '';
  if (!hasInstance && dbFields.port.value.trim() === '') {
    dbFields.port.value = String(DEFAULT_SQL_PORT);
  }
}

dbFields.instance.addEventListener('input', syncInstanceAndPort);
syncInstanceAndPort();

/* ── blank credentials mean "the account running DSMT" ───────────────
   Rather than leaving that as a rule buried in the docs, show which account
   that actually is the moment both boxes are empty. */

let identity = null;

function syncIdentityHint() {
  const box = $('#db-identity');
  const blank = dbFields.user.value.trim() === '' && dbFields.pass.value === '';

  if (!blank || !identity) {
    box.hidden = true;
    return;
  }

  if (identity.platformSupportsIntegrated) {
    showResult(box, {
      kind: 'ok',
      title: 'Will connect as the account running DSMT',
      detail: identity.account
        ? `Windows Integrated Authentication as ${identity.account}.`
        : 'Windows Integrated Authentication.',
      hint: 'That account needs a SQL Server login with the dbcreator role. Fill in a username and password to use a different account.',
    });
  } else {
    // Being explicit beats letting them press Test and get a driver error.
    showResult(box, {
      kind: 'warn',
      title: 'Integrated authentication needs Windows',
      detail: `DSMT is running on ${identity.platform}, where SQL Server cannot use the process account.`,
      hint: 'Enter a SQL Server username and password.',
    });
  }
}

for (const input of [dbFields.user, dbFields.pass]) {
  input.addEventListener('input', syncIdentityHint);
}

/* ── domain drives the base DN ───────────────────────────────────────
   contoso.local → DC=contoso,DC=local. Only auto-filled while the admin
   hasn't written their own base DN, so narrowing it to a single OU sticks. */

let baseDnTouched = false;
dirFields.baseDn.addEventListener('input', () => { baseDnTouched = true; });

function domainToBaseDn(domain) {
  return String(domain || '')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .split('.')
    .filter(Boolean)
    .map((label) => `DC=${label}`)
    .join(',');
}

dirFields.domain.addEventListener('input', () => {
  if (baseDnTouched && dirFields.baseDn.value.trim() !== '') return;
  dirFields.baseDn.value = domainToBaseDn(dirFields.domain.value);
  baseDnTouched = false;
});

/* A bare username is ambiguous to a directory. Complete it to a UPN using the
   domain, but leave DOMAIN\user, user@domain and full DNs exactly as typed —
   a non-AD server needs the DN form and must not be rewritten. */
dirFields.bindDn.addEventListener('blur', () => {
  const value = dirFields.bindDn.value.trim();
  const domain = dirFields.domain.value.trim();
  if (!value || !domain) return;
  if (value.includes('\\') || value.includes('@') || value.includes('=')) return;
  dirFields.bindDn.value = `${value}@${domain}`;
});

/* ── LDAPS toggle ───────────────────────────────────────────────────
   Flipping the toggle moves the port between 389 and 636, but only when
   the field still holds the other default — a deliberately typed port
   (3269 for the global catalog, say) must survive. */

const LDAP_PORT = 389;
const LDAPS_PORT = 636;

dirFields.ldaps.addEventListener('change', () => {
  const on = dirFields.ldaps.checked;
  const port = Number(dirFields.port.value);
  if (on && port === LDAP_PORT) dirFields.port.value = String(LDAPS_PORT);
  else if (!on && port === LDAPS_PORT) dirFields.port.value = String(LDAP_PORT);

  // Certificate trust is meaningless without TLS, so only offer it with
  // LDAPS on — and clear it when switching back, so an unrelated setting
  // isn't silently retained.
  $('#dir-trust-wrap').hidden = !on;
  if (!on) dirFields.trust.checked = false;
});

/* ── step 2: database ────────────────────────────────────────────────── */

const portCheck = (v, disabled) => {
  if (disabled || !v) return '';
  const n = Number(v);
  return (!Number.isInteger(n) || n < 1 || n > 65535) ? 'Enter a port between 1 and 65535.' : '';
};

const dbChecks = () => [
  [dbFields.server, required('The server address')],
  [dbFields.port, (v) => portCheck(v, dbFields.port.disabled)],
  // Both blank is a valid choice — it means "use the account running DSMT".
  // One of the two blank is almost always a typo, so that is still an error.
  [dbFields.user, (v) => (!v && dbFields.pass.value
    ? 'Enter a username, or clear the password to use the account running DSMT.' : '')],
  [dbFields.pass, (v) => (!v && dbFields.user.value.trim()
    ? 'Enter a password, or clear the username to use the account running DSMT.' : '')],
  [dbFields.name, (v) => {
    if (!v) return 'A database name is required.';
    // Matches the server's allowlist; catching it here saves a round trip
    // and explains the rule at the point of entry.
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(v)) {
      return 'Use letters, digits and underscores, starting with a letter.';
    }
    return '';
  }],
];

$('#db-test').addEventListener('click', async (e) => {
  if (!validate(dbChecks())) return;
  const button = e.currentTarget;
  const out = $('#db-result');

  setBusy(button, true, 'Connecting…');
  clearResult(out);
  try {
    const info = await api.post('/api/setup/db/test', dbSettings());

    if (info.databaseExists) {
      showResult(out, {
        kind: 'warn',
        title: `Connected — database "${info.database}" already exists`,
        detail: `${info.edition || 'SQL Server'}, signed in as ${info.loginName}.`,
        hint: 'DSMT will reuse it and add any missing tables. Nothing existing is dropped.',
      });
    } else if (!info.canCreateDatabase) {
      // Connecting is not the same as being able to create — say so now
      // rather than failing on the next button.
      showResult(out, {
        kind: 'warn',
        title: 'Connected, but this account cannot create a database',
        detail: `Signed in as ${info.loginName}.`,
        hint: 'Grant the dbcreator server role, or create the database manually and re-test.',
      });
    } else {
      showResult(out, {
        kind: 'ok',
        title: 'Connected to SQL Server',
        detail: `${info.version || info.edition}. Signed in as ${info.loginName}.`,
        hint: `Ready to create "${info.database}".`,
      });
    }
    verified.db = true;
    $('#db-create').disabled = false;
  } catch (err) {
    showError(out, err);
  } finally {
    setBusy(button, false);
  }
});

$('#db-create').addEventListener('click', async (e) => {
  if (!validate(dbChecks())) return;
  const button = e.currentTarget;
  const out = $('#db-result');

  setBusy(button, true, 'Creating…');
  try {
    const info = await api.post('/api/setup/db/create', dbSettings());
    showResult(out, {
      kind: 'ok',
      title: info.adopted
        ? `Using the existing database "${info.database}"`
        : `Created the database "${info.database}"`,
      detail: 'Schema applied.',
    });
    verified.db = true;
    goTo(3);
  } catch (err) {
    showError(out, err);
  } finally {
    setBusy(button, false);
  }
});

/* ── step 3: directory ───────────────────────────────────────────────── */

const dirChecks = () => [
  [dirFields.host, required('The domain controller')],
  [dirFields.bindDn, required('The username')],
  [dirFields.bindPw, required('The password')],
  [dirFields.port, (v) => portCheck(v, false)],
  // One of the two must be present: without either, there is nothing to
  // search and the old behaviour was to guess from the hostname.
  [dirFields.domain, (v) => (v || dirFields.baseDn.value.trim()
    ? '' : 'Enter the domain, or type the base DN below.')],
];

$('#dir-test').addEventListener('click', async (e) => {
  if (!validate(dirChecks())) return;
  const button = e.currentTarget;
  const out = $('#dir-result');

  setBusy(button, true, 'Connecting…');
  clearResult(out);
  try {
    const info = await api.post('/api/setup/directory/test', dirSettings());

    // Reflect the base DN the server settled on — it may have derived one.
    if (info.baseDn && !dirFields.baseDn.value.trim()) dirFields.baseDn.value = info.baseDn;

    const count = info.userCountCapped ? '500+' : String(info.userCount);
    showResult(out, {
      kind: info.userCount === 0 ? 'warn' : 'ok',
      title: info.userCount === 0
        ? 'Connected, but no users were found'
        : `Connected to ${info.server}`,
      detail: `${count} user account${info.userCount === 1 ? '' : 's'} visible under ${info.baseDn}.`
        + (info.secure ? ' Connection is encrypted (LDAPS).' : ''),
      hint: info.userCount === 0
        ? 'Check the base DN — it may point at a container that holds no users.'
        : (info.secure ? '' : 'This connection is not encrypted. Enable LDAPS if your domain controllers support it.'),
    });
    verified.dir = true;
    $('#dir-next').disabled = false;
  } catch (err) {
    showError(out, err);
  } finally {
    setBusy(button, false);
  }
});

$('#dir-next').addEventListener('click', () => {
  if (!verified.dir) return;
  renderReview();
  goTo(4);
});

/* ── step 4: review and finish ───────────────────────────────────────── */

function row(dl, label, value) {
  dl.append(el('dt', { text: label }), el('dd', { text: value }));
}

function renderReview() {
  const db = dbSettings();
  const dir = dirSettings();

  const dbList = $('#review-db');
  dbList.replaceChildren();
  row(dbList, 'Server', db.server);
  row(dbList, db.instance ? 'Instance' : 'Port',
    db.instance || String(db.port || DEFAULT_SQL_PORT));
  row(dbList, 'Database', db.database);
  if (db.username) {
    row(dbList, 'Authentication', db.authMode === 'windows' ? 'Windows (NTLM)' : 'SQL Server');
    row(dbList, 'Username', db.username);
  } else {
    row(dbList, 'Authentication', 'Windows Integrated');
    row(dbList, 'Account', identity && identity.account ? identity.account : 'the account running DSMT');
  }
  if (db.trustServerCert) row(dbList, 'Certificate', 'Trusted without validation');

  const dirList = $('#review-dir');
  dirList.replaceChildren();
  row(dirList, 'Controller', `${dir.host}:${dir.port || (dir.useLdaps ? LDAPS_PORT : LDAP_PORT)}`);
  row(dirList, 'Encryption', dir.useLdaps ? 'LDAPS' : 'None (plain LDAP)');
  row(dirList, 'Domain', dir.domain || '—');
  row(dirList, 'Base DN', dir.baseDn || domainToBaseDn(dir.domain));
  row(dirList, 'Bind account', dir.bindDn);
  if (dir.trustServerCert) row(dirList, 'Certificate', 'Trusted without validation');
}

$('#finish').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  const out = $('#finish-result');

  if (!verified.db || !verified.dir) {
    return showResult(out, {
      kind: 'error',
      title: 'Both connections must be tested first',
      hint: 'Go back and run the connection test on each step.',
    });
  }

  setBusy(button, true, 'Saving…');
  clearResult(out);
  try {
    await api.post('/api/setup/complete', { database: dbSettings(), directory: dirSettings() });
    showResult(out, {
      kind: 'ok',
      title: 'Setup complete',
      detail: 'Opening the user directory…',
    });
    setTimeout(() => location.assign('users.html'), 900);
  } catch (err) {
    showError(out, err);
    setBusy(button, false);
  }
});

/* ── already configured? ─────────────────────────────────────────────
   Re-running setup would repoint a working installation, so a completed
   install is sent straight to the app instead of being offered the form. */

api.get('/api/setup/status')
  .then((status) => {
    if (status.complete) return location.replace('users.html');
    identity = status.identity || null;
    syncIdentityHint();
    return undefined;
  })
  .catch(() => { /* the wizard is exactly what you need when status fails */ });
