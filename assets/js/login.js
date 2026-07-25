/* Sign-in page behaviour.

   Authentication is not implemented yet — this only switches between the
   two sign-in methods, as the design handoff does. Submitting is blocked
   rather than silently doing nothing, so the page can't look functional
   when it isn't. See PROGRESS.md. */

import { $, $$ } from './shell.js';

function setMode(mode) {
  const standard = mode === 'standard';
  $('#panel-standard').hidden = !standard;
  $('#panel-sso').hidden = standard;
}

for (const radio of $$('input[name="mode"]')) {
  radio.addEventListener('change', (e) => setMode(e.target.value));
}

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
});
