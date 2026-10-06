#!/usr/bin/env node
// `npm test` runs this first (pretest). Several canvas tests import zod and other canvas packages, so a fresh clone
// needs `npm run setup` before they can run. Do it automatically, once, instead of failing with MODULE_NOT_FOUND.
// Skip with ASTRAHACK_NO_INSTALL=1.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './lib/common.mjs';

const have = ['zod', 'next', 'tldraw'].every((p) => existsSync(join(ROOT, 'canvas/node_modules', p)));
if (have || process.env.ASTRAHACK_NO_INSTALL) process.exit(0);
console.log('canvas/node_modules is missing: running `npm install` in canvas/ once (about 10 s). Skip with ASTRAHACK_NO_INSTALL=1.');
const r = spawnSync('npm', ['install', '--prefix', 'canvas', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
