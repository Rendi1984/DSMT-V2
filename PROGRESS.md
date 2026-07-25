# DSMT — Progress Notes

**Current version:** 0.1.0 (see `CHANGELOG.md`)

## Where things stand

The setup wizard and Feature 1 are built. There is **no demo mode** — by
decision, every screen reads from a real SQL Server and a real domain
controller.

| Area | State |
|---|---|
| Setup wizard (4 steps) | Built. Asks for SQL server/port/instance/database name, and the domain, base DN and bind account |
| SQL Server create + schema | Built, **not yet run against a real SQL Server** |
| LDAP connection | Built and verified against a live server |
| LDAPS connection | Built and verified against a live TLS server |
| Feature 1 — user list, detail, membership | Built; LDAP layer verified, page not yet driven end to end |
| Sign-in / authentication | **Not built** |

## What has actually been verified, and how

Unit tests (`npm test`, 63 passing) cover the pure logic — filter escaping,
UAC bit maths, FILETIME conversion, DN parsing, LDAPS port derivation, SQL
config building, identifier allowlisting, encryption round trip.

Beyond that, a real OpenLDAP server was stood up in the dev container with
AD-shaped attributes (`sAMAccountName`, `userAccountControl`, `lockoutTime`,
`objectCategory`, the `memberof` overlay) and 10 users across 5 groups. Against
it, confirmed working:

- Connection test, user listing, search, single-user lookup, group membership
- The wizard's new fields: the paste helper splitting `host,port` and
  `host\INSTANCE`, instance disabling the port box, the domain deriving the
  base DN (including multi-label domains), a hand-typed base DN surviving a
  later domain edit, and bind-name completion leaving `DOMAIN\user`,
  `user@domain` and full DNs untouched
- Attribute decoding from real entries: disabled (UAC 514), locked out
  (`lockoutTime`), password-never-expires (UAC 66048), FILETIME → ISO dates,
  DN → readable OU path, manager DN → name
- **Filter injection neutralised** — `*)(objectClass=*` returns 0 rows against
  the live server
- **LDAPS** with a self-signed certificate: correctly refused with the
  trust-certificate hint when trust is off, connects and reads 10 users over
  TLS when trust is on
- Error classification against real failures: wrong password →
  `ldap_credentials`, bad base DN → `ldap_base_dn`, closed port →
  `ldap_refused`, untrusted cert → `ldap_tls`

The wizard was also driven in a real browser against that server: validation
fires before any network call, a passed test is revoked when a field is
edited, and the LDAPS toggle moves the port 389 ↔ 636 while preserving an
explicitly typed port (e.g. 3269). No horizontal overflow at 320px or 768px.

## Outstanding external steps — these need YOUR environment

1. **Verify against a real SQL Server.** The dev container's network policy
   blocks Microsoft's package CDN, so no SQL Server instance could be
   installed here. The T-SQL in `server/lib/db.js` (`applySchema`, the `MERGE`
   upserts, the `IF OBJECT_ID` guards) has therefore **never executed against a
   real server**. This is the highest-risk unverified area — expect to shake
   out syntax or permission issues on first run. You will need:
   - a login with the `dbcreator` role (or an existing database it can write to)
   - TCP/IP enabled, and the SQL Browser service running if using a named instance
2. **Verify against a real domain controller.** OpenLDAP proved the transport,
   the mapping and the error handling, but it is not AD. Specifically untested:
   - `LDAP_MATCHING_RULE_IN_CHAIN` (`1.2.840.113556.1.4.1941`) for nested
     groups — AD-only, so OpenLDAP returned an empty list for it. The "Include
     nested groups" toggle is the thing to check first on a real DC.
   - AD's `objectCategory=person` shorthand (OpenLDAP needed a literal value)
   - Paged results on a domain with more than 1000 users
3. **Then drive `users.html` end to end** — it needs a completed setup, which
   needs step 1.

## Next up

1. **Authentication.** The app is currently unauthenticated. `server/index.js`
   binds `127.0.0.1` for that reason and warns if bound elsewhere. Do not
   expose DSMT on a network until sign-in is wired up — `index.html` exists but
   its form only calls `preventDefault()`.
2. Wire `index.html` to a real `POST /api/auth/login` that binds as the signing-in
   user, and gate the app pages on a session.
3. Enterprise SSO on the sign-in page has no backend at all yet.

## Notes for a future session

- **No fixtures, ever.** See the mandatory section in `CLAUDE.md`. If something
  is hard to test, improve the error path rather than adding sample data.
- `assets/css/nocturne.css` is vendored from the Claude Design handoff. Do not
  edit it; add to `app.css`.
- The original handoff bundle also shipped a `support.js` / `image-slot.js`
  prototype framework (`x-dc`, `DCLogic`). That is design-tool scaffolding —
  it is deliberately not in this repo and should not be reintroduced.
- `server/data/bootstrap.json` and `server/data/dsmt.key` are per-deployment
  secrets and are gitignored. Deleting `bootstrap.json` is how you re-run the
  wizard; the wizard refuses to run once setup is complete.
- Setup writes `bootstrap.json` **last**, only after the database really holds
  the config, so a half-finished install doesn't leave the app pointing at a
  database that was never provisioned.
- To recreate the OpenLDAP test rig: install `slapd ldap-utils`, add an
  AD-compat schema defining `sAMAccountName` / `userAccountControl` /
  `lockoutTime` / `objectCategory` (as a *string*, not a DN) plus a `user`
  auxiliary objectClass, set the suffix to `dc=contoso,dc=local`, and enable
  the `memberof` overlay. `objectCategory` must be a string or the production
  filter matches nothing.
