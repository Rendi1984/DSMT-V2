/* Setup wizard API. Each endpoint reports a precise outcome — success and
   every distinct failure cause get their own code, message and next step. */

import { Router } from 'express';

import * as db from '../lib/db.js';
import * as ldap from '../lib/ldap.js';
import { encryptSecret } from '../lib/crypto.js';
import { domainToBaseDn } from '../lib/ad-attrs.js';
import {
  isDemo, MODE, secretKey, writeBootstrap, getSetupStatus,
  markDemoSetupComplete, readBootstrap,
} from '../lib/state.js';
import { demoDirectoryInfo, demoSqlInfo } from '../lib/demo.js';
import { ok, fail, asHandler } from './helpers.js';

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
  ok(res, await getSetupStatus());
}));

/* ── database ────────────────────────────────────────────────────────── */

function readSqlSettings(body) {
  const settings = {
    server: String(body.server || '').trim(),
    authMode: body.authMode === 'windows' ? 'windows' : 'sql',
    username: String(body.username || '').trim(),
    password: String(body.password || ''),
    domain: String(body.domain || '').trim(),
    database: String(body.database || '').trim() || 'DSMT',
    encrypt: body.encrypt !== false,
    trustServerCert: Boolean(body.trustServerCert),
  };
  const missing = [];
  if (!settings.server) missing.push('SQL Server address');
  if (!settings.username) missing.push('username');
  if (!settings.password) missing.push('password');
  if (missing.length) {
    throw Object.assign(new Error('Missing required fields'), {
      code: 'validation',
      message: 'Missing required fields',
      detail: `Provide the ${missing.join(', ')}.`,
      status: 400,
    });
  }
  return settings;
}

setupRouter.post('/db/test', asHandler(async (req, res) => {
  await assertSetupOpen();
  const settings = readSqlSettings(req.body || {});

  if (isDemo()) {
    return ok(res, { ...demoSqlInfo, database: settings.database });
  }

  const info = await db.testConnection(settings);
  const exists = await db.databaseExists(settings, settings.database);
  ok(res, { ...info, database: settings.database, databaseExists: exists });
}));

setupRouter.post('/db/create', asHandler(async (req, res) => {
  await assertSetupOpen();
  const settings = readSqlSettings(req.body || {});
  db.assertSafeIdentifier(settings.database); // reject bad names before dialling out

  if (isDemo()) {
    return ok(res, { created: true, adopted: false, database: settings.database });
  }

  const result = await db.createDatabaseAndSchema(settings);
  ok(res, result);
}));

/* ── directory ───────────────────────────────────────────────────────── */

function readDirectorySettings(body) {
  const useLdaps = Boolean(body.useLdaps);
  const settings = {
    host: String(body.host || '').trim(),
    port: Number(body.port) || ldap.defaultPortFor(useLdaps),
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
  // An empty base DN is a common omission with an obvious answer: derive it
  // from the host's domain rather than bouncing the user back to the form.
  if (!settings.baseDn) {
    const parts = settings.host.split('.').slice(1).join('.');
    settings.baseDn = domainToBaseDn(parts || settings.host);
  }
  return settings;
}

setupRouter.post('/directory/test', asHandler(async (req, res) => {
  await assertSetupOpen();
  const settings = readDirectorySettings(req.body || {});

  if (isDemo()) {
    return ok(res, { ...demoDirectoryInfo, baseDn: settings.baseDn, secure: settings.useLdaps });
  }

  const info = await ldap.testConnection(settings);
  ok(res, info);
}));

/* ── finish ──────────────────────────────────────────────────────────── */

setupRouter.post('/complete', asHandler(async (req, res) => {
  await assertSetupOpen();
  const body = req.body || {};
  const sqlSettings = readSqlSettings(body.database || {});
  const dirSettings = readDirectorySettings(body.directory || {});

  if (isDemo()) {
    markDemoSetupComplete();
    return ok(res, { complete: true, database: sqlSettings.database });
  }

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
      baseDn: dirSettings.baseDn,
      bindDn: dirSettings.bindDn,
      bindPasswordEnc: encryptSecret(dirSettings.bindPassword, secretKey()),
      useLdaps: dirSettings.useLdaps,
      trustServerCert: dirSettings.trustServerCert,
    });
    await db.setSetting(pool, 'setup_complete', 'true');
    await db.writeAudit(pool, {
      actor: sqlSettings.username,
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
