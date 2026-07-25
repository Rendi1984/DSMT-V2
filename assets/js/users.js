/* Feature 1 — user lookup.

   Every view distinguishes loading, empty, error and results. A bare empty
   table would leave "no matches" and "the request failed" looking identical,
   which is exactly the ambiguity that turns into a bug report. */

import { api } from './api.js';
import {
  $, el, mountVersion, requireSetup,
} from './shell.js';

mountVersion('#version');

/* ── formatting ──────────────────────────────────────────────────────── */

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dateFmt.format(d);
}

const dash = (v) => (v && String(v).trim() ? v : '—');

/** Status tags, most operationally urgent first. */
function statusTags(status) {
  const tags = [];
  if (status.disabled) tags.push(['Disabled', 'tag-neutral']);
  if (status.locked) tags.push(['Locked out', 'tag-outline']);
  if (status.passwordExpired) tags.push(['Password expired', 'tag-outline']);
  if (status.passwordNeverExpires) tags.push(['Password never expires', 'tag-neutral']);
  if (status.smartcardRequired) tags.push(['Smartcard required', 'tag-neutral']);
  if (!tags.length) tags.push(['Enabled', 'tag-accent']);
  return tags;
}

/* ── list state ──────────────────────────────────────────────────────── */

const view = {
  loading: $('#state-loading'),
  empty: $('#state-empty'),
  error: $('#state-error'),
  results: $('#results'),
};

function show(which) {
  for (const [name, node] of Object.entries(view)) node.hidden = name !== which;
}

let page = 1;
let query = '';
let inflight = 0;

async function load() {
  const token = ++inflight;
  show('loading');

  try {
    const params = new URLSearchParams({ page: String(page) });
    if (query) params.set('q', query);
    const data = await api.get(`/api/users?${params}`);

    // A slower earlier request must not overwrite a newer result.
    if (token !== inflight) return;

    renderRows(data.rows);
    renderPager(data);

    $('#count').textContent = data.total === 0
      ? ''
      : `${data.total} user${data.total === 1 ? '' : 's'}${query ? ' matching' : ''}`;

    if (data.rows.length === 0) {
      $('#empty-detail').textContent = query
        ? `No accounts matched "${query}".`
        : 'The directory returned no user accounts under the configured base DN.';
      show('empty');
    } else {
      show('results');
    }
  } catch (err) {
    if (token !== inflight) return;
    $('#error-title').textContent = err.message;
    $('#error-detail').textContent = err.detail || '';
    $('#error-hint').textContent = err.hint || '';
    $('#count').textContent = '';
    show('error');
  }
}

function renderRows(rows) {
  const tbody = $('#rows');
  tbody.replaceChildren(...rows.map((user) => {
    const tags = el('div', { class: 'tag-row' },
      statusTags(user.status).map(([label, cls]) => el('span', { class: `tag ${cls}`, text: label })));

    return el('tr', {}, [
      el('td', { text: dash(user.displayName) }),
      el('td', { text: dash(user.samAccountName) }),
      el('td', { text: dash(user.mail) }),
      el('td', { text: dash(user.department) }),
      el('td', {}, tags),
      el('td', { class: 'actions' }, [
        el('button', {
          class: 'row-btn',
          type: 'button',
          text: 'View',
          'aria-label': `View details for ${user.displayName || user.samAccountName}`,
          onClick: () => openDetail(user.samAccountName),
        }),
      ]),
    ]);
  }));
}

function renderPager(data) {
  const pager = $('#pager');
  pager.hidden = data.pages <= 1;
  $('#page-label').textContent = `Page ${data.page} of ${data.pages}`;
  $('#prev').disabled = data.page <= 1;
  $('#next').disabled = data.page >= data.pages;
  page = data.page;
}

$('#prev').addEventListener('click', () => { page -= 1; load(); });
$('#next').addEventListener('click', () => { page += 1; load(); });
$('#retry').addEventListener('click', () => load());

/* Debounced so typing doesn't fire a directory search per keystroke. */
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const value = e.target.value.trim();
  searchTimer = setTimeout(() => {
    query = value;
    page = 1;
    load();
  }, 300);
});

/* ── detail dialog ───────────────────────────────────────────────────── */

const detail = $('#detail');
let currentSam = null;
let lastFocused = null;

function infoRow(dl, label, value) {
  dl.append(el('dt', { text: label }), el('dd', { text: value }));
}

async function openDetail(sam) {
  currentSam = sam;
  lastFocused = document.activeElement;
  detail.hidden = false;
  $('#transitive').checked = false;

  $('#detail-title').textContent = sam;
  $('#detail-info').replaceChildren();
  $('#detail-tags').replaceChildren();
  $('#detail-close').focus();

  loadGroups();

  try {
    const { user } = await api.get(`/api/users/${encodeURIComponent(sam)}`);
    if (currentSam !== sam) return;

    $('#detail-title').textContent = user.displayName || user.samAccountName;
    $('#detail-tags').replaceChildren(
      ...statusTags(user.status).map(([label, cls]) => el('span', { class: `tag ${cls}`, text: label })));

    const dl = $('#detail-info');
    dl.replaceChildren();
    infoRow(dl, 'Username', dash(user.samAccountName));
    infoRow(dl, 'Sign-in name', dash(user.userPrincipalName));
    infoRow(dl, 'Email', dash(user.mail));
    infoRow(dl, 'Phone', dash(user.telephone));
    infoRow(dl, 'Title', dash(user.title));
    infoRow(dl, 'Department', dash(user.department));
    infoRow(dl, 'Company', dash(user.company));
    infoRow(dl, 'Office', dash(user.office));
    infoRow(dl, 'Manager', dash(user.managerName));
    infoRow(dl, 'Location', dash(user.path));
    infoRow(dl, 'Created', formatDate(user.whenCreated));
    infoRow(dl, 'Last sign-in', formatDate(user.lastLogon));
    infoRow(dl, 'Password set', formatDate(user.passwordLastSet));
  } catch (err) {
    if (currentSam !== sam) return;
    const dl = $('#detail-info');
    dl.replaceChildren();
    infoRow(dl, 'Error', err.message);
    if (err.detail) infoRow(dl, '', err.detail);
  }
}

function closeDetail() {
  detail.hidden = true;
  currentSam = null;
  if (lastFocused) lastFocused.focus();
}

$('#detail-close').addEventListener('click', closeDetail);
detail.addEventListener('click', (e) => { if (e.target === detail) closeDetail(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !detail.hidden) closeDetail();
});

/* Keep Tab inside the dialog while it's open — otherwise focus wanders into
   the table behind it, which is invisible to a keyboard user. */
detail.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const focusable = detail.querySelectorAll('button, input, a[href], [tabindex]:not([tabindex="-1"])');
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

/* ── group membership ────────────────────────────────────────────────── */

const groupView = {
  loading: $('#groups-loading'),
  empty: $('#groups-empty'),
  error: $('#groups-error'),
  list: $('#groups'),
};

function showGroups(which) {
  for (const [name, node] of Object.entries(groupView)) node.hidden = name !== which;
}

$('#transitive').addEventListener('change', () => loadGroups());

async function loadGroups() {
  const sam = currentSam;
  if (!sam) return;
  const transitive = $('#transitive').checked;

  showGroups('loading');
  try {
    const data = await api.get(
      `/api/users/${encodeURIComponent(sam)}/groups?transitive=${transitive}`);
    if (currentSam !== sam) return;

    if (!data.groups.length) return showGroups('empty');

    groupView.list.replaceChildren(...data.groups.map((group) => el('li', { class: 'group-item' }, [
      el('span', { class: 'group-item__name', text: group.name }),
      el('span', { class: 'group-item__path', text: group.path || group.dn }),
    ])));
    showGroups('list');
  } catch (err) {
    if (currentSam !== sam) return;
    $('#groups-error-detail').textContent = err.detail || err.message;
    showGroups('error');
  }
}

/* ── boot ────────────────────────────────────────────────────────────── */

requireSetup()
  .then((status) => { if (status) load(); })
  .catch((err) => {
    $('#error-title').textContent = err.message;
    $('#error-detail').textContent = err.detail || '';
    $('#error-hint').textContent = err.hint || '';
    show('error');
  });
