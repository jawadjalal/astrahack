# Code integration

```js
import { generateCreatives } from './lib/generate.mjs';

const { runDir, manifest } = await generateCreatives({
  prompt: 'Your product facts and ad brief',
  outputDir: 'artifacts',
  apiKey: process.env.OPENAI_API_KEY,
});

if (manifest.status !== 'complete') {
  // Inspect manifest.creatives for per-image errors.
  // Successful images remain in runDir.
}
```

Optional inputs: `model` (default `gpt-image-2`), `dryRun` (default false), and `onProgress`, which receives `{ index, status }`. `outputDir` defaults to `artifacts`; the key defaults to `OPENAI_API_KEY`.

The prompt must be nonempty and no longer than 24,000 characters. Each successful run contains five images. Manifest status is `complete`, `partial`, `failed`, or `dry-run`. Input validation and filesystem initialization failures throw errors; individual generation failures are recorded in the manifest.

For prompt-only integration, import `planCreatives(prompt)` to obtain all five prompts without filesystem or network operations.
