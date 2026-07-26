# DSMT — Project Rules for Claude

## What is this project
DSMT (Directory Service Management Tool) is a web front end for looking up
Active Directory users. It is installed through a browser-based setup wizard
and then reads the directory live.

- **Frontend**: static HTML + ES modules, no framework and no build step.
  `setup.html` (install wizard), `users.html` (Feature 1), `index.html`
  (sign-in page, not yet wired up). Styles in `assets/css/`, behaviour in
  `assets/js/`.
- **Backend**: `server/index.js` — Express, run as one Node process.
  `server/routes/` holds the HTTP layer, `server/lib/` the logic.
- **Data store**: SQL Server, holding configuration and the audit log only.
  User data is never mirrored — it is read from the DC on every request.
- **Directory**: LDAP or LDAPS via `ldapts`. Not `ldapjs`, which upstream has
  decommissioned.

Run it with `npm start` (default `http://127.0.0.1:8080`), tests with
`npm test`.

---

## Interface language / branding
- All user-facing text is in English.
- `assets/css/nocturne.css` is the vendored Nocturne design system — the
  source of truth for the look. **Do not edit it**; put DSMT-specific rules in
  `assets/css/app.css` and reuse its tokens instead of hardcoding values.
- The only external dependency at runtime is the Google Fonts `@import` for
  Inter, in `nocturne.css`. If an offline/no-CDN requirement appears, that
  import must be replaced with a bundled font file — nothing else reaches out.

---

## Versioning policy (MANDATORY)
Format: `MAJOR.FEATURE.FIX`.
- MAJOR: breaking change
- FEATURE: new feature (reset FIX to 0)
- FIX: bug fix only

**`package.json` is the single source of truth for the version number.** The
server reads it there and exposes it at `/api/version`; the UI reads it from
that endpoint. Never hardcode a version string anywhere else — not in HTML,
not in a JS constant, not in a page footer. Check the top entry of
`CHANGELOG.md` for the authoritative current version before picking the next.

---

## No fake data, ever (MANDATORY)
**DSMT has no demo mode, no sample data and no fixtures, by deliberate
decision.** Every screen reads from the real SQL Server and the real domain
controller.

If a call fails, it must surface as an error with a specific cause. Never add
a fallback that substitutes placeholder data when a live call fails — it
throws nothing and looks fine, so it gets reported as "the feature doesn't
work" across unrelated testing rounds instead of as one clear bug. If you are
tempted to add fixtures to make something testable, make the failure path
clearer instead.

A corollary for the UI: a data view must distinguish **loading**, **empty**,
and **error**. A bare empty table leaves "no results" and "the request failed"
looking identical. `users.html` has explicit blocks for all three.

---

## Errors must name a cause
`classifyLdapError` and `classifySqlError` map failures to distinct codes,
each with its own message, detail and next step. A single generic "connection
failed" is what turns one support call into three.

When adding a new failure path, add a case rather than falling through to the
generic one, and give it a `hint` naming the actual fix (which role to grant,
which port to open, which checkbox to tick).

---

## Active Directory specifics
- **`userAccountControl` is a bit field.** Enable/disable is the
  `ACCOUNTDISABLE` bit (`0x0002`) — always read-modify-write that single bit.
  Assigning a whole new value silently clears unrelated flags such as
  `DONT_EXPIRE_PASSWORD`. Use `setDisabledBit`.
- **Lockout state lives in `lockoutTime`, not the UAC `LOCKOUT` bit** — the
  bit is not reliable for reading current state.
- **Password writes (`unicodePwd`) require LDAPS.** AD rejects them over
  plaintext LDAP, and the value must be the password wrapped in double quotes
  and encoded UTF-16LE. (Not implemented yet — no writes ship today.)
- **Creating a user is three operations**: add with `objectClass: user`, set
  `unicodePwd`, then set `userAccountControl` to `512`.
- **`objectCategory=person` is what excludes computer accounts**, which also
  carry `objectClass=user`.
- **Nested membership uses `LDAP_MATCHING_RULE_IN_CHAIN`**
  (`1.2.840.113556.1.4.1941`). The DC resolves the whole chain in one search;
  walking `memberOf` client-side costs a round trip per level and mishandles
  cycles. This OID is AD-only — other LDAP servers return nothing for it.
- **Escape every value interpolated into a filter** with `escapeFilter`. LDAP
  filter injection is the direct analogue of SQL injection.

## SQL Server specifics
- Accept `host`, `host,1433` and `host\INSTANCE` — admins paste whatever SSMS
  showed them. A named instance resolves through SQL Browser and must **not**
  also carry a port.
- `CREATE DATABASE` needs the `dbcreator` role; detect that failure
  specifically (error 262) rather than surfacing a raw driver message.
- Database names cannot be parameterised, so they are **allowlisted** by
  `assertSafeIdentifier` and bracket-quoted — rejected, not escaped.
- Schema creation is idempotent; re-running the wizard over an existing
  database adds missing tables and drops nothing.

---

## Deployment guide (MANDATORY)
`DEPLOYMENT.html` is what the person installing DSMT actually reads. **Update
it in the same change that alters the thing it describes** — a wizard field, a
default, an environment variable, an error message and its fix, or a
prerequisite. A guide that lags the software is worse than no guide, because it
gets trusted.

It is deliberately self-contained — no external stylesheet, font or script — so
it still renders when forwarded to a DBA or opened off a USB stick on a server
with no internet. Keep it that way.

Its version badge is stamped from `package.json` by `scripts/package.mjs` at
package time. The repository copy holds an empty `<!--PKG_VERSION-->`
placeholder, so an unstamped guide shows no version rather than a wrong one.
Never type a version number into it.

`npm run package` builds `dist/dsmt-<version>.zip` with the guide included
(`--no-deps` for a smaller ZIP that needs `npm install` on site). The script
excludes `server/data/` — that holds the encryption key and the stored SQL
password, and shipping them would hand every recipient the keys.

---

## How changes are delivered
- Work happens on feature branches (e.g. `claude/web-site-new-experiment-g31uu1`)
  and is pushed to `origin`.
- Changing anything under `assets/` or a `.html` file needs only a browser
  refresh. Changing anything under `server/` requires restarting the Node
  process.
- State exactly which file(s) changed when shipping a fix, so it can be
  verified against the specific file.

---

## Testing
`npm test` runs `node --test` over `server/lib/*.test.js`. These cover the
logic that can be exercised without servers: filter escaping, UAC bit maths,
FILETIME conversion, DN parsing, LDAPS port derivation, SQL connection
building, identifier allowlisting, and the encryption round trip.

Anything needing a live server is verified against one — see `PROGRESS.md`
for what has been verified against what, and what is still outstanding.

---

## Recurring root causes
- **`Node.replaceChildren()` stringifies non-Node arguments.** Passing a
  conditional `null` renders the literal text "null" on the page. Filter the
  array before spreading. This bit `showResult` once already.

---

## Attempted and deliberately NOT pursued
- **Authentication.** The sign-in page exists but is not wired to an API. Until
  it is, the server binds `127.0.0.1` and must not be exposed. This is the top
  open item in `PROGRESS.md`.
- **Enterprise SSO / OIDC.** The sign-in page offers the option; no backend
  exists. Needs a real identity provider to build against.

---

## Session/progress memory
See `PROGRESS.md`. Update it at the end of every session that changes the
project.
