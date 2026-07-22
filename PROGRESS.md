# DSMT — Progress Notes

**Current state**: Single static sign-in page (`index.html`, `styles.css`, `app.js`), recreating the `Login.dc.html` Nocturne design handoff. No versioning scheme adopted yet, no backend.

## Open tasks
- Decide on a real tech stack (React/Vite, Next.js, or stay plain static) if the site is going to grow beyond the login page.
- Wire the sign-in form to a real auth backend (currently `e.preventDefault()` only, no request is made).
- Decide on a versioning scheme once there's more than one page/release.

## Recurring root causes
None identified yet.

## Attempted and deliberately not pursued
None yet.

## Notes for next session
- The original design bundle (Claude Design handoff) uses a custom `x-dc`/`DCLogic` component framework (`support.js`, `image-slot.js`) that is prototype-only tooling — do not carry that framework into production code. `index.html`/`styles.css`/`app.js` are the plain-JS recreation; keep new pages in that same plain style unless a stack decision changes it.
- Design tokens (colors, spacing, radii) live at the top of `styles.css` — reuse these vars for any new page instead of hardcoding values.
