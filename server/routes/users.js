/* Feature 1 — user lookup against the domain controller.

   Read-only and always live: the directory is queried on each request rather
   than mirrored into SQL Server, so what the table shows is what the domain
   controller holds right now. */

import { Router } from 'express';

import * as ldap from '../lib/ldap.js';
import { getDirectoryConfig } from '../lib/state.js';
import { ok, asHandler } from './helpers.js';

export const usersRouter = Router();

const PAGE_SIZE = 25;

/** The configured directory, or a clear error if setup hasn't run. */
async function requireDirectory() {
  const cfg = await getDirectoryConfig();
  if (!cfg) {
    throw Object.assign(new Error('DSMT is not configured yet'), {
      code: 'not_configured',
      message: 'DSMT is not configured yet',
      detail: 'No directory connection has been saved.',
      hint: 'Run the setup wizard first.',
      status: 409,
    });
  }
  return cfg;
}

function paginate(items, page) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (current - 1) * PAGE_SIZE;
  return { rows: items.slice(start, start + PAGE_SIZE), total, page: current, pages, pageSize: PAGE_SIZE };
}

/* ── list ────────────────────────────────────────────────────────────── */

usersRouter.get('/', asHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const page = req.query.page;

  const cfg = await requireDirectory();
  const users = await ldap.listUsers(cfg, { q });
  users.sort((a, b) => (a.displayName || a.samAccountName).localeCompare(b.displayName || b.samAccountName));
  ok(res, paginate(users, page));
}));

/* ── detail ──────────────────────────────────────────────────────────── */

usersRouter.get('/:sam', asHandler(async (req, res) => {
  const { sam } = req.params;

  const user = await ldap.getUser(await requireDirectory(), sam);
  if (!user) {
    throw Object.assign(new Error('User not found'), {
      code: 'user_not_found',
      message: 'User not found',
      detail: `No account with the name "${sam}" exists in the searched scope.`,
      status: 404,
    });
  }
  ok(res, { user });
}));

/* ── membership ──────────────────────────────────────────────────────
   `transitive` swaps a direct memberOf lookup for AD's in-chain matching
   rule, which resolves nested groups on the DC in one search. */

usersRouter.get('/:sam/groups', asHandler(async (req, res) => {
  const { sam } = req.params;
  const transitive = req.query.transitive === 'true' || req.query.transitive === '1';

  const cfg = await requireDirectory();
  const user = await ldap.getUser(cfg, sam);
  if (!user) {
    throw Object.assign(new Error('User not found'), {
      code: 'user_not_found',
      message: 'User not found',
      detail: `No account with the name "${sam}" exists in the searched scope.`,
      status: 404,
    });
  }
  const groups = await ldap.getUserGroups(cfg, user.dn, { transitive });
  ok(res, { groups, transitive });
}));
