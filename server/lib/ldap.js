/* Directory transport. The pure helpers at the top are unit-tested; the
   client functions below need a real domain controller. */

import { Client } from 'ldapts';
import { USER_ATTRS, GROUP_ATTRS, toUser, toGroup } from './ad-attrs.js';

/* ── filter escaping ──────────────────────────────────────────────────
   RFC 4515. This is the direct analogue of SQL injection: an unescaped
   `*` or `)` in a search box lets a caller rewrite the filter. Every
   value interpolated into a filter must go through here. */
export function escapeFilter(value) {
  if (value === null || value === undefined) return '';
  // The escape set is exactly `\ * ( )` and NUL. Backslash is listed first
  // so it cannot re-escape the backslashes this same pass emits.
  return String(value).replace(/[\\*()\0]/g, (ch) => {
    switch (ch) {
      case '\\': return '\\5c';
      case '*': return '\\2a';
      case '(': return '\\28';
      case ')': return '\\29';
      case '\0': return '\\00';
      default: return ch;
    }
  });
}

/** Escape a DN value for use inside a filter (e.g. a memberOf comparison). */
export const escapeDnForFilter = escapeFilter;

/* ── connection URL ───────────────────────────────────────────────────
   The LDAPS toggle drives both the scheme and the default port. Callers
   may still pin an explicit port (e.g. 3269 for the global catalog over
   TLS), so an explicit value always wins. */
export const LDAP_PORT = 389;
export const LDAPS_PORT = 636;

export function buildLdapUrl({ host, port, useLdaps }) {
  const scheme = useLdaps ? 'ldaps' : 'ldap';
  const resolved = Number(port) || (useLdaps ? LDAPS_PORT : LDAP_PORT);
  return `${scheme}://${String(host).trim()}:${resolved}`;
}

/** The port a host should default to when the LDAPS toggle flips. */
export const defaultPortFor = (useLdaps) => (useLdaps ? LDAPS_PORT : LDAP_PORT);

/* ── error classification ─────────────────────────────────────────────
   A single generic "connection failed" is what turns one support call into
   three. Each distinct cause gets its own code, message and next step. */
export function classifyLdapError(err, ctx = {}) {
  const raw = String((err && (err.message || err.code)) || err || '');
  const code = err && err.code;
  const name = err && err.name;

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      code: 'ldap_host_not_found',
      message: 'Domain controller not found',
      detail: `The hostname "${ctx.host || ''}" could not be resolved.`,
      hint: 'Check the spelling, and that this server uses the domain DNS.',
    };
  }
  if (code === 'ECONNREFUSED') {
    return {
      code: 'ldap_refused',
      message: 'Connection refused',
      detail: `Nothing is listening on ${ctx.host || ''}:${ctx.port || ''}.`,
      hint: ctx.useLdaps
        ? 'LDAPS needs port 636 open and a certificate installed on the DC.'
        : 'Check the port and that the domain controller is reachable.',
    };
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || name === 'ConnectionError') {
    return {
      code: 'ldap_timeout',
      message: 'Connection timed out',
      detail: `No response from ${ctx.host || ''}:${ctx.port || ''}.`,
      hint: 'A firewall is the usual cause when the host itself resolves.',
    };
  }
  // TLS problems — overwhelmingly a private CA the Node process doesn't trust.
  if (
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    /certificate|self.signed|tls|ssl/i.test(raw)
  ) {
    return {
      code: 'ldap_tls',
      message: 'The LDAPS certificate was rejected',
      detail: raw,
      hint: 'Internal CAs are usually the cause. Enable "Trust the server certificate", or install the CA certificate on this server.',
    };
  }
  if (name === 'InvalidCredentialsError' || /invalid credentials/i.test(raw)) {
    return {
      code: 'ldap_credentials',
      message: 'The bind account was rejected',
      detail: 'The directory refused the username or password.',
      hint: 'Use DOMAIN\\user or user@domain. A locked or expired account fails the same way.',
    };
  }
  if (name === 'NoSuchObjectError' || /no such object/i.test(raw)) {
    return {
      code: 'ldap_base_dn',
      message: 'The base DN was not found',
      detail: `"${ctx.baseDn || ''}" does not exist in this directory.`,
      hint: 'For domain corp.local the base DN is DC=corp,DC=local.',
    };
  }
  if (name === 'InsufficientAccessError' || name === 'InsufficientAccessRightsError'
      || /insufficient access/i.test(raw)) {
    return {
      code: 'ldap_access',
      message: 'The bind account lacks permission',
      detail: 'The account connected but may not read this part of the directory.',
      hint: 'Any authenticated domain account can normally read users; check for a restrictive OU ACL.',
    };
  }
  return {
    code: 'ldap_error',
    message: 'Directory connection failed',
    detail: raw,
    hint: '',
  };
}

/* ── client ──────────────────────────────────────────────────────────── */

function createClient(config) {
  const options = {
    url: buildLdapUrl(config),
    timeout: 15000,
    connectTimeout: 10000,
  };
  if (config.useLdaps) {
    options.tlsOptions = { rejectUnauthorized: !config.trustServerCert };
    // Node checks the certificate against the name we dialled. When an admin
    // connects by IP but the cert names the FQDN, servername keeps the SNI
    // and altname check pointed at the name the certificate actually carries.
    if (config.certServerName) options.tlsOptions.servername = config.certServerName;
  }
  return new Client(options);
}

/** Open a bound connection, run `fn`, and always tear the socket down.
    Every directory call goes through here so no path can leak a socket or
    surface a raw driver error. */
export async function withClient(config, fn) {
  const client = createClient(config);
  try {
    await client.bind(config.bindDn, config.bindPassword);
    return await fn(client);
  } catch (err) {
    const info = classifyLdapError(err, config);
    throw Object.assign(new Error(info.message), info, { isLdapError: true });
  } finally {
    await client.unbind().catch(() => {});
  }
}

/** Run a search and return flattened entries.

    AD caps a single search at 1000 entries and signals the cut with a
    SizeLimitExceeded error rather than a partial result, so paged searching
    is not optional on any real domain. ldapts follows the paging cookie for
    us when `paginate` is set. */
async function search(client, base, options) {
  const { searchEntries } = await client.search(base, {
    scope: 'sub',
    paginate: true,
    sizePageLimit: 500,
    ...options,
  });
  return searchEntries;
}

/* Only real user accounts. objectCategory=person is what excludes computer
   accounts, which also carry objectClass=user and would otherwise flood the
   list on any domain with managed workstations. */
const USER_CLASS = '(&(objectCategory=person)(objectClass=user))';

/** ldapts returns a bare value for single-valued attributes and an array
    when an attribute repeats; callers here always want the first value. */
const first = (v) => (Array.isArray(v) ? v[0] : v) ?? null;

/** Verify a connection and report what was actually reached. */
export async function testConnection(config) {
  return withClient(config, async (client) => {
    // The root DSE answers without a base DN, so it confirms which server we
    // actually reached even when the configured base DN turns out to be wrong.
    const roots = await search(client, '', {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['defaultNamingContext', 'dnsHostName', 'domainFunctionality'],
      paginate: false,
    });
    const root = roots[0] || {};

    // Capped deliberately: the test step only needs to prove the base DN
    // resolves and holds users, not to enumerate a 50,000-seat domain.
    const sample = await search(client, config.baseDn, {
      filter: USER_CLASS,
      attributes: ['sAMAccountName'],
      sizeLimit: 501,
      paginate: false,
    });

    return {
      server: first(root.dnsHostName) || config.host,
      defaultNamingContext: first(root.defaultNamingContext) || '',
      baseDn: config.baseDn,
      secure: Boolean(config.useLdaps),
      userCount: sample.length,
      userCountCapped: sample.length > 500,
    };
  });
}

/** Search users. `q` matches name, account and mail prefixes. */
export async function listUsers(config, { q = '', limit = 200 } = {}) {
  const filter = q
    ? `(&${USER_CLASS}(|(sAMAccountName=${escapeFilter(q)}*)(displayName=*${escapeFilter(q)}*)(cn=*${escapeFilter(q)}*)(mail=${escapeFilter(q)}*)))`
    : USER_CLASS;

  return withClient(config, async (client) => {
    const entries = await search(client, config.baseDn, {
      filter,
      attributes: USER_ATTRS,
      sizeLimit: limit,
    });
    return entries.map(toUser);
  });
}

/** One user by sAMAccountName. */
export async function getUser(config, sam) {
  return withClient(config, async (client) => {
    const entries = await search(client, config.baseDn, {
      filter: `(&${USER_CLASS}(sAMAccountName=${escapeFilter(sam)}))`,
      attributes: USER_ATTRS,
      sizeLimit: 2,
      paginate: false,
    });
    return entries.length ? toUser(entries[0]) : null;
  });
}

/* AD's matching rule for transitive membership. Walking memberOf in the
   client would take one round trip per nesting level and miss cycles; the
   DC evaluates the whole chain in a single search. */
export const MATCHING_RULE_IN_CHAIN = '1.2.840.113556.1.4.1941';

/** Groups a user belongs to — direct only, or the full nested chain. */
export async function getUserGroups(config, userDn, { transitive = false } = {}) {
  const dn = escapeDnForFilter(userDn);
  const filter = transitive
    ? `(&(objectCategory=group)(member:${MATCHING_RULE_IN_CHAIN}:=${dn}))`
    : `(&(objectCategory=group)(member=${dn}))`;

  return withClient(config, async (client) => {
    const entries = await search(client, config.baseDn, {
      filter,
      attributes: GROUP_ATTRS,
    });
    return entries.map(toGroup).sort((a, b) => a.name.localeCompare(b.name));
  });
}
