/* Runtime state: how DSMT finds its database before the database exists.

   Chicken-and-egg — the directory config lives in SQL Server, but reaching
   SQL Server needs its own settings. Those go in a small bootstrap file
   written when the wizard completes; everything else lives in the database. */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, loadDirectoryConfig, getSetting } from './db.js';
import { decryptSecret, loadOrCreateKey } from './crypto.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(HERE, '..', 'data');
export const BOOTSTRAP_PATH = join(DATA_DIR, 'bootstrap.json');
export const KEY_PATH = join(DATA_DIR, 'dsmt.key');

/** 'demo' serves fixtures; 'live' talks to real servers and never falls back. */
export const MODE = process.env.DSMT_MODE === 'demo' ? 'demo' : 'live';
export const isDemo = () => MODE === 'demo';

let key = null;
export function secretKey() {
  if (!key) key = loadOrCreateKey(KEY_PATH);
  return key;
}

/* ── bootstrap file ──────────────────────────────────────────────────── */

export function readBootstrap() {
  if (!existsSync(BOOTSTRAP_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BOOTSTRAP_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function writeBootstrap(data) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(BOOTSTRAP_PATH, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** Bootstrap SQL settings with the password decrypted, ready for `connect`.
    The file stores it encrypted, so every reader must come through here —
    handing the stored form straight to the driver fails as a login error,
    which looks like wrong credentials rather than a decryption bug. */
export function readSqlSettings() {
  const boot = readBootstrap();
  if (!boot || !boot.sql) return null;
  return { ...boot.sql, password: decryptSecret(boot.sql.password, secretKey()) };
}

/** In demo mode setup is never "complete" until the wizard is walked, so the
    wizard can be exercised end to end; the flag lives in memory only. */
let demoSetupComplete = false;
export const markDemoSetupComplete = () => { demoSetupComplete = true; };
export const isDemoSetupComplete = () => demoSetupComplete;

/* ── database-backed config ──────────────────────────────────────────── */

/** Has setup been completed? */
export async function getSetupStatus() {
  if (isDemo()) return { complete: demoSetupComplete, mode: MODE };

  const sqlSettings = readSqlSettings();
  if (!sqlSettings) return { complete: false, mode: MODE };

  try {
    const pool = await connect(sqlSettings, sqlSettings.database);
    try {
      const flag = await getSetting(pool, 'setup_complete');
      return { complete: flag === 'true', mode: MODE, database: sqlSettings.database };
    } finally {
      await pool.close().catch(() => {});
    }
  } catch (err) {
    // The bootstrap file points somewhere we can't reach. Report it plainly
    // rather than pretending setup was never done — re-running the wizard
    // over a working database is not the fix for an unreachable one.
    return {
      complete: false,
      mode: MODE,
      unreachable: true,
      error: { code: err.code, message: err.message, detail: err.detail, hint: err.hint },
    };
  }
}

/** Directory settings ready to hand to the LDAP layer, password decrypted. */
export async function getDirectoryConfig() {
  const sqlSettings = readSqlSettings();
  if (!sqlSettings) return null;

  const pool = await connect(sqlSettings, sqlSettings.database);
  try {
    const cfg = await loadDirectoryConfig(pool);
    if (!cfg) return null;
    return {
      host: cfg.host,
      port: cfg.port,
      baseDn: cfg.baseDn,
      bindDn: cfg.bindDn,
      bindPassword: decryptSecret(cfg.bindPasswordEnc, secretKey()),
      useLdaps: cfg.useLdaps,
      trustServerCert: cfg.trustServerCert,
    };
  } finally {
    await pool.close().catch(() => {});
  }
}
