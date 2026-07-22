# DSMT — Project Rules for Claude

## What is this project
DSMT (Directory Service Management Tool) is a web-based front end, currently a single sign-in page implemented as static HTML/CSS/JS with no build step.

- **Frontend**: `index.html` — plain HTML, styled by `styles.css`, behavior in `app.js`. Served as static files (no framework, no bundler).
- **Design source**: the `Login.dc.html` design handoff (Nocturne design system) — dark theme, blurple accent `#9184d9`, Inter font. `index.html`/`styles.css`/`app.js` are the production recreation of that prototype; the prototype itself is not part of the shipped app.
- **Backend/API**: none yet — the sign-in form currently only prevents default submission (`app.js`); there is no real auth call wired up.

---

## Interface language / branding
- All user-facing text is in English.
- The page must remain self-contained/offline-safe except for the Google Fonts (`Inter`) `@import` in `styles.css` — if an offline/no-external-CDN constraint is introduced later, that import needs to be replaced with a bundled font file.

---

## How changes are delivered
- Work happens directly on feature branches (e.g. `claude/web-site-new-experiment-g31uu1`) and is pushed to `origin`; no build/deploy step exists yet since this is static HTML/CSS/JS.
- Changing `index.html`, `styles.css`, or `app.js` only requires a browser refresh — no restart/rebuild needed.
- State exactly which file(s) changed when shipping a fix, so it can be verified against the specific file.

---

## Recurring root causes
None yet — project is new.

---

## Attempted and deliberately NOT pursued
None yet.

---

## Session/progress memory
See `PROGRESS.md` (create/update this file at the end of sessions that change the project).
