/* Shared page furniture: the version label, the setup guard, busy and
   result rendering, and the small DOM helpers every page needs. */

import { api } from './api.js';

/* ── DOM helpers ─────────────────────────────────────────────────────── */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Build an element. Text is always set via textContent — never innerHTML,
    so directory values (which we do not control) can't inject markup. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/* ── version ─────────────────────────────────────────────────────────
   Read from the server, which reads package.json. Never hardcode a version
   string in a second place. */

export async function mountVersion(target) {
  const node = typeof target === 'string' ? $(target) : target;
  if (!node) return;
  try {
    const { version } = await api.get('/api/version');
    node.textContent = `v${version}`;
  } catch {
    node.textContent = '';
  }
}

/* ── setup guard ─────────────────────────────────────────────────────── */

/** On app pages: bounce to the wizard until setup has been completed. */
export async function requireSetup() {
  const status = await api.get('/api/setup/status');
  if (!status.complete) {
    location.replace('setup.html');
    return null;
  }
  return status;
}

/* ── busy state ──────────────────────────────────────────────────────── */

/** Toggle a button between idle and working, preserving its original label. */
export function setBusy(button, busy, busyLabel) {
  if (busy) {
    if (!button.dataset.idleHtml) button.dataset.idleHtml = button.innerHTML;
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
    button.replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }),
      document.createTextNode(busyLabel || 'Working…'));
  } else {
    button.removeAttribute('aria-busy');
    button.disabled = false;
    if (button.dataset.idleHtml) button.innerHTML = button.dataset.idleHtml;
  }
}

/* ── result regions ──────────────────────────────────────────────────── */

/** Render an outcome into a `.result` block. Success and each distinct
    failure cause get their own message rather than one generic string. */
export function showResult(node, { kind, title, detail, hint }) {
  node.dataset.kind = kind;
  // Filter before spreading: replaceChildren() stringifies any non-Node
  // argument, so a null slot renders as the literal text "null".
  const parts = [
    el('span', { class: 'result__title', text: title }),
    detail ? el('span', { class: 'result__detail', text: detail }) : null,
    hint ? el('span', { class: 'result__hint', text: hint }) : null,
  ].filter(Boolean);
  node.replaceChildren(...parts);
  node.hidden = false;
}

export function showError(node, err) {
  showResult(node, {
    kind: 'error',
    title: err.message || 'Something went wrong',
    detail: err.detail,
    hint: err.hint,
  });
}

export function clearResult(node) {
  node.hidden = true;
  node.replaceChildren();
}

/* ── field validation ────────────────────────────────────────────────── */

/** Mark a `.field` invalid and wire the error text up for screen readers. */
export function setFieldError(input, message) {
  const field = input.closest('.field');
  if (!field) return;
  let error = $('.field__error', field);
  if (!error) {
    error = el('span', { class: 'field__error' });
    error.id = `${input.id}-error`;
    field.append(error);
  }
  if (message) {
    error.textContent = message;
    field.dataset.invalid = 'true';
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', error.id);
  } else {
    delete field.dataset.invalid;
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
  }
}

/** Run a set of [input, validatorFn] pairs; focus the first offender. */
export function validate(pairs) {
  let firstBad = null;
  for (const [input, check] of pairs) {
    const message = check(input.value.trim());
    setFieldError(input, message);
    if (message && !firstBad) firstBad = input;
  }
  if (firstBad) firstBad.focus();
  return !firstBad;
}

export const required = (label) => (v) => (v ? '' : `${label} is required.`);
