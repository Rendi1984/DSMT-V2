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
  baseDn: $('#dir-basedn'),
  bindDn: $('#dir-binddn'),
  bindPw: $('#dir-bindpw'),
};

const dbSettings = () => ({
  server: dbFields.server.value.trim(),
  authMode: dbFields.auth.value,
  username: dbFields.user.value.trim(),
  password: dbFields.pass.value,
  database: dbFields.name.value.trim() || 'DSMT',
  trustServerCert: dbFields.trust.checked,
});

const dirSettings = () => ({
  host: dirFields.host.value.trim(),
  port: Number(dirFields.port.value) || undefined,
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

const dbChecks = () => [
  [dbFields.server, required('The server address')],
  [dbFields.user, required('The username')],
  [dbFields.pass, required('The password')],
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
  [dirFields.port, (v) => {
    const n = Number(v);
    return v && (!Number.isInteger(n) || n < 1 || n > 65535) ? 'Enter a port between 1 and 65535.' : '';
  }],
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
  row(dbList, 'Database', db.database);
  row(dbList, 'Authentication', db.authMode === 'windows' ? 'Windows (NTLM)' : 'SQL Server');
  row(dbList, 'Username', db.username);
  if (db.trustServerCert) row(dbList, 'Certificate', 'Trusted without validation');

  const dirList = $('#review-dir');
  dirList.replaceChildren();
  row(dirList, 'Controller', `${dir.host}:${dir.port || (dir.useLdaps ? LDAPS_PORT : LDAP_PORT)}`);
  row(dirList, 'Encryption', dir.useLdaps ? 'LDAPS' : 'None (plain LDAP)');
  row(dirList, 'Base DN', dir.baseDn || '(derived from the domain)');
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
  .then((status) => { if (status.complete) location.replace('users.html'); })
  .catch(() => { /* the wizard is exactly what you need when status fails */ });
