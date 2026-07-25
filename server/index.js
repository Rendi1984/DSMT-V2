/* DSMT server — static frontend plus the setup and directory APIs. */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { setupRouter } from './routes/setup.js';
import { usersRouter } from './routes/users.js';
import { ok } from './routes/helpers.js';
import { MODE, isDemo } from './lib/state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// package.json is the single source of truth for the version; nothing else
// may hardcode it.
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const PORT = Number(process.env.DSMT_PORT) || 8080;

/* Loopback by default. Sign-in is not wired up yet, so binding every
   interface would expose an unauthenticated directory browser to the
   network — that has to be a deliberate act, not the default. */
const HOST = process.env.DSMT_HOST || '127.0.0.1';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      // The design system pulls Inter from Google Fonts.
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  // Cross-origin isolation headers would block the font CDN for no gain here.
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '64kb' }));

/* Setup accepts credentials, so it is the one surface worth rate limiting:
   it is reachable before any authentication exists. */
app.use('/api/setup', rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    mode: MODE,
    error: {
      code: 'rate_limited',
      message: 'Too many attempts',
      detail: 'More than 30 setup requests in a minute.',
      hint: 'Wait a minute and try again.',
    },
  },
}));

app.get('/api/version', (req, res) => ok(res, { version }));

app.use('/api/setup', setupRouter);
app.use('/api/users', usersRouter);

app.use('/api', (req, res) => {
  res.status(404).json({
    ok: false,
    mode: MODE,
    error: { code: 'not_found', message: `No such endpoint: ${req.method} ${req.originalUrl}` },
  });
});

app.use(express.static(ROOT, {
  index: false,
  extensions: ['html'],
  setHeaders: (res, path) => {
    // The HTML shells are tiny and change with every deploy; letting a
    // browser cache them is how a stale page outlives an upgrade.
    if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

/* Entry point: the wizard until setup is done, the user list afterwards. */
app.get('/', async (req, res) => {
  const { getSetupStatus } = await import('./lib/state.js');
  const status = await getSetupStatus().catch(() => ({ complete: false }));
  res.redirect(status.complete ? '/users.html' : '/setup.html');
});

app.listen(PORT, HOST, () => {
  console.log(`DSMT v${version} listening on http://${HOST}:${PORT}  (mode: ${MODE})`);
  if (isDemo()) {
    console.log('  DEMO MODE — serving sample data. Not connected to any real directory or database.');
  }
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.warn(`  WARNING: bound to ${HOST}. Sign-in is not implemented yet, so this exposes`);
    console.warn('  an unauthenticated directory browser. Keep it on loopback until auth ships.');
  }
});
