import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const directions = [
  ['hero', 'One striking product-specific hero visual. Restrained, premium art direction, generous whitespace, and a clear typographic hierarchy.'],
  ['editorial', 'A refined editorial composition. An unexpected crop or viewpoint on a concrete subject relevant to this product. Minimal copy with confident typography.'],
  ['benefit', 'Make the strongest explicitly supported benefit the visual idea. Use one concrete metaphor related to the product, not generic technology imagery.'],
  ['context', 'Show a believable context of use suited to the audience described in the brief. One focal subject, uncluttered background, minimal copy.'],
  ['typographic', 'A bold typographic composition supported by one small, product-specific visual. Express the supplied message with outstanding readability and generous negative space.'],
];

export function planCreatives(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 24000) throw new Error('Provide a nonempty prompt of at most 24,000 characters.');
  return directions.map(([name, direction], i) => ({
    index: i + 1, name, filename: `${String(i + 1).padStart(2, '0')}-${name}.png`,
    prompt: `Create a finished, original square 1:1 static advertisement for Facebook or Instagram.\n\nPRODUCT AND CAMPAIGN BRIEF:\n${prompt.trim()}\n\nART DIRECTION FOR THIS VARIATION:\n${direction}\n\nREQUIREMENTS:\nUse only product facts, brand details, offers, and claims supplied in the brief. Do not invent testimonials, statistics, discounts, guarantees, certifications, pricing, features, logos, or UI. If a visual treatment conflicts with the product, adapt the treatment while preserving the product facts. Respect any exact copy specified in the brief; otherwise write a short product-specific headline and a concise CTA only if supported by the brief. Keep text minimal and perfectly legible. Use a clean, distinctive composition with one visual idea, strong contrast, intentional whitespace, and safe margins. Render the ad itself edge to edge, without a device frame, social-media interface, watermarks, or explanatory text. Do not include these instructions as visible copy.`,
  }));
}

function verifySquarePng(buffer) {
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  if (buffer.length < 24 || !buffer.subarray(0,8).equals(signature) || buffer.toString('ascii',12,16) !== 'IHDR') throw new Error('Provider returned invalid PNG data.');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (width !== 1024 || height !== 1024) throw new Error(`Expected a 1024×1024 image, received ${width}×${height}.`);
}

/** Generate exactly five distinct square ads. No automatic paid retries. */
export async function generateCreatives({ prompt, outputDir = 'artifacts', provider = process.env.IMAGE_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : process.env.OPENAI_API_KEY ? 'openai' : 'gemini'), apiKey, model,
  openaiApi = process.env.OPENAI_IMAGE_API || 'responses', responseModel = process.env.OPENAI_TEXT_MODEL || 'gpt-6-luna', quality = process.env.OPENAI_IMAGE_QUALITY || 'low',
  dryRun = false, fetchImpl = fetch, onProgress = () => {}, signal, resumeDir, requestTimeoutMs = 600000 } = {}) {
  const previous = resumeDir ? JSON.parse(await readFile(join(resumeDir, 'manifest.json'), 'utf8')) : null;
  if (previous) {
    ({ provider, model, sourcePrompt: prompt } = previous);
    openaiApi = previous.api || 'images'; responseModel = previous.responseModel || responseModel; quality = previous.quality || quality;
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 1800000) throw new Error('requestTimeoutMs must be 1000–1800000.');
  if (!['gemini', 'openai'].includes(provider)) throw new Error('Choose gemini or openai as the image provider.');
  if (!['responses', 'images'].includes(openaiApi)) throw new Error('Choose responses or images as the OpenAI image API.');
  if (!['low', 'medium', 'high', 'auto'].includes(quality)) throw new Error('Choose low, medium, high, or auto image quality.');
  apiKey ??= provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY;
  model ||= provider === 'gemini' ? process.env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1' : process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
  const plan = planCreatives(prompt);
  if (previous && (previous.creatives?.length !== 5 || previous.creatives.some((item, i) => item.filename !== plan[i].filename || typeof item.prompt !== 'string'))) throw new Error('Invalid image resume manifest.');
  if (!dryRun && (typeof apiKey !== 'string' || !apiKey.trim())) throw new Error(`Set ${provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY'} to generate images, or use --dry-run.`);
  const runDir = resumeDir || join(outputDir, `ads-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
  await mkdir(runDir, { recursive: true });
  const manifest = previous || { createdAt: new Date().toISOString(), status: dryRun ? 'dry-run' : 'running', provider, model,
    ...(provider === 'openai' ? { api: openaiApi, responseModel: openaiApi === 'responses' ? responseModel : null, quality } : {}),
    size: '1024x1024', count: 5, sourcePrompt: prompt, creatives: plan.map(item => ({ ...item, status: 'planned' })) };
  const save = () => writeFile(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await save();
  if (dryRun) return { runDir, manifest };
  manifest.requestTimeoutMs = requestTimeoutMs;

  // Two concurrent requests; each batch completes before its checkpoint is saved.
  for (let start = 0; start < plan.length; start += 2) {
    const batch = manifest.creatives.slice(start, start + 2).filter(item => !previous || item.status === 'failed');
    for (const item of batch) {
      item.attempts ||= item.status === 'failed' ? [{ status: 'failed', error: item.error || null, usage: item.usage || null, legacy: true }] : [];
      item.attempts.push({ startedAt: new Date().toISOString(), status: 'running', requestTimeoutMs });
      delete item.error; delete item.usage;
    }
    await save();
    await Promise.all(batch.map(async item => {
      onProgress({ index: item.index, status: 'generating' });
      try {
        const gemini = provider === 'gemini';
        const responses = !gemini && openaiApi === 'responses';
        const response = await fetchImpl(gemini ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent` : `https://api.openai.com/v1/${responses ? 'responses' : 'images/generations'}`, {
          method: 'POST', headers: gemini ? { 'x-goog-api-key': apiKey.trim(), 'Content-Type': 'application/json' } : { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(gemini ? { contents: [{ parts: [{ text: item.prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1', imageSize: '1K' } } } : responses ? {
            model: responseModel, store: false, reasoning: { effort: 'low' }, max_output_tokens: 2048,
            input: item.prompt, tools: [{ type: 'image_generation', model, size: '1024x1024', quality, output_format: 'png' }], tool_choice: { type: 'image_generation' },
          } : { model, prompt: item.prompt, n: 1, size: '1024x1024', quality, output_format: 'png' }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs),
        });
        if (!response.ok) {
          const errors = { 401: 'API key rejected.', 403: 'Image model access denied; check project permissions.', 429: `${gemini ? 'Google' : 'OpenAI'} quota or rate limit reached.` };
          throw new Error(errors[response.status] || `Provider request failed (HTTP ${response.status}).`);
        }
        const data = await response.json();
        if (data.usage) item.usage = data.usage;
        if (responses && data.status !== 'completed') throw new Error('Provider returned an incomplete image response.');
        const image = data.candidates?.[0]?.content?.parts?.find(p => !p.thought && p.inlineData)?.inlineData;
        if (gemini && image && image.mimeType !== 'image/png') throw new Error('Provider returned a non-PNG image.');
        const encoded = gemini ? image?.data : responses ? data.output?.find(item => item.type === 'image_generation_call' && item.status === 'completed')?.result : data.data?.[0]?.b64_json;
        if (typeof encoded !== 'string' || !encoded.length) throw new Error('Provider returned no image.');
        const png = Buffer.from(encoded, 'base64'); verifySquarePng(png);
        await writeFile(join(runDir, item.filename), png, { flag: 'wx' });
        item.status = 'complete';
      } catch (error) {
        item.status = 'failed';
        // Never persist provider error bodies, which can echo sensitive request details.
        item.error = ['TimeoutError','AbortError'].includes(error.name) ? 'Request timed out; the provider may still charge for it.' : /^(API key rejected|Image model access denied|OpenAI quota|Google quota|Provider request failed|Provider returned|Expected a 1024)/.test(error.message) ? error.message : 'Request or file write failed.';
      }
      Object.assign(item.attempts.at(-1), { finishedAt: new Date().toISOString(), status: item.status, error: item.error || null, usage: item.usage || null });
      onProgress({ index: item.index, status: item.status });
    }));
    await save();
  }
  const completed = manifest.creatives.filter(c => c.status === 'complete').length;
  manifest.status = completed === 5 ? 'complete' : completed ? 'partial' : 'failed';
  await save();
  return { runDir, manifest };
}
