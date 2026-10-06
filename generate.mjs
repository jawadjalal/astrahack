import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { generateCreatives } from './lib/generate.mjs';

try {
  const { values } = parseArgs({ options: {
    provider: { type: 'string' }, model: { type: 'string' }, prompt: { type: 'string' }, 'prompt-file': { type: 'string' }, out: { type: 'string', default: 'artifacts' },
    'openai-api': { type: 'string' }, 'response-model': { type: 'string' }, quality: { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Generate five square ad creatives from one prompt.\n\n  npm run generate -- --provider openai --prompt-file brief.txt\n  npm run generate -- --prompt "Your product and ad brief"\n  npm run generate -- --prompt-file brief.txt --dry-run\n\nOptions: --out <directory>, --dry-run, --provider gemini|openai, --model <image model>\nOpenAI: --openai-api responses|images (default: responses), --response-model <text model> (default: gpt-6-luna), --quality low|medium|high|auto (default: low).\nUses the provider selected by IMAGE_PROVIDER or available GEMINI_API_KEY / OPENAI_API_KEY in .env.');
  } else {
    if (Boolean(values.prompt) === Boolean(values['prompt-file'])) throw new Error('Supply exactly one of --prompt or --prompt-file.');
    const prompt = values['prompt-file'] ? await readFile(values['prompt-file'], 'utf8') : values.prompt;
    const { runDir, manifest } = await generateCreatives({ provider: values.provider, model: values.model, openaiApi: values['openai-api'], responseModel: values['response-model'], quality: values.quality, prompt, outputDir: resolve(values.out), dryRun: values['dry-run'], onProgress: ({ index, status }) => console.log(`[${index}/5] ${status}`) });
    const count = manifest.creatives.filter(c => c.status === 'complete').length;
    console.log(values['dry-run'] ? `Saved five image prompts (no API calls): ${runDir}` : `Generated ${count}/5 square ads: ${runDir}`);
    if (!values['dry-run'] && count !== 5) { console.error('Some images failed. See manifest.json; successful images are preserved. No automatic retries were made.'); process.exitCode = 1; }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
