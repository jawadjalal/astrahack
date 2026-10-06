import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCreatives } from '../lib/generate.mjs';
const prompt = 'Gather is a recipe planner. Make a clean ad about planning meals. Use forest green and the CTA Plan a meal.';
// PNG header fixture tests validation/output transport, not visual quality.
function fixture(width=1024, height=1024) { const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.write('IHDR',12); png.writeUInt32BE(width,16); png.writeUInt32BE(height,20); return png.toString('base64'); }
async function temp(t) { const dir = await mkdtemp(join(tmpdir(),'astra-test-')); t.after(() => rm(dir,{ recursive:true, force:true })); return dir; }
test('one prompt produces five distinct square image requests and five files', async t => {
  const outputDir = await temp(t); const calls = [];
  const { runDir, manifest } = await generateCreatives({ prompt, outputDir, apiKey:'fake-key', fetchImpl:async (url,init) => { calls.push({url,body:JSON.parse(init.body)}); return Response.json({ data:[{ b64_json:fixture() }] }); } });
  assert.equal(manifest.status,'complete'); assert.equal(calls.length,5); assert.equal(new Set(calls.map(c=>c.body.prompt)).size,5);
  assert.ok(calls.every(c=>c.url==='https://api.openai.com/v1/images/generations' && c.body.size==='1024x1024' && c.body.n===1 && c.body.prompt.includes(prompt)));
  assert.equal((await readdir(runDir)).filter(f=>f.endsWith('.png')).length,5);
  assert.ok(!(await readFile(join(runDir,'manifest.json'),'utf8')).includes('fake-key'));
});
test('dry run saves five prompts without a key or network call',async t=>{
  const {runDir,manifest}=await generateCreatives({prompt,outputDir:await temp(t),apiKey:'',dryRun:true,fetchImpl:()=>{throw new Error('Must not call network');}});
  assert.equal(manifest.status,'dry-run'); assert.equal(manifest.creatives.length,5); assert.deepEqual(await readdir(runDir),['manifest.json']);
});
test('missing key fails before making an output directory',async t=>{
  const outputDir=await temp(t); await assert.rejects(generateCreatives({prompt,outputDir,apiKey:''}),/OPENAI_API_KEY/); assert.deepEqual(await readdir(outputDir),[]);
});
test('partial failure preserves successful images, reports failure, and never retries',async t=>{
  let calls=0; const {runDir,manifest}=await generateCreatives({prompt,outputDir:await temp(t),apiKey:'fake',fetchImpl:async()=>++calls===2?Response.json({error:'sensitive provider detail'},{status:429}):Response.json({data:[{b64_json:fixture()}]})});
  assert.equal(calls,5); assert.equal(manifest.status,'partial'); assert.equal((await readdir(runDir)).filter(f=>f.endsWith('.png')).length,4); assert.equal(manifest.creatives[1].error,'OpenAI quota or rate limit reached.');
});
test('rejects missing and non-square images',async t=>{
  let calls=0; const {manifest,runDir}=await generateCreatives({prompt,outputDir:await temp(t),apiKey:'fake',fetchImpl:async()=>Response.json(++calls%2?{data:[]}:{data:[{b64_json:fixture(1536,1024)}]})});
  assert.equal(manifest.status,'failed'); assert.deepEqual(await readdir(runDir),['manifest.json']);
});
test('rejects empty prompts',async()=>{await assert.rejects(generateCreatives({prompt:'',dryRun:true}),/nonempty/);});
