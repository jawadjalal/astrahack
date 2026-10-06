import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { generateCreatives } from './lib/generate.mjs';

try {
  const { values } = parseArgs({ options: {
    provider: { type: 'string' }, model: { type: 'string' }, prompt: { type: 'string' }, 'prompt-file': { type: 'string' }, out: { type: 'string', default: 'artifacts' },
    'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Generate five square ad creatives from one prompt.\n\n  npm run generate -- --prompt-file brief.txt\n  npm run generate -- --prompt "Your product and ad brief"\n  npm run generate -- --prompt-file brief.txt --dry-run\n\nOptions: --out <directory> (default: artifacts), --dry-run (no API calls)\nDefault: Nano Banana. Set GEMINI_API_KEY in .env. Use --provider openai with OPENAI_API_KEY to switch. Optional --model <name>.');
  } else {
    if (Boolean(values.prompt) === Boolean(values['prompt-file'])) throw new Error('Supply exactly one of --prompt or --prompt-file.');
    const prompt = values['prompt-file'] ? await readFile(values['prompt-file'], 'utf8') : values.prompt;
    const { runDir, manifest } = await generateCreatives({ provider: values.provider, model: values.model, prompt, outputDir: resolve(values.out), dryRun: values['dry-run'], onProgress: ({ index, status }) => console.log(`[${index}/5] ${status}`) });
    const count = manifest.creatives.filter(c => c.status === 'complete').length;
    console.log(values['dry-run'] ? `Saved five image prompts (no API calls): ${runDir}` : `Generated ${count}/5 square ads: ${runDir}`);
    if (!values['dry-run'] && count !== 5) { console.error('Some images failed. See manifest.json; successful images are preserved. No automatic retries were made.'); process.exitCode = 1; }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
