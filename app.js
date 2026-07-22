function setMode(mode) {
  const isStandard = mode === 'standard';
  document.getElementById('panel-standard').hidden = !isStandard;
  document.getElementById('panel-sso').hidden = isStandard;
}

document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener('change', (e) => setMode(e.target.value));
});

document.getElementById('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
});
