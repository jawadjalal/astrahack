#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { crawlSite } from '../src/crawl.js';
import { runQaAgent } from '../src/qa-agent.js';
import { runFleet } from '../src/fleet.js';
import { findChrome } from '../src/chrome-path.js';

try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }

const usage = 'Usage: node bin/qa.js <crawl|agent|fleet> <config.json> [--output DIR] [--chrome PATH] [--model MODEL] [--max-requests N] [--max-agents N] [--concurrency N] [--max-turns N] [--max-duration-ms N] [--headed] [--include-design]\nFindings are functional bugs only by default; --include-design also keeps usability/visual observations at severity info.';
const numericFlags = { '--max-requests': 'maxRequests', '--max-agents': 'maxAgents', '--concurrency': 'concurrency', '--max-turns': 'maxTurns', '--max-duration-ms': 'maxDurationMs', '--max-output-tokens': 'maxOutputTokens' };

try {
  const [mode, configFile, ...args] = process.argv.slice(2);
  if (mode === '--help' || !mode) { console.log(usage); process.exit(0); }
  if (!['crawl', 'agent', 'fleet'].includes(mode) || !configFile) throw new Error(usage);
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const options = { ...config };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--headed') options.headless = false;
    else if (flag === '--include-design') options.includeDesign = true;
    else if (flag === '--output' || flag === '--chrome' || flag === '--model') {
      if (!args.length) throw new Error(`${flag} needs a value`);
      options[flag.slice(2)] = args.shift();
    } else if (numericFlags[flag]) {
      if (!args.length) throw new Error(`${flag} needs a value`);
      options[numericFlags[flag]] = Number(args.shift());
    } else throw new Error(`Unknown option: ${flag}`);
  }
  options.chrome ||= findChrome() || undefined; // ASTRAHACK_CHROME first, then the usual install paths
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
  const runStatus = result.report?.status || result.fleet?.status;
  if (result.fleet?.usage) console.log(`API usage: ${result.fleet.usage.requests} requests, ${result.fleet.usage.inputTokens} input + ${result.fleet.usage.outputTokens} output tokens`);
  process.exitCode = runStatus === 'error' ? 2 : ['partial', 'limit_reached', 'needs_attention'].includes(runStatus) ? 1 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
