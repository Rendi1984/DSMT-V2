/* Shared response shape. Every payload carries `mode` so the browser can
   tell live data from fixtures without a separate round trip. */

import { MODE } from '../lib/state.js';

export function ok(res, data) {
  res.json({ ok: true, mode: MODE, ...data });
}

export function fail(res, err) {
  const status = err.status || (err.isSqlError || err.isLdapError ? 502 : 500);
  res.status(status).json({
    ok: false,
    mode: MODE,
    error: {
      code: err.code || 'internal',
      message: err.message || 'Something went wrong',
      detail: err.detail || '',
      hint: err.hint || '',
    },
  });
}

/** Wrap an async handler so a rejection becomes a classified JSON error
    instead of an unhandled rejection and a hung request. */
export function asHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      if (res.headersSent) return next(err);
      // Anything without a code is unexpected: log the stack server-side but
      // don't leak internals to the browser.
      if (!err.code) console.error('[dsmt] unhandled', err);
      fail(res, err);
    });
  };
}
