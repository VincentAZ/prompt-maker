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
test.after(async () => { await fs.rm(scratch,{recursive:true,force:true}); });
