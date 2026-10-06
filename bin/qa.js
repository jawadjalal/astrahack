#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { crawlSite } from '../src/crawl.js';
import { runQaAgent } from '../src/qa-agent.js';
import { runFleet } from '../src/fleet.js';

const usage = 'Usage: node bin/qa.js <crawl|agent|fleet> <config.json> [--output DIR] [--chrome PATH] [--headed]';

try {
  const [mode, configFile, ...args] = process.argv.slice(2);
  if (mode === '--help' || !mode) { console.log(usage); process.exit(0); }
  if (!['crawl', 'agent', 'fleet'].includes(mode) || !configFile) throw new Error(usage);
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
  if (mode === 'fleet') options.onProgress = event => {
    if (event.phase === 'crawl') console.log('Crawling site…');
    else if (event.status === 'started') console.log(`${event.job.id} ${event.job.mission}: ${event.job.url}`);
    else console.log(`${event.job.id} ${event.status}${event.error ? `: ${event.error}` : ''}`);
  };
  const result = mode === 'crawl' ? await crawlSite(options) : mode === 'agent' ? await runQaAgent(options) : await runFleet(options);
  const status = mode === 'crawl' ? `${result.report.pages.length} pages, ${result.report.findings.length} findings`
    : mode === 'agent' ? result.report.status
    : `${result.fleet.coverage.completedAgents}/${result.fleet.coverage.totalAgents} agents completed; ${result.fleet.coverage.crawledPages} pages crawled`;
  console.log(`${status}: ${result.out}/${mode === 'crawl' ? 'crawl' : mode === 'agent' ? 'qa-agent' : 'fleet'}.json`);
  if (result.report?.error) console.error(result.report.error);
  process.exitCode = result.report?.status === 'error' || result.fleet?.status === 'error' ? 2 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
