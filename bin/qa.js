#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { crawlSite } from '../src/crawl.js';
import { runQaAgent } from '../src/qa-agent.js';

const usage = 'Usage: node bin/qa.js <crawl|agent> <config.json> [--output DIR] [--chrome PATH] [--headed]';

try {
  const [mode, configFile, ...args] = process.argv.slice(2);
  if (mode === '--help' || !mode) { console.log(usage); process.exit(0); }
  if (!['crawl', 'agent'].includes(mode) || !configFile) throw new Error(usage);
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const options = { ...config };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--headed') options.headless = false;
    else if (flag === '--output' || flag === '--chrome') {
      if (!args.length) throw new Error(`${flag} needs a value`);
      options[flag.slice(2)] = args.shift();
    } else throw new Error(`Unknown option: ${flag}`);
  }
  options.chrome ||= process.env.ASTRAHACK_CHROME;
  options.output ||= `runs/${mode}-${Date.now()}`;
  const result = mode === 'crawl' ? await crawlSite(options) : await runQaAgent(options);
  const status = mode === 'crawl' ? `${result.report.pages.length} pages, ${result.report.findings.length} findings` : result.report.status;
  console.log(`${status}: ${result.out}/${mode === 'crawl' ? 'crawl' : 'qa-agent'}.json`);
  if (result.report.error) console.error(result.report.error);
  process.exitCode = result.report.status === 'error' ? 2 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
