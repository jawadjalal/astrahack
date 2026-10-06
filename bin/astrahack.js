#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { run } from '../src/runner.js';

function usage() {
  console.log('Usage: node bin/astrahack.js <journey.json> [--output DIR] [--chrome PATH] [--ffmpeg PATH] [--headed]');
}

function parse(args) {
  if (!args.length || args.includes('--help')) { usage(); process.exit(0); }
  const options = {};
  const file = args.shift();
  while (args.length) {
    const arg = args.shift();
    if (arg === '--headed') options.headless = false;
    else if (['--output', '--chrome', '--ffmpeg'].includes(arg)) {
      if (!args.length) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = args.shift();
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return { file, options };
}

try {
  const { file, options } = parse(process.argv.slice(2));
  const config = JSON.parse(await readFile(file, 'utf8'));
  options.chrome ||= process.env.ASTRAHACK_CHROME;
  options.ffmpeg ||= process.env.ASTRAHACK_FFMPEG;
  const { out, report } = await run(config, options);
  console.log(`${report.status}: ${out}/report.json`);
  if (report.error) console.error(report.error);
  process.exitCode = report.status === 'error' ? 2 : report.findings.length ? 1 : 0;
} catch (error) {
  console.error(error.message);
  usage();
  process.exitCode = 2;
}
