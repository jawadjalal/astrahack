#!/usr/bin/env node
// Autonomous teardown agent. See docs/AGENT.md and `node agent/run.mjs --help`.
import { main } from './src/cli.mjs';

// Optional .env (repo root, then cwd). Already-set environment variables win.
for (const path of [new URL('../.env', import.meta.url).pathname, '.env']) {
  try { process.loadEnvFile(path); } catch { /* no such file */ }
}

process.exitCode = await main(process.argv.slice(2));
// stdin/timers can keep the loop alive after the run; exit explicitly once output is flushed.
setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref?.();
process.stdout.write('', () => process.exit(process.exitCode ?? 0));
