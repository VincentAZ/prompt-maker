import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { normalizeSweep, sweepRows, sweepSetup } from '../public/batches.js';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-updates-unit-'));
process.env.PROMPT_MAKER_DATA = scratch;
const { modelLabel } = await import('../lib/lmstudio.js');
const { acquireGpu, withGpu, registerGpuRelease, memoryError } = await import('../lib/gpu.js');
const axis = (target, key, values) => ({ target, key, values });
test('cycles preserve the caption setup, LoRA strength and every combination', () => {
  const sweep = normalizeSweep({ mode: 'combinations', axes: [axis('seed', 'seed', [0, 8]), axis('loraOn', '20', [false, true])] });
  const rows = sweepRows(sweep, 1);
  assert.equal(rows.length, 4);
  const base = { workflowId: 'one', loras: { tweaks: { 20: { strength: .4, on: true } }, added: [{ name: 'generic.safetensors', strength: 100, on: false }] }, overrides: { '3|cfg': 3.5 } };
  const out = rows.map(row => sweepSetup(base, row, { resolution: '1024×1024' }));
  assert.deepEqual(out.map(o => [o.seed.value, o.loras.tweaks[20].on]), [[0,false],[8,false],[0,true],[8,true]]);
  assert(out.every(o => o.loras.tweaks[20].strength === .4 && o.overrides['3|cfg'] === 3.5));
  assert.equal(base.loras.tweaks[20].on, true);
  const cycle = normalizeSweep({ mode: 'cycle', axes: [axis('seed', 'seed', [1,2]), axis('loraStrength', '+generic.safetensors', [0,100,1])] });
  assert.deepEqual(sweepRows(cycle, 4).map(r => r.map(a => a.value)), [[1,0],[2,100],[1,1],[2,0]]);
  assert.throws(() => normalizeSweep({ mode: 'combinations', axes: [axis('seed','seed',Array.from({length: 8},(_,i)=>i)),axis('param','3|steps',Array.from({length: 8},(_,i)=>i+1))] }), /at most 50/);
  assert.throws(() => normalizeSweep({ mode:'cycle',axes:[axis('param','__proto__',[1])] }), /Unknown/);
});
test('compression stays visible exactly once', () => {
  assert.equal(modelLabel('Example 27B','Q4_K_M'), 'Example 27B · Q4_K_M');
  assert.equal(modelLabel('Example 27B Q4_K_M','Q4_K_M'), 'Example 27B Q4_K_M');
});
test('more than twelve added local LoRAs survive saving, take setup and rendering', async () => {
  const wf = await import('../lib/workflows.js');
  await wf.initWorkflows();
  const fixture = JSON.parse(await fs.readFile(new URL('../workflows/krea2-raw/text-to-image.json', import.meta.url), 'utf8'));
  const added = Array.from({ length: 16 }, (_, i) => ({
    name: `local/example_${i + 1}.safetensors`, strength: i === 12 ? -0.5 : 1, on: i !== 13,
  }));
  const saved = await wf.saveWorkflow({ ...fixture, modelId: 'krea2-raw', loras: { tweaks: {}, added } });
  assert.deepEqual(saved.loras.added, added, 'saving must not silently discard later additions');
  let reloaded = await wf.getWorkflow(saved.id);
  assert.deepEqual(reloaded.loras.added, added, 'all choices persist on disk');
  assert.deepEqual((await wf.listWorkflows()).find(w => w.id === saved.id).loras.added, added, 'the UI receives every addition');
  added[12].strength = 0.75;
  await wf.saveWorkflow({ loras: { tweaks: {}, added } }, reloaded);
  reloaded = await wf.getWorkflow(saved.id);
  assert.deepEqual(reloaded.loras.added, added, 'later additions remain adjustable');
  const setup = wf.withSetup(reloaded, { loras: { tweaks: {}, added } });
  assert.deepEqual(setup.loras.added, added, 'queued takes retain every choice');
  const { prompt, applied } = wf.buildPrompt(setup, { text: '', seed: 0 });
  assert.deepEqual(applied.loras.filter(l => l.added).map(({ name, strength }) => ({ name, strength })),
    added.filter(l => l.on).map(({ name, strength }) => ({ name, strength })));
  assert.deepEqual(Object.values(prompt).filter(n => n._meta?.title === 'LoRA (Prompt Maker)').map(n => n.inputs.lora_name),
    added.filter(l => l.on).map(l => l.name), 'enabled additions reach ComfyUI; disabled ones stay out');
});
test('GPU handoff waits, cancels promptly, and unloads before the next owner', async () => {
  const calls = [];
  const srv = http.createServer(async (req,res) => {
    for await (const _ of req) {};
    calls.push(req.url);
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(req.url === '/api/v1/models' ? {models:[{key:'mock',type:'llm',loaded_instances:[{id:'instance'}]}]} : req.url === '/queue' ? {queue_running:[],queue_pending:[]} : {}));
  });
  await new Promise(r => srv.listen(0,'127.0.0.1',r));
  const settings = {lmStudioUrl:`http://127.0.0.1:${srv.address().port}`,comfyUrl:`http://127.0.0.1:${srv.address().port}`};
  registerGpuRelease('voice', async () => calls.push('stop-voice'));
  try {
    const release = await acquireGpu('brain',settings);
    assert(calls.indexOf('/free') > calls.indexOf('stop-voice'));
    const controller = new AbortController();
    const cancelled = acquireGpu('voice',settings,{signal:controller.signal});
    controller.abort();
    await assert.rejects(cancelled, /abort/i);
    let ran = false;
    const next = withGpu('render',settings,{},async () => { ran = true; assert(calls.includes('/api/v1/models/unload')); });
    await new Promise(r => setTimeout(r,25));
    assert.equal(ran,false);
    release(); await next;
    await assert.rejects(withGpu('voice',settings,{},async()=>{throw new Error('CUDA out of memory');}), /Other apps/);
    await withGpu('brain',settings,{},async()=>{}); // failure did not strand the gate
    assert.equal(memoryError(new Error('OutOfMemoryError: CUDA')).status,507);
  } finally { await new Promise(r=>srv.close(r)); }
});
test('FLUX 3 Base variants are scrubbed and use Base sampling settings', async () => {
  for (const quant of ['int8-convrot','bf16','nvfp4']) {
    const w = JSON.parse(await fs.readFile(new URL(`../workflows/flux-3-klein-base/text-to-image-${quant}.json`,import.meta.url),'utf8'));
    assert(w.prompt['1'].inputs.unet_name.includes(quant));
    assert.equal(w.prompt['7'].inputs.steps,50); assert.equal(w.prompt['7'].inputs.cfg,3.5); assert.equal(w.prompt['7'].inputs.seed,0);
    assert.equal(w.prompt['4'].inputs.text,''); assert.equal(w.prompt['5'].inputs.text,'');
    assert.equal(w.prompt['2'].inputs.type,'flux3');
    for (const n of Object.values(w.prompt)) for (const v of Object.values(n.inputs)) if (Array.isArray(v)) assert(w.prompt[v[0]],`missing node ${v[0]}`);
  }
});
test('FLUX edit workflows reuse Base files and route only supplied references to both conditionings', async () => {
  const wf = await import('../lib/workflows.js');
  await wf.initWorkflows();
  for (const quant of ['int8-convrot', 'bf16', 'nvfp4']) {
    const read = file => fs.readFile(new URL(`../workflows/${file}`, import.meta.url), 'utf8').then(JSON.parse);
    const fixture = await read(`flux-3-klein-base-edit/image-edit-${quant}.json`);
    const base = await read(`flux-3-klein-base/text-to-image-${quant}.json`);
    assert.deepEqual(fixture.models, base.models, 'existing downloads are reused');
    const saved = await wf.saveWorkflow({ ...fixture, modelId: 'flux-3-klein-base-edit' });
    const workflow = await wf.getWorkflow(saved.id);
    assert.equal(wf.summary(workflow).maps.size, false, 'size comes from the reference, not the size picker');
    assert.deepEqual(wf.summary(workflow).imageSlots.map(s => s.optional), [false, true, true]);
    for (const imageNames of [['main.png'], ['main.png', 'second.png'], ['main.png', null, 'third.png'], ['main.png', 'second.png', 'third.png']]) {
      const { prompt } = wf.buildPrompt(workflow, { text: 'The finished picture.', imageNames, seed: 42, resolution: '2048×2048' });
      assert.equal(prompt['4'].inputs.text, 'The finished picture.');
      assert.equal(prompt['5'].inputs.text, '');
      assert.equal(prompt['7'].inputs.seed, 42);
      assert.equal(prompt['7'].inputs.cfg, 3.5);
      assert.equal(prompt['7'].inputs.steps, 50);
      assert.deepEqual(['positive', 'negative', 'latent_image'].map(k => prompt['7'].inputs[k]), [['13', 0], ['13', 1], ['13', 2]]);
      assert.deepEqual(prompt['13'].inputs.positive, ['4', 0]);
      assert.deepEqual(prompt['13'].inputs.negative, ['5', 0]);
      assert.equal(prompt['13'].inputs['resolution.megapixels'], 1);
      for (let i = 0; i < 3; i++) {
        assert.equal(prompt[String(10 + i)]?.inputs.image, imageNames[i] || undefined);
        assert.deepEqual(prompt['13'].inputs[`images.image${i}`], imageNames[i] ? [String(10 + i), 0] : undefined);
      }
      for (const n of Object.values(prompt)) for (const v of Object.values(n.inputs)) if (Array.isArray(v)) assert(prompt[v[0]], `missing node ${v[0]}`);
    }
  }
});
test('editing prompts acknowledge the supplied picture and keep unrelated details across takes', async () => {
  const { buildRequestText } = await import('../lib/prompt.js');
  const model = JSON.parse(await fs.readFile(new URL('../playbooks/flux-3-klein-base-edit.json', import.meta.url), 'utf8'));
  for (const imageRole of ['reference', 'recreate', 'character']) {
    const request = buildRequestText(model, { hasImage: true, imageRole, theme: 'make the jacket blue', length: 'medium' }, { index: 1, count: 2, previous: ['Previous caption.'] });
    assert(request.includes('generator WILL receive this picture'));
    assert(!request.includes('will NOT receive'));
    assert(request.includes('preserve everything outside that edit'));
    assert(request.includes('Keep the picture’s framing, camera angle and lighting'));
  }
  const textOnly = buildRequestText({ ...model, task: 'picture' }, { hasImage: true, imageRole: 'reference', theme: 'a new scene', length: 'short' });
  assert(textOnly.includes('will NOT receive'), 'text-to-image reference behavior is unchanged');
});
test.after(async () => { await fs.rm(scratch,{recursive:true,force:true}); });

test('MiniMax small exports use a full generation canvas and retain the requested output size', async () => {
  const { buildPrompt } = await import('../lib/workflows.js');
  const path = 'minimax-h3-image/text-to-image.json';
  const workflow = JSON.parse(await fs.readFile(new URL('../workflows/' + path, import.meta.url)));
  workflow.source = 'starter:' + path;
  const build = resolution => buildPrompt(workflow, { text: '', resolution });
  const { prompt, applied } = build('896×1184');
  assert.equal(applied.size, '896×1184');
  assert.ok(prompt['5'].inputs.width * prompt['5'].inputs.height >= 2048 ** 2);
  const resize = prompt[prompt['9'].inputs.images[0]];
  assert.equal(resize.class_type, 'ImageScale');
  assert.deepEqual(resize.inputs, { image: ['8', 0], width: 896, height: 1184, upscale_method: 'lanczos', crop: 'disabled' });
  assert.deepEqual(build('2048×2048').prompt['9'].inputs.images, ['8', 0]);
  workflow.source = 'upload';
  assert.equal(build('896×1184').prompt['5'].inputs.width, 896);
});
