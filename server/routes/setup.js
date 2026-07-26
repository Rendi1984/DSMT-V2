/* Setup wizard API. Each endpoint reports a precise outcome — success and
   every distinct failure cause get their own code, message and next step. */

import { Router } from 'express';

import * as db from '../lib/db.js';
import * as ldap from '../lib/ldap.js';
import { encryptSecret } from '../lib/crypto.js';
import { domainToBaseDn } from '../lib/ad-attrs.js';
import { secretKey, writeBootstrap, getSetupStatus } from '../lib/state.js';
import { ok, asHandler } from './helpers.js';

export const setupRouter = Router();

/* Setup rewrites how the whole app connects, so it must stop being usable
   once it has run — otherwise anyone reaching the page could repoint DSMT
   at a directory of their choosing. */
async function assertSetupOpen() {
  const status = await getSetupStatus();
  if (status.complete) {
    throw Object.assign(new Error('Setup has already been completed'), {
      code: 'setup_closed',
      message: 'Setup has already been completed',
      detail: 'DSMT is already configured.',
      hint: 'To reconfigure, stop the service and remove server/data/bootstrap.json.',
      status: 409,
    });
  }
}

/* ── status ──────────────────────────────────────────────────────────── */

setupRouter.get('/status', asHandler(async (req, res) => {
  ok(res, { ...await getSetupStatus(), identity: db.processIdentity() });
}));

/* ── database ────────────────────────────────────────────────────────── */

function readSqlSettings(body) {
  const settings = {
    server: String(body.server || '').trim(),
    port: Number(body.port) || undefined,
    instance: String(body.instance || '').trim(),
    authMode: body.authMode === 'windows' ? 'windows' : 'sql',
    username: String(body.username || '').trim(),
    password: String(body.password || ''),
    domain: String(body.domain || '').trim(),
    database: String(body.database || '').trim() || 'DSMT',
    encrypt: body.encrypt !== false,
    trustServerCert: Boolean(body.trustServerCert),
  };
  if (!settings.server) {
    throw Object.assign(new Error('Missing required fields'), {
      code: 'validation',
      message: 'Missing required fields',
      detail: 'Provide the SQL Server address.',
      status: 400,
    });
  }
  // Username and password are deliberately optional: leaving both blank means
  // "connect as the account DSMT already runs as" (Windows Integrated
  // Authentication). Half-filled is still an error, since it is far more
  // likely to be a typo than a deliberate choice.
  const hasUser = settings.username !== '';
  const hasPassword = settings.password !== '';
  if (hasUser !== hasPassword) {
    throw Object.assign(new Error('Incomplete credentials'), {
      code: 'validation',
      message: 'Incomplete credentials',
      detail: hasUser ? 'A username was given without a password.' : 'A password was given without a username.',
      hint: 'Fill in both, or clear both to connect as the account running DSMT.',
      status: 400,
    });
  }
  return settings;
}

setupRouter.post('/db/test', asHandler(async (req, res) => {
  await assertSetupOpen();
  const settings = readSqlSettings(req.body || {});

  const info = await db.testConnection(settings);
  const exists = await db.databaseExists(settings, settings.database);
  ok(res, {
    ...info,
    database: settings.database,
    databaseExists: exists,
    authMode: db.resolveAuthMode(settings),
  });
}));

setupRouter.post('/db/create', asHandler(async (req, res) => {
  await assertSetupOpen();
  const settings = readSqlSettings(req.body || {});
  db.assertSafeIdentifier(settings.database); // reject bad names before dialling out

  const result = await db.createDatabaseAndSchema(settings);
  ok(res, result);
}));

/* ── directory ───────────────────────────────────────────────────────── */

function readDirectorySettings(body) {
  const useLdaps = Boolean(body.useLdaps);
  const settings = {
    host: String(body.host || '').trim(),
    port: Number(body.port) || ldap.defaultPortFor(useLdaps),
    domain: String(body.domain || '').trim(),
    baseDn: String(body.baseDn || '').trim(),
    bindDn: String(body.bindDn || '').trim(),
    bindPassword: String(body.bindPassword || ''),
    useLdaps,
    trustServerCert: Boolean(body.trustServerCert),
  };
  const missing = [];
  if (!settings.host) missing.push('domain controller');
  if (!settings.bindDn) missing.push('bind account');
  if (!settings.bindPassword) missing.push('password');
  if (missing.length) {
    throw Object.assign(new Error('Missing required fields'), {
      code: 'validation',
      message: 'Missing required fields',
      detail: `Provide the ${missing.join(', ')}.`,
      status: 400,
    });
  }
  // Derive the base DN from the domain the admin gave us. Deriving it from
  // the DC hostname instead is a guess that breaks whenever the DC is reached
  // by IP or short name, or its FQDN doesn't match the AD domain.
  if (!settings.baseDn) {
    if (!settings.domain) {
      throw Object.assign(new Error('Domain or base DN required'), {
        code: 'validation',
        message: 'Domain or base DN required',
        detail: 'Provide the domain (for example contoso.local), or type the base DN directly.',
        hint: 'DSMT builds the base DN from the domain: contoso.local becomes DC=contoso,DC=local.',
        status: 400,
      });
    }
    settings.baseDn = domainToBaseDn(settings.domain);
  }
  return settings;
}

setupRouter.post('/directory/test', asHandler(async (req, res) => {
  await assertSetupOpen();
  const settings = readDirectorySettings(req.body || {});

  const info = await ldap.testConnection(settings);
  ok(res, info);
}));

/* ── finish ──────────────────────────────────────────────────────────── */

setupRouter.post('/complete', asHandler(async (req, res) => {
  await assertSetupOpen();
  const body = req.body || {};
  const sqlSettings = readSqlSettings(body.database || {});
  const dirSettings = readDirectorySettings(body.directory || {});

  // Re-verify both connections rather than trusting that the earlier test
  // steps passed — the browser controls what it sends here.
  await db.testConnection(sqlSettings);
  await ldap.testConnection(dirSettings);

  await db.createDatabaseAndSchema(sqlSettings);

  const pool = await db.connect(sqlSettings, sqlSettings.database);
  try {
    await db.saveDirectoryConfig(pool, {
      host: dirSettings.host,
      port: dirSettings.port,
      domain: dirSettings.domain,
      baseDn: dirSettings.baseDn,
      bindDn: dirSettings.bindDn,
      bindPasswordEnc: encryptSecret(dirSettings.bindPassword, secretKey()),
      useLdaps: dirSettings.useLdaps,
      trustServerCert: dirSettings.trustServerCert,
    });
    await db.setSetting(pool, 'setup_complete', 'true');
    await db.writeAudit(pool, {
      actor: sqlSettings.username || db.processIdentity().account,
      action: 'setup.complete',
      target: dirSettings.host,
      detail: `base DN ${dirSettings.baseDn}, LDAPS ${dirSettings.useLdaps ? 'on' : 'off'}`,
      sourceIp: req.ip,
    });
  } finally {
    await pool.close().catch(() => {});
  }

  // Written last: only once the database really holds the config is it safe
  // to point future startups at it.
  writeBootstrap({
    sql: { ...sqlSettings, password: encryptSecret(sqlSettings.password, secretKey()) },
    savedUtc: new Date().toISOString(),
  });

  ok(res, { complete: true, database: sqlSettings.database });
}));
