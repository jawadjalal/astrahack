#!/usr/bin/env node
import { publishFeatureCaptures } from '../src/feature-canvas.js';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log('Usage: node bin/feature-canvas.js RUN_DIR/feature-captures/manifest.json [--canvas-url URL]');
  process.exit(args.includes('--help') ? 0 : 2);
}
const manifestPath = args.shift();
let canvasUrl;
while (args.length) {
  const arg = args.shift();
  if (arg !== '--canvas-url' || !args.length) {
    console.error(`Unknown or incomplete option: ${arg}`);
    process.exit(2);
  }
  canvasUrl = args.shift();
}
try {
  const result = await publishFeatureCaptures(manifestPath, { canvasUrl });
  console.log(`Canvas: ${result.imageCount} screenshots, ${result.gapCount} coverage gaps at ${result.canvasUrl}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
