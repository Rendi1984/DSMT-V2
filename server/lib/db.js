/* SQL Server access. `buildSqlConfig` and `classifySqlError` are pure and
   unit-tested; everything below them needs a reachable SQL Server. */

import os from 'node:os';

import sql from 'mssql';

export const SCHEMA_VERSION = 2;

export const DEFAULT_SQL_PORT = 1433;

/* ── connection config ────────────────────────────────────────────────
   The wizard asks for server, port and instance as separate fields, but an
   admin will still paste `host,1433` or `host\INSTANCE` straight out of SSMS
   into the server box. This parses all three shapes so that keeps working. */
export function parseServerSpec(spec) {
  const raw = String(spec || '').trim();
  if (!raw) return { server: '', instanceName: undefined, port: undefined };

  // `host\INSTANCE` — named instances are resolved by the SQL Browser
  // service, so a port must NOT also be supplied.
  const backslash = raw.indexOf('\\');
  if (backslash !== -1) {
    return {
      server: raw.slice(0, backslash).trim(),
      instanceName: raw.slice(backslash + 1).trim() || undefined,
      port: undefined,
    };
  }
  // `host,1433` is SSMS syntax; `host:1433` is the usual URL form.
  const sep = raw.search(/[,:]/);
  if (sep !== -1) {
    const port = Number(raw.slice(sep + 1).trim());
    return {
      server: raw.slice(0, sep).trim(),
      instanceName: undefined,
      port: Number.isFinite(port) && port > 0 ? port : undefined,
    };
  }
  return { server: raw, instanceName: undefined, port: undefined };
}

/** Resolve the three connection fields into one answer.

    Anything embedded in the server string wins over the separate fields —
    if someone pasted `sql01\SQLEXPRESS`, that is a more specific statement of
    intent than a port box still sitting on its 1433 default.

    A named instance and a port are mutually exclusive: the instance is
    resolved by the SQL Browser service, and supplying a port as well makes
    the driver dial that port directly and ignore the instance, which fails
    as a confusing timeout rather than as "you can't set both". */
export function resolveEndpoint(settings) {
  const parsed = parseServerSpec(settings.server);
  const instanceName = parsed.instanceName || (settings.instance
    ? String(settings.instance).trim() || undefined
    : undefined);

  if (instanceName) return { server: parsed.server, instanceName, port: undefined };

  const explicit = Number(parsed.port || settings.port);
  return {
    server: parsed.server,
    instanceName: undefined,
    port: Number.isFinite(explicit) && explicit > 0 ? explicit : DEFAULT_SQL_PORT,
  };
}

/* ── who are we connecting as ─────────────────────────────────────────
   Leaving the username and password blank means "use the account DSMT is
   already running as" — Windows Integrated Authentication. That is the
   normal answer for a domain-joined server, and it avoids storing a second
   set of credentials just to reach a database the service account can
   already open. */
export function resolveAuthMode(settings) {
  const hasUser = String(settings.username || '').trim() !== '';
  const hasPassword = String(settings.password || '') !== '';
  if (!hasUser && !hasPassword) return 'integrated';
  return settings.authMode === 'windows' ? 'ntlm' : 'sql';
}

/** The account DSMT itself runs as, for the wizard to show before connecting. */
export function processIdentity() {
  let username = '';
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USERNAME || process.env.USER || '';
  }
  const domain = process.env.USERDOMAIN || '';
  return {
    account: domain ? `${domain}\\${username}` : username,
    // Integrated auth is a Windows facility; say so rather than offering it
    // on a platform where it cannot work.
    platformSupportsIntegrated: process.platform === 'win32',
    platform: process.platform,
  };
}

/** Build an `mssql` config. `database` is chosen by the caller: setup
    connects to `master` first, then to the new database. */
export function buildSqlConfig(settings, database) {
  const { server, instanceName, port } = resolveEndpoint(settings);
  const authMode = resolveAuthMode(settings);

  const config = {
    server,
    database: database || settings.database || 'master',
    options: {
      // TLS on by default; trustServerCertificate is the explicit escape
      // hatch for the self-signed certs that internal servers ship with.
      encrypt: settings.encrypt !== false,
      trustServerCertificate: Boolean(settings.trustServerCert),
      enableArithAbort: true,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 15000,
    requestTimeout: 30000,
  };

  if (instanceName) config.options.instanceName = instanceName;
  else config.port = port;

  if (authMode === 'integrated') {
    // Handled by the msnodesqlv8 driver, which passes Trusted_Connection to
    // ODBC and so authenticates as the process's own Windows token. No
    // credentials are set here — that is the whole point.
    config.options.trustedConnection = true;
  } else if (authMode === 'ntlm') {
    // NTLM: tedious wants the bare account plus the domain separately.
    const user = String(settings.username || '');
    const slash = user.indexOf('\\');
    config.authentication = {
      type: 'ntlm',
      options: {
        userName: slash === -1 ? user : user.slice(slash + 1),
        password: settings.password || '',
        domain: settings.domain || (slash === -1 ? '' : user.slice(0, slash)),
      },
    };
  } else {
    config.user = settings.username || '';
    config.password = settings.password || '';
  }

  config.authMode = authMode;
  return config;
}

/* ── error classification ────────────────────────────────────────────── */
export function classifySqlError(err, ctx = {}) {
  const raw = String((err && (err.message || err.code)) || err || '');
  const number = err && (err.number ?? err.originalError?.info?.number);
  const code = err && err.code;

  if (code === 'ENOTFOUND' || /getaddrinfo/i.test(raw)) {
    return {
      code: 'sql_host_not_found',
      message: 'SQL Server not found',
      detail: `The hostname "${ctx.server || ''}" could not be resolved.`,
      hint: 'Check the spelling, or use the IP address.',
    };
  }
  if (code === 'ESOCKET' && /instance/i.test(raw)) {
    return {
      code: 'sql_instance',
      message: 'Named instance not found',
      detail: raw,
      hint: 'The SQL Browser service must be running on the server for named instances, and UDP 1434 must be open.',
    };
  }
  if (code === 'ECONNREFUSED' || code === 'ESOCKET') {
    return {
      code: 'sql_refused',
      message: 'Could not reach SQL Server',
      detail: raw,
      hint: 'Check that the instance is running, TCP/IP is enabled, and the port is open.',
    };
  }
  if (code === 'ETIMEOUT' || /timeout/i.test(raw)) {
    return {
      code: 'sql_timeout',
      message: 'Connection timed out',
      detail: raw,
      hint: 'A firewall between this server and SQL Server is the usual cause.',
    };
  }
  // 18456 is "login failed"; 4060 is "cannot open database".
  if (number === 18456 || /login failed/i.test(raw)) {
    return {
      code: 'sql_login',
      message: 'SQL Server rejected the login',
      detail: raw,
      hint: 'Check the credentials. SQL Authentication also requires mixed-mode auth to be enabled on the server.',
    };
  }
  if (number === 4060) {
    return {
      code: 'sql_db_access',
      message: 'Cannot open that database',
      detail: raw,
      hint: 'The login exists but has no access to this database.',
    };
  }
  // 262 = CREATE DATABASE permission denied; 15247/229 = generic permission.
  if (number === 262 || number === 15247 || number === 229 || /permission (was )?denied/i.test(raw)) {
    return {
      code: 'sql_permission',
      message: 'The account lacks permission',
      detail: raw,
      hint: 'Creating a database requires the dbcreator server role (or sysadmin).',
    };
  }
  if (/self.signed|certificate/i.test(raw)) {
    return {
      code: 'sql_tls',
      message: 'The SQL Server certificate was rejected',
      detail: raw,
      hint: 'Enable "Trust the server certificate" if the server uses a self-signed certificate.',
    };
  }
  return { code: 'sql_error', message: 'SQL Server request failed', detail: raw, hint: '' };
}

/** Wrap a driver error in our classified shape. */
export function asSqlError(err, ctx) {
  const info = classifySqlError(err, ctx);
  const wrapped = new Error(info.message);
  return Object.assign(wrapped, info, { isSqlError: true });
}

/* ── identifier safety ───────────────────────────────────────────────
   Database names cannot be parameterised — `CREATE DATABASE @name` is not
   valid T-SQL — so the name is validated against a strict allowlist and
   then bracket-quoted. Anything outside the allowlist is rejected rather
   than escaped, which keeps the injection surface at zero. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function assertSafeIdentifier(name) {
  if (!IDENT_RE.test(String(name || ''))) {
    throw Object.assign(new Error('Invalid database name'), {
      code: 'invalid_db_name',
      message: 'Invalid database name',
      detail: `"${name}" is not a valid identifier.`,
      hint: 'Use letters, digits and underscores, starting with a letter. Maximum 63 characters.',
      isSqlError: true,
    });
  }
  return `[${name}]`;
}

/* ── connections ─────────────────────────────────────────────────────── */

/* Integrated authentication needs the msnodesqlv8 driver: tedious, the
   default, can do NTLM with explicit credentials but cannot present the
   process's own Windows token. msnodesqlv8 is a native, Windows-only module,
   so it is an optional dependency loaded only on this path — importing it
   eagerly would break `npm install` everywhere else. */
let integratedDriver;

async function loadIntegratedDriver() {
  if (integratedDriver) return integratedDriver;
  try {
    const mod = await import('mssql/msnodesqlv8.js');
    integratedDriver = mod.default || mod;
    return integratedDriver;
  } catch (cause) {
    throw Object.assign(new Error('Windows Integrated Authentication is unavailable'), {
      code: 'sql_driver_missing',
      message: 'Windows Integrated Authentication is unavailable',
      detail: process.platform === 'win32'
        ? 'The msnodesqlv8 driver is not installed.'
        : `Integrated authentication is a Windows feature; this server runs ${process.platform}.`,
      hint: process.platform === 'win32'
        ? 'Run "npm install msnodesqlv8" in the DSMT folder, then restart DSMT. Or enter a username and password to use SQL Server Authentication instead.'
        : 'Enter a SQL Server username and password instead.',
      isSqlError: true,
      cause,
    });
  }
}

export async function connect(settings, database) {
  const config = buildSqlConfig(settings, database);
  const driver = config.authMode === 'integrated' ? await loadIntegratedDriver() : sql;
  try {
    const pool = new driver.ConnectionPool(config);
    await pool.connect();
    return pool;
  } catch (err) {
    throw asSqlError(err, { server: config.server });
  }
}

/** Connect to `master`, confirm identity and report what we can do. */
export async function testConnection(settings) {
  const pool = await connect(settings, 'master');
  try {
    const info = await pool.request().query(`
      SELECT
        @@VERSION                                              AS version,
        SERVERPROPERTY('ProductVersion')                       AS productVersion,
        SERVERPROPERTY('Edition')                              AS edition,
        SUSER_SNAME()                                          AS loginName,
        IS_SRVROLEMEMBER('dbcreator')                          AS isDbCreator,
        IS_SRVROLEMEMBER('sysadmin')                           AS isSysadmin
    `);
    const row = info.recordset[0] || {};
    const canCreate = row.isSysadmin === 1 || row.isDbCreator === 1;
    return {
      version: String(row.version || '').split('\n')[0].trim(),
      edition: row.edition || '',
      loginName: row.loginName || '',
      canCreateDatabase: canCreate,
    };
  } catch (err) {
    throw asSqlError(err, { server: settings.server });
  } finally {
    await pool.close().catch(() => {});
  }
}

/** Does the database already exist? */
export async function databaseExists(settings, name) {
  const pool = await connect(settings, 'master');
  try {
    const res = await pool.request()
      .input('name', sql.NVarChar, name)
      .query('SELECT database_id FROM sys.databases WHERE name = @name');
    return res.recordset.length > 0;
  } catch (err) {
    throw asSqlError(err, { server: settings.server });
  } finally {
    await pool.close().catch(() => {});
  }
}

/** Create the database if absent, then apply the schema.
    Idempotent by design: an existing database is adopted and only the
    missing tables are created, so re-running the wizard is safe. */
export async function createDatabaseAndSchema(settings) {
  const name = settings.database;
  const quoted = assertSafeIdentifier(name);
  const existed = await databaseExists(settings, name);

  if (!existed) {
    const master = await connect(settings, 'master');
    try {
      await master.request().batch(`CREATE DATABASE ${quoted}`);
    } catch (err) {
      throw asSqlError(err, { server: settings.server });
    } finally {
      await master.close().catch(() => {});
    }
  }

  const pool = await connect(settings, name);
  try {
    await applySchema(pool);
    return { created: !existed, adopted: existed, database: name };
  } catch (err) {
    throw asSqlError(err, { server: settings.server });
  } finally {
    await pool.close().catch(() => {});
  }
}

/** Create any missing tables. Every statement is guarded, so this can run
    against a fresh database or one from an earlier version. */
export async function applySchema(pool) {
  await pool.request().batch(`
IF OBJECT_ID('dbo.app_settings', 'U') IS NULL
CREATE TABLE dbo.app_settings (
  [key]        NVARCHAR(128)  NOT NULL PRIMARY KEY,
  [value]      NVARCHAR(MAX)  NULL,
  updated_utc  DATETIME2(0)   NOT NULL CONSTRAINT DF_app_settings_updated DEFAULT SYSUTCDATETIME()
);

IF OBJECT_ID('dbo.directory_config', 'U') IS NULL
CREATE TABLE dbo.directory_config (
  id                 INT            NOT NULL PRIMARY KEY,
  host               NVARCHAR(255)  NOT NULL,
  port               INT            NOT NULL,
  domain             NVARCHAR(255)  NULL,
  base_dn            NVARCHAR(512)  NOT NULL,
  bind_dn            NVARCHAR(512)  NOT NULL,
  bind_password_enc  NVARCHAR(MAX)  NOT NULL,
  use_ldaps          BIT            NOT NULL CONSTRAINT DF_dir_ldaps DEFAULT 0,
  trust_server_cert  BIT            NOT NULL CONSTRAINT DF_dir_trust DEFAULT 0,
  updated_utc        DATETIME2(0)   NOT NULL CONSTRAINT DF_dir_updated DEFAULT SYSUTCDATETIME(),
  CONSTRAINT CK_directory_config_single_row CHECK (id = 1)
);

/* Schema v1 → v2: the domain became a field the wizard asks for rather than
   something inferred from the DC hostname. Guarded so re-running the wizard
   over a v1 database adds the column instead of failing. */
IF OBJECT_ID('dbo.directory_config', 'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.columns
                   WHERE object_id = OBJECT_ID('dbo.directory_config') AND name = 'domain')
ALTER TABLE dbo.directory_config ADD domain NVARCHAR(255) NULL;

IF OBJECT_ID('dbo.audit_log', 'U') IS NULL
CREATE TABLE dbo.audit_log (
  id          BIGINT IDENTITY(1,1) PRIMARY KEY,
  occurred_utc DATETIME2(0)  NOT NULL CONSTRAINT DF_audit_at DEFAULT SYSUTCDATETIME(),
  actor       NVARCHAR(255)  NULL,
  action      NVARCHAR(128)  NOT NULL,
  target      NVARCHAR(512)  NULL,
  detail      NVARCHAR(MAX)  NULL,
  source_ip   NVARCHAR(64)   NULL
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_audit_log_occurred')
CREATE INDEX IX_audit_log_occurred ON dbo.audit_log (occurred_utc DESC);
  `);

  await pool.request()
    .input('v', sql.NVarChar, String(SCHEMA_VERSION))
    .query(`
      MERGE dbo.app_settings AS t
      USING (SELECT 'schema_version' AS [key]) AS s ON t.[key] = s.[key]
      WHEN MATCHED THEN UPDATE SET [value] = @v, updated_utc = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES ('schema_version', @v);
    `);
}

/* ── settings and directory config ───────────────────────────────────── */

export async function getSetting(pool, key) {
  const res = await pool.request()
    .input('key', sql.NVarChar, key)
    .query('SELECT [value] FROM dbo.app_settings WHERE [key] = @key');
  return res.recordset.length ? res.recordset[0].value : null;
}

export async function setSetting(pool, key, value) {
  await pool.request()
    .input('key', sql.NVarChar, key)
    .input('value', sql.NVarChar, value === null ? null : String(value))
    .query(`
      MERGE dbo.app_settings AS t
      USING (SELECT @key AS [key]) AS s ON t.[key] = s.[key]
      WHEN MATCHED THEN UPDATE SET [value] = @value, updated_utc = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (@key, @value);
    `);
}

export async function saveDirectoryConfig(pool, cfg) {
  await pool.request()
    .input('host', sql.NVarChar, cfg.host)
    .input('port', sql.Int, cfg.port)
    .input('domain', sql.NVarChar, cfg.domain || null)
    .input('baseDn', sql.NVarChar, cfg.baseDn)
    .input('bindDn', sql.NVarChar, cfg.bindDn)
    .input('enc', sql.NVarChar, cfg.bindPasswordEnc)
    .input('ldaps', sql.Bit, cfg.useLdaps ? 1 : 0)
    .input('trust', sql.Bit, cfg.trustServerCert ? 1 : 0)
    .query(`
      MERGE dbo.directory_config AS t
      USING (SELECT 1 AS id) AS s ON t.id = s.id
      WHEN MATCHED THEN UPDATE SET
        host = @host, port = @port, domain = @domain, base_dn = @baseDn, bind_dn = @bindDn,
        bind_password_enc = @enc, use_ldaps = @ldaps, trust_server_cert = @trust,
        updated_utc = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (id, host, port, domain, base_dn, bind_dn, bind_password_enc, use_ldaps, trust_server_cert)
        VALUES (1, @host, @port, @domain, @baseDn, @bindDn, @enc, @ldaps, @trust);
    `);
}

export async function loadDirectoryConfig(pool) {
  const res = await pool.request().query(`
    SELECT host, port, domain, base_dn, bind_dn, bind_password_enc, use_ldaps, trust_server_cert
    FROM dbo.directory_config WHERE id = 1
  `);
  if (!res.recordset.length) return null;
  const r = res.recordset[0];
  return {
    host: r.host,
    port: r.port,
    domain: r.domain || '',
    baseDn: r.base_dn,
    bindDn: r.bind_dn,
    bindPasswordEnc: r.bind_password_enc,
    useLdaps: Boolean(r.use_ldaps),
    trustServerCert: Boolean(r.trust_server_cert),
  };
}

export async function writeAudit(pool, { actor, action, target, detail, sourceIp }) {
  await pool.request()
    .input('actor', sql.NVarChar, actor || null)
    .input('action', sql.NVarChar, action)
    .input('target', sql.NVarChar, target || null)
    .input('detail', sql.NVarChar, detail || null)
    .input('ip', sql.NVarChar, sourceIp || null)
    .query(`INSERT INTO dbo.audit_log (actor, action, target, detail, source_ip)
            VALUES (@actor, @action, @target, @detail, @ip)`);
}
