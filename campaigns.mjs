import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { generateCampaigns } from './lib/campaigns.mjs';

try {
  const { values } = parseArgs({ options: {
    prompt: { type: 'string' }, 'prompt-file': { type: 'string' }, channel: { type: 'string', default: 'both' },
    model: { type: 'string' }, out: { type: 'string', default: 'artifacts' },
    provider: { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Generate detailed X and Reddit GTM campaign drafts.\n\n  npm run campaigns -- --provider openai --prompt-file brief.txt\n  npm run campaigns -- --prompt "Product, audience, goals" --channel x\n\nOptions: --channel both|x|reddit, --provider gemini|openai, --model <text model>, --out <directory>, --dry-run\nSet GEMINI_API_KEY or OPENAI_API_KEY in .env. OpenAI defaults to gpt-6-luna. Saves Markdown and JSON; does not publish posts.');
  } else {
    if (Boolean(values.prompt) === Boolean(values['prompt-file'])) throw new Error('Supply exactly one of --prompt or --prompt-file.');
    const prompt = values['prompt-file'] ? await readFile(values['prompt-file'], 'utf8') : values.prompt;
    const { runDir, manifest } = await generateCampaigns({ prompt, channels: values.channel === 'both' ? ['x', 'reddit'] : [values.channel], provider: values.provider, model: values.model, outputDir: resolve(values.out), dryRun: values['dry-run'], onProgress: ({ channel, status }) => console.log(`${channel}: ${status}`) });
    console.log(`${manifest.status}: ${runDir}`);
    if (!values['dry-run'] && manifest.status !== 'complete') { console.error('See manifest.json for failures. Successful drafts are preserved; no automatic retries were made.'); process.exitCode = 1; }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
