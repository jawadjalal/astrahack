#!/usr/bin/env node
import { analyzeQa } from '../src/qa-analysis.js';

const [runDir, ...args] = process.argv.slice(2);
if (!runDir || args.includes('--help')) {
  console.log('Usage: node bin/analyze-qa.js RUN_DIR [--no-images] [--model MODEL]');
  process.exitCode = runDir ? 0 : 2;
} else {
  try {
    const options = {};
    while (args.length) {
      const flag = args.shift();
      if (flag === '--no-images') options.includeImages = false;
      else if (flag === '--model' && args.length) options.model = args.shift();
      else throw new Error(`Unknown or incomplete option: ${flag}`);
    }
    const { out, report } = await analyzeQa(runDir, options);
    console.log(`${report.findings.length} findings: ${out}/qa-analysis.md`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
