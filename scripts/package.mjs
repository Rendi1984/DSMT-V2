#!/usr/bin/env node
/* Build a release ZIP.

   Usage:
     node scripts/package.mjs              bundles node_modules (offline install)
     node scripts/package.mjs --no-deps    smaller ZIP; needs `npm install` on site

   The deployment guide's version badge is stamped from package.json here, so
   the number has exactly one source and can never go stale in the document. */

import { execFileSync } from 'node:child_process';
import {
  cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const withDeps = !process.argv.includes('--no-deps');

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const name = `dsmt-${version}`;
const dist = join(ROOT, 'dist');
const stage = join(dist, name);
const zipPath = join(dist, `${name}.zip`);

/* Everything an install needs, and nothing that is only useful in the repo.
   Tests ship deliberately: `npm test` is how an admin sanity-checks the
   install before pointing it at production. */
const INCLUDE = [
  'index.html', 'setup.html', 'users.html',
  'assets',
  'server',
  'package.json', 'package-lock.json',
  'DEPLOYMENT.html', 'CHANGELOG.md',
];

rmSync(stage, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(stage, { recursive: true });

for (const entry of INCLUDE) {
  const from = join(ROOT, entry);
  if (!existsSync(from)) {
    console.error(`  missing: ${entry}`);
    process.exit(1);
  }
  cpSync(from, join(stage, entry), {
    recursive: true,
    // server/data holds this deployment's secrets — the encryption key and the
    // stored SQL password. Shipping them would hand every recipient the keys.
    filter: (src) => !src.includes(`${'server'}/data`) && !src.endsWith('.key'),
  });
}

// A fresh install must run the wizard, so no bootstrap may travel in the ZIP.
rmSync(join(stage, 'server', 'data'), { recursive: true, force: true });
mkdirSync(join(stage, 'server', 'data'), { recursive: true });
writeFileSync(join(stage, 'server', 'data', '.gitkeep'), '');

/* Stamp the version into the guide. The repository copy keeps an empty
   placeholder on purpose — an unstamped guide shows no version at all rather
   than a wrong one. */
const guidePath = join(stage, 'DEPLOYMENT.html');
const guide = readFileSync(guidePath, 'utf8');
if (!guide.includes('<!--PKG_VERSION-->')) {
  console.error('  DEPLOYMENT.html has no <!--PKG_VERSION--> placeholder to stamp');
  process.exit(1);
}
writeFileSync(guidePath, guide.replace('<!--PKG_VERSION-->', `Version ${version}`));

if (withDeps) {
  // All runtime dependencies are pure JavaScript, so a copy made here runs
  // unchanged on Windows. That is what makes an offline install possible;
  // msnodesqlv8 is the one exception and is installed on site if needed.
  const modules = join(ROOT, 'node_modules');
  if (!existsSync(modules)) {
    console.error('  node_modules is missing — run `npm install` first, or pass --no-deps');
    process.exit(1);
  }
  cpSync(modules, join(stage, 'node_modules'), { recursive: true });
}

execFileSync('zip', ['-rq', zipPath, name], { cwd: dist });
rmSync(stage, { recursive: true, force: true });

const mb = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(`  ${zipPath}  (${mb} MB, dependencies ${withDeps ? 'bundled' : 'not included'})`);
