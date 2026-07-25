# Changelog

Format: `MAJOR.FEATURE.FIX`. The top entry is the authoritative current
version; `package.json` is the single source of truth for the number itself
and everything else reads it from `/api/version`.

## 0.1.0

First working increment: the web setup wizard and Feature 1.

### Added
- **Setup wizard** (`setup.html`) — four steps: Welcome, Database, Directory,
  Review. Forward navigation is gated on each step's connection test passing.
- **SQL Server provisioning** — test the connection against `master`, then
  create the database and schema. Idempotent: an existing database is adopted
  and any missing schema applied rather than failing. Supports SQL Server
  Authentication and NTLM, `server\instance` or `server:port`, and an explicit
  trust-server-certificate toggle for self-signed certs.
- **Directory connection** — LDAP with an optional **LDAPS** toggle that
  switches scheme and default port (389 ↔ 636), plus a trust-certificate
  option for internal CAs. Connection failures are reported by distinct cause
  (host unreachable, TLS rejected, bad credentials, bad base DN).
- **Feature 1 — user lookup** (`users.html`): live user list from the domain
  controller with search and pagination, per-user detail, and group membership
  showing both direct groups and full nested membership.
- **Demo mode** (`DSMT_MODE=demo`) for driving the UI with no SQL Server or
  domain controller present, behind a persistent, unmissable banner.

### Security
- Bind passwords are encrypted at rest with AES-256-GCM and are never
  returned to the browser.
- All directory search input is LDAP-filter-escaped.
- The server binds `127.0.0.1` by default; sign-in is not yet enforced, so
  non-loopback exposure requires an explicit opt-in. See `PROGRESS.md`.
