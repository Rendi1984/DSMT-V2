# Changelog

Format: `MAJOR.FEATURE.FIX`. The top entry is the authoritative current
version; `package.json` is the single source of truth for the number itself
and everything else reads it from `/api/version`.

## 0.1.0

First working increment: the web setup wizard and Feature 1.

### Added
- **Setup wizard** (`setup.html`) — four steps: Welcome, Database, Directory,
  Review. Forward navigation is gated on each step's connection test passing,
  and editing a tested field revokes that pass so the review step can never
  describe settings that were never verified.
- **SQL Server provisioning** — test the connection against `master`, then
  create the database and schema. Idempotent: an existing database is adopted
  and any missing schema applied rather than failing. Supports SQL Server
  Authentication and NTLM, `server\instance` or `server,port`, and an explicit
  trust-server-certificate toggle for self-signed certs.
- **Directory connection** — LDAP with an optional **LDAPS** toggle that
  switches scheme and default port (389 ↔ 636), plus a trust-certificate
  option for internal CAs. Connection failures are reported by distinct cause
  (host unreachable, TLS rejected, bad credentials, bad base DN).
- **Feature 1 — user lookup** (`users.html`): live user list from the domain
  controller with search and pagination, per-user detail, and group membership
  showing both direct groups and full nested membership.

### Security
- Bind passwords are encrypted at rest with AES-256-GCM and are never
  returned to the browser.
- All directory search input is LDAP-filter-escaped; database names are
  allowlisted rather than escaped, since `CREATE DATABASE` cannot be
  parameterised.
- The server binds `127.0.0.1` by default. Sign-in is not yet enforced, so
  non-loopback exposure requires an explicit opt-in. See `PROGRESS.md`.

### Notes
- There is no demo or sample-data mode. Every screen reads from the real
  SQL Server and the real domain controller, and a failed call surfaces as
  an error rather than as substituted data.
