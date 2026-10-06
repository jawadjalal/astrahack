#!/usr/bin/env node
import { captureMajorFeatures } from '../src/feature-capture.js';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log('Usage: node bin/feature-capture.js RUN_DIR/report.json|crawl.json|qa-agent.json [--output DIR]');
  process.exit(args.includes('--help') ? 0 : 2);
}
const reportPath = args.shift();
let output;
while (args.length) {
  const arg = args.shift();
  if (arg !== '--output' || !args.length) {
    console.error(`Unknown or incomplete option: ${arg}`);
    process.exit(2);
  }
  output = args.shift();
}
try {
  const result = await captureMajorFeatures(reportPath, { output });
  console.log(`${result.manifest.features.length} features; ${result.manifest.gaps.length} gaps: ${result.outputDir}/manifest.json`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
